import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AdvisoryLockNotInTransactionError,
  AdvisoryLockTimeoutError,
  LockedTransactionDeadlineError,
  TransactionTimeoutInvariantError,
  advisoryLockKey,
  runLockSetup,
  withAdvisoryXactLock,
} from "./advisory-lock.js";
import type { AdvisoryLockKey, LockedTransactionOptions } from "./advisory-lock.js";
import { disconnectWithin } from "./client.js";
import type { Database } from "./client.js";
import { prismaCodeOf, sqlStateOf } from "./errors.js";
import { sha256Hex, toEventRow } from "./event-ingestion.js";
import { assertServerBaseline, readServerBaseline } from "./test-support/baseline.js";
import { bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { guardedDatabase, ingestionInput, latch, removeIntegrations, seedIntegration } from "./test-support/database.js";
import { connectGuarded, openClient, requireTestUrl, validateTarget, withDatabase, withUser } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { readServerLog, settleLog, statementsOf } from "./test-support/server-log.js";
import { API_ROLE, scratchDatabaseName } from "./test-support/registry.js";

// The lock-scoped runner against PostgreSQL (Rev 1.7 §16.2, AL-T1 – AL-T11).
// The runner runs as irs_test_api (api mode) unless a role setting is the
// point of the test (irs_test_api_role_setting, special mode).

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const ROLE_SETTING = "irs_test_api_role_setting";

// Admin mode: baseline observation, pg_locks / pg_stat_activity observation, seeding, cleanup and termination.
let admin: GuardedConnection;
let db: Database;
const seeded: string[] = [];

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-lock-admin" });
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
});

after(async () => {
  await db.prisma.$disconnect();
  await removeIntegrations(admin.client, seeded);
  await assertServerBaseline(admin.client);
  await admin.close();
});

function freshKey(name: string): AdvisoryLockKey {
  return advisoryLockKey("irs.test.advisory-lock", `${name}-${randomUUID()}`);
}

function options(database: Database, windowMs = 5_000, overrides: Partial<LockedTransactionOptions> = {}): LockedTransactionOptions {
  return {
    deadline: database.monotonicNow() + windowMs,
    lockTimeoutMs: 2_000,
    postLockReserveMs: 1_500,
    commitReserveMs: 200,
    maxWaitMs: 500,
    ...overrides,
  };
}

async function pidOf(tx: { $queryRaw: Database["prisma"]["$queryRaw"] }): Promise<number> {
  return (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? -1;
}

/** Admin mode observation: advisory locks of one backend. */
async function advisoryLocks(pid: number): Promise<{ granted: boolean }[]> {
  return (
    await admin.client.query<{ granted: boolean }>(
      `SELECT granted FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = $1`,
      [pid],
    )
  ).rows;
}

/** Admin mode observation: waiting advisory-lock requests in a database. */
async function waitingAdvisory(database: string): Promise<number[]> {
  return (
    await admin.client.query<{ pid: number }>(
      `SELECT l.pid FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_database d ON d.oid = l.database
        WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = $1`,
      [database],
    )
  ).rows.map((row) => row.pid);
}

async function until(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const started = performance.now();
  while (!(await condition())) {
    if (performance.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Holds a key inside a runner until released; resolves `held` once work runs. */
function holdKey(database: Database, key: AdvisoryLockKey, windowMs = 20_000) {
  const held = latch();
  const release = latch();
  const done = withAdvisoryXactLock(database, key, options(database, windowMs, { postLockReserveMs: 10_000 }), async (tx) => {
    const pid = await pidOf(tx);
    held.release();
    await release.wait;
    return pid;
  });
  return { held: held.wait, release: () => release.release(), done };
}

describe("AL-T1 – AL-T5, AL-T8: mutual exclusion, release, same session", () => {
  it("AL-T1: two runners on one key serialize; the second's work starts only after the first's work ended", async () => {
    const key = freshKey("t1");
    const events: string[] = [];
    const first = withAdvisoryXactLock(db, key, options(db, 10_000), async () => {
      events.push("A-work-start");
      await new Promise((resolve) => setTimeout(resolve, 600));
      events.push("A-work-end");
    });
    await until(async () => events.includes("A-work-start"), 3_000, "A in work");
    const second = withAdvisoryXactLock(db, key, options(db, 10_000), async () => {
      events.push("B-work-start");
    });
    await until(async () => (await waitingAdvisory("irs_011_test")).length === 1, 3_000, "B waiting on the lock");
    await Promise.all([first, second]);
    process.stdout.write(`[AL-T1] order: ${events.join(" → ")}\n`);
    assert.deepEqual(events, ["A-work-start", "A-work-end", "B-work-start"]);
  });

  it("AL-T2 / AL-T3: released at commit and at rollback (a third runner acquires immediately)", async () => {
    for (const ending of ["commit", "rollback"] as const) {
      const key = freshKey(`t2-${ending}`);
      await withAdvisoryXactLock(db, key, options(db), async () => {
        if (ending === "rollback") throw new Error("work throws");
      }).catch((error: unknown) => {
        assert.equal((error as { phase?: string }).phase, "WORK");
      });
      const started = performance.now();
      await withAdvisoryXactLock(db, key, options(db, 5_000, { lockTimeoutMs: 200, postLockReserveMs: 1_500 }), async () => undefined);
      assert.ok(performance.now() - started < 1_000, `${ending}: acquired immediately`);
    }
  });

  it("AL-T4: released when the holder's backend is terminated; the holder's error has phase WORK", async () => {
    const key = freshKey("t4");
    const killed = latch();
    const holder = withAdvisoryXactLock(db, key, options(db, 10_000, { postLockReserveMs: 5_000 }), async (tx) => {
      const pid = await pidOf(tx);
      await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
      killed.release();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.$queryRaw`SELECT 1`;
    }).then(
      () => assert.fail("the holder must fail"),
      (error: unknown) => error,
    );
    await killed.wait;
    const failure = await holder;
    process.stdout.write(`[AL-T4] holder error: ${(failure as Error).name}, phase ${String((failure as { phase?: string }).phase)}, outcome ${String((failure as { outcome?: string }).outcome)}\n`);
    assert.equal((failure as { phase?: string }).phase, "WORK");
    assert.equal((failure as { outcome?: string }).outcome, "NOT_COMMITTED");
    const started = performance.now();
    await withAdvisoryXactLock(db, key, options(db, 5_000, { lockTimeoutMs: 200 }), async () => undefined);
    assert.ok(performance.now() - started < 1_000, "the lock was released with the session");
  });

  it("AL-T5: s0–s4 and every work statement run on one backend, which holds the advisory lock during work", async () => {
    const single = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    try {
      const pid = await pidOf(single.prisma);
      const since = new Date(Date.now() - 2_000);
      let locks: { granted: boolean }[] = [];
      let workPid = -1;
      await withAdvisoryXactLock(single, freshKey("t5"), options(single), async (tx) => {
        workPid = await pidOf(tx);
        locks = await advisoryLocks(workPid);
      });
      assert.equal(workPid, pid);
      assert.deepEqual(locks, [{ granted: true }]);
      await settleLog();
      const statements = statementsOf(await readServerLog(since), pid);
      const begin = statements.lastIndexOf("BEGIN");
      const transaction = statements.slice(begin);
      process.stdout.write(`[AL-T5] pid ${pid}: ${JSON.stringify(transaction)}\n`);
      assert.deepEqual(transaction.slice(0, 2), ["BEGIN", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"]);
      assert.match(transaction[2] ?? "", /^SELECT current_setting\('transaction_timeout'\) AS tt$/);
      assert.match(transaction[3] ?? "", /^SELECT set_config\('transaction_timeout', \$1, true\)/);
      assert.match(transaction[4] ?? "", /^SELECT current_setting\('irs\.advisory_lock_guard', true\) AS guard$/);
      assert.equal(transaction[5], "SELECT pg_advisory_xact_lock($1::bigint)");
      assert.equal(transaction[6], "SELECT set_config('lock_timeout', '0', true)");
      assert.equal(transaction[transaction.length - 1], "COMMIT");
    } finally {
      await single.prisma.$disconnect();
    }
  });

  it("AL-T8: different identities and namespaces do not block each other", async () => {
    const holder = holdKey(db, advisoryLockKey("irs.test.ns-a", "same-identity"));
    await holder.held;
    try {
      for (const other of [advisoryLockKey("irs.test.ns-b", "same-identity"), advisoryLockKey("irs.test.ns-a", "other-identity")]) {
        const started = performance.now();
        await withAdvisoryXactLock(db, other, options(db, 5_000, { lockTimeoutMs: 200 }), async () => undefined);
        assert.ok(performance.now() - started < 1_000);
      }
    } finally {
      holder.release();
      await holder.done;
    }
  });
});

describe("AL-T6b / AL-T6d: the runtime guard and integer timeouts on the wire", () => {
  it("AL-T6b: the lock steps on the root client (outside a transaction) throw before the lock statement; no advisory lock appears", async () => {
    for (const maxConnections of [1, 2]) {
      const root = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections } });
      try {
        const since = new Date(Date.now() - 2_000);
        const pids = new Set<number>();
        for (let i = 0; i < 3; i += 1) pids.add(await pidOf(root.prisma));
        const deadline = root.monotonicNow() + 5_000;
        await assert.rejects(
          runLockSetup(root.prisma, freshKey("t6b"), 4_000, 1_000, root.monotonicNow, deadline),
          AdvisoryLockNotInTransactionError,
        );
        await settleLog();
        const entries = await readServerLog(since);
        const lockStatements = [...pids].flatMap((pid) => statementsOf(entries, pid)).filter((sql) => sql.includes("pg_advisory_xact_lock"));
        assert.deepEqual(lockStatements, [], `pool max ${maxConnections}: no lock statement sent`);
        for (const pid of pids) assert.deepEqual(await advisoryLocks(pid), []);
      } finally {
        await root.prisma.$disconnect();
      }
    }
  });

  it("AL-T6d (wire): s1 carries the floored window as a positive integer string", async () => {
    const single = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    try {
      const pid = await pidOf(single.prisma);
      const since = new Date(Date.now() - 2_000);
      await withAdvisoryXactLock(single, freshKey("t6d"), { ...options(single), deadline: single.monotonicNow() + 4_321.7 }, async () => undefined);
      await settleLog();
      // PostgreSQL 17 logs bound values as "DETAIL:  Parameters: $1 = '…', …".
      const detail = (await readServerLog(since)).filter((entry) => entry.pid === pid && entry.level === "DETAIL" && /parameters:/i.test(entry.message));
      const s1 = detail.find((entry) => /\$3 = '[0-9a-f-]{36}'/.test(entry.message));
      process.stdout.write(`[AL-T6d] s1 parameters: ${String(s1?.message)}\n`);
      assert.match(s1?.message ?? "", /Parameters: \$1 = '[1-9][0-9]*', \$2 = '2000', \$3 = '/i);
    } finally {
      await single.prisma.$disconnect();
    }
  });
});

describe("AL-T7a – AL-T7f: deadlines and settings", () => {
  it("AL-T7a: lock busy → AdvisoryLockTimeoutError (LOCK, NOT_COMMITTED), cause 55P03, at ≈300 ms; work never called", async () => {
    const key = freshKey("t7a");
    const holder = holdKey(db, key);
    await holder.held;
    try {
      let workCalled = false;
      const started = performance.now();
      const failure = await withAdvisoryXactLock(
        db,
        key,
        { deadline: db.monotonicNow() + 1_500, maxWaitMs: 200, lockTimeoutMs: 300, postLockReserveMs: 700, commitReserveMs: 100 },
        async () => {
          workCalled = true;
        },
      ).then(
        () => assert.fail("expected a lock timeout"),
        (error: unknown) => error,
      );
      const elapsed = performance.now() - started;
      process.stdout.write(`[AL-T7a] ${(failure as Error).name} after ${Math.round(elapsed)} ms; cause SQLSTATE ${String(sqlStateOf((failure as Error).cause))}\n`);
      assert.ok(failure instanceof AdvisoryLockTimeoutError);
      assert.equal(failure.phase, "LOCK");
      assert.equal(failure.outcome, "NOT_COMMITTED");
      assert.equal(sqlStateOf(failure.cause), "55P03");
      assert.equal(workCalled, false);
      assert.ok(elapsed >= 250 && elapsed < 900, `elapsed ${elapsed} ms (tolerance 250–900 ms)`);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  it("AL-T7b / AL-T10c: a deadline during work ends the session by transaction_timeout; WORK / NOT_COMMITTED; the lock is released; the pool recovers", async () => {
    const key = freshKey("t7b");
    let pid = -1;
    const since = new Date(Date.now() - 2_000);
    const started = performance.now();
    const failure = await withAdvisoryXactLock(
      db,
      key,
      { deadline: db.monotonicNow() + 2_500, maxWaitMs: 500, lockTimeoutMs: 1_000, postLockReserveMs: 900, commitReserveMs: 200 },
      async (tx) => {
        pid = await pidOf(tx);
        await tx.$executeRaw`SELECT pg_sleep(6)`;
      },
    ).then(
      () => assert.fail("expected the deadline"),
      (error: unknown) => error,
    );
    const elapsed = performance.now() - started;
    await settleLog();
    const fatal = (await readServerLog(since)).find((entry) => entry.pid === pid && entry.level === "FATAL");
    const cause = (failure as Error).cause;
    process.stdout.write(
      `[AL-T7b] ${(failure as Error).name} after ${Math.round(elapsed)} ms; phase ${String((failure as { phase?: string }).phase)}; ` +
        `cause ${(cause as Error | undefined)?.constructor.name} ${String(prismaCodeOf(cause))} ${String(sqlStateOf(cause))}; server: ${String(fatal?.message)}\n`,
    );
    assert.ok(failure instanceof LockedTransactionDeadlineError);
    assert.equal(failure.phase, "WORK");
    assert.equal(failure.outcome, "NOT_COMMITTED");
    assert.equal(fatal?.message, "terminating connection due to transaction timeout");
    const alive = (await admin.client.query(`SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1`, [pid])).rows.length;
    assert.equal(alive, 0, "the backend is gone");
    // AL-T10c: the pool discards the dead client; the lock is free; ping and the runner work on a fresh connection.
    await db.ping();
    let freshPid = -1;
    await withAdvisoryXactLock(db, key, options(db, 5_000, { lockTimeoutMs: 200 }), async (tx) => {
      freshPid = await pidOf(tx);
    });
    assert.notEqual(freshPid, pid);
    const tempDb = await guardedDatabase({ url: apiUrl, mode: "api" });
    await tempDb.ping();
    assert.deepEqual(await disconnectWithin(tempDb, 5_000), { completed: true });
  });

  it("AL-T7c: a setup overrun refuses before s1 (SETUP); a reserve consumed during the lock wait gives LOCK, never AdvisoryLockTimeoutError", async () => {
    let shift = 0;
    let reads = 0;
    let shiftAtRead = Number.POSITIVE_INFINITY;
    const clocked = await guardedDatabase({
      url: apiUrl,
      mode: "api",
      pool: { maxConnections: 1 },
      monotonicNow: () => {
        reads += 1;
        return performance.now() + (reads >= shiftAtRead ? shift : 0);
      },
    });
    try {
      const pid = await pidOf(clocked.prisma);
      const since = new Date(Date.now() - 2_000);
      // options() reads the clock itself, so it is computed before the reads are scripted.
      const setupOptions = options(clocked);
      reads = 0;
      shiftAtRead = 2;
      shift = 3_000;
      await assert.rejects(withAdvisoryXactLock(clocked, freshKey("t7c"), setupOptions, async () => undefined), (error: unknown) => {
        assert.ok(error instanceof LockedTransactionDeadlineError);
        assert.equal(error.phase, "SETUP");
        return true;
      });
      await settleLog();
      const sent = statementsOf(await readServerLog(since), pid);
      assert.equal(sent.some((sql) => sql.includes("set_config('transaction_timeout'")), false, "no s1 was sent");

      const key = freshKey("t7c-lock");
      const holder = holdKey(db, key);
      await holder.held;
      try {
        const lockOptions = options(clocked, 5_000, { lockTimeoutMs: 300 });
        reads = 0;
        shiftAtRead = 3;
        shift = 10_000;
        await assert.rejects(
          withAdvisoryXactLock(clocked, key, lockOptions, async () => undefined),
          (error: unknown) => {
            assert.ok(error instanceof LockedTransactionDeadlineError, String(error));
            assert.equal(error.phase, "LOCK");
            return true;
          },
        );
      } finally {
        holder.release();
        await holder.done;
      }
    } finally {
      await clocked.prisma.$disconnect();
    }
  });

  it("AL-T7d: inside work lock_timeout = 0, statement_timeout = 0, transaction_timeout = w1; nothing leaks to the next transaction", async () => {
    let frozen: number | undefined;
    let reads = 0;
    const single = await guardedDatabase({
      url: apiUrl,
      mode: "api",
      pool: { maxConnections: 1 },
      monotonicNow: () => {
        reads += 1;
        return reads <= 2 && frozen !== undefined ? frozen : performance.now();
      },
    });
    const settings = async (client: { $queryRaw: Database["prisma"]["$queryRaw"] }) =>
      (
        await client.$queryRaw<Record<string, string | null>[]>`
          SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout,
                 current_setting('transaction_timeout') AS transaction_timeout,
                 current_setting('irs.advisory_lock_guard', true) AS guard`
      )[0];
    try {
      const beforeRunner = await single.prisma.$transaction(async (tx) => settings(tx));
      // An integer, so (frozen + 4321) − frozen is exactly 4321 in floating point.
      frozen = Math.floor(performance.now());
      reads = 0;
      let inside: Record<string, string | null> | undefined;
      // Literal options (no clock read), so the runner's t0 and t1 are the two frozen reads.
      const literal = { deadline: frozen + 4_321, lockTimeoutMs: 2_000, postLockReserveMs: 1_500, commitReserveMs: 200, maxWaitMs: 500 };
      await withAdvisoryXactLock(single, freshKey("t7d"), literal, async (tx) => {
        inside = await settings(tx);
      });
      frozen = undefined;
      process.stdout.write(`[AL-T7d] before ${JSON.stringify(beforeRunner)}; inside ${JSON.stringify(inside)}\n`);
      assert.equal(inside?.lock_timeout, "0");
      assert.equal(inside?.statement_timeout, "0");
      assert.equal(inside?.transaction_timeout, "4321ms");
      // Rev 1.7 AL-T7d: the next transaction sees exactly the timeouts it saw before, "with an
      // empty guard setting". Before first use the custom setting is undefined (null); after a
      // transaction-local set it reverts to the empty string. Both are empty.
      const unchanged = (observed: Record<string, string | null> | undefined, label: string) => {
        assert.deepEqual(
          { lock_timeout: observed?.lock_timeout, statement_timeout: observed?.statement_timeout, transaction_timeout: observed?.transaction_timeout },
          { lock_timeout: beforeRunner?.lock_timeout, statement_timeout: beforeRunner?.statement_timeout, transaction_timeout: beforeRunner?.transaction_timeout },
          label,
        );
        assert.ok(observed?.guard === null || observed?.guard === "", `${label}: empty guard setting`);
      };
      const afterSuccess = await single.prisma.$transaction(async (tx) => settings(tx));
      process.stdout.write(`[AL-T7d] after a successful runner: ${JSON.stringify(afterSuccess)}\n`);
      unchanged(afterSuccess, "after a successful runner");

      const key = freshKey("t7d-lock");
      const holder = holdKey(db, key);
      await holder.held;
      try {
        await assert.rejects(
          withAdvisoryXactLock(single, key, options(single, 5_000, { lockTimeoutMs: 300 }), async () => undefined),
          AdvisoryLockTimeoutError,
        );
      } finally {
        holder.release();
        await holder.done;
      }
      unchanged(await single.prisma.$transaction(async (tx) => settings(tx)), "after a lock timeout");
      assert.ok(beforeRunner?.guard === null || beforeRunner?.guard === "", "an empty guard setting before the runner");
    } finally {
      await single.prisma.$disconnect();
    }
  });

  it("AL-T7e: a work-time lock wait of 600 ms is not cut by the advisory timeout (200 ms), even with a role-level lock_timeout of 100ms", async () => {
    const integrationId = await seedIntegration(admin.client, "ACTIVE");
    seeded.push(integrationId);
    // Admin mode: a role setting on the only role registered for ALTER ROLE ... SET; reverted below.
    await admin.client.query(`ALTER ROLE "${ROLE_SETTING}" SET lock_timeout = '100ms'`);
    const roleDb = await guardedDatabase({ url: withUser(apiUrl, ROLE_SETTING), mode: "special", special: ROLE_SETTING });
    try {
      for (const [label, database] of [["irs_test_api", db], [`${ROLE_SETTING} (lock_timeout 100ms)`, roleDb]] as const) {
        const input = ingestionInput(integrationId, `t7e-${randomUUID()}`);
        // Admin mode: another session holds the key's index entry uncommitted for 600 ms.
        const blocker = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-t7e-blocker" });
        try {
          await blocker.client.query("BEGIN");
          await blocker.client.query(
            `INSERT INTO "public"."Event" ("id", "integrationId", "externalEventId", "eventType", "resourceType", "resourceId", "payload", "occurredAt", "receivedAt", "status", "schemaVersion", "rawBody", "rawBodySha256")
             VALUES (gen_random_uuid(), $1, $2, 'x', 'x', 'x', '{}'::jsonb, now(), now(), 'VALIDATED', '1', '\\x61'::bytea, $3)`,
            [integrationId, input.externalEventId, "a".repeat(64)],
          );
          let waited = 0;
          await withAdvisoryXactLock(database, freshKey("t7e"), options(database, 5_000, { lockTimeoutMs: 200 }), async (tx) => {
            // The blocker is released 600 ms after the work's own insert starts waiting.
            setTimeout(() => void blocker.client.query("ROLLBACK"), 600);
            const started = performance.now();
            const inserted = await tx.event.createManyAndReturn({
              data: [toEventRow(input, sha256Hex(input.rawBody))],
              skipDuplicates: true,
              select: { id: true },
            });
            waited = performance.now() - started;
            assert.equal(inserted.length, 1);
          });
          process.stdout.write(`[AL-T7e] ${label}: waited ${Math.round(waited)} ms in work, no 55P03\n`);
          assert.ok(waited >= 550, `${label}: waited ${waited} ms`);
        } finally {
          await blocker.close();
        }
      }
    } finally {
      await roleDb.prisma.$disconnect();
      await admin.client.query(`ALTER ROLE "${ROLE_SETTING}" RESET lock_timeout`);
      assert.deepEqual(await readServerBaseline(admin.client), { roleSettings: 0, autoConfEntries: 0 });
    }
  });

  it("AL-T7f (evidence): COMMIT round-trip time under local Docker, recorded only", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      let returned = 0;
      await withAdvisoryXactLock(db, freshKey("t7f"), options(db), async () => {
        returned = performance.now();
      });
      samples.push(performance.now() - returned);
    }
    samples.sort((a, b) => a - b);
    process.stdout.write(
      `[AL-T7f] COMMIT round trip (work return → resolve), n=20: p50 ${samples[9]?.toFixed(1)} ms, max ${samples[19]?.toFixed(1)} ms (local evidence only)\n`,
    );
  });
});

describe("AL-T9: protected writes must use tx", () => {
  it("a write through tx runs on the locked backend; the same write through the root client does not", async () => {
    const ids: string[] = [];
    try {
      let lockedPid = -1;
      let txWritePid = -1;
      let rootWritePid = -1;
      await withAdvisoryXactLock(db, freshKey("t9"), options(db), async (tx) => {
        lockedPid = await pidOf(tx);
        const write = async (client: { $queryRaw: Database["prisma"]["$queryRaw"] }) => {
          const id = randomUUID();
          ids.push(id);
          return (
            await client.$queryRaw<{ pid: number }[]>`INSERT INTO "public"."AuditEntry" ("id", "actorType", "action", "entityType", "entityId", "createdAt")
              VALUES (${id}::uuid, 'TEST', 'AL_T9', 'TEST', 'al-t9', now()) RETURNING pg_backend_pid() AS pid`
          )[0]?.pid ?? -1;
        };
        txWritePid = await write(tx);
        rootWritePid = await write(db.prisma);
      });
      process.stdout.write(`[AL-T9] locked pid ${lockedPid}; write via tx on ${txWritePid}; write via root client on ${rootWritePid}\n`);
      assert.equal(txWritePid, lockedPid);
      assert.notEqual(rootWritePid, lockedPid);
    } finally {
      // Admin mode: removes the probe audit rows.
      await admin.client.query(`DELETE FROM "public"."AuditEntry" WHERE "id" = ANY($1::uuid[])`, [ids]);
    }
  });
});

describe("AL-T10: the session transaction_timeout invariant", () => {
  it("AL-T10a: (i) 0 outside a transaction; (ii) a session value of 60s is not shortened by a local value; (iii) a local value starts the timer mid-transaction", async () => {
    assert.equal((await db.prisma.$queryRaw<{ tt: string }[]>`SELECT current_setting('transaction_timeout') AS tt`)[0]?.tt, "0");
    validateTarget(apiUrl, "api");
    const check = await connectGuarded({ url: apiUrl, mode: "api" });
    await check.close();

    const control = await openClient(apiUrl, "irs-test-al-t10a-ii");
    try {
      await control.query(`SET transaction_timeout = '60s'`);
      await control.query("BEGIN");
      await control.query(`SELECT set_config('transaction_timeout', '1000', true)`);
      await control.query("SELECT pg_sleep(2)");
      await control.query("COMMIT");
      process.stdout.write(`[AL-T10a ii] with session 60s, a local 1000 ms did not end the session within 2 s (the active timer is not rescheduled)\n`);
    } finally {
      await control.end().catch(() => undefined);
    }

    const local = await openClient(apiUrl, "irs-test-al-t10a-iii");
    try {
      await local.query("BEGIN");
      await local.query(`SELECT set_config('transaction_timeout', '1000', true)`);
      const failure = await local.query("SELECT pg_sleep(3)").then(
        () => assert.fail("expected termination"),
        (error: unknown) => error,
      );
      process.stdout.write(`[AL-T10a iii] local 1000 ms → ${String((failure as { code?: string }).code)} ${(failure as Error).message}\n`);
      assert.equal((failure as { code?: string }).code, "25P04");
    } finally {
      await local.end().catch(() => undefined);
    }
  });

  it("AL-T10b: the runner's timer does not leak into the next transaction on the same connection", async () => {
    const single = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    try {
      const pid = await pidOf(single.prisma);
      await withAdvisoryXactLock(single, freshKey("t10b"), options(single, 2_500, { lockTimeoutMs: 500, postLockReserveMs: 1_000, maxWaitMs: 500 }), async () => undefined);
      await single.prisma.$transaction(
        async (tx) => {
          assert.equal(await pidOf(tx), pid);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 10_000 },
      );
    } finally {
      await single.prisma.$disconnect();
    }
  });

  it("AL-T10d: a session-level transaction_timeout on one pooled connection makes the runner fail closed at s0 on that session only", async () => {
    const pair = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 2 } });
    try {
      const hold = latch();
      const pids: number[] = [];
      const holders = [0, 1].map(() =>
        pair.prisma.$transaction(
          async (tx) => {
            pids.push(await pidOf(tx));
            await hold.wait;
          },
          { timeout: 10_000 },
        ),
      );
      await until(async () => pids.length === 2, 3_000, "two pooled connections");
      hold.release();
      await Promise.all(holders);
      const misconfigured = (
        await pair.prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid, set_config('transaction_timeout', '60s', false) AS v`
      )[0]?.pid ?? -1;
      const outcomes: { pid: number; result: string }[] = [];
      for (let round = 0; round < 10 && new Set(outcomes.map((o) => o.result)).size < 2; round += 1) {
        const runs = [0, 1].map(() => {
          let workPid = -1;
          return withAdvisoryXactLock(pair, freshKey("t10d"), options(pair), async (tx) => {
            workPid = await pidOf(tx);
          }).then(
            () => ({ pid: workPid, result: "ok" }),
            (error: unknown) => ({ pid: -1, result: error instanceof TransactionTimeoutInvariantError ? `invariant:${error.phase}` : String(error) }),
          );
        });
        outcomes.push(...(await Promise.all(runs)));
      }
      process.stdout.write(`[AL-T10d] misconfigured pid ${misconfigured}; outcomes ${JSON.stringify(outcomes)}\n`);
      assert.ok(outcomes.some((o) => o.result === "invariant:SETUP"), "the misconfigured session fails closed");
      assert.ok(outcomes.some((o) => o.result === "ok" && o.pid !== misconfigured), "the correct session succeeds");
      assert.ok(outcomes.every((o) => o.result !== "ok" || o.pid !== misconfigured), "never succeeds on the misconfigured session");
      assert.deepEqual(await advisoryLocks(misconfigured), []);
    } finally {
      await pair.prisma.$disconnect();
    }
  });

  it("AL-T10e: the connection-start option gives 0 on every new connection, even under a role setting of 60s, before any statement; the runner works", async () => {
    // Admin mode: a role setting on the only role registered for ALTER ROLE ... SET; reverted below.
    await admin.client.query(`ALTER ROLE "${ROLE_SETTING}" SET transaction_timeout = '60s'`);
    const roleDb = await guardedDatabase({ url: withUser(apiUrl, ROLE_SETTING), mode: "special", special: ROLE_SETTING });
    try {
      const since = new Date(Date.now() - 2_000);
      const hold = latch();
      const seen: { pid: number; value: string }[] = [];
      const runs = Array.from({ length: 5 }, () =>
        roleDb.prisma.$transaction(
          async (tx) => {
            const row = (
              await tx.$queryRaw<{ pid: number; value: string }[]>`
                SELECT pg_backend_pid() AS pid, (SELECT setting || '|' || source FROM pg_catalog.pg_settings WHERE name = 'transaction_timeout') AS value`
            )[0];
            if (row !== undefined) seen.push(row);
            await hold.wait;
          },
          { timeout: 10_000 },
        ),
      );
      await until(async () => seen.length === 5, 5_000, "five new connections");
      hold.release();
      await Promise.all(runs);
      await withAdvisoryXactLock(roleDb, freshKey("t10e"), options(roleDb), async () => undefined);
      await settleLog();
      const entries = await readServerLog(since);
      process.stdout.write(`[AL-T10e] ${JSON.stringify(seen)}\n`);
      assert.equal(new Set(seen.map((row) => row.pid)).size, 5);
      for (const row of seen) {
        assert.equal(row.value, "0|client");
        const first = statementsOf(entries, row.pid)[0];
        assert.equal(first, "BEGIN", `pid ${row.pid}: no statement precedes the first transaction`);
      }
    } finally {
      await roleDb.prisma.$disconnect();
      await admin.client.query(`ALTER ROLE "${ROLE_SETTING}" RESET transaction_timeout`);
      assert.deepEqual(await readServerBaseline(admin.client), { roleSettings: 0, autoConfEntries: 0 });
    }
  });
});

describe("AL-T11: post-lock snapshot visibility", () => {
  it("work sees the row the previous holder committed while it waited; the combined-statement control is recorded", async () => {
    const purpose = "lock";
    const database = scratchDatabaseName(purpose);
    const scratchUrl = await bootstrapScratch(admin, adminUrl, purpose);
    let scratch: GuardedConnection | undefined;
    let lockDb: Database | undefined;
    try {
      scratch = await connectGuarded({ url: scratchUrl, mode: "admin", applicationName: "irs-test-al-t11" });
      await scratch.client.query(`CREATE TABLE "public"."irs_probe" ("k" text PRIMARY KEY)`);
      await scratch.client.query(`GRANT SELECT, INSERT ON "public"."irs_probe" TO "${API_ROLE}"`);
      const apiScratchUrl = withDatabase(apiUrl, database);
      lockDb = await guardedDatabase({ url: apiScratchUrl, mode: "api" });
      const key = freshKey("t11");
      const row = `r-${randomUUID()}`;

      const inserted = latch();
      const commit = latch();
      const session1 = withAdvisoryXactLock(lockDb, key, options(lockDb, 15_000, { postLockReserveMs: 10_000 }), async (tx) => {
        await tx.$executeRaw`INSERT INTO "public"."irs_probe" ("k") VALUES (${row})`;
        inserted.release();
        await commit.wait;
      });
      await inserted.wait;
      let seenBySession2 = -1;
      const session2 = withAdvisoryXactLock(lockDb, key, options(lockDb, 15_000), async (tx) => {
        seenBySession2 = (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "public"."irs_probe" WHERE "k" = ${row}`)[0]?.n ?? -1;
      });
      await until(async () => (await waitingAdvisory(database)).length === 1, 3_000, "session 2 waiting at s3");
      commit.release();
      await Promise.all([session1, session2]);
      process.stdout.write(`[AL-T11] positive: session 2 saw ${seenBySession2} row(s) committed by session 1 while it waited\n`);
      assert.equal(seenBySession2, 1);

      // Negative control (evidence only, Addendum): a statement that forces lock evaluation, established to have waited.
      const row2 = `r-${randomUUID()}`;
      const inserted2 = latch();
      const commit2 = latch();
      const holder = withAdvisoryXactLock(lockDb, key, options(lockDb, 15_000, { postLockReserveMs: 10_000 }), async (tx) => {
        await tx.$executeRaw`INSERT INTO "public"."irs_probe" ("k") VALUES (${row2})`;
        inserted2.release();
        await commit2.wait;
      });
      await inserted2.wait;
      const control = await openClient(apiScratchUrl, "irs-test-al-t11-control");
      try {
        const controlPid = (await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? -1;
        const combined = control.query<{ n: number }>(
          `SELECT pg_advisory_xact_lock($1::bigint), (SELECT count(*)::int FROM "public"."irs_probe" WHERE "k" = $2) AS n`,
          [key.toString(), row2],
        );
        let waited = false;
        try {
          await until(async () => (await waitingAdvisory(database)).includes(controlPid), 3_000, "the control statement waiting");
          waited = true;
        } finally {
          commit2.release();
        }
        await holder;
        const n = (await combined).rows[0]?.n;
        process.stdout.write(`[AL-T11] negative control: waited on the lock = ${waited}; count after the wait = ${String(n)} (evidence only)\n`);
        assert.equal(waited, true, "the control statement is shown to have waited before its count is interpreted");
      } finally {
        await control.end().catch(() => undefined);
      }
    } finally {
      await lockDb?.prisma.$disconnect();
      await scratch?.close();
      await dropScratch(admin, purpose);
    }
  });
});
