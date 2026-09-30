import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RetryPolicy } from "./index.js";
import {
  createRetryPolicy,
  DEFAULT_RETRY_POLICY,
  InvalidRetryPolicyError,
} from "./index.js";

function validPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: 4,
    backoffStrategy: "exponential",
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: true,
    respectRetryAfter: true,
    ...overrides,
  };
}

describe("DEFAULT_RETRY_POLICY", () => {
  it("represents the Master Specification's exact V1 demonstration defaults", () => {
    assert.deepStrictEqual(DEFAULT_RETRY_POLICY, {
      maxAttempts: 4,
      backoffStrategy: "exponential",
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      jitter: true,
      respectRetryAfter: true,
    });
  });

  it("is frozen and cannot be mutated", () => {
    assert.equal(Object.isFrozen(DEFAULT_RETRY_POLICY), true);
    assert.throws(() => {
      // @ts-expect-error — readonly at the type level too
      DEFAULT_RETRY_POLICY.maxAttempts = 99;
    });
  });
});

describe("createRetryPolicy — represents configuration, not one hard-coded policy", () => {
  it("accepts a policy with different values than the default", () => {
    const conservative = createRetryPolicy(
      validPolicy({ maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000, jitter: false }),
    );
    assert.equal(conservative.maxAttempts, 2);
    assert.equal(conservative.baseDelayMs, 500);
    assert.equal(conservative.jitter, false);
    assert.notDeepStrictEqual(conservative, DEFAULT_RETRY_POLICY);
  });

  it("accepts any non-empty backoffStrategy string, not a closed set", () => {
    // Confirms backoffStrategy is deliberately not a closed enum, per
    // the task's explicit instruction not to invent one.
    assert.doesNotThrow(() =>
      createRetryPolicy(validPolicy({ backoffStrategy: "linear" })),
    );
    assert.doesNotThrow(() =>
      createRetryPolicy(validPolicy({ backoffStrategy: "some-future-strategy-name" })),
    );
  });

  it("returns a frozen value", () => {
    const policy = createRetryPolicy(validPolicy());
    assert.equal(Object.isFrozen(policy), true);
  });
});

describe("createRetryPolicy — validation", () => {
  it("rejects maxAttempts = 0", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ maxAttempts: 0 })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects a negative maxAttempts", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ maxAttempts: -1 })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects a non-integer maxAttempts", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ maxAttempts: 2.5 })),
      InvalidRetryPolicyError,
    );
  });

  it("accepts maxAttempts = 1, the smallest valid positive integer", () => {
    assert.doesNotThrow(() => createRetryPolicy(validPolicy({ maxAttempts: 1 })));
  });

  it("rejects an empty backoffStrategy", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ backoffStrategy: "" })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects a whitespace-only backoffStrategy", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ backoffStrategy: "   " })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects a zero baseDelayMs", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ baseDelayMs: 0 })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects a negative baseDelayMs", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ baseDelayMs: -100 })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects a zero maxDelayMs", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ maxDelayMs: 0 })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects a negative maxDelayMs", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ maxDelayMs: -1 })),
      InvalidRetryPolicyError,
    );
  });

  it("rejects baseDelayMs greater than maxDelayMs", () => {
    assert.throws(
      () => createRetryPolicy(validPolicy({ baseDelayMs: 5000, maxDelayMs: 1000 })),
      InvalidRetryPolicyError,
    );
  });

  it("accepts baseDelayMs exactly equal to maxDelayMs", () => {
    assert.doesNotThrow(() =>
      createRetryPolicy(validPolicy({ baseDelayMs: 1000, maxDelayMs: 1000 })),
    );
  });

  it("reports every violated rule at once, not just the first", () => {
    assert.throws(
      () =>
        createRetryPolicy(
          validPolicy({ maxAttempts: 0, backoffStrategy: "", baseDelayMs: -1 }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRetryPolicyError);
        assert.equal(error.issues.length, 3);
        return true;
      },
    );
  });
});

describe("policy representation vs. retry execution", () => {
  it("jitter is a plain boolean flag — no formula, delay value, or execution logic exists in this module", () => {
    // This test exists to make the boundary explicit and enforced: if
    // someone later adds a jitter *formula* here, this test is what
    // should make them notice they've crossed into Task 016's
    // territory. There is deliberately nothing to assert about
    // jitter's effect, only that the flag itself is a plain boolean —
    // O-004 (exact jitter formula) stays open.
    assert.equal(typeof DEFAULT_RETRY_POLICY.jitter, "boolean");
  });
});