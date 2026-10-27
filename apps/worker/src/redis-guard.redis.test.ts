import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { REGISTERED_TARGET, RedisGuardRefusal, checkGuardedEndpoint, guardCheckSentinel } from "./test-support/redis-guard.js";
import type { RedisGuardCheck } from "./test-support/redis-guard.js";
import { GUARD_CHECK_DATABASE_INDEX } from "./test-support/redis-registry.js";

// Post-connect sentinel checks against the test Redis (127.0.0.1:46379).
// The real sentinel in the main database is only read. The wrong and missing
// cases run in the guard-check database, whose sentinel key this file sets
// and deletes only through DF-3's helper (guardCheckSentinel: that key, that
// database, nothing else); nothing is ever flushed.

const CHECK_TARGET = { ...REGISTERED_TARGET, db: GUARD_CHECK_DATABASE_INDEX };

async function refusedBy(check: RedisGuardCheck): Promise<void> {
  await assert.rejects(checkGuardedEndpoint(CHECK_TARGET), (error: unknown) => {
    assert.ok(error instanceof RedisGuardRefusal, "expected a RedisGuardRefusal");
    assert.equal(error.check, check);
    return true;
  });
}

describe("redis guard: post-connect sentinel", () => {
  let touched = false;

  after(async () => {
    if (touched) await guardCheckSentinel.deleteKey();
  });

  it("passes with the real sentinel present in the main database", async () => {
    await checkGuardedEndpoint();
  });

  it("passes, then refuses a wrong value and a missing key, in the guard-check database", async () => {
    touched = true;
    assert.equal(await guardCheckSentinel.setMarker(), "OK");
    await checkGuardedEndpoint(CHECK_TARGET);

    assert.equal(await guardCheckSentinel.setWrongValue(), "OK");
    await refusedBy("sentinel-mismatch");

    assert.equal(await guardCheckSentinel.deleteKey(), 1);
    await refusedBy("sentinel-missing");
  });
});
