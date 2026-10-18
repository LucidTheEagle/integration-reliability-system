import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ingestEvent } from "./event-ingestion.js";
import { STATUS_FUNCTION_BODY } from "./schema-readiness.js";
import { assertServerBaseline } from "./test-support/baseline.js";
import { bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { guardedDatabase, ingestionInput } from "./test-support/database.js";
import { connectGuarded, requireTestUrl, withDatabase } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { migrateScratch } from "./test-support/provision.js";
import { API_ROLE, LOCK_OWNER_ROLE, scratchDatabaseName } from "./test-support/registry.js";

// VPF-3a catalog proof (the function as created and provisioned), and the
// V2 decoy test (DB-T1): ingestion writes only to "public" even when another
// schema with the same tables comes first on the search_path.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");

// Admin mode: baseline observation and the registered scratch database.
let admin: GuardedConnection;

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-status-function-admin" });
  await assertServerBaseline(admin.client);
});

after(async () => {
  await assertServerBaseline(admin.client);
  await admin.close();
});

describe("VPF-3a: the status function in the catalog (api mode reads)", () => {
  it("SECURITY DEFINER, VOLATILE, fixed search_path, uuid → IntegrationConfigState, the specified body, owned by the NOLOGIN role", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      const rows = (
        await api.client.query<Record<string, unknown>>(
          `SELECT pg_get_function_identity_arguments(p.oid) AS args, rn.nspname || '.' || rt.typname AS returns,
                  p.proretset, p.prosecdef, p.provolatile::text AS provolatile, p.proconfig, p.prosrc, l.lanname::text AS lanname,
                  r.rolname AS owner, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                  has_function_privilege($1, p.oid, 'EXECUTE') AS api_execute
             FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             JOIN pg_catalog.pg_type rt ON rt.oid = p.prorettype
             JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.typnamespace
             JOIN pg_catalog.pg_language l ON l.oid = p.prolang
             JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
            WHERE n.nspname = 'public' AND p.proname = 'irs_integration_config_status_for_share'`,
          [API_ROLE],
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        args: "p_integration_id uuid",
        returns: "public.IntegrationConfigState",
        proretset: false,
        prosecdef: true,
        provolatile: "v",
        proconfig: ["search_path=pg_catalog, pg_temp"],
        prosrc: STATUS_FUNCTION_BODY,
        lanname: "sql",
        owner: LOCK_OWNER_ROLE,
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        public_execute: false,
        api_execute: true,
      });
    } finally {
      await api.close();
    }
  });

  it("the owner holds exactly what the body needs on Integration; irs_test_api holds nothing there", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      const check = async (role: string, column: string, privilege: string) =>
        (
          await api.client.query<{ ok: boolean }>(
            `SELECT has_column_privilege($1, '"public"."Integration"', $2, $3) AS ok`,
            [role, column, privilege],
          )
        ).rows[0]?.ok;
      assert.equal(await check(LOCK_OWNER_ROLE, "id", "SELECT"), true);
      assert.equal(await check(LOCK_OWNER_ROLE, "configStatus", "SELECT"), true);
      assert.equal(await check(LOCK_OWNER_ROLE, "updatedAt", "UPDATE"), true);
      assert.equal(await check(LOCK_OWNER_ROLE, "configStatus", "UPDATE"), false);
      assert.equal(await check(LOCK_OWNER_ROLE, "name", "SELECT"), false);
      for (const [column, privilege] of [["configStatus", "SELECT"], ["configStatus", "UPDATE"], ["updatedAt", "UPDATE"], ["id", "SELECT"]]) {
        assert.equal(await check(API_ROLE, column ?? "", privilege ?? ""), false, `${API_ROLE} ${privilege} ${column}`);
      }
      const table = async (role: string, privilege: string) =>
        (await api.client.query<{ ok: boolean }>(`SELECT has_table_privilege($1, '"public"."Integration"', $2) AS ok`, [role, privilege])).rows[0]?.ok;
      for (const privilege of ["INSERT", "DELETE", "TRUNCATE"]) {
        assert.equal(await table(LOCK_OWNER_ROLE, privilege), false);
        assert.equal(await table(API_ROLE, privilege), false);
      }
    } finally {
      await api.close();
    }
  });
});

describe("DB-T1 / V2 decoy: a decoy schema first on the search_path receives nothing", () => {
  it("ingestion reads the status from public and writes only public tables", async () => {
    const purpose = "decoy";
    const scratchUrl = await bootstrapScratch(admin, adminUrl, purpose);
    const apiScratchUrl = withDatabase(apiUrl, scratchDatabaseName(purpose));
    let scratch: GuardedConnection | undefined;
    try {
      const integrationId = randomUUID();
      await migrateScratch(scratchUrl, [API_ROLE], [
        `CREATE SCHEMA "decoy"`,
        `CREATE TABLE "decoy"."Integration" (LIKE "public"."Integration" INCLUDING ALL)`,
        `CREATE TABLE "decoy"."Event" (LIKE "public"."Event" INCLUDING ALL)`,
        `CREATE TABLE "decoy"."AuditEntry" (LIKE "public"."AuditEntry" INCLUDING ALL)`,
        `GRANT USAGE ON SCHEMA "decoy" TO "${API_ROLE}"`,
        `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA "decoy" TO "${API_ROLE}"`,
        `ALTER DATABASE "${scratchDatabaseName(purpose)}" SET search_path = "decoy", "public"`,
      ]);
      scratch = await connectGuarded({ url: scratchUrl, mode: "admin", applicationName: "irs-test-decoy" });
      await scratch.client.query(
        `INSERT INTO "public"."Integration" ("id", "name", "provider", "type", "configStatus", "environment", "updatedAt") VALUES ($1, 'p', 't', 't', 'ACTIVE', 't', now())`,
        [integrationId],
      );
      await scratch.client.query(
        `INSERT INTO "decoy"."Integration" ("id", "name", "provider", "type", "configStatus", "environment", "updatedAt") VALUES ($1, 'd', 't', 't', 'DISABLED', 't', now())`,
        [integrationId],
      );
      const db = await guardedDatabase({ url: apiScratchUrl, mode: "api" });
      try {
        const path = (await db.prisma.$queryRaw<{ path: string }[]>`SELECT current_setting('search_path') AS path`)[0]?.path;
        process.stdout.write(`[V2 decoy] api session search_path: ${String(path)}\n`);
        assert.equal(path, "decoy, public");
        assert.equal((await ingestEvent(db, ingestionInput(integrationId, "decoy-1"))).disposition, "NEW");
        assert.equal((await ingestEvent(db, ingestionInput(integrationId, "decoy-1"))).disposition, "DUPLICATE");
      } finally {
        await db.prisma.$disconnect();
      }
      const counts = (
        await scratch.client.query<Record<string, number>>(
          `SELECT (SELECT count(*)::int FROM "public"."Event") AS public_event, (SELECT count(*)::int FROM "public"."AuditEntry") AS public_audit,
                  (SELECT count(*)::int FROM "decoy"."Event") AS decoy_event, (SELECT count(*)::int FROM "decoy"."AuditEntry") AS decoy_audit`,
        )
      ).rows[0];
      process.stdout.write(`[V2 decoy] row counts: ${JSON.stringify(counts)}\n`);
      assert.deepEqual(counts, { public_event: 1, public_audit: 2, decoy_event: 0, decoy_audit: 0 });
      await scratch.client.query(`ALTER DATABASE "${scratchDatabaseName(purpose)}" RESET search_path`);
    } finally {
      await scratch?.close();
      await dropScratch(admin, purpose);
    }
  });
});
