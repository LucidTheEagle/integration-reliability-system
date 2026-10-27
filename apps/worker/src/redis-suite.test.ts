import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RedisConnectionFailure } from "./test-support/redis-guard.js";
import type { TestRedisAudit } from "./test-support/redis-guard.js";
import { PreflightFailure } from "./test-support/redis-preflight.js";
import { REDIS_TEST_ARGUMENTS, runRedisSuite } from "./test-support/redis-suite.js";
import type { ChildOutcome, SuiteDependencies } from "./test-support/redis-suite.js";

// The `test:redis` suite runner's exit rules (DF-4 and the partner's
// execution rule), with injected child results and audit readings and no
// Redis. The test status and the audit outcome are reported separately, the
// audit is always attempted (after the tests, or after a preflight refusal:
// S1-C1), and only "tests pass and audit passes" exits 0.

const BEFORE = 1_198_344;
const CLEAN: TestRedisAudit = { sentinelIntact: true, usedMemory: 1_250_000, remainingTestKeys: 0 };

interface Run {
  readonly lines: string[];
  readonly order: string[];
  readonly outcome: Awaited<ReturnType<typeof runRedisSuite>>;
}

async function run(options: {
  preflight?: () => Promise<{ usedMemory: number }>;
  child?: () => Promise<ChildOutcome>;
  audit?: () => Promise<TestRedisAudit>;
}): Promise<Run> {
  const lines: string[] = [];
  const order: string[] = [];
  const dependencies: SuiteDependencies = {
    preflight: async () => {
      order.push("preflight");
      return options.preflight === undefined ? { usedMemory: BEFORE } : options.preflight();
    },
    runTests: async () => {
      order.push("tests");
      return options.child === undefined ? { code: 0, signal: null } : options.child();
    },
    audit: async () => {
      order.push("audit");
      return options.audit === undefined ? CLEAN : options.audit();
    },
    write: (line) => lines.push(line),
  };
  const outcome = await runRedisSuite(dependencies);
  return { lines, order, outcome };
}

function hasLine(lines: readonly string[], text: string): boolean {
  return lines.some((line) => line.includes(text));
}

describe("redis suite runner: exit rules", () => {
  it("tests pass and audit passes: exit 0, both reported", async () => {
    const { lines, order, outcome } = await run({});
    assert.deepEqual(outcome, { tests: "passed", audit: "passed", exitCode: 0 });
    assert.deepEqual(order, ["preflight", "tests", "audit"]);
    assert.ok(hasLine(lines, "preflight: PASSED used_memory_before=1198344"));
    assert.ok(hasLine(lines, "tests: PASSED (exit status 0)"));
    assert.ok(hasLine(lines, "audit: used_memory_after=1250000 difference=+51656"));
    assert.ok(hasLine(lines, "audit: remaining_test_keys=0 sentinel=intact"));
    assert.ok(hasLine(lines, "audit: PASSED"));
    assert.ok(hasLine(lines, "result: PASSED"));
  });

  it("tests fail and audit passes: non-zero, the test failure visible, the audit still run", async () => {
    const { lines, order, outcome } = await run({ child: async () => ({ code: 1, signal: null }) });
    assert.deepEqual(outcome, { tests: "failed", audit: "passed", exitCode: 1 });
    assert.deepEqual(order, ["preflight", "tests", "audit"]);
    assert.ok(hasLine(lines, "tests: FAILED (exit status 1)"));
    assert.ok(hasLine(lines, "audit: PASSED"));
    assert.ok(hasLine(lines, "result: FAILED"));
  });

  it("tests pass and audit fails (keys remain): non-zero", async () => {
    const { lines, outcome } = await run({ audit: async () => ({ ...CLEAN, remainingTestKeys: 3 }) });
    assert.deepEqual(outcome, { tests: "passed", audit: "failed", exitCode: 1 });
    assert.ok(hasLine(lines, "tests: PASSED"));
    assert.ok(hasLine(lines, "audit: FAILED (3 test key(s) remain: a cleanup did not happen)"));
  });

  it("tests pass and the sentinel is not intact: non-zero, nothing else claimed", async () => {
    const { lines, outcome } = await run({ audit: async () => ({ sentinelIntact: false }) });
    assert.deepEqual(outcome, { tests: "passed", audit: "failed", exitCode: 1 });
    assert.ok(hasLine(lines, "audit: sentinel NOT INTACT; used_memory and remaining keys not established"));
    assert.ok(!hasLine(lines, "remaining_test_keys="));
  });

  it("both fail: non-zero, with both findings", async () => {
    const { lines, outcome } = await run({
      child: async () => ({ code: 1, signal: null }),
      audit: async () => ({ ...CLEAN, remainingTestKeys: 12 }),
    });
    assert.deepEqual(outcome, { tests: "failed", audit: "failed", exitCode: 1 });
    assert.ok(hasLine(lines, "tests: FAILED (exit status 1)"));
    assert.ok(hasLine(lines, "audit: FAILED (12 test key(s) remain"));
  });

  it("the audit cannot establish the final state: non-zero, \"not established\", never a pass", async () => {
    const { lines, outcome } = await run({
      audit: async () => {
        throw new RedisConnectionFailure("ECONNREFUSED");
      },
    });
    assert.deepEqual(outcome, { tests: "passed", audit: "not-established", exitCode: 1 });
    assert.ok(hasLine(lines, "audit: NOT ESTABLISHED (the final state could not be read: test-Redis connection failed (ECONNREFUSED))"));
    assert.ok(!hasLine(lines, "audit: PASSED"));
  });

  it("an audit reading without values is not established", async () => {
    const { outcome } = await run({ audit: async () => ({ sentinelIntact: true }) });
    assert.deepEqual(outcome, { tests: "passed", audit: "not-established", exitCode: 1 });
  });

  it("a test process ended by a signal is a failure", async () => {
    const { lines, outcome } = await run({ child: async () => ({ code: null, signal: "SIGTERM" }) });
    assert.deepEqual(outcome, { tests: "failed", audit: "passed", exitCode: 1 });
    assert.ok(hasLine(lines, "tests: FAILED (ended by signal SIGTERM)"));
  });

  it("a test process that did not start is not established; the audit still runs", async () => {
    const { lines, order, outcome } = await run({
      child: async () => {
        throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
      },
    });
    assert.deepEqual(outcome, { tests: "not-established", audit: "passed", exitCode: 1 });
    assert.deepEqual(order, ["preflight", "tests", "audit"]);
    assert.ok(hasLine(lines, "tests: NOT ESTABLISHED (the test process did not run: unexpected error (ENOENT))"));
  });

  // S1-C1: after a preflight refusal or failure the audit is still attempted
  // and reported, with no before value; the outcome stays non-zero.
  const refused = async () => {
    throw new PreflightFailure("used_memory 25165825 is above 25165824 bytes: founder reset required");
  };

  it("a preflight refusal: no test runs; the audit is still attempted, with no before value; non-zero", async () => {
    const { lines, order, outcome } = await run({ preflight: refused });
    assert.deepEqual(outcome, { tests: "not-run", audit: "passed", exitCode: 1 });
    assert.deepEqual(order, ["preflight", "audit"]);
    assert.ok(hasLine(lines, "preflight: REFUSED (used_memory 25165825 is above 25165824 bytes: founder reset required)"));
    assert.ok(hasLine(lines, "tests: NOT RUN"));
    assert.ok(hasLine(lines, "audit: used_memory_after=1250000 difference=not available (no before value)"));
    assert.ok(hasLine(lines, "audit: remaining_test_keys=0 sentinel=intact"));
    assert.ok(hasLine(lines, "audit: PASSED"));
    assert.ok(hasLine(lines, "result: FAILED (tests not-run, audit passed)"));
  });

  it("a preflight connection failure: no test runs; the audit is still attempted; non-zero", async () => {
    const { lines, order, outcome } = await run({
      preflight: async () => {
        throw new RedisConnectionFailure("ECONNREFUSED");
      },
    });
    assert.deepEqual(outcome, { tests: "not-run", audit: "passed", exitCode: 1 });
    assert.deepEqual(order, ["preflight", "audit"]);
    assert.ok(hasLine(lines, "preflight: REFUSED (test-Redis connection failed (ECONNREFUSED))"));
  });

  it("a preflight refusal and an audit that cannot read: not established, non-zero", async () => {
    const { lines, order, outcome } = await run({
      preflight: refused,
      audit: async () => {
        throw new RedisConnectionFailure("ECONNREFUSED");
      },
    });
    assert.deepEqual(outcome, { tests: "not-run", audit: "not-established", exitCode: 1 });
    assert.deepEqual(order, ["preflight", "audit"]);
    assert.ok(hasLine(lines, "audit: NOT ESTABLISHED (the final state could not be read: test-Redis connection failed (ECONNREFUSED))"));
    assert.ok(hasLine(lines, "result: FAILED (tests not-run, audit not-established)"));
  });

  it("a preflight refusal and keys remaining: the audit fails, non-zero", async () => {
    const { lines, outcome } = await run({ preflight: refused, audit: async () => ({ ...CLEAN, remainingTestKeys: 4 }) });
    assert.deepEqual(outcome, { tests: "not-run", audit: "failed", exitCode: 1 });
    assert.ok(hasLine(lines, "audit: FAILED (4 test key(s) remain: a cleanup did not happen)"));
  });
});

describe("redis suite runner: the child", () => {
  it("runs the Redis test files with concurrency 1, and nothing else", () => {
    assert.deepEqual([...REDIS_TEST_ARGUMENTS], ["--test", "--test-concurrency=1", "dist/**/*.redis.test.js"]);
    assert.ok(Object.isFrozen(REDIS_TEST_ARGUMENTS));
  });
});
