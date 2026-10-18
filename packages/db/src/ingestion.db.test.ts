import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "./client.js";
import { IngestionCommitUnknownError, classifyDatabaseError, sqlStateOf } from "./errors.js";
import { ingestEvent, sha256Hex, toAuditRow, toEventRow } from "./event-ingestion.js";
import { assertServerBaseline } from "./test-support/baseline.js";
import {
  countRows,
  guardedDatabase,
  ingestionInput,
  latch,
  removeIntegrations,
  seedIntegration,
} from "./test-support/database.js";
import type { ConfigStatus } from "./test-support/database.js";
import { connectGuarded, requireTestUrl } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { readServerLog, settleLog, statementsOf } from "./test-support/server-log.js";

// Durable ingestion against PostgreSQL (Rev 1.7 §16.1). Ingestion runs as
// irs_test_api (api mode) through the production createDatabase path.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");

// Admin mode: baseline observation, seeding, cleanup and row observation.
let admin: GuardedConnection;
let db: Database;
const seeded: string[] = [];

async function seed(status: ConfigStatus = "ACTIVE"): Promise<string> {
  const id = await seedIntegration(admin.client, status);
  seeded.push(id);
  return id;
}

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-ingestion-admin" });
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
});

after(async () => {
  await db.prisma.$disconnect();
  await removeIntegrations(admin.client, seeded);
  await assertServerBaseline(admin.client);
  await admin.close();
});

/**
 * Admin mode: reads the stored Event row in full (observation). The timestamp
 * columns are timestamp(3) without time zone holding UTC wall-clock time (how
 * Prisma stores DateTime), so they are read as UTC text, never through the
 * host time zone.
 */
async function storedEvent(integrationId: string, externalEventId: string) {
  const result = await admin.client.query<Record<string, unknown>>(
    `SELECT "id", "integrationId", "externalEventId", "eventType", "resourceType", "resourceId", "payload", "metadata",
            to_char("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt", to_char("receivedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt", "status", "schemaVersion", "correlationId", "rawBody", "rawBodySha256"
       FROM "public"."Event" WHERE "integrationId" = $1 AND "externalEventId" = $2`,
    [integrationId, externalEventId],
  );
  return result.rows;
}

/** Admin mode: the audit rows for one integration (observation). */
async function audits(integrationId: string) {
  return (
    await admin.client.query<Record<string, unknown>>(
      `SELECT "id", "actorType", "actorId", "action", "entityType", "entityId", "metadata", to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
         FROM "public"."AuditEntry" WHERE "metadata"->>'integrationId' = $1::text ORDER BY "createdAt", "id"`,
      [integrationId],
    )
  ).rows;
}

describe("DB-T1 / V2: SQL capture through the production client (Case Q)", () => {
  it("the status check is the transaction's first statement; every application table is schema-qualified", async () => {
    const integrationId = await seed();
    const captureDb = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    try {
      const pid = (await captureDb.prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid;
      assert.equal(typeof pid, "number");
      const since = new Date(Date.now() - 2_000);
      const externalEventId = `capture-${randomUUID()}`;
      const draft = await seed("DRAFT");
      assert.equal((await ingestEvent(captureDb, ingestionInput(integrationId, externalEventId))).disposition, "NEW");
      assert.equal((await ingestEvent(captureDb, ingestionInput(integrationId, externalEventId))).disposition, "DUPLICATE");
      assert.equal(
        (await ingestEvent(captureDb, ingestionInput(draft, `capture-${randomUUID()}`))).disposition,
        "INTEGRATION_INELIGIBLE",
      );
      await settleLog();
      const statements = statementsOf(await readServerLog(since), pid ?? -1);
      const transactions: string[][] = [];
      for (const sql of statements) {
        if (sql === "BEGIN") transactions.push([]);
        else transactions[transactions.length - 1]?.push(sql);
      }
      process.stdout.write(`[DB-T1] captured ${transactions.length} transactions on pid ${pid}:\n`);
      for (const transaction of transactions) process.stdout.write(`  ${JSON.stringify(transaction)}\n`);
      assert.equal(transactions.length, 3);
      for (const transaction of transactions) {
        assert.equal(transaction[0], "SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        assert.equal(transaction[1], `SELECT "public"."irs_integration_config_status_for_share"($1) AS "configStatus"`);
        assert.equal(transaction[transaction.length - 1], "COMMIT");
      }
      const [newTx, duplicateTx, draftTx] = transactions;
      assert.match(newTx?.[2] ?? "", /^INSERT INTO "public"\."Event" \(.*\) ON CONFLICT DO NOTHING RETURNING "public"\."Event"\."id"$/s);
      assert.match(newTx?.[3] ?? "", /^INSERT INTO "public"\."AuditEntry" /);
      assert.doesNotMatch(newTx?.[3] ?? "", /RETURNING/);
      assert.match(duplicateTx?.[3] ?? "", /^SELECT "public"\."Event"\."id", "public"\."Event"\."rawBodySha256" FROM "public"\."Event" WHERE/);
      assert.equal(draftTx?.length, 3, "an ineligible integration ends the transaction with no writes");
      for (const sql of statements) {
        for (const table of ["Event", "AuditEntry", "Integration"]) {
          const unqualified = new RegExp(`(?<!"public"\\.)"${table}"(?!\\.)`).exec(sql.replace(/"public"\."[A-Za-z]+"\."[A-Za-z0-9]+"/g, ""));
          assert.equal(unqualified, null, `unqualified "${table}" in: ${sql}`);
        }
      }
    } finally {
      await captureDb.prisma.$disconnect();
    }
  });
});

describe("DB-T2 – DB-T8: ingestion semantics", () => {
  it("DB-T2: a new event stores every §7.2 column, byte-identical raw body, digest and one EVENT_RECEIVED(NEW)", async () => {
    const integrationId = await seed();
    const rawText = '{ "externalEventId":"t2","b" : [1,2.50,"é—𝄞"],"a":{}}   ';
    const input = ingestionInput(integrationId, "t2", { rawText, payload: { b: [1, 2.5, "é—𝄞"], a: {} } });
    const result = await ingestEvent(db, input);
    assert.equal(result.disposition, "NEW");
    const rows = await storedEvent(integrationId, "t2");
    assert.equal(rows.length, 1);
    const row = rows[0] ?? {};
    assert.equal(row.id, result.disposition === "NEW" ? result.eventId : undefined);
    assert.equal(String(row.id).charAt(14), "7", "uuid(7) generated client-side");
    assert.deepEqual(Buffer.from(row.rawBody as Buffer), Buffer.from(input.rawBody));
    assert.equal(row.rawBodySha256, sha256Hex(input.rawBody));
    assert.equal(row.status, "VALIDATED");
    assert.deepEqual(row.payload, { b: [1, 2.5, "é—𝄞"], a: {} });
    assert.deepEqual(row.metadata, {
      schemaVersion: 1,
      requestId: input.requestId,
      contentType: "application/json",
      bodyByteLength: input.rawBody.byteLength,
    });
    assert.equal(row.receivedAt, input.receivedAt.toISOString());
    assert.equal(row.occurredAt, "2026-10-17T00:00:00.000Z");
    for (const key of ["eventType", "resourceType", "resourceId", "schemaVersion"] as const) {
      assert.equal(row[key], input[key]);
    }
    assert.equal(row.correlationId, null);
    const audit = await audits(integrationId);
    assert.equal(audit.length, 1);
    const expected = toAuditRow(input, String(row.id), "NEW", null, sha256Hex(input.rawBody));
    assert.deepEqual(audit[0], { ...expected, createdAt: input.receivedAt.toISOString() });
  });

  it("DB-T3: a throw after the Event insert rolls back: no Event, no AuditEntry", async () => {
    const integrationId = await seed();
    const input = ingestionInput(integrationId, "t3");
    await assert.rejects(
      db.prisma.$transaction(async (tx) => {
        await tx.event.createManyAndReturn({ data: [toEventRow(input, sha256Hex(input.rawBody))], skipDuplicates: true, select: { id: true } });
        throw new Error("thrown after the insert");
      }),
      /thrown after the insert/,
    );
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
  });

  it("DB-T4: a failed statement aborts the transaction; nothing commits; the failure is classified", async () => {
    const integrationId = await seed();
    const input = ingestionInput(integrationId, "t4");
    const failure = await db.prisma
      .$transaction(async (tx) => {
        await tx.event.createManyAndReturn({ data: [toEventRow(input, sha256Hex(input.rawBody))], skipDuplicates: true, select: { id: true } });
        try {
          await tx.$executeRaw`SELECT 1 / 0`;
        } catch {
          // Swallowing the error does not rescue the transaction.
        }
        await tx.auditEntry.createMany({ data: [toAuditRow(input, randomUUID(), "NEW", null, "0".repeat(64))] });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(failure !== undefined, "the transaction must fail");
    process.stdout.write(`[DB-T4] failure SQLSTATE ${String(sqlStateOf(failure))}; ${JSON.stringify(classifyDatabaseError(failure))}\n`);
    assert.equal(sqlStateOf(failure), "25P02");
    assert.equal(classifyDatabaseError(failure).failureClass, "FAULT");
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
  });

  it("DB-T5: a sequential duplicate returns DUPLICATE with the existing id; one Event, two audit rows", async () => {
    const integrationId = await seed();
    const first = await ingestEvent(db, ingestionInput(integrationId, "t5"));
    const second = await ingestEvent(db, ingestionInput(integrationId, "t5"));
    assert.equal(first.disposition, "NEW");
    assert.deepEqual(second, { disposition: "DUPLICATE", eventId: first.disposition === "NEW" ? first.eventId : "", contentMatches: true });
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 1, audits: 2 });
  });

  it("DB-T6: 20 parallel deliveries of one key → 1 NEW, 19 DUPLICATE, one Event, 20 audit rows; ×50", async () => {
    const integrationId = await seed();
    // A pool of 20 lets all 20 deliveries contend at the database at once, so the test exercises
    // the unique-index arbitration rather than queueing for the pool (whose limits are DB-T13/V8).
    const wide = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 20 } });
    try {
      for (let round = 0; round < 50; round += 1) {
        const key = `t6-${round}`;
        const results = await Promise.all(Array.from({ length: 20 }, () => ingestEvent(wide, ingestionInput(integrationId, key))));
        const dispositions = results.map((result) => result.disposition);
        assert.equal(dispositions.filter((value) => value === "NEW").length, 1, `round ${round}`);
        assert.equal(dispositions.filter((value) => value === "DUPLICATE").length, 19, `round ${round}`);
        const ids = new Set(results.map((result) => ("eventId" in result ? result.eventId : "")));
        assert.equal(ids.size, 1);
      }
    } finally {
      await wide.prisma.$disconnect();
    }
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 50, audits: 1_000 });
  });

  it("DB-T6 variant: when the first inserter rolls back, the waiting delivery inserts (NEW)", async () => {
    const integrationId = await seed();
    const input = ingestionInput(integrationId, "t6-rollback");
    const inserted = latch();
    const release = latch();
    const first = db.prisma
      .$transaction(async (tx) => {
        await tx.event.createManyAndReturn({ data: [toEventRow(input, sha256Hex(input.rawBody))], skipDuplicates: true, select: { id: true } });
        inserted.release();
        await release.wait;
        throw new Error("first inserter rolls back");
      }, { timeout: 20_000 })
      .catch((error: unknown) => error);
    await inserted.wait;
    const waiter = ingestEvent(db, ingestionInput(integrationId, "t6-rollback"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release.release();
    assert.match(String(await first), /first inserter rolls back/);
    assert.equal((await waiter).disposition, "NEW");
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 1, audits: 1 });
  });

  it("DB-T7: the same externalEventId under two integrations creates two events, both NEW", async () => {
    const a = await seed();
    const b = await seed();
    assert.equal((await ingestEvent(db, ingestionInput(a, "t7"))).disposition, "NEW");
    assert.equal((await ingestEvent(db, ingestionInput(b, "t7"))).disposition, "NEW");
    assert.equal((await countRows(admin.client, a)).events, 1);
    assert.equal((await countRows(admin.client, b)).events, 1);
  });

  it("DB-T8: a duplicate with different bytes → contentMatches false; the stored row is unchanged", async () => {
    const integrationId = await seed();
    await ingestEvent(db, ingestionInput(integrationId, "t8", { rawText: '{"v":1}', payload: { v: 1 } }));
    const before = await storedEvent(integrationId, "t8");
    const result = await ingestEvent(db, ingestionInput(integrationId, "t8", { rawText: '{"v":2}', payload: { v: 2 } }));
    assert.equal(result.disposition, "DUPLICATE");
    assert.equal(result.disposition === "DUPLICATE" ? result.contentMatches : undefined, false);
    assert.deepEqual(await storedEvent(integrationId, "t8"), before);
    const metadata = (await audits(integrationId)).map((row) => row.metadata as Record<string, unknown>);
    assert.deepEqual(metadata.map((m) => m.disposition).sort(), ["DUPLICATE", "NEW"]);
    assert.deepEqual(metadata.find((m) => m.disposition === "DUPLICATE")?.contentMatches, false);
  });
});

describe("DB-T9 / DB-T16(c): payload conditions reaching PostgreSQL", () => {
  it("DB-T9: P1 (U+0000) and P2 (unpaired surrogate) in jsonb are rejected by PostgreSQL when not pre-validated → FAULT, no rows", async () => {
    const integrationId = await seed();
    for (const [label, value] of [
      ["P1 U+0000", "a\u0000b"],
      ["P2 lone high surrogate", "a\uD800b"],
      ["P2 lone low surrogate", "a\uDC00b"],
    ] as const) {
      const failure = await ingestEvent(db, ingestionInput(integrationId, `t9-${label}`, { payload: { text: value } })).then(
        () => undefined,
        (error: unknown) => error,
      );
      process.stdout.write(
        `[DB-T9] payload ${label}: ${failure === undefined ? "STORED (unexpected)" : `${(failure as Error).name}, SQLSTATE ${String(sqlStateOf(failure))}, ${JSON.stringify(classifyDatabaseError(failure))}`}\n`,
      );
      assert.ok(failure !== undefined, `${label} must be rejected`);
      assert.equal(classifyDatabaseError(failure).failureClass, "FAULT");
    }
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
  });

  it("DB-T9: in a text column, U+0000 is rejected; a lone surrogate's fate is recorded", async () => {
    const integrationId = await seed();
    const nul = await ingestEvent(db, ingestionInput(integrationId, "t9-text-\u0000")).then(
      () => undefined,
      (error: unknown) => error,
    );
    process.stdout.write(`[DB-T9] text U+0000: ${nul === undefined ? "STORED" : `SQLSTATE ${String(sqlStateOf(nul))}, ${(nul as Error).name}`}\n`);
    assert.ok(nul !== undefined);
    const surrogate = await ingestEvent(db, ingestionInput(integrationId, "t9-text-\uD800")).then(
      (result) => result,
      (error: unknown) => error,
    );
    const stored = await admin.client.query<{ hex: string }>(
      `SELECT encode(convert_to("externalEventId", 'UTF8'), 'hex') AS hex FROM "public"."Event" WHERE "integrationId" = $1`,
      [integrationId],
    );
    process.stdout.write(
      `[DB-T9] text lone surrogate: ${surrogate instanceof Error ? `rejected, SQLSTATE ${String(sqlStateOf(surrogate))}` : `stored as hex ${JSON.stringify(stored.rows.map((r) => r.hex))}`}\n`,
    );
  });

  it("DB-T16(c): a payload number 1e400 parses to Infinity; what is persisted is recorded; rawBody keeps the original bytes", async () => {
    const integrationId = await seed();
    const rawText = '{"n":1e400}';
    const payload = JSON.parse(rawText) as Record<string, unknown>;
    assert.equal(payload.n, Number.POSITIVE_INFINITY);
    const outcome = await ingestEvent(db, ingestionInput(integrationId, "t16c", { rawText, payload })).then(
      (result) => result,
      (error: unknown) => error,
    );
    if (outcome instanceof Error) {
      process.stdout.write(`[DB-T16c] threw ${outcome.name}; ${JSON.stringify(classifyDatabaseError(outcome))}\n`);
      assert.equal(classifyDatabaseError(outcome).failureClass, "FAULT");
    } else {
      const row = (await storedEvent(integrationId, "t16c"))[0] ?? {};
      process.stdout.write(`[DB-T16c] stored payload ${JSON.stringify(row.payload)}; rawBody ${Buffer.from(row.rawBody as Buffer).toString("utf8")}\n`);
      assert.equal(Buffer.from(row.rawBody as Buffer).toString("utf8"), rawText);
    }
  });
});

describe("DB-T11: commit-unknown", () => {
  function failingCommit(base: Database, commitFirst: boolean): Database {
    const prisma = new Proxy(base.prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver) as unknown;
        return async (callback: (tx: unknown) => Promise<unknown>, options: unknown) => {
          if (commitFirst) {
            await target.$transaction(callback as never, options as never);
          } else {
            await target
              .$transaction(async (tx) => {
                await callback(tx);
                throw new Error("rolled back before the commit");
              }, options as never)
              .catch(() => undefined);
          }
          throw new Error("commit acknowledgement lost");
        };
      },
    });
    return { ...base, prisma };
  }

  it("a failure after the callback completed → IngestionCommitUnknownError (COMMIT_UNKNOWN), whether or not it committed", async () => {
    const integrationId = await seed();
    for (const commitFirst of [false, true]) {
      const failure = await ingestEvent(failingCommit(db, commitFirst), ingestionInput(integrationId, `t11-${String(commitFirst)}`)).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof IngestionCommitUnknownError);
      assert.equal(classifyDatabaseError(failure).code, "COMMIT_UNKNOWN");
    }
    assert.equal((await countRows(admin.client, integrationId)).events, 1, "only the committed run left a row");
  });

  it("a run that committed and then reported failure resolves as DUPLICATE on retry", async () => {
    const integrationId = await seed();
    await assert.rejects(ingestEvent(failingCommit(db, true), ingestionInput(integrationId, "t11-retry")), IngestionCommitUnknownError);
    const retry = await ingestEvent(db, ingestionInput(integrationId, "t11-retry"));
    assert.equal(retry.disposition, "DUPLICATE");
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 1, audits: 2 });
  });
});

describe("DB-T12 / DB-T17: integration eligibility", () => {
  it("DB-T12: no Integration row → INTEGRATION_INELIGIBLE (NOT_REGISTERED), no rows, no FK error", async () => {
    const missing = randomUUID();
    assert.deepEqual(await ingestEvent(db, ingestionInput(missing, "t12")), {
      disposition: "INTEGRATION_INELIGIBLE",
      configStatus: "NOT_REGISTERED",
    });
    assert.deepEqual(await countRows(admin.client, missing), { events: 0, audits: 0 });
  });

  it("DB-T17: ACTIVE → NEW; DRAFT, DISABLED, DECOMMISSIONED → INTEGRATION_INELIGIBLE with that status and no rows", async () => {
    const active = await seed("ACTIVE");
    assert.equal((await ingestEvent(db, ingestionInput(active, "t17"))).disposition, "NEW");
    for (const status of ["DRAFT", "DISABLED", "DECOMMISSIONED"] as const) {
      const id = await seed(status);
      assert.deepEqual(await ingestEvent(db, ingestionInput(id, "t17")), { disposition: "INTEGRATION_INELIGIBLE", configStatus: status });
      assert.deepEqual(await countRows(admin.client, id), { events: 0, audits: 0 });
    }
  });
});

describe("DB-T18 / DB-T19: the Integration row lock (through the SECURITY DEFINER function)", () => {
  /** Admin mode: pg_locks observation of a waiting backend. */
  async function waitingOnLock(pid: number): Promise<boolean> {
    const result = await admin.client.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid = $1 AND NOT granted) AS waiting`,
      [pid],
    );
    return result.rows[0]?.waiting === true;
  }

  async function backendPidOf(client: GuardedConnection): Promise<number> {
    return (await client.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? -1;
  }

  it("DB-T18 (i): while ingestion holds FOR SHARE, a status UPDATE waits; the Event commits under ACTIVE", async () => {
    const integrationId = await seed();
    const paused = latch();
    const resume = latch();
    const ingestion = ingestEvent(db, ingestionInput(integrationId, "t18-i"), {
      afterStatusCheck: async () => {
        paused.release();
        await resume.wait;
      },
    });
    await paused.wait;
    // Admin mode: the concurrent configuration change.
    const updater = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-t18-updater" });
    try {
      const pid = await backendPidOf(updater);
      const update = updater.client.query(`UPDATE "public"."Integration" SET "configStatus" = 'DISABLED' WHERE "id" = $1`, [integrationId]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(await waitingOnLock(pid), true, "the UPDATE waits on the share lock");
      resume.release();
      assert.equal((await ingestion).disposition, "NEW");
      await update;
      assert.equal((await countRows(admin.client, integrationId)).events, 1);
    } finally {
      await updater.close();
    }
  });

  it("DB-T18 (ii): a status check waiting behind an uncommitted UPDATE fails 57014 at statement_timeout → TRANSIENT, no rows", async () => {
    const integrationId = await seed();
    const holder = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-t18-holder" });
    try {
      await holder.client.query("BEGIN");
      await holder.client.query(`UPDATE "public"."Integration" SET "configStatus" = 'DISABLED' WHERE "id" = $1`, [integrationId]);
      const started = performance.now();
      const failure = await ingestEvent(db, ingestionInput(integrationId, "t18-ii")).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsed = performance.now() - started;
      process.stdout.write(`[DB-T18 ii] failed after ${Math.round(elapsed)} ms; SQLSTATE ${String(sqlStateOf(failure))}\n`);
      assert.equal(sqlStateOf(failure), "57014");
      assert.equal(classifyDatabaseError(failure).failureClass, "TRANSIENT");
      assert.ok(elapsed >= 4_900 && elapsed < 7_500, `elapsed ${elapsed} ms (tolerance 4.9–7.5 s)`);
      await holder.client.query("ROLLBACK");
      assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
    } finally {
      await holder.client.query("ROLLBACK").catch(() => undefined);
      await holder.close();
    }
  });

  it("DB-T18 (iii): after the UPDATE commits, the next ingestion is INTEGRATION_INELIGIBLE", async () => {
    const integrationId = await seed();
    // Admin mode: the configuration change.
    await admin.client.query(`UPDATE "public"."Integration" SET "configStatus" = 'DISABLED' WHERE "id" = $1`, [integrationId]);
    assert.deepEqual(await ingestEvent(db, ingestionInput(integrationId, "t18-iii")), {
      disposition: "INTEGRATION_INELIGIBLE",
      configStatus: "DISABLED",
    });
  });

  it("DB-T18 (iv): concurrent ingestions for one ACTIVE integration hold the share lock together", async () => {
    const integrationId = await seed();
    const concurrency = 8;
    let arrived = 0;
    const allArrived = latch();
    const resume = latch();
    const runs = Array.from({ length: concurrency }, (_, i) =>
      ingestEvent(db, ingestionInput(integrationId, `t18-iv-${i}`), {
        afterStatusCheck: async () => {
          arrived += 1;
          if (arrived === concurrency) allArrived.release();
          await resume.wait;
        },
      }),
    );
    await Promise.race([
      allArrived.wait,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`only ${arrived} of ${concurrency} passed the status check`)), 4_000)),
    ]);
    resume.release();
    const results = await Promise.all(runs);
    assert.ok(results.every((result) => result.disposition === "NEW"));
  });

  it("DB-T19: a concurrent DELETE of the Integration waits for the in-flight ingestion; no 23503 in the insert", async () => {
    const integrationId = await seed();
    const paused = latch();
    const resume = latch();
    const ingestion = ingestEvent(db, ingestionInput(integrationId, "t19"), {
      afterStatusCheck: async () => {
        paused.release();
        await resume.wait;
      },
    });
    await paused.wait;
    // Admin mode: the concurrent delete.
    const deleter = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-t19-deleter" });
    try {
      const pid = await backendPidOf(deleter);
      const deletion = deleter.client
        .query(`DELETE FROM "public"."Integration" WHERE "id" = $1`, [integrationId])
        .then(() => "deleted", (error: unknown) => `failed ${String(sqlStateOf(error) ?? (error as { code?: string }).code)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(await waitingOnLock(pid), true, "the DELETE waits on the share lock");
      resume.release();
      assert.equal((await ingestion).disposition, "NEW", "the insert saw no 23503");
      const deleteOutcome = await deletion;
      process.stdout.write(`[DB-T19] delete after the ingestion committed: ${deleteOutcome}\n`);
      assert.equal(deleteOutcome, "failed 23503", "the committed Event now blocks the delete (RESTRICT)");
    } finally {
      await deleter.close();
    }
  });
});
