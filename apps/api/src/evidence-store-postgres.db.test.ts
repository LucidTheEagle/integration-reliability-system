import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { disconnectWithin } from "@irs/db";
import type { Database, EvidenceStoreHooks, TransactionClient } from "@irs/db";
import type * as BaselineSupport from "../../../packages/db/dist/test-support/baseline.js";
import type * as DatabaseSupport from "../../../packages/db/dist/test-support/database.js";
import type * as GuardSupport from "../../../packages/db/dist/test-support/guard.js";
import type * as SyncRepSupport from "../../../packages/db/dist/test-support/syncrep-stall.js";
import { createDurableIngestionHandoff } from "./durable-ingestion.js";
import { buildRejectionRecord, freezeInstanceStarted, freezeUncleanGap } from "./evidence-records.js";
import type { FrozenEvidenceRecord, FrozenRejectionRecord, JsonValue } from "./evidence-records.js";
import { classifyRegistrationVerification, storeErrorOutcome } from "./evidence-store.js";
import type { DurableInstanceState, EvidenceRow, RegistrationAttempt, RejectionRow } from "./evidence-store.js";
import { runEvidenceStoreContract } from "./evidence-store-contract.js";
import { createPostgresEvidenceStore } from "./evidence-store-postgres.js";
import type { PostgresEvidenceStore } from "./evidence-store-postgres.js";
import { RecordingHandoff, SECRET_TEXT, envelopeJson, makeApp, validRequest } from "./test-helpers.js";

// Task 011A on PostgreSQL through the apps/api adapter (Stage 4):
// - the shared EvidenceStore contract (addendum RD-2), against the
//   PostgreSQL store, including A-T20's PostgreSQL half through the adapter;
// - the RD-3 cap tests (i) – (iii);
// - A-T22b (i) – (iv), U3 registration verification (AN4 E5a).
//
// Store calls run as irs_test_api (api mode). Admin mode (synchronous_commit
// = local pinned, FD-14): the baseline check; the contract fixture's
// out-of-protocol seeding, alteration and reads (irs_test_api has no UPDATE
// and the contract needs raw rows); the RD-8 stall and its verified revert;
// pg_stat_activity observation; backend termination; Integration seeding;
// clean-up. Every evidence row created here has a scope starting with
// PREFIX; every EVENT_REJECTED row carries one of `tags`; all are deleted in
// after().
//
// Tolerances (stated before running): each SyncRep wait or held transaction
// must be observed within 10 s, otherwise the case is not established and
// fails. Cap (i): with op 1 stalled and op 2 held, waiting = 1, inFlight = 2,
// highWaterMark = 2, and exactly 2 irs_test_api backends are inside a
// transaction; highWaterMark never exceeds 2. Cap (iii): inFlight stays 1 for
// at least 500 ms after the caller stops waiting, and reaches 0 only after
// pg_terminate_backend. No latency is asserted.

const TEST_SUPPORT = new URL("../../../packages/db/dist/test-support/", import.meta.url);

async function loadTestSupport<T>(file: string): Promise<T> {
  const url = new URL(file, TEST_SUPPORT);
  if (!existsSync(url)) {
    assert.fail(
      `@irs/db test support not built: ${fileURLToPath(url)} is missing; build it first (pnpm --filter @irs/db build)`,
    );
  }
  return (await import(url.href)) as T;
}

const { assertServerBaseline } = await loadTestSupport<typeof BaselineSupport>("baseline.js");
const { pinnedAdmin, revertCommitStall, stallCommits } = await loadTestSupport<typeof SyncRepSupport>("syncrep-stall.js");
const { guardedDatabase, latch, removeIntegrations, seedIntegration } = await loadTestSupport<typeof DatabaseSupport>("database.js");
const { requireTestUrl } = await loadTestSupport<typeof GuardSupport>("guard.js");

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const PREFIX = `pg-store-${randomUUID()}`;
const T0 = "2026-10-21T10:00:00.000Z";
const T1 = "2026-10-21T10:01:00.000Z";

let admin: GuardSupport.GuardedConnection;
let db: Database;
const tags: string[] = [];
const integrations: string[] = [];
const apps: FastifyInstance[] = [];
let scopes = 0;

function newScope(): string {
  scopes += 1;
  return `${PREFIX}-${scopes}`;
}

before(async () => {
  admin = await pinnedAdmin(adminUrl, "irs-test-pg-store-admin");
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
});

after(async () => {
  try {
    for (const app of apps) await app.close();
    await disconnectWithin(db, 5_000);
    await admin.client.query(`DELETE FROM "public"."RateLimitEvidence" WHERE left("scope", length($1)) = $1`, [PREFIX]);
    await admin.client.query(
      `DELETE FROM "public"."AuditEntry" WHERE "action" = 'EVENT_REJECTED' AND "metadata"->>'limiterInstanceId' = ANY($1::text[])`,
      [tags],
    );
    await removeIntegrations(admin.client, integrations);
    await assertServerBaseline(admin.client);
  } finally {
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// Admin-mode raw access for the contract fixture

const COLUMN_TYPES: Readonly<Record<keyof EvidenceRow, string>> = {
  id: "uuid",
  limiterInstanceId: "uuid",
  scope: "text",
  kind: "text",
  gapReason: "text",
  firstSequence: "int",
  lastSequence: "int",
  missingFrom: "int",
  missingTo: "int",
  payload: "jsonb",
  recordSha256: "text",
  recordedAt: "timestamptz",
};
const COLUMNS = Object.keys(COLUMN_TYPES) as (keyof EvidenceRow)[];

function parameter(column: keyof EvidenceRow, value: unknown): unknown {
  return column === "payload" ? JSON.stringify(value) : value;
}

/** Admin mode: out-of-protocol INSERT (the table's constraints apply). */
async function seedRaw(row: EvidenceRow): Promise<void> {
  const values = COLUMNS.map((column, index) => `$${index + 1}::${COLUMN_TYPES[column]}`);
  await admin.client.query(
    `INSERT INTO "public"."RateLimitEvidence" (${COLUMNS.map((c) => `"${c}"`).join(", ")}) VALUES (${values.join(", ")})`,
    COLUMNS.map((column) => parameter(column, row[column])),
  );
}

/** Admin mode: out-of-protocol UPDATE (the table's constraints apply). */
async function alterRaw(id: string, changes: Partial<Omit<EvidenceRow, "id">>): Promise<void> {
  const values = changes as Partial<EvidenceRow>;
  const columns = Object.keys(values) as (keyof EvidenceRow)[];
  const sets = columns.map((column, index) => `"${column}" = $${index + 2}::${COLUMN_TYPES[column]}`);
  const result = await admin.client.query(
    `UPDATE "public"."RateLimitEvidence" SET ${sets.join(", ")} WHERE "id" = $1::uuid`,
    [id, ...columns.map((column) => parameter(column, values[column]))],
  );
  assert.equal(result.rowCount, 1, "alterRaw: no such row");
}

/** Admin mode, observation: one instance's rows. */
async function readRaw(limiterInstanceId: string): Promise<EvidenceRow[]> {
  const rows = (
    await admin.client.query<EvidenceRow & { payload: string }>(
      `SELECT "id"::text AS "id", "limiterInstanceId"::text AS "limiterInstanceId", "scope", "kind", "gapReason",
              "firstSequence", "lastSequence", "missingFrom", "missingTo", "payload"::text AS "payload", "recordSha256",
              to_char("recordedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
         FROM "public"."RateLimitEvidence" WHERE "limiterInstanceId" = $1::uuid ORDER BY "id"`,
      [limiterInstanceId],
    )
  ).rows;
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as JsonValue }));
}

/** Admin mode, observation: one AuditEntry row. */
async function readRejection(id: string): Promise<RejectionRow | null> {
  const row = (
    await admin.client.query<RejectionRow & { metadata: string | null }>(
      `SELECT "id"::text AS "id", "actorType", "actorId", "action", "entityType", "entityId", "metadata"::text AS "metadata",
              to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
         FROM "public"."AuditEntry" WHERE "id" = $1::uuid`,
      [id],
    )
  ).rows[0];
  return row === undefined ? null : { ...row, metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as JsonValue) };
}

/** The violated constraint carried by a driver-adapter error (test-only extraction). */
function constraintOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const value = queue.shift();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.constraint === "string") return record.constraint;
    for (const key of ["originalMessage", "message"]) {
      const text = record[key];
      const match = typeof text === "string" ? /check constraint "([^"]+)"/.exec(text) : null;
      if (match?.[1] !== undefined) return match[1];
    }
    queue.push(record.cause, record.meta, record.driverAdapterError);
  }
  return undefined;
}

runEvidenceStoreContract("PostgreSQL store (adapter)", async () => {
  const scope = newScope();
  const tag = randomUUID();
  tags.push(tag);
  return {
    store: createPostgresEvidenceStore({ db }),
    scope,
    otherScope: `${scope}-other`,
    rejectionTag: tag,
    now: () => db.monotonicNow(),
    seedRaw,
    alterRaw,
    readRaw,
    readRejection,
    constraintOf,
    cleanup: async () => undefined,
  };
});

// ---------------------------------------------------------------------------
// Shared pieces for the cap and A-T22b tests

function started(scope: string, instance: string): FrozenEvidenceRecord {
  return freezeInstanceStarted({
    id: randomUUID(),
    limiterInstanceId: instance,
    scope,
    recordedAt: T0,
    instanceStartedAt: T0,
    rateLimitPolicies: {},
    auditPolicies: {},
  });
}

function rejection(): FrozenRejectionRecord {
  const id = randomUUID();
  const tag = randomUUID();
  tags.push(tag);
  return buildRejectionRecord({
    id,
    actorType: "EXTERNAL_SENDER",
    actorId: null,
    action: "EVENT_REJECTED",
    entityType: "WEBHOOK_DELIVERY",
    entityId: id,
    metadata: {
      schemaVersion: 1,
      limiterInstanceId: tag,
      stage: "VERIFIER",
      httpStatus: 401,
      errorCode: "UNAUTHORIZED",
      claimedIntegrationId: null,
      verifierReason: null,
      responseCompletion: "FINISH_OBSERVED",
      receivedAt: T0,
    },
    createdAt: T1,
  });
}

function gapFrom(scope: string, state: DurableInstanceState): FrozenEvidenceRecord {
  return freezeUncleanGap({
    id: randomUUID(),
    limiterInstanceId: state.limiterInstanceId,
    scope,
    recordedAt: T1,
    lastDurableSequence: state.lastDurableSequence,
    cumulativeAsOfLastDurable:
      state.cumulativeAsOfLastDurable === null || state.auditCumulativeAsOfLastDurable === null
        ? null
        : { rateLimit: state.cumulativeAsOfLastDurable, audit: state.auditCumulativeAsOfLastDurable },
    detectedAt: T1,
    detectedByInstanceId: randomUUID(),
  });
}

async function waitFor<T>(observe: () => Promise<T | undefined>, what: string): Promise<T> {
  const until = performance.now() + 10_000;
  for (;;) {
    const seen = await observe();
    if (seen !== undefined) return seen;
    if (performance.now() > until) assert.fail(`not established: ${what} not observed within 10 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Admin mode, observation: the irs_test_api backend waiting on SyncRep. */
function syncRepWaiter(): Promise<number> {
  return waitFor(async () => {
    const rows = (
      await admin.client.query<{ pid: number }>(
        `SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename = 'irs_test_api' AND datname = current_database() AND wait_event = 'SyncRep'`,
      )
    ).rows;
    return rows[0]?.pid;
  }, "a COMMIT waiting on SyncRep");
}

/** Admin mode, observation: irs_test_api backends inside a transaction. */
async function backendsInTransaction(): Promise<number> {
  const rows = (
    await admin.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
        WHERE usename = 'irs_test_api' AND datname = current_database() AND xact_start IS NOT NULL`,
    )
  ).rows;
  return rows[0]?.n ?? Number.NaN;
}

async function turns(count = 5): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

type Mode = "STALL" | "HOLD" | "PLAIN";

/**
 * Hooks assigning a mode to each transaction in the order its work starts.
 * STALL: SET LOCAL synchronous_commit = on as the work's first statement (RD-8).
 * HOLD: the work waits after completing, before COMMIT, until released.
 */
function modeHooks(modes: Mode[]): {
  readonly hooks: EvidenceStoreHooks;
  readonly held: Promise<void>;
  readonly pids: Promise<number>[];
  release(): void;
} {
  const modeOf = new WeakMap<object, Mode>();
  const reached = latch();
  const gate = latch();
  const pidLatches: { resolve: (pid: number) => void }[] = [];
  const pids = modes.map(
    () =>
      new Promise<number>((resolve) => {
        pidLatches.push({ resolve });
      }),
  );
  let started = 0;
  return {
    hooks: {
      beforeWork: async (tx: TransactionClient) => {
        const index = started;
        started += 1;
        const mode = modes[index] ?? "PLAIN";
        modeOf.set(tx, mode);
        const pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS "pid"`)[0]?.pid;
        if (pid !== undefined) pidLatches[index]?.resolve(pid);
        if (mode === "STALL") await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
      },
      afterWork: async (tx: TransactionClient) => {
        if (modeOf.get(tx) !== "HOLD") return;
        reached.release();
        await gate.wait;
      },
    },
    held: reached.wait,
    pids,
    release: gate.release,
  };
}

/** Runs `body` with the RD-8 stall active; the revert is verified in finally. */
async function withStall(label: string, body: () => Promise<void>): Promise<void> {
  let stallStarted = false;
  try {
    await stallCommits(adminUrl, admin.client, label);
    stallStarted = true;
    await body();
  } finally {
    if (stallStarted) await revertCommitStall(adminUrl, label);
  }
}

function settle<T>(promise: Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// ---------------------------------------------------------------------------

describe("RD-3 connection cap on PostgreSQL (cap tests (i) – (iii))", () => {
  it("(i) one stalled write, one held, a third queued: waiting 1, inFlight 2, highWaterMark 2, two backends in a transaction", async () => {
    const scope = newScope();
    const capDb = await guardedDatabase({ url: apiUrl, mode: "api" });
    const control = modeHooks(["STALL", "HOLD", "PLAIN"]);
    const store: PostgresEvidenceStore = createPostgresEvidenceStore({ db: capDb, hooks: control.hooks });
    try {
      await withStall("cap (i)", async () => {
        const op1 = settle(store.writeEvidenceGroup([started(scope, randomUUID())]));
        const stalledPid = await syncRepWaiter();
        const op2 = settle(store.writeEvidenceGroup([started(scope, randomUUID())]));
        await control.held;
        const op3 = settle(store.writeEvidenceGroup([started(scope, randomUUID())]));
        await turns();
        assert.deepEqual([store.waiting, store.inFlight, store.highWaterMark], [1, 2, 2]);
        assert.equal(await backendsInTransaction(), 2, "the third operation waits at the limiter, not in the pool");
        process.stdout.write(
          `[cap (i)] waiting ${store.waiting}, inFlight ${store.inFlight}, highWaterMark ${store.highWaterMark}; ` +
            `irs_test_api backends in a transaction: 2\n`,
        );
        control.release();
        const [second, third] = await Promise.all([op2, op3]);
        assert.deepEqual([second.ok && second.value, third.ok && third.value], [["CREATED"], ["CREATED"]]);
        assert.deepEqual([store.waiting, store.inFlight, store.highWaterMark], [0, 1, 2]);
        await admin.client.query("SELECT pg_terminate_backend($1)", [stalledPid]);
        const first = await op1;
        assert.equal(first.ok, false);
        assert.equal(storeErrorOutcome(first.ok ? undefined : first.error), "UNKNOWN");
        assert.deepEqual([store.waiting, store.inFlight, store.highWaterMark], [0, 0, 2]);
      });
    } finally {
      control.release();
      await disconnectWithin(capDb, 5_000);
    }
  });

  it("(ii) during the stall, an ingestion request through Task 011's real handoff on the same Database commits (202)", async () => {
    const scope = newScope();
    const capDb = await guardedDatabase({ url: apiUrl, mode: "api" });
    const control = modeHooks(["STALL"]);
    const store = createPostgresEvidenceStore({ db: capDb, hooks: control.hooks });
    const integrationId = await seedIntegration(admin.client, "ACTIVE");
    integrations.push(integrationId);
    try {
      await withStall("cap (ii)", async () => {
        const op1 = settle(store.writeEvidenceGroup([started(scope, randomUUID())]));
        const stalledPid = await syncRepWaiter();
        assert.equal(store.inFlight, 1);
        const durable = createDurableIngestionHandoff({ db: capDb });
        const t = makeApp({
          handoff: new RecordingHandoff((request) => durable.accept(request)),
          secrets: { [integrationId]: SECRET_TEXT },
        });
        apps.push(t.app);
        const request = validRequest(envelopeJson({ externalEventId: `cap-ii-${randomUUID()}` }));
        const response = await t.app.inject({
          method: "POST",
          url: `/api/webhooks/${integrationId}`,
          headers: request.headers,
          payload: request.body,
        });
        assert.equal(response.statusCode, 202);
        const events = await admin.client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "public"."Event" WHERE "integrationId" = $1::uuid`,
          [integrationId],
        );
        assert.equal(events.rows[0]?.n, 1);
        assert.equal(store.inFlight, 1, "the stalled evidence write still holds its slot");
        await admin.client.query("SELECT pg_terminate_backend($1)", [stalledPid]);
        await op1;
      });
    } finally {
      await disconnectWithin(capDb, 5_000);
    }
  });

  it("(iii) a caller that abandons a stalled write leaves inFlight unchanged until the write settles after pg_terminate_backend", async () => {
    const capDb = await guardedDatabase({ url: apiUrl, mode: "api" });
    const control = modeHooks(["STALL"]);
    const store = createPostgresEvidenceStore({ db: capDb, hooks: control.hooks });
    try {
      await withStall("cap (iii)", async () => {
        const write = store.writeRejections([rejection()]);
        const stalledPid = await syncRepWaiter();
        // A D3-style race: the caller stops waiting.
        const raced = await Promise.race([
          write.then(
            () => "settled",
            () => "settled",
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve("abandoned"), 100)),
        ]);
        assert.equal(raced, "abandoned");
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(store.inFlight, 1, "the abandoned write keeps its slot");
        await admin.client.query("SELECT pg_terminate_backend($1)", [stalledPid]);
        const outcome = await settle(write);
        assert.equal(storeErrorOutcome(outcome.ok ? undefined : outcome.error), "UNKNOWN");
        assert.equal(store.inFlight, 0);
      });
    } finally {
      await disconnectWithin(capDb, 5_000);
    }
  });
});

describe("A-T22b: U3 registration verification on PostgreSQL (AN4 E5a)", () => {
  /** Admin mode, observation: the instance's row count. */
  async function rowCount(instance: string): Promise<number> {
    return (await readRaw(instance)).length;
  }

  async function verify(store: PostgresEvidenceStore, instance: string): Promise<{ ok: true; present: boolean } | { ok: false }> {
    const read = await settle(store.verifyRegistration(instance, db.monotonicNow() + 1_000));
    return read.ok ? { ok: true, present: read.value.present } : { ok: false };
  }

  it("(i) registration holds the lock with its COMMIT delayed: verification times out → STILL_UNKNOWN; the next startup's Case A records the gap", async () => {
    const scope = newScope();
    const instance = randomUUID();
    const control = modeHooks(["HOLD"]);
    const registrationStore = createPostgresEvidenceStore({ db, hooks: control.hooks });
    const verifier = createPostgresEvidenceStore({ db });
    const registration = settle(registrationStore.writeEvidenceGroup([started(scope, instance)]));
    await control.held;
    const read = await settle(verifier.verifyRegistration(instance, db.monotonicNow() + 1_000));
    assert.equal(read.ok, false);
    const error = (read as { error: { name?: unknown; outcome?: unknown } }).error;
    assert.deepEqual([error.name, error.outcome], ["AdvisoryLockTimeoutError", "NOT_COMMITTED"]);
    const attempts: RegistrationAttempt[] = [{ outcome: "UNKNOWN" }];
    assert.deepEqual(
      classifyRegistrationVerification({ attempts, recorderAndConsumerStarted: false }, { ok: false }),
      { kind: "STILL_UNKNOWN" },
    );
    control.release();
    const committed = await registration;
    assert.deepEqual(committed.ok && committed.value, ["CREATED"]);
    // The next startup (store-level Case A; the consumer is Stage 5).
    const next = createPostgresEvidenceStore({ db });
    assert.deepEqual(await next.findRecoveryCandidates(scope, randomUUID()), [{ limiterInstanceId: instance, hasUncleanGap: false }]);
    const state = await next.readDurableState(instance);
    assert.equal(await next.writeUncleanGap(gapFrom(scope, state), state), "CREATED");
  });

  it("(ii) RD-8: the registration COMMIT is durable but unacknowledged (UNKNOWN) → CONFIRMED_PRESENT; verification writes nothing", async () => {
    const scope = newScope();
    const instance = randomUUID();
    const stalledDb = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    const control = modeHooks(["STALL"]);
    const registrationStore = createPostgresEvidenceStore({ db: stalledDb, hooks: control.hooks });
    try {
      await withStall("A-T22b(ii)", async () => {
        const registration = settle(registrationStore.writeEvidenceGroup([started(scope, instance)]));
        const pid = await syncRepWaiter();
        await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
        const outcome = await registration;
        const attempts: RegistrationAttempt[] = [{ outcome: storeErrorOutcome(outcome.ok ? undefined : outcome.error) }];
        assert.deepEqual(attempts, [{ outcome: "UNKNOWN" }]);
        const before = await rowCount(instance);
        assert.equal(before, 1, "the COMMIT was durable");
        const read = await verify(createPostgresEvidenceStore({ db }), instance);
        assert.deepEqual(read, { ok: true, present: true });
        assert.deepEqual(classifyRegistrationVerification({ attempts, recorderAndConsumerStarted: false }, read), {
          kind: "CONFIRMED_PRESENT",
          recorderAndConsumerStarted: false,
        });
        assert.equal(await rowCount(instance), before);
      });
    } finally {
      await disconnectWithin(stalledDb, 5_000);
    }
  });

  it("(iii) every attempt NOT_COMMITTED and no row → CONFIRMED_ABSENT", async () => {
    const scope = newScope();
    const instance = randomUUID();
    const failing = createPostgresEvidenceStore({
      db,
      hooks: {
        afterWork: async () => {
          throw new Error("injected failure before COMMIT");
        },
      },
    });
    const attempts: RegistrationAttempt[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await settle(failing.writeEvidenceGroup([started(scope, instance)]));
      attempts.push({ outcome: outcome.ok ? "CONFIRMED" : storeErrorOutcome(outcome.error) });
    }
    assert.deepEqual(attempts, [{ outcome: "NOT_COMMITTED" }, { outcome: "NOT_COMMITTED" }]);
    const read = await verify(createPostgresEvidenceStore({ db }), instance);
    assert.deepEqual(read, { ok: true, present: false });
    assert.deepEqual(classifyRegistrationVerification({ attempts, recorderAndConsumerStarted: false }, read), {
      kind: "CONFIRMED_ABSENT",
    });
    assert.equal(await rowCount(instance), 0);
  });

  it("(iv) an UNKNOWN attempt whose backend was terminated before COMMIT, and no row → STILL_UNKNOWN, never CONFIRMED_ABSENT", async () => {
    const scope = newScope();
    const instance = randomUUID();
    const control = modeHooks(["HOLD"]);
    const registrationStore = createPostgresEvidenceStore({ db, hooks: control.hooks });
    const registration = settle(registrationStore.writeEvidenceGroup([started(scope, instance)]));
    await control.held;
    const pid = await (control.pids[0] as Promise<number>);
    await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
    control.release();
    const outcome = await registration;
    const attempts: RegistrationAttempt[] = [{ outcome: outcome.ok ? "CONFIRMED" : storeErrorOutcome(outcome.error) }];
    process.stdout.write(
      `[A-T22b(iv)] the terminated attempt ended ${JSON.stringify({
        phase: outcome.ok ? null : (outcome.error as { phase?: unknown }).phase ?? null,
        outcome: attempts[0]?.outcome,
      })}\n`,
    );
    assert.deepEqual(attempts, [{ outcome: "UNKNOWN" }]);
    assert.equal(await rowCount(instance), 0, "the transaction was terminated before COMMIT");
    const read = await verify(createPostgresEvidenceStore({ db }), instance);
    assert.deepEqual(read, { ok: true, present: false });
    assert.deepEqual(classifyRegistrationVerification({ attempts, recorderAndConsumerStarted: false }, read), {
      kind: "STILL_UNKNOWN",
    });
  });
});
