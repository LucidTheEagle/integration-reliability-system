import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertServerBaseline } from "./test-support/baseline.js";
import { BootstrapStop, bootstrapMain, bootstrapShadow } from "./test-support/bootstrap.js";
import {
  GuardRefusal,
  connectGuarded,
  openClient,
  requireTestUrl,
  validateTarget,
  verifyPostConnect,
  withUser,
} from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { listDatabases, listRoles, readPasswordPresence, readRole } from "./test-support/inspect.js";
import { sqlState } from "./test-support/pg.js";
import type { PgClient } from "./test-support/pg.js";
import { grantProblems, roleProfileProblems } from "./test-support/provision.js";
import { bootstrapRoles, bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { SPECIAL_ROLES, STATUS_FUNCTION, WORKER_ROLE, scratchDatabaseName } from "./test-support/registry.js";
import { withDatabase } from "./test-support/guard.js";

// Guard refusals that need the database, bootstrap re-run refusals, and the
// provisioned grant set (FD-2). Connections are api mode unless stated.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");

// Admin mode: baseline observation, seeding and catalog snapshots.
let admin: GuardedConnection;

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-guard-db" });
  await assertServerBaseline(admin.client);
});

after(async () => {
  await assertServerBaseline(admin.client);
  await admin.close();
});

async function refused(check: string, action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof GuardRefusal, `expected GuardRefusal, got ${String(error)}`);
    assert.equal(error.check, check);
    return true;
  });
}

async function withApiClient(run: (client: PgClient) => Promise<void>): Promise<void> {
  const target = validateTarget(apiUrl, "api");
  assert.equal(target.user, "irs_test_api");
  const client = await openClient(apiUrl, "irs-test-guard-db-raw");
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

describe("guard: post-connect refusals", () => {
  it("passes the real expectation (control)", async () => {
    await withApiClient((client) =>
      verifyPostConnect(client, { database: "irs_011_test", user: "irs_test_api", mode: "api" }),
    );
  });

  it("refuses a wrong sentinel marker", async () => {
    await withApiClient((client) =>
      refused("sentinel-marker", () =>
        verifyPostConnect(client, {
          database: "irs_011_test",
          user: "irs_test_api",
          mode: "api",
          sentinelMarker: randomUUID(),
        }),
      ),
    );
  });

  it("refuses a missing sentinel row (this database holds no row for another name)", async () => {
    await withApiClient((client) =>
      refused("sentinel", () =>
        verifyPostConnect(client, {
          database: "irs_011_test",
          user: "irs_test_api",
          mode: "api",
          sentinelDatabase: "irs_011_shadow_test",
        }),
      ),
    );
  });

  it("refuses a wrong current_user", async () => {
    await withApiClient((client) =>
      refused("current-user", () =>
        verifyPostConnect(client, { database: "irs_011_test", user: "postgres", mode: "api" }),
      ),
    );
  });

  it("refuses a wrong current_database", async () => {
    await withApiClient((client) =>
      refused("database", () =>
        verifyPostConnect(client, { database: "irs_011_shadow_test", user: "irs_test_api", mode: "api" }),
      ),
    );
  });

  it("refuses a role without the sentinel privileges", async () => {
    await refused("sentinel-privileges", () =>
      connectGuarded({
        url: withUser(apiUrl, "irs_test_no_sentinel"),
        mode: "special",
        special: "irs_test_no_sentinel",
      }),
    );
  });

  it("api mode verifies a non-privileged role (control)", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    await api.close();
  });

  it("each registered special role with sentinel privileges passes, including its exact grants", async () => {
    for (const role of SPECIAL_ROLES.filter((entry) => entry.sentinelPrivileges)) {
      const special = await connectGuarded({
        url: withUser(apiUrl, role.name),
        mode: "special",
        special: role.name,
      });
      await special.close();
    }
  });
});

describe("guard: worker mode in the database (Task 012B, B1-8, Q2)", () => {
  const workerUrl = requireTestUrl("IRS_TEST_WORKER_DATABASE_URL");

  it("worker mode passes for irs_test_worker on irs_011_test: profile, sentinel and exact grant set (control)", async () => {
    validateTarget(workerUrl, "worker");
    const worker = await connectGuarded({ url: workerUrl, mode: "worker" });
    await worker.close();
  });

  it("refuses with role-profile when another role is verified against the worker's profile (irs_test_api is INHERIT, no limit)", async () => {
    await withApiClient((client) =>
      refused("role-profile", () => verifyPostConnect(client, { database: "irs_011_test", user: "irs_test_api", mode: "worker" })),
    );
  });

  it("refuses with worker-grants where the worker holds the sentinel but not its registered grants (a scratch database without them)", async () => {
    const adminScratchUrl = await bootstrapScratch(admin, adminUrl, "dispatch");
    try {
      // The scratch database's sentinel grants the worker read access; no migration and no application grant.
      await refused("worker-grants", () =>
        connectGuarded({ url: withDatabase(workerUrl, scratchDatabaseName("dispatch")), mode: "worker" }),
      );
      void adminScratchUrl;
    } finally {
      await dropScratch(admin, "dispatch");
    }
  });

  it("the worker's profile holds in both directions, with no password (admin, Boolean only)", async () => {
    const record = await readRole(admin.client, WORKER_ROLE);
    assert.deepEqual(record, {
      name: WORKER_ROLE,
      super: false,
      login: true,
      createdb: false,
      createrole: false,
      replication: false,
      bypassrls: false,
      inherit: false,
      memberOf: [],
      connectionLimit: 16,
      validUntilSet: false,
      members: [],
    });
    assert.equal(await readPasswordPresence(admin.client, WORKER_ROLE), false);
    // Control: the Boolean read distinguishes a missing role (undefined) from a role without a password.
    assert.equal(await readPasswordPresence(admin.client, `irs_test_absent_${randomUUID().slice(0, 8)}`), undefined);
    assert.deepEqual(await roleProfileProblems(admin.client), []);
  });

  it("bootstrap-roles on the provisioned cluster reports the worker present and verified, and changes nothing", async () => {
    const rolesBefore = await listRoles(admin.client);
    const evidence = await bootstrapRoles(adminUrl);
    assert.ok(evidence.some((line) => line.startsWith(`present, verified: ${WORKER_ROLE}`)), evidence.join(" | "));
    assert.deepEqual(await listRoles(admin.client), rolesBefore);
  });
});

describe("bootstrap re-runs stop", () => {
  it("bootstrap-main stops on the existing state and changes nothing", async () => {
    const rolesBefore = await listRoles(admin.client);
    await assert.rejects(bootstrapMain(adminUrl), (error: unknown) => {
      assert.ok(error instanceof BootstrapStop);
      assert.equal(error.step, "preconditions");
      assert.ok(error.state.some((line) => line.includes("irs_test_meta")));
      return true;
    });
    assert.deepEqual(await listRoles(admin.client), rolesBefore);
  });

  it("bootstrap-shadow stops because the database exists (no IF NOT EXISTS)", async () => {
    const databasesBefore = await listDatabases(admin.client);
    await assert.rejects(bootstrapShadow(admin.client, adminUrl), (error: unknown) => {
      assert.ok(error instanceof BootstrapStop);
      assert.equal(error.step, "create-database");
      assert.match(error.state.join(" "), /already exists/);
      return true;
    });
    assert.deepEqual(await listDatabases(admin.client), databasesBefore);
  });
});

describe("provisioned grants (FD-2)", () => {
  const ACTIVE_ID = "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a0001";

  before(async () => {
    // Admin mode: test-data seeding.
    await admin.client.query(
      `INSERT INTO "public"."Integration" ("id", "name", "provider", "type", "configStatus", "environment", "updatedAt")
       VALUES ($1, 'guard-db seed', 'test', 'test', 'ACTIVE', 'test', now())`,
      [ACTIVE_ID],
    );
  });

  after(async () => {
    // Admin mode: removes the seed row.
    await admin.client.query(`DELETE FROM "public"."Integration" WHERE "id" = $1`, [ACTIVE_ID]);
  });

  it("every role holds exactly its registered grants; the function owner is the NOLOGIN role; PUBLIC has no EXECUTE", async () => {
    assert.deepEqual(await grantProblems(admin.client), []);
  });

  it("irs_test_api cannot read or write Integration directly, yet the status check works through the function", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      const denied = [
        [`SELECT "configStatus" FROM "public"."Integration" WHERE "id" = $1`, [ACTIVE_ID]],
        [`UPDATE "public"."Integration" SET "configStatus" = 'DISABLED' WHERE "id" = $1`, [ACTIVE_ID]],
        [`UPDATE "public"."Integration" SET "updatedAt" = now() WHERE "id" = $1`, [ACTIVE_ID]],
        [`DELETE FROM "public"."Integration" WHERE "id" = $1`, [ACTIVE_ID]],
        [`SELECT "configStatus" FROM "public"."Integration" WHERE "id" = $1 FOR SHARE`, [ACTIVE_ID]],
      ] as const;
      for (const [sql, values] of denied) {
        await assert.rejects(api.client.query(sql, values), (error: unknown) => {
          assert.equal(sqlState(error), "42501", sql);
          return true;
        });
      }

      await api.client.query("BEGIN");
      try {
        const status = await api.client.query<{ configStatus: string | null }>(
          `SELECT "public"."${STATUS_FUNCTION}"($1) AS "configStatus"`,
          [ACTIVE_ID],
        );
        assert.equal(status.rows[0]?.configStatus, "ACTIVE");
        const missing = await api.client.query<{ configStatus: string | null }>(
          `SELECT "public"."${STATUS_FUNCTION}"($1) AS "configStatus"`,
          [randomUUID()],
        );
        assert.equal(missing.rows[0]?.configStatus, null);
      } finally {
        await api.client.query("ROLLBACK");
      }

      const publicExecute = await api.client.query<{ allowed: boolean }>(
        `SELECT has_function_privilege('public', 'public.${STATUS_FUNCTION}(uuid)', 'EXECUTE') AS allowed`,
      );
      assert.equal(publicExecute.rows[0]?.allowed, false);
    } finally {
      await api.close();
    }
  });
});
