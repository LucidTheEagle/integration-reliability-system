import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GuardRefusal, parseTestUrl, validateTarget, withDatabase } from "./test-support/guard.js";
import { SPECIAL_ROLES, scratchDatabaseName } from "./test-support/registry.js";

// Database-free guard refusals (Prompt B §4.1–§4.2). No connection is made.

const ADMIN = "postgresql://postgres@127.0.0.1:55433/irs_011_test";
const API = "postgresql://irs_test_api@127.0.0.1:55433/irs_011_test";

function refusedBy(check: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof GuardRefusal, "expected a GuardRefusal");
    assert.equal(error.check, check);
    assert.doesNotMatch(error.message, /postgresql:\/\//, "a refusal never echoes the URL");
    return true;
  });
}

describe("guard: endpoint and name checks (every mode)", () => {
  it("accepts the two registered URLs in their modes", () => {
    assert.deepEqual(validateTarget(ADMIN, "admin"), {
      host: "127.0.0.1",
      port: 55433,
      database: "irs_011_test",
      user: "postgres",
    });
    assert.equal(validateTarget(API, "api").user, "irs_test_api");
  });

  it("refuses a wrong host", () => {
    refusedBy("host", () => parseTestUrl("postgresql://postgres@127.0.0.2:55433/irs_011_test"));
    refusedBy("host", () => parseTestUrl("postgresql://postgres@10.0.0.5:55433/irs_011_test"));
  });

  it("refuses localhost, which may resolve elsewhere", () => {
    refusedBy("host", () => parseTestUrl("postgresql://postgres@localhost:55433/irs_011_test"));
  });

  it("refuses every port but 55433", () => {
    refusedBy("port", () => parseTestUrl("postgresql://postgres@127.0.0.1:5432/irs_011_test"));
    refusedBy("port", () => parseTestUrl("postgresql://postgres@127.0.0.1:55432/irs_011_test"));
    refusedBy("port", () => parseTestUrl("postgresql://postgres@127.0.0.1/irs_011_test"));
  });

  it("refuses a protocol other than postgresql", () => {
    refusedBy("protocol", () => parseTestUrl("postgres://postgres@127.0.0.1:55433/irs_011_test"));
  });

  it("refuses unregistered databases, including irs_dev and unregistered scratch names", () => {
    refusedBy("database", () => parseTestUrl("postgresql://postgres@127.0.0.1:55433/irs_dev"));
    refusedBy("database", () => parseTestUrl("postgresql://postgres@127.0.0.1:55433/postgres"));
    refusedBy("database", () => parseTestUrl("postgresql://postgres@127.0.0.1:55433/irs_test"));
    refusedBy("database", () =>
      parseTestUrl(`postgresql://postgres@127.0.0.1:55433/${scratchDatabaseName("unregistered")}`),
    );
  });

  it("accepts the shadow and registered scratch databases structurally", () => {
    assert.equal(parseTestUrl(withDatabase(ADMIN, "irs_011_shadow_test")).database, "irs_011_shadow_test");
    assert.equal(
      parseTestUrl(withDatabase(ADMIN, scratchDatabaseName("migt1"))).database,
      "irs_011_scratch_migt1_test",
    );
  });

  it("refuses a password or query parameters", () => {
    refusedBy("password", () => parseTestUrl("postgresql://postgres:secret@127.0.0.1:55433/irs_011_test"));
    refusedBy("query", () => parseTestUrl("postgresql://postgres@127.0.0.1:55433/irs_011_test?schema=public"));
    refusedBy("query", () => parseTestUrl("postgresql://postgres@127.0.0.1:55433/irs_011_test?"));
  });

  it("refuses a URL without a user", () => {
    refusedBy("user", () => parseTestUrl("postgresql://127.0.0.1:55433/irs_011_test"));
  });
});

describe("guard: mode and role pairing", () => {
  it("refuses the admin URL in api mode and the api URL in admin mode", () => {
    refusedBy("mode-user", () => validateTarget(ADMIN, "api"));
    refusedBy("mode-user", () => validateTarget(API, "admin"));
  });

  it("refuses any non-admin connection to the shadow database", () => {
    refusedBy("mode-database", () =>
      validateTarget("postgresql://irs_test_api@127.0.0.1:55433/irs_011_shadow_test", "api"),
    );
  });

  it("refuses a role not registered for a scratch database", () => {
    refusedBy("mode-database", () =>
      validateTarget(`postgresql://irs_test_api@127.0.0.1:55433/${scratchDatabaseName("migt1")}`, "api"),
    );
  });

  it("refuses an unregistered special role, whatever its name prefix", () => {
    refusedBy("special-role", () =>
      validateTarget("postgresql://irs_test_api_extra@127.0.0.1:55433/irs_011_test", "special", "irs_test_api_extra"),
    );
    refusedBy("special-role", () => validateTarget(API, "special", undefined));
  });

  it("accepts each registered special role only under its own name", () => {
    for (const role of SPECIAL_ROLES) {
      const url = `postgresql://${role.name}@127.0.0.1:55433/irs_011_test`;
      assert.equal(validateTarget(url, "special", role.name).user, role.name);
      refusedBy("mode-user", () => validateTarget(API, "special", role.name));
    }
  });
});
