import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdvisoryLockNotInTransactionError,
  AdvisoryLockTimeoutError,
  LockedTransactionDeadlineError,
  MAX_LOCKED_TRANSACTION_WINDOW_MS,
  TransactionTimeoutInvariantError,
  advisoryLockKey,
  withAdvisoryXactLock,
} from "./advisory-lock.js";
import type { LockedTransactionOptions } from "./advisory-lock.js";
import type { Database } from "./client.js";
import { classifyDatabaseError } from "./errors.js";
import { Prisma } from "./generated/prisma/client.js";

// Runner behaviour without a database: a fake interactive transaction
// records every statement, and a scripted monotonic clock drives the
// deadline arithmetic (AL-T6c, AL-T6d, AL-T7f, AL-T8 and the §9.4 mapping).

interface Recorded {
  readonly kind: "query" | "execute";
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface FakeOptions {
  readonly tt?: string;
  readonly guardMismatch?: boolean;
  readonly lockError?: unknown;
  readonly commitError?: boolean;
}

/** A clock that returns the scripted values in order, then repeats the last one. */
function scriptedClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function fakeDatabase(clock: () => number, options: FakeOptions = {}) {
  const statements: Recorded[] = [];
  const transactions: unknown[] = [];
  let nonce: unknown;
  const tx = {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = strings.join("$");
      statements.push({ kind: "query", sql, values });
      if (sql.includes("current_setting('transaction_timeout') AS tt")) return [{ tt: options.tt ?? "0" }];
      if (sql.includes("set_config('transaction_timeout'")) nonce = values[2];
      if (sql.includes("current_setting('irs.advisory_lock_guard', true)")) {
        return [{ guard: options.guardMismatch === true ? "another-session" : nonce }];
      }
      return [{}];
    },
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      statements.push({ kind: "execute", sql: strings.join("$"), values });
      if (options.lockError !== undefined) throw options.lockError;
      return 0;
    },
  };
  const prisma = {
    async $transaction(callback: (client: typeof tx) => Promise<unknown>, transactionOptions: unknown) {
      transactions.push(transactionOptions);
      const result = await callback(tx);
      if (options.commitError === true) throw new Error("commit reply lost");
      return result;
    },
  };
  const db = { prisma, monotonicNow: clock, ping: async () => undefined } as unknown as Database;
  return { db, statements, transactions };
}

const KEY = advisoryLockKey("irs.test", "runner-unit");
const BASE: Omit<LockedTransactionOptions, "deadline"> = {
  lockTimeoutMs: 300,
  postLockReserveMs: 700,
  commitReserveMs: 100,
  maxWaitMs: 200,
};

function setTransactionTimeout(statements: readonly Recorded[]): Recorded | undefined {
  return statements.find((statement) => statement.sql.includes("set_config('transaction_timeout'"));
}

describe("AL-T8: advisoryLockKey", () => {
  it("matches golden vectors (signed 64-bit)", () => {
    assert.equal(advisoryLockKey("irs.rate-limit-evidence.instance", "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61"), 1501044657706836854n);
    assert.equal(advisoryLockKey("a", "b"), 6463353407833682387n);
    assert.equal(advisoryLockKey("irs.test", "é"), -3762204664190851624n);
    assert.equal(advisoryLockKey("ns", "x"), 8416188989054722701n);
  });
  it("is deterministic, separates namespaces and stays within int64", () => {
    assert.equal(advisoryLockKey("ns", "id"), advisoryLockKey("ns", "id"));
    assert.notEqual(advisoryLockKey("ns-a", "id"), advisoryLockKey("ns-b", "id"));
    assert.notEqual(advisoryLockKey("ab", "c"), advisoryLockKey("a", "bc"));
    for (let i = 0; i < 200; i += 1) {
      const key = advisoryLockKey("ns", `identity-${i}`);
      assert.ok(key >= -(2n ** 63n) && key < 2n ** 63n);
    }
  });
  it("rejects an empty namespace or identity", () => {
    assert.throws(() => advisoryLockKey("", "x"), TypeError);
    assert.throws(() => advisoryLockKey("x", ""), TypeError);
  });
});

describe("AL-T6c: option and window validation, before any I/O", () => {
  it("rejects non-integers, values < 1 and postLockReserveMs ≤ commitReserveMs with RangeError", async () => {
    const bad: Partial<LockedTransactionOptions>[] = [
      { lockTimeoutMs: 1.5 },
      { lockTimeoutMs: 0 },
      { maxWaitMs: -1 },
      { commitReserveMs: Number.NaN },
      { postLockReserveMs: 100, commitReserveMs: 100 },
      { postLockReserveMs: 50, commitReserveMs: 100 },
      { deadline: Number.POSITIVE_INFINITY },
    ];
    for (const override of bad) {
      const fake = fakeDatabase(scriptedClock([0]));
      await assert.rejects(
        withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 5_000, ...override }, async () => "work"),
        RangeError,
      );
      assert.equal(fake.transactions.length, 0, "no connection was acquired");
    }
  });
  it("rejects a window above MAX_LOCKED_TRANSACTION_WINDOW_MS with RangeError", async () => {
    const fake = fakeDatabase(scriptedClock([1_000]));
    await assert.rejects(
      withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 1_000 + MAX_LOCKED_TRANSACTION_WINDOW_MS + 1 }, async () => 1),
      RangeError,
    );
    assert.equal(fake.transactions.length, 0);
  });
  it("refuses a window that cannot fit (including a past deadline) as NOT_STARTED / NOT_COMMITTED", async () => {
    const minimum = BASE.maxWaitMs + BASE.lockTimeoutMs + BASE.postLockReserveMs;
    for (const deadline of [minimum - 1, 0, -500]) {
      const fake = fakeDatabase(scriptedClock([0]));
      await assert.rejects(withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline }, async () => 1), (error: unknown) => {
        assert.ok(error instanceof LockedTransactionDeadlineError);
        assert.equal(error.phase, "NOT_STARTED");
        assert.equal(error.outcome, "NOT_COMMITTED");
        return true;
      });
      assert.equal(fake.transactions.length, 0);
    }
  });
});

describe("AL-T6d: millisecond flooring", () => {
  const minimumAtS1 = BASE.lockTimeoutMs + BASE.postLockReserveMs;

  it("w0 is floored: 0.5 ms below the call-time minimum refuses with no I/O", async () => {
    const minimum = BASE.maxWaitMs + BASE.lockTimeoutMs + BASE.postLockReserveMs;
    const fake = fakeDatabase(scriptedClock([10.5]));
    await assert.rejects(
      withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 10.5 + minimum - 0.5 }, async () => 1),
      LockedTransactionDeadlineError,
    );
    assert.equal(fake.transactions.length, 0);
  });

  it("deadline − t1 = minimum − 0.4 → SETUP refusal and no s1", async () => {
    const deadline = 5_000;
    const fake = fakeDatabase(scriptedClock([0, deadline - minimumAtS1 + 0.4]));
    await assert.rejects(withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline }, async () => 1), (error: unknown) => {
      assert.ok(error instanceof LockedTransactionDeadlineError);
      assert.equal(error.phase, "SETUP");
      return true;
    });
    assert.equal(setTransactionTimeout(fake.statements), undefined);
  });

  it("deadline − t1 = minimum + 0.9 → s1 carries exactly the minimum as an integer string", async () => {
    const deadline = 5_000;
    const fake = fakeDatabase(scriptedClock([0, deadline - minimumAtS1 - 0.9, 0]));
    await withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline }, async () => "done");
    assert.equal(setTransactionTimeout(fake.statements)?.values[0], String(minimumAtS1));
  });

  it("across randomized fractional clocks, s1 never carries 0, a negative or a non-integer value", async () => {
    for (let i = 0; i < 300; i += 1) {
      const t0 = Math.random() * 1_000;
      const deadline = t0 + 1_200 + Math.random() * 3_000;
      const t1 = t0 + Math.random() * (deadline - t0);
      const fake = fakeDatabase(scriptedClock([t0, t1, t0]));
      try {
        await withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline }, async () => 1);
      } catch (error) {
        assert.ok(error instanceof LockedTransactionDeadlineError, String(error));
      }
      const s1 = setTransactionTimeout(fake.statements);
      if (s1 !== undefined) {
        const value = s1.values[0];
        assert.equal(typeof value, "string");
        assert.match(value as string, /^[1-9][0-9]*$/);
        assert.ok(Number(value) >= minimumAtS1);
      }
    }
  });
});

describe("runner statement sequence (§9.3)", () => {
  it("s0, s1, s2, s3 (alone), s4, then work; Prisma maxWait/timeout from the window", async () => {
    const deadline = 2_000;
    const fake = fakeDatabase(scriptedClock([0, 100, 500]));
    const seenByWork: number[] = [];
    const result = await withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline }, async () => {
      seenByWork.push(fake.statements.length);
      return "ok";
    });
    assert.equal(result, "ok");
    const sql = fake.statements.map((statement) => statement.sql);
    assert.match(sql[0] ?? "", /^SELECT current_setting\('transaction_timeout'\) AS tt$/);
    assert.equal(
      sql[1],
      "SELECT set_config('transaction_timeout', $, true), set_config('statement_timeout', '0', true), set_config('lock_timeout', $, true), set_config('irs.advisory_lock_guard', $, true)",
    );
    assert.equal(sql[2], "SELECT current_setting('irs.advisory_lock_guard', true) AS guard");
    assert.equal(fake.statements[3]?.kind, "execute");
    assert.equal(sql[3], "SELECT pg_advisory_xact_lock($::bigint)");
    assert.equal(fake.statements[3]?.values[0], KEY);
    assert.equal(sql[4], "SELECT set_config('lock_timeout', '0', true)");
    assert.deepEqual(seenByWork, [5], "work starts only after s4");
    assert.deepEqual(fake.statements[1]?.values.slice(0, 2), ["1900", "300"]);
    assert.deepEqual(fake.transactions, [
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 200, timeout: 1_800 },
    ]);
  });

  it("s0: a nonzero session transaction_timeout throws TransactionTimeoutInvariantError before s1", async () => {
    const fake = fakeDatabase(scriptedClock([0, 0]), { tt: "1min" });
    await assert.rejects(withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 2_000 }, async () => 1), (error: unknown) => {
      assert.ok(error instanceof TransactionTimeoutInvariantError);
      assert.equal(error.phase, "SETUP");
      assert.equal(error.outcome, "NOT_COMMITTED");
      assert.equal(classifyDatabaseError(error).failureClass, "FAULT");
      return true;
    });
    assert.equal(fake.statements.length, 1);
  });

  it("s0 accepts a zero with a unit", async () => {
    const fake = fakeDatabase(scriptedClock([0, 0, 0]), { tt: "0ms" });
    assert.equal(await withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 2_000 }, async () => 7), 7);
  });

  it("a guard mismatch throws AdvisoryLockNotInTransactionError and never sends the lock statement", async () => {
    const fake = fakeDatabase(scriptedClock([0, 0]), { guardMismatch: true });
    await assert.rejects(
      withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 2_000 }, async () => 1),
      AdvisoryLockNotInTransactionError,
    );
    assert.equal(fake.statements.some((statement) => statement.kind === "execute"), false);
  });
});

describe("§9.4 phase and outcome mapping", () => {
  const lockTimeout = new Prisma.PrismaClientKnownRequestError("lock timeout", {
    code: "P2010",
    clientVersion: "7.10.0",
    meta: { driverAdapterError: { cause: { originalCode: "55P03", kind: "postgres" } } },
  });

  it("55P03 on the lock statement → AdvisoryLockTimeoutError (LOCK, NOT_COMMITTED), work never called", async () => {
    let workCalled = false;
    const fake = fakeDatabase(scriptedClock([0, 0, 0]), { lockError: lockTimeout });
    await assert.rejects(
      withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 2_000 }, async () => {
        workCalled = true;
      }),
      (error: unknown) => {
        assert.ok(error instanceof AdvisoryLockTimeoutError);
        assert.equal(error.phase, "LOCK");
        assert.equal(error.outcome, "NOT_COMMITTED");
        assert.equal((error as Error).cause, lockTimeout);
        return true;
      },
    );
    assert.equal(workCalled, false);
  });

  it("a lock-wait failure once the deadline has passed → LockedTransactionDeadlineError (LOCK), never AdvisoryLockTimeoutError", async () => {
    const fake = fakeDatabase(scriptedClock([0, 0, 2_000]), { lockError: lockTimeout });
    await assert.rejects(withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 2_000 }, async () => 1), (error: unknown) => {
      assert.ok(error instanceof LockedTransactionDeadlineError);
      assert.equal(error.phase, "LOCK");
      return true;
    });
  });

  it("an error from work → phase WORK, outcome NOT_COMMITTED", async () => {
    const fake = fakeDatabase(scriptedClock([0, 0, 0]));
    const failure = new Error("work failed");
    await assert.rejects(
      withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 2_000 }, async () => {
        throw failure;
      }),
      (error: unknown) => {
        assert.equal(error, failure);
        assert.equal((error as { phase?: unknown }).phase, "WORK");
        assert.equal((error as { outcome?: unknown }).outcome, "NOT_COMMITTED");
        return true;
      },
    );
  });

  it("an error after the callback completed → COMMIT / UNKNOWN, classified COMMIT_UNKNOWN", async () => {
    const fake = fakeDatabase(scriptedClock([0, 0, 0, 0]), { commitError: true });
    await assert.rejects(withAdvisoryXactLock(fake.db, KEY, { ...BASE, deadline: 2_000 }, async () => 1), (error: unknown) => {
      assert.equal((error as { phase?: unknown }).phase, "COMMIT");
      assert.equal((error as { outcome?: unknown }).outcome, "UNKNOWN");
      assert.equal(classifyDatabaseError(error).code, "COMMIT_UNKNOWN");
      return true;
    });
  });
});

describe("AL-T7f: commit-reserve boundary (unit half)", () => {
  it("work returning at deadline − 201 commits; at deadline − 200 throws WORK / NOT_COMMITTED with no commit", async () => {
    const deadline = 2_000;
    const commitReserveMs = 200;
    const options = { ...BASE, postLockReserveMs: 700, commitReserveMs, deadline };

    const commits = fakeDatabase(scriptedClock([0, 0, deadline - 201]));
    assert.equal(await withAdvisoryXactLock(commits.db, KEY, options, async () => "committed"), "committed");

    const gated = fakeDatabase(scriptedClock([0, 0, deadline - 200]));
    await assert.rejects(withAdvisoryXactLock(gated.db, KEY, options, async () => "late"), (error: unknown) => {
      assert.ok(error instanceof LockedTransactionDeadlineError);
      assert.equal(error.phase, "WORK");
      assert.equal(error.outcome, "NOT_COMMITTED");
      return true;
    });
  });
});
