import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GuardRefusal, expectedGrantsInMain, parseTestUrl, requireTestUrl, validateTarget, withDatabase } from "./test-support/guard.js";
import { roleStatement } from "./test-support/bootstrap.js";
import {
  APPLICATION_GRANTS,
  BOOTSTRAP_ROLES,
  INCREMENTAL_ROLES,
  MAIN_SENTINEL_ROLES,
  ROLE_PROFILES,
  SPECIAL_ROLES,
  WORKER_CONNECTION_LIMIT,
  WORKER_ROLE,
  scratchDatabaseName,
} from "./test-support/registry.js";

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

describe("guard: worker mode (Task 012B, B1-8)", () => {
  const WORKER = "postgresql://irs_test_worker@127.0.0.1:55433/irs_011_test";

  it("accepts the worker URL in worker mode only, and no other user in worker mode", () => {
    assert.deepEqual(validateTarget(WORKER, "worker"), {
      host: "127.0.0.1",
      port: 55433,
      database: "irs_011_test",
      user: "irs_test_worker",
    });
    refusedBy("mode-user", () => validateTarget(WORKER, "api"));
    refusedBy("mode-user", () => validateTarget(WORKER, "admin"));
    refusedBy("mode-user", () => validateTarget(API, "worker"));
    refusedBy("mode-user", () => validateTarget(ADMIN, "worker"));
    refusedBy("special-role", () => validateTarget(WORKER, "special", "irs_test_worker"));
  });

  it("refuses the worker on the shadow database and on a scratch database it is not registered for", () => {
    refusedBy("mode-database", () => validateTarget(withDatabase(WORKER, "irs_011_shadow_test"), "worker"));
    for (const purpose of ["migt1", "rdt1", "rle"]) {
      refusedBy("mode-database", () => validateTarget(withDatabase(WORKER, scratchDatabaseName(purpose)), "worker"));
    }
  });

  it("accepts the worker on the three Task 012B scratch purposes, and the API role there too", () => {
    for (const purpose of ["dispatch", "dispatchtime", "dispatchready"]) {
      assert.equal(validateTarget(withDatabase(WORKER, scratchDatabaseName(purpose)), "worker").user, "irs_test_worker");
      assert.equal(validateTarget(withDatabase(API, scratchDatabaseName(purpose)), "api").user, "irs_test_api");
    }
  });

  it("refuses a worker URL carrying a password, like every test URL", () => {
    refusedBy("password", () => parseTestUrl("postgresql://irs_test_worker:secret@127.0.0.1:55433/irs_011_test"));
  });

  it("IRS_TEST_WORKER_DATABASE_URL is required by name and fails loudly when missing or empty", () => {
    const saved = process.env.IRS_TEST_WORKER_DATABASE_URL;
    try {
      delete process.env.IRS_TEST_WORKER_DATABASE_URL;
      refusedBy("environment", () => requireTestUrl("IRS_TEST_WORKER_DATABASE_URL"));
      process.env.IRS_TEST_WORKER_DATABASE_URL = "";
      refusedBy("environment", () => requireTestUrl("IRS_TEST_WORKER_DATABASE_URL"));
      process.env.IRS_TEST_WORKER_DATABASE_URL = WORKER;
      assert.equal(requireTestUrl("IRS_TEST_WORKER_DATABASE_URL"), WORKER);
    } finally {
      if (saved === undefined) delete process.env.IRS_TEST_WORKER_DATABASE_URL;
      else process.env.IRS_TEST_WORKER_DATABASE_URL = saved;
    }
  });
});

describe("registry: the worker role (Task 012B, PL-5, PL-6.1, FD-1)", () => {
  it("is registered with its profile, LOGIN NOINHERIT CONNECTION LIMIT 16, and is the only incremental role", () => {
    assert.equal(WORKER_ROLE, "irs_test_worker");
    assert.equal(WORKER_CONNECTION_LIMIT, 16);
    assert.deepEqual(ROLE_PROFILES[WORKER_ROLE], { login: true, inherit: false, connectionLimit: 16 });
    assert.deepEqual([...INCREMENTAL_ROLES], [WORKER_ROLE]);
    assert.ok(BOOTSTRAP_ROLES.some((role) => role.name === WORKER_ROLE && role.login));
    assert.ok(MAIN_SENTINEL_ROLES.includes(WORKER_ROLE));
    assert.deepEqual(Object.keys(ROLE_PROFILES).sort(), BOOTSTRAP_ROLES.map((role) => role.name).sort());
  });

  it("every Task 011 role keeps its observed profile (INHERIT, no connection limit)", () => {
    for (const role of BOOTSTRAP_ROLES.filter((entry) => entry.name !== WORKER_ROLE)) {
      assert.deepEqual(ROLE_PROFILES[role.name], { login: role.login, inherit: true, connectionLimit: -1 }, role.name);
    }
  });

  it("roleStatement writes the profile explicitly, with no password and no expiry", () => {
    assert.equal(
      roleStatement(WORKER_ROLE),
      `CREATE ROLE "irs_test_worker" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16`,
    );
    assert.equal(
      roleStatement("irs_test_status_lock_owner"),
      `CREATE ROLE "irs_test_status_lock_owner" NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1`,
    );
    for (const role of BOOTSTRAP_ROLES) assert.doesNotMatch(roleStatement(role.name), /PASSWORD|VALID UNTIL/i);
  });

  it("the worker's exact expected grant set is the 28 catalog keys of PL-5, and nothing on the payload", () => {
    const expected = [
      ...["id", "status", "receivedAt", "queuedAt", "lastPublishAttemptAt", "publishAttemptCount", "publishAckedAt", "lastPublishAckAt",
        "redispatchRequestedAt", "redispatchCount", "dispatchAnomalyAt", "dispatchAnomalyKind"].map((c) => `COLUMN public.Event.${c} SELECT`),
      ...["status", "queuedAt", "lastPublishAttemptAt", "publishAttemptCount", "publishAckedAt", "lastPublishAckAt",
        "redispatchRequestedAt", "redispatchCount", "dispatchAnomalyAt", "dispatchAnomalyKind"].map((c) => `COLUMN public.Event.${c} UPDATE`),
      "TABLE public.AuditEntry INSERT",
      ...["migration_name", "finished_at", "rolled_back_at"].map((c) => `COLUMN public._prisma_migrations.${c} SELECT`),
      "SCHEMA irs_test_meta USAGE",
      "TABLE irs_test_meta.sentinel SELECT",
    ].sort();
    assert.equal(expected.length, 28);
    assert.deepEqual(expectedGrantsInMain(WORKER_ROLE), expected);
    assert.equal(APPLICATION_GRANTS[WORKER_ROLE]?.length, 26);
    for (const key of expectedGrantsInMain(WORKER_ROLE)) {
      assert.doesNotMatch(key, /payload|rawBody|metadata|integrationId|externalEventId|EXECUTE|DELETE|TRUNCATE|CREATE/, key);
    }
  });

  it("control: the Task 011 roles' expected grant sets are unchanged by the worker's addition", () => {
    assert.equal(expectedGrantsInMain("irs_test_api").length, 33);
    assert.equal(expectedGrantsInMain("irs_test_api_no_execute").length, 11);
    assert.equal(expectedGrantsInMain("irs_test_api_no_ledger").length, 9);
    assert.equal(expectedGrantsInMain("irs_test_api_role_setting").length, 12);
    assert.equal(expectedGrantsInMain("irs_test_no_sentinel").length, 0);
  });
});
