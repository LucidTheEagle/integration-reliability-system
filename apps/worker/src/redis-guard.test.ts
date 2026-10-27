import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { REPOSITORY_ROOT } from "./repository-root.js";
import {
  REGISTERED_TARGET,
  RedisCommandFailure,
  RedisConnectionFailure,
  RedisGuardRefusal,
  checkGuardCheckScope,
  checkGuardedEndpoint,
  checkSentinelValue,
  guardCheckSentinel,
  redisErrorCode,
  safeReason,
  validateRedisTarget,
} from "./test-support/redis-guard.js";
import type { RedisGuardCheck, RedisTestTarget } from "./test-support/redis-guard.js";
import {
  GUARD_CHECK_DATABASE_INDEX,
  MAIN_DATABASE_INDEX,
  SENTINEL_KEY,
  SENTINEL_MARKER,
} from "./test-support/redis-registry.js";

// Redis-free guard refusals (DR-11; Task 012A record D7, D17). No connection
// is made and no password file is read: every case is refused before either.

const CLEAN_ENV = {};

function target(overrides: Partial<RedisTestTarget>): RedisTestTarget {
  return { ...REGISTERED_TARGET, ...overrides };
}

function refusedBy(check: RedisGuardCheck, action: () => unknown, hidden: readonly string[] = []): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RedisGuardRefusal, "expected a RedisGuardRefusal");
    assert.equal(error.check, check);
    for (const text of hidden) {
      assert.ok(!error.message.includes(text), "a refusal never echoes a value");
    }
    return true;
  });
}

describe("redis guard: pre-connect checks", () => {
  it("accepts the registered target, by relative or absolute password path, in both registered databases", () => {
    validateRedisTarget(REGISTERED_TARGET, CLEAN_ENV);
    validateRedisTarget(target({ passwordFile: join(REPOSITORY_ROOT, "secrets", "redis_test_password") }), CLEAN_ENV);
    validateRedisTarget(target({ db: GUARD_CHECK_DATABASE_INDEX }), CLEAN_ENV);
  });

  it("refuses a host other than 127.0.0.1", () => {
    for (const host of ["localhost", "127.0.0.2", "0.0.0.0", "::1", "irs-test-redis"]) {
      refusedBy("host", () => validateRedisTarget(target({ host }), CLEAN_ENV), [host]);
    }
  });

  it("refuses a port other than 46379, including the development port", () => {
    for (const port of [6379, 46380, 0]) {
      refusedBy("port", () => validateRedisTarget(target({ port }), CLEAN_ENV), [String(port)]);
    }
  });

  it("refuses the development password file, by relative or absolute path", () => {
    for (const passwordFile of [
      "secrets/redis_password",
      "./secrets/redis_password",
      join(REPOSITORY_ROOT, "secrets", "redis_password"),
    ]) {
      refusedBy("password-source", () => validateRedisTarget(target({ passwordFile }), CLEAN_ENV), [passwordFile]);
    }
  });

  it("refuses any other password source", () => {
    for (const passwordFile of ["secrets/postgres_password", ".env", "redis_test_password", "secrets/redis_test_users.acl"]) {
      refusedBy("password-source", () => validateRedisTarget(target({ passwordFile }), CLEAN_ENV), [passwordFile]);
    }
  });

  it("refuses an unregistered logical database", () => {
    for (const db of [2, 15, -1]) {
      refusedBy("database", () => validateRedisTarget(target({ db }), CLEAN_ENV));
    }
  });

  it("refuses an inherited REDIS_HOST or REDIS_PORT that points at 6379", () => {
    const cases: Record<string, string>[] = [
      { REDIS_PORT: "6379" },
      { REDIS_PORT: " 6379 " },
      { REDIS_HOST: "127.0.0.1:6379" },
      { REDIS_HOST: "redis://127.0.0.1:6379/0" },
    ];
    for (const env of cases) {
      refusedBy("inherited-endpoint", () => validateRedisTarget(REGISTERED_TARGET, env), Object.values(env));
    }
  });

  it("does not refuse inherited variables that do not point at 6379", () => {
    validateRedisTarget(REGISTERED_TARGET, { REDIS_HOST: "127.0.0.1", REDIS_PORT: "46379" });
    validateRedisTarget(REGISTERED_TARGET, { REDIS_HOST: "127.0.0.1:46379" });
  });

  it("refuses before connecting or reading the password file", async () => {
    await assert.rejects(
      checkGuardedEndpoint(target({ passwordFile: "secrets/redis_password" }), CLEAN_ENV),
      (error: unknown) => error instanceof RedisGuardRefusal && error.check === "password-source",
    );
  });
});

describe("redis guard: the sentinel check on a GET reply", () => {
  it("accepts exactly the registered marker", () => {
    checkSentinelValue(SENTINEL_MARKER);
  });

  it("refuses a missing key and any other value, never echoing the value", () => {
    refusedBy("sentinel-missing", () => checkSentinelValue(null));
    for (const value of ["", "not-the-marker", `${SENTINEL_MARKER} `, SENTINEL_MARKER.toUpperCase()]) {
      refusedBy("sentinel-mismatch", () => checkSentinelValue(value), value === "" ? [] : [value]);
    }
  });
});

describe("redis guard: DF-3's guard-check sentinel helper", () => {
  it("its scope check accepts only the sentinel key in the guard-check database", () => {
    checkGuardCheckScope(GUARD_CHECK_DATABASE_INDEX, SENTINEL_KEY);
  });

  it("its scope check refuses database 0, any other database and any other key", () => {
    refusedBy("guard-check-scope", () => checkGuardCheckScope(MAIN_DATABASE_INDEX, SENTINEL_KEY));
    for (const db of [2, 15, -1]) {
      refusedBy("guard-check-scope", () => checkGuardCheckScope(db, SENTINEL_KEY));
    }
    for (const key of ["irs-test-x-0:key", "irs:test:sentinel:other", "", "*"]) {
      refusedBy("guard-check-scope", () => checkGuardCheckScope(GUARD_CHECK_DATABASE_INDEX, key));
    }
  });

  it("is frozen, with exactly its three operations, none taking a key or a database argument", () => {
    assert.ok(Object.isFrozen(guardCheckSentinel));
    assert.deepEqual(Reflect.ownKeys(guardCheckSentinel).sort(), ["deleteKey", "setMarker", "setWrongValue"]);
    for (const operation of Object.values(guardCheckSentinel)) {
      assert.equal(typeof operation, "function");
      assert.equal(operation.length, 0, "no parameter");
    }
  });
});

describe("redis guard: error classification", () => {
  it("uses the first word of a Redis error reply as the code", () => {
    const reply = Object.assign(new Error("NOAUTH Authentication required."), { name: "ReplyError" });
    assert.equal(redisErrorCode(reply), "NOAUTH");
    const wrongpass = Object.assign(new Error("WRONGPASS invalid username-password pair"), { name: "ReplyError" });
    assert.equal(redisErrorCode(wrongpass), "WRONGPASS");
  });

  it("uses a Node system error code, and nothing else", () => {
    assert.equal(redisErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), "ECONNREFUSED");
    assert.equal(redisErrorCode(new Error("Connection is closed.")), "UNCLASSIFIED");
    assert.equal(redisErrorCode(undefined), "UNCLASSIFIED");
  });

  it("prints only typed messages or a code", () => {
    assert.equal(safeReason(new RedisConnectionFailure("ECONNREFUSED")), "test-Redis connection failed (ECONNREFUSED)");
    assert.equal(safeReason(new RedisCommandFailure("OOM")), "test-Redis command failed (OOM)");
    assert.equal(safeReason(new Error("a raw message")), "unexpected error (UNCLASSIFIED)");
  });
});
