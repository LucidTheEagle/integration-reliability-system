import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertServerBaseline } from "./test-support/baseline.js";
import { bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { connectGuarded, requireTestUrl, withDatabase } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { sqlState } from "./test-support/pg.js";
import type { PgClient } from "./test-support/pg.js";
import { runPrismaCli } from "./test-support/prisma-cli.js";
import { SHADOW_DATABASE, STATUS_FUNCTION } from "./test-support/registry.js";

// MIG-T1 – MIG-T3 (Rev 1.7 §16.3) and M2 (Addendum VPF-6).

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");

const MIGRATION_NAME = readdirSync(fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url)), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)[0];

/** Golden PostgreSQL 17 text, captured once (2026-10-17) and changed only by deliberate review. */
const GOLDEN_CHECKS = {
  Event_rawBodySha256_format_check: `CHECK (("rawBodySha256" ~ '^[0-9a-f]{64}$'::text))`,
  Event_rawBody_length_check: `CHECK (((octet_length("rawBody") >= 1) AND (octet_length("rawBody") <= 1048576)))`,
};

// Admin mode: migrations, scratch databases and catalog snapshots.
let admin: GuardedConnection;

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-migration-db" });
  await assertServerBaseline(admin.client);
});

after(async () => {
  await assertServerBaseline(admin.client);
  await admin.close();
});

async function checkConstraints(client: PgClient): Promise<Record<string, { def: string; validated: boolean }>> {
  const result = await client.query<{ conname: string; def: string; convalidated: boolean }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public."Event"'::regclass AND contype = 'c' ORDER BY conname`,
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.conname, { def: row.def, validated: row.convalidated }]),
  );
}

async function mainSnapshot(client: PgClient): Promise<unknown> {
  const relations = await client.query(
    `SELECT n.nspname, c.relname, c.relkind FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'irs_test_meta') ORDER BY 1, 2`,
  );
  const ledger = await client.query(
    `SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count
       FROM "public"."_prisma_migrations" ORDER BY started_at`,
  );
  const sentinel = await client.query(`SELECT database_name, marker FROM "irs_test_meta"."sentinel"`);
  const fn = await client.query(
    `SELECT p.prosrc, pg_get_userbyid(p.proowner) AS owner FROM pg_catalog.pg_proc p WHERE p.proname = $1`,
    [STATUS_FUNCTION],
  );
  return { relations: relations.rows, ledger: ledger.rows, sentinel: sentinel.rows, fn: fn.rows };
}

describe("MIG-T1: migrate deploy on an empty database", () => {
  it("applies the init migration to an empty registered scratch database; the catalog matches", async () => {
    assert.ok(MIGRATION_NAME !== undefined);
    const scratchUrl = await bootstrapScratch(admin, adminUrl, "migt1");
    try {
      const deploy = await runPrismaCli(["migrate", "deploy", "--config", "prisma7.config.ts"], {
        DATABASE_URL: scratchUrl,
      });
      assert.equal(deploy.exitCode, 0, deploy.stderr);
      assert.match(deploy.stdout, new RegExp(`Applying migration \`${MIGRATION_NAME}\``));

      // Admin mode: no test role is registered for this scratch database.
      const scratch = await connectGuarded({ url: scratchUrl, mode: "admin", applicationName: "irs-test-migt1" });
      try {
        const c = scratch.client;
        const index = await c.query<{ def: string }>(
          `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_catalog.pg_index i
             JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid WHERE x.relname = 'Event_integrationId_externalEventId_key'`,
        );
        assert.equal(
          index.rows[0]?.def,
          `CREATE UNIQUE INDEX "Event_integrationId_externalEventId_key" ON public."Event" USING btree ("integrationId", "externalEventId")`,
        );

        const fk = await c.query<{ ref: string; cols: string; del: string; upd: string }>(
          `SELECT confrelid::regclass::text AS ref,
                  (SELECT string_agg(a.attname, ',') FROM pg_catalog.pg_attribute a
                    WHERE a.attrelid = co.conrelid AND a.attnum = ANY (co.conkey)) AS cols,
                  co.confdeltype AS del, co.confupdtype AS upd
             FROM pg_catalog.pg_constraint co WHERE co.conname = 'Event_integrationId_fkey' AND co.contype = 'f'`,
        );
        assert.deepEqual(fk.rows, [{ ref: `"Integration"`, cols: "integrationId", del: "r", upd: "c" }]);
        const fkCount = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_catalog.pg_constraint co
             JOIN pg_catalog.pg_namespace n ON n.oid = co.connamespace WHERE n.nspname = 'public' AND co.contype = 'f'`,
        );
        assert.equal(fkCount.rows[0]?.n, "15");

        const labels = await c.query<{ labels: string }>(
          `SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_catalog.pg_enum e
            WHERE e.enumtypid = 'public."EventState"'::regtype`,
        );
        assert.equal(
          labels.rows[0]?.labels,
          "RECEIVED,VALIDATED,QUEUED,PROCESSING,SUCCEEDED,RETRYING,FAILED,UNKNOWN,REJECTED,DUPLICATE",
        );

        const columns = await c.query<{ attname: string; type: string; notnull: boolean; has_default: boolean }>(
          `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.atthasdef AS has_default
             FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public."Event"'::regclass
              AND a.attname IN ('id', 'rawBody', 'rawBodySha256') ORDER BY a.attname`,
        );
        assert.deepEqual(columns.rows, [
          { attname: "id", type: "uuid", notnull: true, has_default: false },
          { attname: "rawBody", type: "bytea", notnull: true, has_default: false },
          { attname: "rawBodySha256", type: "text", notnull: true, has_default: false },
        ]);

        const checks = await checkConstraints(c);
        assert.deepEqual(checks, {
          Event_rawBodySha256_format_check: { def: GOLDEN_CHECKS.Event_rawBodySha256_format_check, validated: true },
          Event_rawBody_length_check: { def: GOLDEN_CHECKS.Event_rawBody_length_check, validated: true },
        });

        const absent = await c.query<{ rle: string | null; fn: string | null }>(
          `SELECT to_regclass('public."RateLimitEvidence"')::text AS rle,
                  to_regprocedure('public.${STATUS_FUNCTION}(uuid)')::text AS fn`,
        );
        assert.equal(absent.rows[0]?.rle, null);
        assert.equal(absent.rows[0]?.fn, `${STATUS_FUNCTION}(uuid)`);

        const ledger = await c.query(
          `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at FROM "public"."_prisma_migrations"`,
        );
        assert.deepEqual(ledger.rows, [{ migration_name: MIGRATION_NAME, finished: true, rolled_back_at: null }]);
      } finally {
        await scratch.close();
      }
    } finally {
      await dropScratch(admin, "migt1");
    }
  });
});

describe("MIG-T2: re-running migrate deploy", () => {
  it("is a no-op on irs_011_test", async () => {
    const before = await mainSnapshot(admin.client);
    const deploy = await runPrismaCli(["migrate", "deploy", "--config", "prisma7.config.ts"], {
      DATABASE_URL: adminUrl,
    });
    assert.equal(deploy.exitCode, 0, deploy.stderr);
    assert.match(deploy.stdout, /No pending migrations to apply/);
    assert.deepEqual(await mainSnapshot(admin.client), before);
  });
});

describe("MIG-T3: drift check against the dedicated shadow database", () => {
  // Limitation (VP-011 F-3; Addendum VPF-6): the drift check compares the
  // migrations with the Prisma schema only. It cannot see raw-SQL objects:
  // it would not detect a removed or altered TD-3 CHECK or VPF-3a function.
  // Those are guarded by M1 (migration content) and M2 (catalog), not here.
  it("reports no difference, touches only the shadow database, and keeps its sentinel", async () => {
    const shadowUrl = withDatabase(adminUrl, SHADOW_DATABASE);
    const before = await mainSnapshot(admin.client);
    process.stdout.write(`[MIG-T3] start ${new Date().toISOString()}\n`);
    const drift = await runPrismaCli(
      [
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
        "--config",
        "packages/db/src/test-support/prisma.drift.config.ts",
      ],
      { IRS_DRIFT_DATASOURCE_URL: adminUrl, IRS_DRIFT_SHADOW_DATABASE_URL: shadowUrl },
    );
    const script = await runPrismaCli(
      [
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema",
        "prisma/schema.prisma",
        "--script",
        "--config",
        "packages/db/src/test-support/prisma.drift.config.ts",
      ],
      { IRS_DRIFT_DATASOURCE_URL: adminUrl, IRS_DRIFT_SHADOW_DATABASE_URL: shadowUrl },
    );
    process.stdout.write(`[MIG-T3] end ${new Date().toISOString()}\n`);
    process.stdout.write(`[MIG-T3] --exit-code: exit ${drift.exitCode}; ${(drift.stdout + drift.stderr).trim()}\n`);
    process.stdout.write(`[MIG-T3] --script: exit ${script.exitCode}; ${(script.stdout + script.stderr).trim()}\n`);
    assert.equal(drift.exitCode, 0, drift.stderr);
    assert.match(drift.stdout + drift.stderr, /No difference detected/);
    assert.equal(script.exitCode, 0, script.stderr);
    assert.match(script.stdout, /empty migration/i);
    // irs_011_test is unchanged; runPrismaCli has already re-verified both sentinels.
    assert.deepEqual(await mainSnapshot(admin.client), before);
  });
});

describe("M2: TD-3 CHECKs in the catalog", () => {
  it("pg_constraint holds both CHECKs, validated, with the golden PostgreSQL 17 text", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      assert.deepEqual(await checkConstraints(api.client), {
        Event_rawBodySha256_format_check: { def: GOLDEN_CHECKS.Event_rawBodySha256_format_check, validated: true },
        Event_rawBody_length_check: { def: GOLDEN_CHECKS.Event_rawBody_length_check, validated: true },
      });
    } finally {
      await api.close();
    }
  });

  it("rejects a 0-byte body, a body over 1 MiB, an uppercase digest and a 63-character digest with 23514", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    const validDigest = "a".repeat(64);
    async function insertError(rawBody: Buffer, digest: string): Promise<{ state?: string; constraint?: string }> {
      await api.client.query("BEGIN");
      try {
        await api.client.query(
          `INSERT INTO "public"."Event" ("id", "integrationId", "externalEventId", "eventType", "resourceType",
             "resourceId", "payload", "occurredAt", "receivedAt", "status", "schemaVersion", "rawBody", "rawBodySha256")
           VALUES ($1, $2, $3, 'm2', 'm2', 'm2', '{}'::jsonb, now(), now(), 'VALIDATED', '1', $4, $5)`,
          [randomUUID(), randomUUID(), `m2-${randomUUID()}`, rawBody, digest],
        );
        return {};
      } catch (error) {
        const constraint = (error as { constraint?: unknown }).constraint;
        return { state: sqlState(error), constraint: typeof constraint === "string" ? constraint : undefined };
      } finally {
        await api.client.query("ROLLBACK");
      }
    }
    try {
      const length = "Event_rawBody_length_check";
      const format = "Event_rawBodySha256_format_check";
      assert.deepEqual(await insertError(Buffer.alloc(0), validDigest), { state: "23514", constraint: length });
      assert.deepEqual(await insertError(Buffer.alloc(1_048_577, 0x61), validDigest), {
        state: "23514",
        constraint: length,
      });
      assert.deepEqual(await insertError(Buffer.from("x"), "A".repeat(64)), { state: "23514", constraint: format });
      assert.deepEqual(await insertError(Buffer.from("x"), "a".repeat(63)), { state: "23514", constraint: format });
      // Controls at the boundaries: the CHECKs pass, and the row then fails its
      // foreign key (no Integration row), which proves the CHECK was not the cause.
      assert.equal((await insertError(Buffer.from("x"), validDigest)).state, "23503");
      assert.equal((await insertError(Buffer.alloc(1_048_576, 0x61), validDigest)).state, "23503");
    } finally {
      await api.close();
    }
  });
});
