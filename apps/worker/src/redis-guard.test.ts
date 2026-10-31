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
  checkSelectedDatabase,
  checkSentinelValue,
  describeClientInfoShape,
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

// ---- Task 012B (Q4, PL-11; B1-12 carry-forward 1): the CLIENT INFO db= parser ----

/** A CLIENT INFO-like reply around the given db tokens (Redis's reply ends with one "\n"). */
function reply(dbTokens: string): string {
  return `id=7 addr=127.0.0.1:50000 laddr=127.0.0.1:46379 fd=8 name= age=0 idle=0 flags=N ${dbTokens} sub=0 psub=0 cmd=client|info user=default resp=2\n`;
}

describe("redis guard: checkSelectedDatabase (Q4)", () => {
  it("positive control: well-formed replies naming the expected database pass, with or without the trailing newline", () => {
    checkSelectedDatabase(reply("db=0"), MAIN_DATABASE_INDEX);
    checkSelectedDatabase(reply("db=1"), GUARD_CHECK_DATABASE_INDEX);
    checkSelectedDatabase(reply("db=1").slice(0, -1), GUARD_CHECK_DATABASE_INDEX);
    checkSelectedDatabase("db=1\n", GUARD_CHECK_DATABASE_INDEX);
  });

  it("refuses a reply that is not one line of single-space key=value tokens (database-reply)", () => {
    for (const text of ["", "\n", "\n\n", `${reply("db=1")}\n`, reply("db=1").replace(" fd=8", "\nfd=8"), reply("db=1").replace(" fd=8", "  fd=8"),
      ` ${reply("db=1")}`, reply("db=1").replace("flags=N", "flags"), reply("db=1").replace("flags=N", "=N"), reply("db=1").replace("\n", "\r\n")]) {
      refusedBy("database-reply", () => checkSelectedDatabase(text, GUARD_CHECK_DATABASE_INDEX));
    }
  });

  it("refuses a missing field, a look-alike key only, and duplicate fields equal or different (database-field)", () => {
    for (const tokens of ["xdb=1", "dbx=1", "DB=1", "db=1 db=1", "db=1 db=0", "db=0 db=1"]) {
      refusedBy("database-field", () => checkSelectedDatabase(reply(tokens), GUARD_CHECK_DATABASE_INDEX), [tokens]);
    }
    refusedBy("database-field", () => checkSelectedDatabase(reply("").replace("  ", " "), GUARD_CHECK_DATABASE_INDEX));
  });

  it("refuses an empty, signed, negative, non-decimal, fractional, leading-zero or overlong value (database-value)", () => {
    for (const value of ["", "+1", "-1", "0x1", "1a", "1.0", " 1", "01", "00", "0001", "1234567890", "18446744073709551617"]) {
      const text = value === " 1" ? reply("db=").replace("db= ", "db= 1 ") : reply(`db=${value}`);
      refusedBy("database-value", () => checkSelectedDatabase(text, GUARD_CHECK_DATABASE_INDEX), value === "" ? [] : [value]);
    }
  });

  it("refuses a well-formed number that is not the expected database (database-mismatch)", () => {
    refusedBy("database-mismatch", () => checkSelectedDatabase(reply("db=0"), GUARD_CHECK_DATABASE_INDEX));
    refusedBy("database-mismatch", () => checkSelectedDatabase(reply("db=1"), MAIN_DATABASE_INDEX));
    refusedBy("database-mismatch", () => checkSelectedDatabase(reply("db=15"), GUARD_CHECK_DATABASE_INDEX));
  });

  it("refuses an unregistered expected index before reading the reply (database-expected)", () => {
    for (const expected of [2, 15, -1, 1.5]) {
      refusedBy("database-expected", () => checkSelectedDatabase(reply("db=1"), expected));
    }
  });
});

describe("redis guard: describeClientInfoShape (Part B5 decision 3; the RUN B observation)", () => {
  const OTHER_VALUES = ["127.0.0.1:50000", "127.0.0.1:46379", "client|info", "default", "VALUE-PLANTED", "Bad_Key"];

  it("reports each field of a well-formed reply, and the verdict of the strict check", () => {
    const shape = describeClientInfoShape(reply("db=1"));
    assert.deepEqual(
      { ...shape, keyNames: [...shape.keyNames] },
      {
        lineCount: 1,
        endsWithSingleNewline: true,
        tokenCount: 14,
        allTokensKeyValue: true,
        keyNames: ["id", "addr", "laddr", "fd", "name", "age", "idle", "flags", "db", "sub", "psub", "cmd", "user", "resp"],
        dbTokenCount: 1,
        dbValue: "1",
        verdict: "accepted",
      },
    );
  });

  it("reports malformed and ambiguous shapes without throwing, with the strict check's refusal code", () => {
    const duplicate = describeClientInfoShape(reply("db=1 db=0"));
    assert.equal(duplicate.dbTokenCount, 2);
    assert.equal(duplicate.dbValue, null, "no db value unless exactly one db token");
    assert.equal(duplicate.verdict, "database-field");
    const twoLines = describeClientInfoShape(`${reply("db=1")}x=1\n`);
    assert.equal(twoLines.lineCount, 2);
    assert.equal(twoLines.endsWithSingleNewline, true);
    assert.equal(twoLines.allTokensKeyValue, false);
    assert.equal(twoLines.verdict, "database-reply");
    const noNewline = describeClientInfoShape(reply("db=1").slice(0, -1));
    assert.equal(noNewline.endsWithSingleNewline, false);
    assert.equal(noNewline.verdict, "accepted");
    const doubleNewline = describeClientInfoShape(`${reply("db=1")}\n`);
    assert.equal(doubleNewline.endsWithSingleNewline, false);
    assert.equal(doubleNewline.verdict, "database-reply");
    assert.equal(describeClientInfoShape(reply("db=01")).verdict, "database-value");
    assert.equal(describeClientInfoShape(reply("db=0")).verdict, "database-mismatch");
    assert.equal(describeClientInfoShape(reply("db=0")).dbValue, "0");
    assert.equal(describeClientInfoShape("").verdict, "database-reply");
  });

  it("never returns a value other than db's: no field holds any other token's value or fragment", () => {
    const planted = `${reply("db=1").slice(0, -1)} secret=VALUE-PLANTED-1 x=y=VALUE-PLANTED-2 VALUE-PLANTED-3 Bad_Key=VALUE-PLANTED-4\n`;
    for (const text of [reply("db=1"), planted, planted.replace("\n", "\nVALUE-PLANTED-5=6\n")]) {
      const serialized = JSON.stringify(describeClientInfoShape(text));
      for (const value of OTHER_VALUES) assert.ok(!serialized.includes(value), `${value} is not returned`);
    }
    // Control: the same check does find a value that is present in the input.
    assert.ok(planted.includes("VALUE-PLANTED") && planted.includes("127.0.0.1:50000"));
    // Positive control: the db value itself is returned, and the planted key name (a plain name) is listed.
    const shape = describeClientInfoShape(planted);
    assert.equal(shape.dbValue, "1");
    assert.ok(shape.keyNames.includes("secret"));
    assert.ok(!shape.keyNames.includes("Bad_Key"), "a key that is not a plain name is not listed");
    assert.equal(shape.allTokensKeyValue, false, "the token without '=' is counted, not listed");
  });

  it("is pure: frozen output, and the same input gives the same output", () => {
    const text = reply("db=1");
    assert.ok(Object.isFrozen(describeClientInfoShape(text)));
    assert.deepEqual(describeClientInfoShape(text), describeClientInfoShape(text));
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
