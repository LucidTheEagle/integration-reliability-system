import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomUUIDv7 } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { DEFAULT_POOL_SETTINGS, createDatabase, toPgPoolConfig } from "./client.js";
import type { Database } from "./client.js";
import { DISPATCH_AUDIT_INSERT_SQL, insertDispatchAuditEntry } from "./dispatch-audit.js";
import { ingestEvent } from "./event-ingestion.js";
import { PrismaClient } from "./generated/prisma/client.js";
import { assertServerBaseline } from "./test-support/baseline.js";
import { bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { guardedDatabase, ingestionInput, latch, seedIntegration } from "./test-support/database.js";
import { connectGuarded, requireTestUrl, validateTarget, verifyPostConnect, withDatabase } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { pg, sqlState } from "./test-support/pg.js";
import type { PgClient, PgClientConfig } from "./test-support/pg.js";
import { migrateScratch } from "./test-support/provision.js";
import { API_ROLE, WORKER_ROLE, scratchDatabaseName } from "./test-support/registry.js";

// Task 012B: R1 (PL-8), the B1-1 backlog age (PL-9, with Part B4's corrected
// time-zone control) and the B2-11 audit insert (PL-10), in the registered
// scratch database `dispatchtime` (FD-6), dropped afterwards.
// The non-UTC sessions here are test-only and separate from the worker's
// UTC-pinned pool (R1 part 3). Every decision is made in SQL; JavaScript only
// compares results, and the expected time-zone shift is obtained from
// PostgreSQL for each specific instant tested, never hard-coded.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const workerUrl = requireTestUrl("IRS_TEST_WORKER_DATABASE_URL");
const PURPOSE = "dispatchtime";
const NON_UTC_ZONE = "America/New_York";
/** Allowed difference between the database clock and the instants the test wrote from the host clock, in seconds. */
const CLOCK_TOLERANCE_S = 5;

const workerScratchUrl = withDatabase(workerUrl, scratchDatabaseName(PURPOSE));
const apiScratchUrl = withDatabase(apiUrl, scratchDatabaseName(PURPOSE));

// Admin mode on irs_011_test: the baseline, and creating and dropping the scratch database.
let admin: GuardedConnection;
// Admin mode on the scratch database: row construction and read-back (the worker cannot read AuditEntry).
let scratchAdmin: GuardedConnection;
let integrationId: string;

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-dispatch-time" });
  await assertServerBaseline(admin.client);
  const adminScratchUrl = await bootstrapScratch(admin, adminUrl, PURPOSE);
  await migrateScratch(adminScratchUrl, [API_ROLE, WORKER_ROLE]);
  scratchAdmin = await connectGuarded({ url: adminScratchUrl, mode: "admin", applicationName: "irs-test-dispatch-time-admin" });
  integrationId = await seedIntegration(scratchAdmin.client, "ACTIVE");
});

after(async () => {
  await scratchAdmin?.close();
  await dropScratch(admin, PURPOSE);
  await assertServerBaseline(admin.client);
  await admin.close();
});

/** A raw worker session with a session TimeZone set at connection start, through the guard (worker mode). */
async function workerSession(timeZone: string): Promise<PgClient> {
  const target = validateTarget(workerScratchUrl, "worker");
  const config: PgClientConfig & { readonly options: string } = {
    connectionString: workerScratchUrl,
    connectionTimeoutMillis: 5_000,
    application_name: `irs-test-worker-tz-${timeZone.replace(/[^A-Za-z]/g, "")}`,
    options: `-c TimeZone=${timeZone}`,
  };
  const client = new pg.Client(config);
  client.on("error", () => undefined);
  await client.connect();
  try {
    await verifyPostConnect(client, { database: target.database, user: WORKER_ROLE, mode: "worker" });
    const shown = (await client.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz")).rows[0]?.tz;
    assert.equal(shown, timeZone, "the session TimeZone is asserted independently");
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

/** The worker's production-shaped pool: a worker-mode guard check, then createDatabase (max 3). */
async function workerPool(pinned: boolean): Promise<Database> {
  const check = await connectGuarded({ url: workerScratchUrl, mode: "worker", applicationName: "irs-test-worker-pool-check" });
  await check.close();
  return createDatabase({ connectionString: workerScratchUrl, pool: { maxConnections: 3 }, sessionTimeZone: pinned ? "UTC" : undefined });
}

/** Admin mode: one unmarked Event row in the given status, with SQL-set dispatch timestamps. */
async function eventRow(status: string, set = ""): Promise<string> {
  const id = randomUUID();
  await scratchAdmin.client.query(
    `INSERT INTO "public"."Event" ("id", "integrationId", "externalEventId", "eventType", "resourceType", "resourceId", "payload",
       "occurredAt", "receivedAt", "status", "schemaVersion", "rawBody", "rawBodySha256")
     VALUES ($1, $2, $3, 't', 't', 't', '{}'::jsonb, now(), now(), $4::"public"."EventState", '1', '\\x61'::bytea, $5)`,
    [id, integrationId, `dt-${id}`, status, "a".repeat(64)],
  );
  if (set !== "") await scratchAdmin.client.query(`UPDATE "public"."Event" SET ${set} WHERE "id" = $1`, [id]);
  return id;
}

describe("R1 (PL-8): every physical worker connection is pinned to UTC at connection start", () => {
  async function threeAtOnce(db: Database): Promise<{ tz: string; source: string; pid: number }[]> {
    let started = 0;
    const gate = latch();
    return Promise.all(
      [0, 1, 2].map(() =>
        db.prisma.$transaction(
          async (tx) => {
            started += 1;
            if (started === 3) gate.release();
            await gate.wait;
            const rows = await tx.$queryRawUnsafe<{ tz: string; source: string; pid: number }[]>(
              `SELECT current_setting('TimeZone') AS tz, (SELECT s.source FROM pg_catalog.pg_settings s WHERE s.name = 'TimeZone') AS source,
                      pg_backend_pid() AS pid`,
            );
            const row = rows[0];
            assert.ok(row !== undefined);
            return row;
          },
          { maxWait: 5_000, timeout: 10_000 },
        ),
      ),
    );
  }

  it("a worker pool (max 3) holding three transactions at once: three distinct backends, each TimeZone UTC with source 'client'", async () => {
    const db = await workerPool(true);
    try {
      const rows = await threeAtOnce(db);
      process.stdout.write(`[R1] pinned worker pool: ${JSON.stringify(rows.map((r) => ({ tz: r.tz, source: r.source })))}\n`);
      assert.equal(new Set(rows.map((r) => r.pid)).size, 3, "three physical connections");
      for (const row of rows) assert.deepEqual({ tz: row.tz, source: row.source }, { tz: "UTC", source: "client" });
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("control: the default (unpinned) pool's TimeZone comes from the server's configuration file", async () => {
    const db = await workerPool(false);
    try {
      const rows = await threeAtOnce(db);
      for (const row of rows) assert.equal(row.source, "configuration file");
    } finally {
      await db.prisma.$disconnect();
    }
  });
});

describe("R1 (PL-8): dispatch timestamps classify identically in a UTC and a non-UTC session", () => {
  const CORRECT = `SELECT "id"::text AS id,
           ("queuedAt" < now() - interval '1 hour') AS past_t,
           ("lastPublishAttemptAt" < now() - interval '20 minutes') AS past_r,
           ("publishAckedAt" < now() - interval '1 hour') AS acked_past_t
      FROM "public"."Event" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`;
  // A deliberately wrong form: the timestamptz cast through the session zone.
  const WRONG = `SELECT "id"::text AS id,
           ("queuedAt"::timestamp < (now() AT TIME ZONE 'UTC') - interval '1 hour') AS past_t,
           ("lastPublishAttemptAt"::timestamp < (now() AT TIME ZONE 'UTC') - interval '20 minutes') AS past_r,
           ("publishAckedAt"::timestamp < (now() AT TIME ZONE 'UTC') - interval '1 hour') AS acked_past_t
      FROM "public"."Event" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`;

  it("rows set by SQL relative to now(): the same classification, equal to their construction; the wrong form shifts under the non-UTC session", async () => {
    const old = await eventRow("QUEUED", `"queuedAt" = now() - interval '2 hours', "lastPublishAttemptAt" = now() - interval '2 hours', "publishAckedAt" = now() - interval '2 hours'`);
    const recent = await eventRow("QUEUED", `"queuedAt" = now() - interval '30 minutes', "lastPublishAttemptAt" = now() - interval '10 minutes', "publishAckedAt" = now() - interval '30 minutes'`);
    const ids = [old, recent];
    const expected = [
      { id: old, past_t: true, past_r: true, acked_past_t: true },
      { id: recent, past_t: false, past_r: false, acked_past_t: false },
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    const utc = await workerSession("UTC");
    const nonUtc = await workerSession(NON_UTC_ZONE);
    try {
      const inUtc = (await utc.query(CORRECT, [ids])).rows;
      const inNonUtc = (await nonUtc.query(CORRECT, [ids])).rows;
      assert.deepEqual(inUtc, expected, "UTC session: equal to the construction");
      assert.deepEqual(inNonUtc, expected, "non-UTC session: identical");
      // Controls: the wrong form agrees under UTC, and is detected under the non-UTC session.
      assert.deepEqual((await utc.query(WRONG, [ids])).rows, expected);
      const wrongNonUtc = (await nonUtc.query(WRONG, [ids])).rows;
      process.stdout.write(`[R1 control] wrong form under ${NON_UTC_ZONE}: ${JSON.stringify(wrongNonUtc)}\n`);
      assert.notDeepEqual(wrongNonUtc, expected, "the shift is detected");
    } finally {
      await utc.end();
      await nonUtc.end();
    }
  });

  it("records (does not assume) whether the pinned adapter shifts a timestamptz read through Prisma under a non-UTC session", async () => {
    const id = await eventRow("QUEUED", `"queuedAt" = now() - interval '2 hours'`);
    const results: Record<string, number> = {};
    for (const zone of ["UTC", NON_UTC_ZONE]) {
      const check = await connectGuarded({ url: workerScratchUrl, mode: "worker", applicationName: "irs-test-adapter-read-check" });
      await check.close();
      // Test-only client with a session option; never the production pool.
      const prisma = new PrismaClient({
        adapter: new PrismaPg({
          ...toPgPoolConfig(workerScratchUrl, { ...DEFAULT_POOL_SETTINGS, maxConnections: 1 }),
          options: `-c transaction_timeout=0 -c TimeZone=${zone}`,
        }),
      });
      try {
        const rows = await prisma.$queryRawUnsafe<{ at: Date; epoch: number }[]>(
          `SELECT "queuedAt" AS at, EXTRACT(EPOCH FROM "queuedAt")::float8 AS epoch FROM "public"."Event" WHERE "id" = $1::uuid`,
          id,
        );
        const row = rows[0];
        assert.ok(row !== undefined && row.at instanceof Date && typeof row.epoch === "number");
        results[zone] = Math.round(row.at.getTime() / 1000 - row.epoch);
      } finally {
        await prisma.$disconnect();
      }
    }
    process.stdout.write(`[R1 adapter] Prisma read minus SQL epoch, in seconds, by session zone: ${JSON.stringify(results)}\n`);
    for (const value of Object.values(results)) assert.ok(Number.isFinite(value));
  });
});

describe("B1-1 (PL-9): the backlog age of VALIDATED events from receivedAt (timestamp without time zone)", () => {
  it("events ingested through the normal path; ages and classifications under a non-UTC session match the written instants; the naive form shifts by PostgreSQL's per-instant offset", async () => {
    const db = await guardedDatabase({ url: apiScratchUrl, mode: "api" });
    const offsets = [90, 3 * 3600, 26 * 3600, 0];
    const written: { id: string; instant: number }[] = [];
    try {
      for (const seconds of offsets) {
        const instant = Date.now() - seconds * 1000;
        const result = await ingestEvent(db, { ...ingestionInput(integrationId, `age-${randomUUID()}`), receivedAt: new Date(instant) });
        assert.equal(result.disposition, "NEW");
        if (result.disposition === "NEW") written.push({ id: result.eventId, instant });
      }
    } finally {
      await db.prisma.$disconnect();
    }
    const ids = written.map((entry) => entry.id);
    const perRow = `SELECT "id"::text AS id,
                           EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - "receivedAt"))::float8 AS age,
                           ("receivedAt" < (now() AT TIME ZONE 'UTC') - interval '1 hour') AS older_1h,
                           ("receivedAt" < (now() AT TIME ZONE 'UTC') - interval '1 day') AS older_1d
                      FROM "public"."Event" WHERE "status" = 'VALIDATED' AND "id" = ANY($1::uuid[])`;
    const oldest = `SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - min("receivedAt")))::float8 AS age,
                           EXTRACT(EPOCH FROM (now() - min("receivedAt")))::float8 AS naive_age,
                           (EXTRACT(EPOCH FROM min("receivedAt")::timestamptz) - EXTRACT(EPOCH FROM (min("receivedAt") AT TIME ZONE 'UTC')))::float8 AS shift
                      FROM "public"."Event" WHERE "status" = 'VALIDATED' AND "id" = ANY($1::uuid[])`;
    const classified: Record<string, unknown[]> = {};
    for (const zone of ["UTC", NON_UTC_ZONE]) {
      const session = await workerSession(zone);
      try {
        const before = Date.now();
        const rows = (await session.query<{ id: string; age: number; older_1h: boolean; older_1d: boolean }>(perRow, [ids])).rows;
        const summary = (await session.query<{ age: number; naive_age: number; shift: number }>(oldest, [ids])).rows[0];
        const afterQuery = Date.now();
        assert.equal(rows.length, 4, zone);
        // Independent check: against the instants the test itself wrote (never the conversion under test).
        for (const entry of written) {
          const row = rows.find((r) => r.id === entry.id);
          assert.ok(row !== undefined);
          const low = (before - entry.instant) / 1000 - CLOCK_TOLERANCE_S;
          const high = (afterQuery - entry.instant) / 1000 + CLOCK_TOLERANCE_S;
          assert.ok(row.age >= low && row.age <= high, `${zone}: age ${row.age} within [${low}, ${high}]`);
          const ageS = (before - entry.instant) / 1000;
          assert.equal(row.older_1h, ageS > 3600, `${zone} older than 1 hour`);
          assert.equal(row.older_1d, ageS > 86_400, `${zone} older than 1 day`);
        }
        classified[zone] = rows.map((r) => ({ id: r.id, older_1h: r.older_1h, older_1d: r.older_1d })).sort((a, b) => (a.id < b.id ? -1 : 1));
        assert.ok(summary !== undefined);
        const oldestInstant = Math.min(...written.map((entry) => entry.instant));
        assert.ok(Math.abs(summary.age - (before - oldestInstant) / 1000) <= CLOCK_TOLERANCE_S + (afterQuery - before) / 1000, `${zone} oldest age`);
        // The naive form differs from the correct one by exactly the shift PostgreSQL reports for that stored value.
        assert.ok(Math.abs(summary.age - summary.naive_age - summary.shift) < 0.001, `${zone}: correct - naive = shift`);
        process.stdout.write(`[B1-1] ${zone}: oldest age ${summary.age.toFixed(3)} s; naive ${summary.naive_age.toFixed(3)} s; per-instant shift ${summary.shift} s\n`);
        if (zone === "UTC") {
          assert.equal(summary.shift, 0, "under UTC both forms agree");
        } else {
          assert.notEqual(summary.shift, 0, "control: a wrong zone shift is non-zero under the non-UTC session");
          assert.ok(Math.abs(summary.naive_age - (before - oldestInstant) / 1000) > CLOCK_TOLERANCE_S + 1, "control: the naive form is detected as shifted");
        }
      } finally {
        await session.end();
      }
    }
    assert.deepEqual(classified[NON_UTC_ZONE], classified.UTC, "classifications are unchanged from the UTC session");
  });

  it("index usability: EXPLAIN of the oldest-VALIDATED query, with enable_seqscan off, uses Event_status_receivedAt_idx", async () => {
    const session = await workerSession("UTC");
    try {
      await session.query("BEGIN");
      try {
        await session.query("SET LOCAL enable_seqscan = off");
        const plan = (await session.query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (FORMAT JSON) SELECT min("receivedAt") FROM "public"."Event" WHERE "status" = 'VALIDATED'`,
        )).rows[0]?.["QUERY PLAN"];
        const text = JSON.stringify(plan);
        const indexes = [...text.matchAll(/"Index Name":"([^"]+)"/g)].map((match) => match[1]);
        process.stdout.write(`[B1-1 index] indexes in the plan: ${JSON.stringify(indexes)}\n`);
        assert.ok(indexes.includes("Event_status_receivedAt_idx"));
      } finally {
        await session.query("ROLLBACK");
      }
    } finally {
      await session.end();
    }
  });
});

describe("B2-11 (PL-10): the audit insert under the worker role, with a non-UTC session", () => {
  const METADATA = { schema: 1, classification: "CONFIRMED_MISSING", observedJobState: "missing", redispatchCount: 1, thresholds: { T: 300, B: 3 } } as const;

  /** A stand-in of DR5 §3.1's repair request and its audit row, in one transaction; returns the rows updated. */
  async function repairRequest(db: Database, eventId: string, fail = false): Promise<{ updated: number; observed?: Record<string, unknown> }> {
    return db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TimeZone = '${NON_UTC_ZONE}'`);
      const tz = (await tx.$queryRawUnsafe<{ tz: string }[]>(`SELECT current_setting('TimeZone') AS tz`))[0]?.tz;
      assert.equal(tz, NON_UTC_ZONE, "the test transaction's session is non-UTC");
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `UPDATE "public"."Event" SET "redispatchRequestedAt" = now(), "redispatchCount" = "redispatchCount" + 1
          WHERE "id" = $1::uuid AND "status" = 'QUEUED' AND "dispatchAnomalyAt" IS NULL
            AND ("redispatchRequestedAt" IS NULL OR "redispatchRequestedAt" < now() - interval '300 seconds') AND "redispatchCount" < 3
          RETURNING ("redispatchRequestedAt" AT TIME ZONE 'UTC')::text AS requested_utc, now()::timestamp::text AS now_session,
                    EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - now()::timestamp))::float8 AS shift`,
        eventId,
      );
      if (rows.length === 1) {
        await insertDispatchAuditEntry(tx, { id: randomUUIDv7(), action: "EVENT_REDISPATCH_REQUESTED", eventId, metadata: METADATA });
      }
      if (fail) throw new Error("planted failure after the update and the insert");
      return { updated: rows.length, observed: rows[0] };
    });
  }

  async function auditRows(eventId: string): Promise<Record<string, unknown>[]> {
    return (
      await scratchAdmin.client.query(
        `SELECT a."id"::text AS id, a."actorType", a."actorId", a."action", a."entityType", a."entityId", a."metadata",
                a."createdAt"::text AS created_at, (a."createdAt" = (e."redispatchRequestedAt" AT TIME ZONE 'UTC')) AS created_equals_request
           FROM "public"."AuditEntry" a JOIN "public"."Event" e ON e."id"::text = a."entityId"
          WHERE a."entityId" = $1 ORDER BY a."createdAt"`,
        [eventId],
      )
    ).rows;
  }

  it("createdAt is the transaction's now() as UTC wall-clock time, whatever the session zone; the id is a UUIDv7; the actor is fixed", async () => {
    const eventId = await eventRow("QUEUED", `"queuedAt" = now() - interval '1 hour', "publishAckedAt" = now() - interval '1 hour'`);
    const db = await workerPool(false);
    try {
      const first = await repairRequest(db, eventId);
      assert.equal(first.updated, 1);
      const rows = await auditRows(eventId);
      assert.equal(rows.length, 1);
      const row = rows[0] ?? {};
      assert.deepEqual(
        { actorType: row.actorType, actorId: row.actorId, action: row.action, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata },
        { actorType: "SYSTEM", actorId: "irs-dispatcher", action: "EVENT_REDISPATCH_REQUESTED", entityType: "EVENT", entityId: eventId, metadata: METADATA },
      );
      assert.equal(row.created_equals_request, true, "createdAt equals that transaction's now() AT TIME ZONE 'UTC'");
      assert.match(String(row.id), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "version nibble 7, RFC 9562 variant");
      // Control: the session-zone value of the same instant differs from createdAt by PostgreSQL's shift for that instant.
      const shift = Number(first.observed?.shift);
      assert.notEqual(shift, 0, "the session is non-UTC");
      const diff = (
        await scratchAdmin.client.query<{ diff: number }>(
          `SELECT EXTRACT(EPOCH FROM ($1::timestamp - $2::timestamp))::float8 AS diff`,
          [row.created_at, first.observed?.now_session],
        )
      ).rows[0]?.diff;
      process.stdout.write(`[B2-11] createdAt minus the session-zone wall time: ${String(diff)} s; PostgreSQL's shift for that instant: ${shift} s\n`);
      assert.ok(Math.abs(Number(diff) - shift) < 0.001);
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("no duplicate on retry: the same transaction again finds the predicate false and writes no second row", async () => {
    const eventId = await eventRow("QUEUED", `"queuedAt" = now() - interval '1 hour', "publishAckedAt" = now() - interval '1 hour'`);
    const db = await workerPool(false);
    try {
      assert.equal((await repairRequest(db, eventId)).updated, 1);
      assert.equal((await repairRequest(db, eventId)).updated, 0);
      assert.equal((await auditRows(eventId)).length, 1);
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("no orphan after a rollback: the update and the insert, then ROLLBACK, leave no audit row and the Event unchanged", async () => {
    const eventId = await eventRow("QUEUED", `"queuedAt" = now() - interval '1 hour', "publishAckedAt" = now() - interval '1 hour'`);
    const db = await workerPool(false);
    try {
      await assert.rejects(repairRequest(db, eventId, true), /planted failure/);
      assert.equal((await auditRows(eventId)).length, 0);
      const event = (
        await scratchAdmin.client.query<{ redispatchCount: number; requested: boolean }>(
          `SELECT "redispatchCount", ("redispatchRequestedAt" IS NOT NULL) AS requested FROM "public"."Event" WHERE "id" = $1`,
          [eventId],
        )
      ).rows[0];
      assert.deepEqual(event, { redispatchCount: 0, requested: false });
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("INSERT-only: the same insert with RETURNING \"id\" is refused for the worker (42501)", async () => {
    const eventId = await eventRow("QUEUED");
    const session = await workerSession("UTC");
    try {
      const state = await session
        .query(`${DISPATCH_AUDIT_INSERT_SQL} RETURNING "id"`, [randomUUIDv7(), "SYSTEM", "irs-dispatcher", "EVENT_REDISPATCH_REQUESTED", eventId, JSON.stringify(METADATA)])
        .then(
          () => "ok",
          (error: unknown) => sqlState(error),
        );
      assert.equal(state, "42501");
    } finally {
      await session.end();
    }
  });
});
