import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REGISTERED_TARGET,
  RedisGuardRefusal,
  connectGuarded,
  connectUnverified,
} from "./test-support/redis-guard.js";
import type { GuardedRedis, RedisGuardCheck } from "./test-support/redis-guard.js";
import { GUARD_CHECK_DATABASE_INDEX, SENTINEL_KEY, SENTINEL_MARKER } from "./test-support/redis-registry.js";

// Post-connect sentinel checks against the test Redis (127.0.0.1:46379).
// The real sentinel in the main database is only read. The wrong and missing
// cases run in the guard-check database, whose sentinel key this file sets
// and deletes itself; nothing is ever flushed.

const CHECK_TARGET = { ...REGISTERED_TARGET, db: GUARD_CHECK_DATABASE_INDEX };

async function refusedBy(check: RedisGuardCheck): Promise<void> {
  await assert.rejects(connectGuarded(CHECK_TARGET), (error: unknown) => {
    assert.ok(error instanceof RedisGuardRefusal, "expected a RedisGuardRefusal");
    assert.equal(error.check, check);
    return true;
  });
}

describe("redis guard: post-connect sentinel", () => {
  let scratch: GuardedRedis | undefined;

  after(async () => {
    if (scratch !== undefined) {
      await scratch.client.del(SENTINEL_KEY);
      await scratch.close();
    }
  });

  it("passes with the real sentinel present in the main database", async () => {
    const guarded = await connectGuarded();
    await guarded.close();
  });

  it("passes, then refuses a wrong value and a missing key, in the guard-check database", async () => {
    scratch = await connectUnverified(CHECK_TARGET);

    assert.equal(await scratch.client.set(SENTINEL_KEY, SENTINEL_MARKER), "OK");
    const guarded = await connectGuarded(CHECK_TARGET);
    await guarded.close();

    assert.equal(await scratch.client.set(SENTINEL_KEY, "not-the-marker"), "OK");
    await refusedBy("sentinel-mismatch");

    assert.equal(await scratch.client.del(SENTINEL_KEY), 1);
    await refusedBy("sentinel-missing");
  });
});
