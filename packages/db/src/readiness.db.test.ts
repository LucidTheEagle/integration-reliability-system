import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { DEFAULT_POOL_SETTINGS, createDatabase, toPgPoolConfig } from "./client.js";
import type { Database } from "./client.js";
import { sqlStateOf } from "./errors.js";
import { ingestEvent } from "./event-ingestion.js";
import { PrismaClient } from "./generated/prisma/client.js";
import { REQUIRED_MIGRATIONS, verifySchemaReadiness } from "./schema-readiness.js";
import type { SchemaReadiness } from "./schema-readiness.js";
import { assertServerBaseline, readServerBaseline } from "./test-support/baseline.js";
import { bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { guardedDatabase, ingestionInput, removeIntegrations, seedIntegration } from "./test-support/database.js";
import { connectGuarded, requireTestUrl, withDatabase, withUser } from "./test-support/guard.js";
import type { GuardMode, GuardedConnection } from "./test-support/guard.js";
import { runPrismaCli } from "./test-support/prisma-cli.js";
import { grantScratch, migrateScratch } from "./test-support/provision.js";
import { API_ROLE, WORKER_ROLE, scratchDatabaseName } from "./test-support/registry.js";

// Schema readiness against PostgreSQL (Rev 1.7 §8.5, §16.1 RD-T*; Addendum
// VPF-3b, VPF-6). Readiness runs as irs_test_api unless a special role is the
// point of the test. Catalog manipulation happens only in registered scratch
// databases, in admin mode, and each scratch database is dropped afterwards.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const MIGRATION_DIR = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));
const INIT = REQUIRED_MIGRATIONS[0] ?? "";
const ORIGINAL_INDEX = `CREATE UNIQUE INDEX "Event_integrationId_externalEventId_key" ON "public"."Event"("integrationId", "externalEventId")`;

// Admin mode: baseline observation, scratch databases, seeding and cleanup.
let admin: GuardedConnection;
const seeded: string[] = [];

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-readiness-admin" });
  await assertServerBaseline(admin.client);
});

after(async () => {
  await removeIntegrations(admin.client, seeded);
  await assertServerBaseline(admin.client);
  await admin.close();
});

async function readiness(url: string, mode: GuardMode = "api", special?: string): Promise<SchemaReadiness> {
  const db = await guardedDatabase({ url, mode, special });
  try {
    return await verifySchemaReadiness(db);
  } finally {
    await db.prisma.$disconnect();
  }
}

const STRUCTURE = (assertion: string) => ({ ready: false, reason: "STRUCTURE_MISMATCH", assertion });

/** A registered scratch database, created, used, and dropped (verified absent). */
async function withScratch(
  purpose: string,
  body: (scratch: GuardedConnection, apiScratchUrl: string, adminScratchUrl: string) => Promise<void>,
): Promise<void> {
  const adminScratchUrl = await bootstrapScratch(admin, adminUrl, purpose);
  const apiScratchUrl = withDatabase(apiUrl, scratchDatabaseName(purpose));
  let scratch: GuardedConnection | undefined;
  try {
    scratch = await connectGuarded({ url: adminScratchUrl, mode: "admin", applicationName: `irs-test-${purpose}` });
    await body(scratch, apiScratchUrl, adminScratchUrl);
  } finally {
    await scratch?.close();
    await dropScratch(admin, purpose);
  }
}

describe("readiness on irs_011_test", () => {
  it("RD-T2 / RD-T8e: the migrated database is ready: true under the real API stand-in role (every query privileged)", async () => {
    assert.deepEqual(await readiness(apiUrl), { ready: true });
  });

  it("VPF-3b: irs_test_api reads only the three ledger columns and cannot write the ledger (42501 each)", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    try {
      for (const sql of [
        `SELECT "logs" FROM "public"."_prisma_migrations"`,
        `SELECT "checksum" FROM "public"."_prisma_migrations"`,
        `SELECT * FROM "public"."_prisma_migrations"`,
        `INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "migration_name") VALUES ('x', 'x', 'x')`,
        `UPDATE "public"."_prisma_migrations" SET "migration_name" = "migration_name"`,
        `DELETE FROM "public"."_prisma_migrations"`,
      ]) {
        const error = await db.prisma.$executeRawUnsafe(sql).then(
          () => assert.fail(`must be denied: ${sql}`),
          (failure: unknown) => failure,
        );
        assert.equal(sqlStateOf(error), "42501", sql);
      }
      const allowed = await db.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT "migration_name", "finished_at", "rolled_back_at" FROM "public"."_prisma_migrations"`,
      );
      assert.equal(allowed.length, REQUIRED_MIGRATIONS.length);
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("VPF-3b: without the ledger grant (irs_test_api_no_ledger) readiness fails closed with LEDGER_MISSING", async () => {
    assert.deepEqual(await readiness(withUser(apiUrl, "irs_test_api_no_ledger"), "special", "irs_test_api_no_ledger"), {
      ready: false,
      reason: "LEDGER_MISSING",
    });
  });

  it("VPF-6 S3 extension: without EXECUTE on the status function (irs_test_api_no_execute) → STRUCTURE_MISMATCH (S3)", async () => {
    assert.deepEqual(
      await readiness(withUser(apiUrl, "irs_test_api_no_execute"), "special", "irs_test_api_no_execute"),
      STRUCTURE("S3"),
    );
  });

  it("RD-T6q–s: identifiers differing by case, normalization or a trailing space are distinct events", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    const integrationId = await seedIntegration(admin.client, "ACTIVE");
    seeded.push(integrationId);
    try {
      for (const [a, b] of [
        ["evt_A1", "evt_a1"],
        ["evt_é", "evt_é"],
        ["evt_1", "evt_1 "],
      ] as const) {
        assert.equal((await ingestEvent(db, ingestionInput(integrationId, a))).disposition, "NEW", a);
        assert.equal((await ingestEvent(db, ingestionInput(integrationId, b))).disposition, "NEW", JSON.stringify(b));
      }
      const count = (
        await admin.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "public"."Event" WHERE "integrationId" = $1`, [integrationId])
      ).rows[0]?.n;
      assert.equal(count, 6);
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("RD-T8b/c: a role-level transaction_timeout fails closed, with and without the establishment mechanism", async () => {
    const role = "irs_test_api_role_setting";
    const url = withUser(apiUrl, role);
    // Admin mode: a role setting on the only role registered for ALTER ROLE ... SET; reverted below.
    await admin.client.query(`ALTER ROLE "${role}" SET transaction_timeout = '60s'`);
    try {
      // (b) Mechanism disabled: the same pool settings without the connection-start option.
      const check = await connectGuarded({ url, mode: "special", special: role });
      await check.close();
      const { options: _disabled, ...withoutOption } = toPgPoolConfig(url, DEFAULT_POOL_SETTINGS);
      void _disabled;
      const prisma = new PrismaClient({ adapter: new PrismaPg({ ...withoutOption }) });
      const unprotected: Database = { prisma, monotonicNow: () => performance.now(), ping: async () => void (await prisma.$queryRaw`SELECT 1`) };
      try {
        const shown = (await prisma.$queryRaw<{ tt: string }[]>`SELECT current_setting('transaction_timeout') AS tt`)[0]?.tt;
        process.stdout.write(`[RD-T8b] mechanism disabled: session transaction_timeout = ${String(shown)}\n`);
        assert.deepEqual(await verifySchemaReadiness(unprotected), { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.b" });
      } finally {
        await prisma.$disconnect();
      }
      // (c) Mechanism enabled: the session value is 0 (client), but S6.c still fails closed (strict reading).
      const db = await guardedDatabase({ url, mode: "special", special: role });
      try {
        const shown = (await db.prisma.$queryRaw<{ tt: string }[]>`SELECT current_setting('transaction_timeout') AS tt`)[0]?.tt;
        process.stdout.write(`[RD-T8c] mechanism enabled: session transaction_timeout = ${String(shown)}\n`);
        assert.equal(shown, "0");
        assert.deepEqual(await verifySchemaReadiness(db), { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.c" });
      } finally {
        await db.prisma.$disconnect();
      }
    } finally {
      await admin.client.query(`ALTER ROLE "${role}" RESET transaction_timeout`);
      assert.deepEqual(await readServerBaseline(admin.client), { roleSettings: 0, autoConfEntries: 0 });
    }
  });
});

describe("RD-T1: no ledger", () => {
  it("an empty database, and then tables created without a ledger, both give LEDGER_MISSING", async () => {
    await withScratch("rdt1", async (scratch, apiScratchUrl) => {
      assert.deepEqual(await readiness(apiScratchUrl), { ready: false, reason: "LEDGER_MISSING" });
      // `prisma db push` is prohibited (Prompt B §4.3), so the tables are created by running the
      // committed migration SQL directly, which leaves no ledger.
      await scratch.client.query(readFileSync(join(MIGRATION_DIR, INIT, "migration.sql"), "utf8"));
      assert.deepEqual(await readiness(apiScratchUrl), { ready: false, reason: "LEDGER_MISSING" });
    });
  });
});

describe("RD-T2 / RD-T3 / RD-T5: ledger states", () => {
  it("required present → ready; absent or rolled back → MIGRATION_MISSING; unfinished → MIGRATION_FAILED; extra → UNKNOWN_MIGRATION", async () => {
    await withScratch("ledger", async (scratch, apiScratchUrl, adminScratchUrl) => {
      await migrateScratch(adminScratchUrl, [API_ROLE]);
      assert.deepEqual(await readiness(apiScratchUrl), { ready: true });

      // Task 011A (RD-4a): save and restore every ledger row, not only the first.
      const originals = (await scratch.client.query(`SELECT * FROM "public"."_prisma_migrations" ORDER BY "migration_name"`))
        .rows as Record<string, unknown>[];
      await scratch.client.query(`DELETE FROM "public"."_prisma_migrations"`);
      assert.deepEqual(await readiness(apiScratchUrl), { ready: false, reason: "MIGRATION_MISSING" });
      for (const original of originals) {
        await scratch.client.query(
          `INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [original.id, original.checksum, original.finished_at, original.migration_name, original.logs, original.rolled_back_at, original.started_at, original.applied_steps_count],
        );
      }

      await scratch.client.query(`UPDATE "public"."_prisma_migrations" SET "rolled_back_at" = now()`);
      assert.deepEqual(await readiness(apiScratchUrl), { ready: false, reason: "MIGRATION_MISSING" });
      await scratch.client.query(`UPDATE "public"."_prisma_migrations" SET "rolled_back_at" = NULL`);

      await scratch.client.query(
        `INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "applied_steps_count")
         VALUES ($1, 'seeded', '29990101000000_seeded_failure', now(), 0)`,
        [randomUUID()],
      );
      assert.deepEqual(await readiness(apiScratchUrl), { ready: false, reason: "MIGRATION_FAILED" });
      await scratch.client.query(`DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '29990101000000_seeded_failure'`);

      await scratch.client.query(
        `INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count")
         VALUES ($1, 'later', '29990101000000_later', now(), now(), 1)`,
        [randomUUID()],
      );
      assert.deepEqual(await readiness(apiScratchUrl), { ready: false, reason: "UNKNOWN_MIGRATION" });
      await scratch.client.query(`DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '29990101000000_later'`);

      assert.deepEqual(await readiness(apiScratchUrl), { ready: true });
    });
  });
});

describe("RD-T4: a deliberately failing migration", () => {
  it("records how Prisma 7.10 leaves the ledger and the schema; readiness → MIGRATION_FAILED", async () => {
    const work = mkdtempSync(join(tmpdir(), "irs-011-rdt4-"));
    try {
      mkdirSync(join(work, INIT));
      writeFileSync(join(work, INIT, "migration.sql"), readFileSync(join(MIGRATION_DIR, INIT, "migration.sql")));
      mkdirSync(join(work, "29990101000000_failing"));
      writeFileSync(
        join(work, "29990101000000_failing", "migration.sql"),
        `CREATE TABLE "public"."irs_rdt4_partial" ("id" integer);\nSELECT 1 / 0;\n`,
      );
      writeFileSync(join(work, "migration_lock.toml"), readFileSync(join(MIGRATION_DIR, "migration_lock.toml")));
      await withScratch("rdt4", async (scratch, apiScratchUrl, adminScratchUrl) => {
        const deploy = await runPrismaCli(
          ["migrate", "deploy", "--config", "packages/db/src/test-support/prisma.probe.config.ts"],
          { IRS_PROBE_DATASOURCE_URL: adminScratchUrl },
          { IRS_PROBE_MIGRATIONS_DIR: work },
        );
        const ledger = (
          await scratch.client.query(
            `SELECT "migration_name", "finished_at" IS NOT NULL AS finished, "rolled_back_at" IS NOT NULL AS rolled_back,
                    "applied_steps_count", "logs" IS NOT NULL AS has_logs
               FROM "public"."_prisma_migrations" ORDER BY "started_at"`,
          )
        ).rows;
        const partial = (await scratch.client.query(`SELECT to_regclass('public.irs_rdt4_partial')::text AS t`)).rows[0];
        process.stdout.write(
          `[RD-T4] deploy exit ${deploy.exitCode}; stderr: ${deploy.stderr.split("\n").filter((l) => /Error|P3|failed/i.test(l)).slice(0, 4).join(" | ")}\n` +
            `[RD-T4] ledger: ${JSON.stringify(ledger)}\n[RD-T4] partial table from the failing migration: ${JSON.stringify(partial)}\n`,
        );
        assert.notEqual(deploy.exitCode, 0);
        assert.ok(ledger.some((row) => row.migration_name === "29990101000000_failing" && row.finished === false && row.rolled_back === false));
        await grantScratch(adminScratchUrl, [API_ROLE]);
        assert.deepEqual(await readiness(apiScratchUrl), { ready: false, reason: "MIGRATION_FAILED" });
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("RD-T6: S2–S5 and the S3 function, altered out of band", () => {
  it("each alteration gives STRUCTURE_MISMATCH with its assertion; the structure is restored between cases", async () => {
    await withScratch("structure", async (scratch, apiScratchUrl, adminScratchUrl) => {
      await migrateScratch(adminScratchUrl, [API_ROLE]);
      assert.deepEqual(await readiness(apiScratchUrl), { ready: true });
      const spellings = (
        await scratch.client.query(
          `SELECT column_name, data_type, udt_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'Event' AND column_name IN ('id', 'payload', 'rawBody') ORDER BY 1`,
        )
      ).rows;
      process.stdout.write(`[RD-T6] information_schema spellings (admin view): ${JSON.stringify(spellings)}\n`);

      const fn = `"public"."irs_integration_config_status_for_share"(uuid)`;
      const cases: [string, string[], string[]][] = [
        ["S2", [`ALTER TABLE "public"."Event" DROP CONSTRAINT "Event_integrationId_fkey"`], [
          `ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "public"."Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
        ]],
        ["S3", [`ALTER TYPE "public"."EventState" RENAME VALUE 'VALIDATED' TO 'VALIDATED_X'`], [`ALTER TYPE "public"."EventState" RENAME VALUE 'VALIDATED_X' TO 'VALIDATED'`]],
        ["S3", [`ALTER TYPE "public"."IntegrationConfigState" RENAME VALUE 'ACTIVE' TO 'ACTIVE_X'`], [`ALTER TYPE "public"."IntegrationConfigState" RENAME VALUE 'ACTIVE_X' TO 'ACTIVE'`]],
        ["S3", [`ALTER FUNCTION ${fn} SECURITY INVOKER`], [`ALTER FUNCTION ${fn} SECURITY DEFINER`]],
        ["S3", [`ALTER FUNCTION ${fn} STABLE`], [`ALTER FUNCTION ${fn} VOLATILE`]],
        ["S3", [`ALTER FUNCTION ${fn} RESET search_path`], [`ALTER FUNCTION ${fn} SET search_path = pg_catalog, pg_temp`]],
        ["S3", [`REVOKE EXECUTE ON FUNCTION ${fn} FROM "${API_ROLE}"`], [`GRANT EXECUTE ON FUNCTION ${fn} TO "${API_ROLE}"`]],
        ["S3", [
          `CREATE OR REPLACE FUNCTION "public"."irs_integration_config_status_for_share"(p_integration_id uuid) RETURNS "public"."IntegrationConfigState" LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT "configStatus" FROM "public"."Integration" WHERE "id" = p_integration_id $$`,
        ], [
          `CREATE OR REPLACE FUNCTION "public"."irs_integration_config_status_for_share"(p_integration_id uuid) RETURNS "public"."IntegrationConfigState" LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$\n  SELECT "configStatus" FROM "public"."Integration" WHERE "id" = p_integration_id FOR SHARE\n$$`,
        ]],
        ["S4", [`ALTER TABLE "public"."Event" DROP COLUMN "rawBody"`], [
          `ALTER TABLE "public"."Event" ADD COLUMN "rawBody" BYTEA NOT NULL`,
          `ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_rawBody_length_check" CHECK (octet_length("rawBody") BETWEEN 1 AND 1048576)`,
        ]],
        ["S4", [`ALTER TABLE "public"."Integration" RENAME COLUMN "configStatus" TO "configStatusX"`], [`ALTER TABLE "public"."Integration" RENAME COLUMN "configStatusX" TO "configStatus"`]],
        ["S5", [`ALTER TABLE "public"."AuditEntry" DROP CONSTRAINT "AuditEntry_pkey"`], [`ALTER TABLE "public"."AuditEntry" ADD CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")`]],
      ];
      for (const [assertion, alter, restore] of cases) {
        for (const statement of alter) await scratch.client.query(statement);
        try {
          assert.deepEqual(await readiness(apiScratchUrl), STRUCTURE(assertion), alter.join("; "));
        } finally {
          for (const statement of restore) await scratch.client.query(statement);
        }
        assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, `restored after: ${alter.join("; ")}`);
      }
    });
  });
});

describe("RD-T6a–p: S1 against substitute idempotency indexes", () => {
  it("every weakened substitute gives STRUCTURE_MISMATCH (S1); the Prisma index, in either column order, passes", async () => {
    await withScratch("s1", async (scratch, apiScratchUrl, adminScratchUrl) => {
      await migrateScratch(adminScratchUrl, [API_ROLE]);
      const q = (sql: string, values?: unknown[]) => scratch.client.query(sql, values);
      const dropOriginal = `DROP INDEX "public"."Event_integrationId_externalEventId_key"`;
      const s1 = STRUCTURE("S1");
      assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, "positive: the Prisma-created index");

      const substitutes: [string, string[], string[]][] = [
        ["a non-unique", [`CREATE INDEX "irs_sub" ON "public"."Event"("integrationId", "externalEventId")`], []],
        ["d deferrable", [`ALTER TABLE "public"."Event" ADD CONSTRAINT "irs_sub" UNIQUE ("integrationId", "externalEventId") DEFERRABLE`], [`ALTER TABLE "public"."Event" DROP CONSTRAINT "irs_sub"`]],
        ["e partial", [`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("integrationId", "externalEventId") WHERE "eventType" <> ''`], []],
        ["f expression", [`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("integrationId", lower("externalEventId"))`], []],
        ["g three columns", [`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("integrationId", "externalEventId", "eventType")`], []],
        ["h INCLUDE", [`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("integrationId", "externalEventId") INCLUDE ("eventType")`], []],
        ["i single column", [`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("externalEventId")`], []],
        ["k exclusion", [`ALTER TABLE "public"."Event" ADD CONSTRAINT "irs_sub" EXCLUDE USING btree ("integrationId" WITH =, "externalEventId" WITH =)`], [`ALTER TABLE "public"."Event" DROP CONSTRAINT "irs_sub"`]],
        ["l non-default opclass", [`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("integrationId", "externalEventId" text_pattern_ops)`], []],
        ["n index collation C", [`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("integrationId", "externalEventId" COLLATE "C")`], []],
      ];
      for (const [label, create, cleanup] of substitutes) {
        await q(dropOriginal);
        try {
          for (const statement of create) await q(statement);
          assert.deepEqual(await readiness(apiScratchUrl), s1, label);
        } finally {
          for (const statement of cleanup) await q(statement);
          await q(`DROP INDEX IF EXISTS "public"."irs_sub"`);
          await q(ORIGINAL_INDEX);
        }
      }

      // b: an invalid unique index from a CREATE UNIQUE INDEX CONCURRENTLY that fails on duplicate rows.
      const integrationId = randomUUID();
      await q(dropOriginal);
      try {
        await q(`INSERT INTO "public"."Integration" ("id", "name", "provider", "type", "configStatus", "environment", "updatedAt") VALUES ($1, 's1', 't', 't', 'ACTIVE', 't', now())`, [integrationId]);
        for (let i = 0; i < 2; i += 1) {
          await q(
            `INSERT INTO "public"."Event" ("id", "integrationId", "externalEventId", "eventType", "resourceType", "resourceId", "payload", "occurredAt", "receivedAt", "status", "schemaVersion", "rawBody", "rawBodySha256")
             VALUES (gen_random_uuid(), $1, 'dup', 'x', 'x', 'x', '{}'::jsonb, now(), now(), 'VALIDATED', '1', '\\x61'::bytea, $2)`,
            [integrationId, "a".repeat(64)],
          );
        }
        const failed = await q(`CREATE UNIQUE INDEX CONCURRENTLY "irs_sub" ON "public"."Event"("integrationId", "externalEventId")`).then(
          () => "created",
          (error: unknown) => (error as { code?: string }).code,
        );
        const valid = (await q(`SELECT indisvalid FROM pg_catalog.pg_index WHERE indexrelid = 'public.irs_sub'::regclass`)).rows[0];
        process.stdout.write(`[RD-T6b] CREATE UNIQUE INDEX CONCURRENTLY on duplicates: ${String(failed)}; left index ${JSON.stringify(valid)}\n`);
        assert.equal(failed, "23505");
        assert.deepEqual(await readiness(apiScratchUrl), s1, "b invalid index");
      } finally {
        await q(`DROP INDEX IF EXISTS "public"."irs_sub"`);
        await q(`DELETE FROM "public"."Event" WHERE "integrationId" = $1`, [integrationId]);
        await q(`DELETE FROM "public"."Integration" WHERE "id" = $1`, [integrationId]);
        await q(ORIGINAL_INDEX);
      }

      // c: not ready / not live, by catalog update in this disposable database only (a test-only technique).
      for (const flag of ["indisready", "indislive"]) {
        await q(`UPDATE pg_catalog.pg_index SET ${flag} = false WHERE indexrelid = 'public."Event_integrationId_externalEventId_key"'::regclass`);
        try {
          assert.deepEqual(await readiness(apiScratchUrl), s1, `c ${flag}`);
        } finally {
          await q(`UPDATE pg_catalog.pg_index SET ${flag} = true WHERE indexrelid = 'public."Event_integrationId_externalEventId_key"'::regclass`);
        }
      }

      // j: the correct index on a nullable column.
      await q(`ALTER TABLE "public"."Event" ALTER COLUMN "externalEventId" DROP NOT NULL`);
      try {
        assert.deepEqual(await readiness(apiScratchUrl), s1, "j nullable column");
      } finally {
        await q(`ALTER TABLE "public"."Event" ALTER COLUMN "externalEventId" SET NOT NULL`);
      }

      // m: a nondeterministic ICU collation on the column and its index; plus the identity negative counterpart.
      const defaultCollation = (await q(`SELECT collprovider::text, collisdeterministic FROM pg_catalog.pg_collation WHERE collname = 'default'`)).rows[0];
      process.stdout.write(`[RD-T6m] database default collation row: ${JSON.stringify(defaultCollation)}\n`);
      await q(`CREATE COLLATION "public"."irs_ci" (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`);
      const ciIntegration = randomUUID();
      try {
        await q(`ALTER TABLE "public"."Event" ALTER COLUMN "externalEventId" TYPE text COLLATE "public"."irs_ci"`);
        assert.deepEqual(await readiness(apiScratchUrl), s1, "m nondeterministic collation");
        await q(`INSERT INTO "public"."Integration" ("id", "name", "provider", "type", "configStatus", "environment", "updatedAt") VALUES ($1, 'ci', 't', 't', 'ACTIVE', 't', now())`, [ciIntegration]);
        const db = await guardedDatabase({ url: apiScratchUrl, mode: "api" });
        try {
          const first = await ingestEvent(db, ingestionInput(ciIntegration, "evt_A1"));
          const second = await ingestEvent(db, ingestionInput(ciIntegration, "evt_a1"));
          process.stdout.write(`[RD-T6q negative] under irs_ci: ${first.disposition}, then ${second.disposition}\n`);
          assert.deepEqual([first.disposition, second.disposition], ["NEW", "DUPLICATE"]);
        } finally {
          await db.prisma.$disconnect();
        }
      } finally {
        await q(`DELETE FROM "public"."AuditEntry" WHERE "metadata"->>'integrationId' = $1`, [ciIntegration]);
        await q(`DELETE FROM "public"."Event" WHERE "integrationId" = $1`, [ciIntegration]);
        await q(`DELETE FROM "public"."Integration" WHERE "id" = $1`, [ciIntegration]);
        await q(`ALTER TABLE "public"."Event" ALTER COLUMN "externalEventId" TYPE text COLLATE "default"`);
        await q(`DROP COLLATION "public"."irs_ci"`);
      }

      // o: a correct index on an "Event" in another schema, first on the search_path; the expected table lacks it.
      await q(`CREATE SCHEMA "decoy"`);
      await q(`CREATE TABLE "decoy"."Event" ("integrationId" uuid NOT NULL, "externalEventId" text NOT NULL)`);
      await q(`CREATE UNIQUE INDEX "decoy_event_key" ON "decoy"."Event"("integrationId", "externalEventId")`);
      await q(`GRANT USAGE ON SCHEMA "decoy" TO "${API_ROLE}"`);
      await q(`GRANT SELECT ON "decoy"."Event" TO "${API_ROLE}"`);
      await q(`ALTER DATABASE "${scratchDatabaseName("s1")}" SET search_path = "decoy", "public"`);
      await q(dropOriginal);
      try {
        assert.deepEqual(await readiness(apiScratchUrl), s1, "o schema resolution");
      } finally {
        await q(`ALTER DATABASE "${scratchDatabaseName("s1")}" RESET search_path`);
        await q(`DROP SCHEMA "decoy" CASCADE`);
        await q(ORIGINAL_INDEX);
      }

      // Positive: the same columns in reverse order (order-insensitive).
      await q(dropOriginal);
      try {
        await q(`CREATE UNIQUE INDEX "irs_sub" ON "public"."Event"("externalEventId", "integrationId")`);
        assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, "reverse column order passes");
      } finally {
        await q(`DROP INDEX IF EXISTS "public"."irs_sub"`);
        await q(ORIGINAL_INDEX);
      }
      assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, "restored");
      assert.ok(readdirSync(MIGRATION_DIR).includes(INIT));
    });
  });
});

/**
 * Task 012B (R1, PL-4): the worker's own pool, as 012B-3 composes it: a
 * worker-mode guard check, then max 3 connections pinned to UTC at connection start.
 */
async function workerReadiness(url: string, options: { readonly pinned: boolean; readonly sessionOptions?: string }): Promise<SchemaReadiness> {
  const check = await connectGuarded({ url, mode: "worker", applicationName: "irs-test-worker-readiness-check" });
  await check.close();
  if (options.sessionOptions === undefined) {
    const db = createDatabase({ connectionString: url, pool: { maxConnections: 3 }, sessionTimeZone: options.pinned ? "UTC" : undefined });
    try {
      return await verifySchemaReadiness(db, "worker");
    } finally {
      await db.prisma.$disconnect();
    }
  }
  // Test-only: a worker-role pool opened with another session option (never the production pool).
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ ...toPgPoolConfig(url, { ...DEFAULT_POOL_SETTINGS, maxConnections: 3 }), options: options.sessionOptions }),
  });
  const db: Database = { prisma, monotonicNow: () => performance.now(), ping: async () => void (await prisma.$queryRaw`SELECT 1`) };
  try {
    const shown = (await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`)[0]?.tz;
    process.stdout.write(`[S6.d] worker pool with ${options.sessionOptions}: session TimeZone = ${String(shown)}\n`);
    return await verifySchemaReadiness(db, "worker");
  } finally {
    await prisma.$disconnect();
  }
}

describe("Task 012B (B1-6, PL-4): the api and worker profiles on irs_011_test", () => {
  const workerUrl = requireTestUrl("IRS_TEST_WORKER_DATABASE_URL");

  it("api as irs_test_api and worker as irs_test_worker (through the UTC-pinned worker pool) are both ready: true", async () => {
    assert.deepEqual(await readiness(apiUrl), { ready: true });
    assert.deepEqual(await workerReadiness(workerUrl, { pinned: true }), { ready: true });
  });

  it("a worker-role pool opened with a non-UTC session option fails closed with S6.d", async () => {
    assert.deepEqual(
      await workerReadiness(workerUrl, { pinned: false, sessionOptions: "-c transaction_timeout=0 -c TimeZone=America/New_York" }),
      { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.d" },
    );
  });

  it("the worker holds no EXECUTE on the status function, yet its profile is ready (control for FD-4)", async () => {
    const check = await connectGuarded({ url: workerUrl, mode: "worker", applicationName: "irs-test-worker-execute" });
    try {
      const row = (
        await check.client.query<{ can_execute: boolean }>(
          `SELECT has_function_privilege('public.irs_integration_config_status_for_share(uuid)', 'EXECUTE') AS can_execute`,
        )
      ).rows[0];
      assert.equal(row?.can_execute, false);
    } finally {
      await check.close();
    }
  });
});

describe("Task 012B (B1-6, PL-4): readiness against altered dispatch objects (dispatchready)", () => {
  it("each out-of-band alteration fails closed with its own assertion; ENABLE ALWAYS passes; the structure is restored between cases", async () => {
    await withScratch("dispatchready", async (scratch, apiScratchUrl, adminScratchUrl) => {
      await migrateScratch(adminScratchUrl, [API_ROLE, WORKER_ROLE]);
      assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, "positive before any alteration");
      const event = `"public"."Event"`;
      const trigger = `"irs_event_dispatch_marker_guard"`;
      const name = REQUIRED_MIGRATIONS.find((entry) => entry.endsWith("_event_dispatch")) ?? "";
      const migration = readFileSync(join(MIGRATION_DIR, name, "migration.sql"), "utf8");
      const createFunction = migration.slice(migration.indexOf("CREATE FUNCTION"), migration.indexOf("$$;") + 3);
      assert.ok(createFunction.startsWith("CREATE FUNCTION") && createFunction.endsWith("$$;"), "the migration's CREATE FUNCTION");
      const restoreFunction = createFunction.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
      const cases: [string, string[], string[]][] = [
        ["DISPATCH.trigger_enabled", [`ALTER TABLE ${event} DISABLE TRIGGER ${trigger}`], [`ALTER TABLE ${event} ENABLE TRIGGER ${trigger}`]],
        ["DISPATCH.trigger_enabled", [`ALTER TABLE ${event} ENABLE REPLICA TRIGGER ${trigger}`], [`ALTER TABLE ${event} ENABLE TRIGGER ${trigger}`]],
        ["DISPATCH.check", [`ALTER TABLE ${event} DROP CONSTRAINT "Event_dispatchAnomaly_consistency_check"`], [
          `ALTER TABLE ${event} ADD CONSTRAINT "Event_dispatchAnomaly_consistency_check" CHECK (("dispatchAnomalyAt" IS NULL) = ("dispatchAnomalyKind" IS NULL))`,
        ]],
        ["DISPATCH.index", [`DROP INDEX "public"."Event_status_receivedAt_idx"`], [
          `CREATE INDEX "Event_status_receivedAt_idx" ON ${event}("status", "receivedAt")`,
        ]],
        ["DISPATCH.function", [restoreFunction.replace("  RETURN NEW;\nEND", "  RETURN NEW;\n  -- altered\nEND")], [restoreFunction]],
        ["DISPATCH.columns", [`ALTER TABLE ${event} ALTER COLUMN "queuedAt" TYPE timestamp(3)`], [`ALTER TABLE ${event} ALTER COLUMN "queuedAt" TYPE timestamptz(3)`]],
      ];
      for (const [assertion, alter, restore] of cases) {
        // Admin mode, scratch only: an out-of-band alteration, restored below.
        for (const statement of alter) await scratch.client.query(statement);
        try {
          assert.deepEqual(await readiness(apiScratchUrl), STRUCTURE(assertion), alter.join("; "));
        } finally {
          for (const statement of restore) await scratch.client.query(statement);
        }
        assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, `restored after: ${alter.join("; ")}`);
      }
      await scratch.client.query(`ALTER TABLE ${event} ENABLE ALWAYS TRIGGER ${trigger}`);
      try {
        assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, "ENABLE ALWAYS (A) passes");
      } finally {
        await scratch.client.query(`ALTER TABLE ${event} ENABLE TRIGGER ${trigger}`);
      }
      const mode = (
        await scratch.client.query<{ tgenabled: string }>(
          `SELECT tgenabled::text AS tgenabled FROM pg_catalog.pg_trigger WHERE tgname = 'irs_event_dispatch_marker_guard'`,
        )
      ).rows;
      assert.deepEqual(mode, [{ tgenabled: "O" }], "restored to origin-enabled");
    });
  });
});

describe("RD-7 (Task 011A): RateLimitEvidence table, primary key and natural-key indexes", () => {
  it("positive: irs_011_test, with both migrations, is ready: true as irs_test_api", async () => {
    assert.deepEqual(await readiness(apiUrl), { ready: true });
  });

  it("negatives in a registered scratch database: each index missing, non-unique or with a wrong predicate; the primary key; the table — each fails closed with its own assertion", async () => {
    await withScratch("rle", async (scratch, apiScratchUrl, adminScratchUrl) => {
      await migrateScratch(adminScratchUrl, [API_ROLE]);
      assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, "positive before any alteration");
      const table = `"public"."RateLimitEvidence"`;
      // The A14 §7.4 definitions, schema-qualified, used to restore each index.
      const indexes: [string, string, string, string][] = [
        ["RLE.lifecycle_uq", "rle_instance_lifecycle_uq", `("limiterInstanceId", "kind")`, `"kind" IN ('INSTANCE_STARTED', 'INSTANCE_CLOSED')`],
        ["RLE.summary_range_uq", "rle_summary_range_uq", `("limiterInstanceId", "firstSequence", "lastSequence")`, `"kind" = 'SUMMARY'`],
        ["RLE.gap_discontinuity_uq", "rle_gap_discontinuity_uq", `("limiterInstanceId", "missingFrom", "missingTo")`, `"kind" = 'EVIDENCE_GAP' AND "gapReason" = 'SEQUENCE_DISCONTINUITY'`],
        ["RLE.gap_unclean_uq", "rle_gap_unclean_uq", `("limiterInstanceId")`, `"kind" = 'EVIDENCE_GAP' AND "gapReason" = 'UNCLEAN_TERMINATION'`],
      ];
      for (const [assertion, name, columns, predicate] of indexes) {
        const restore = `CREATE UNIQUE INDEX "${name}" ON ${table} ${columns} WHERE ${predicate}`;
        const variants: [string, string[]][] = [
          ["missing", []],
          ["non-unique", [`CREATE INDEX "${name}" ON ${table} ${columns} WHERE ${predicate}`]],
          ["wrong predicate", [`CREATE UNIQUE INDEX "${name}" ON ${table} ${columns} WHERE "kind" = 'OTHER'`]],
        ];
        for (const [label, create] of variants) {
          // Admin mode, scratch only: an out-of-band alteration of the index.
          await scratch.client.query(`DROP INDEX "public"."${name}"`);
          try {
            for (const statement of create) await scratch.client.query(statement);
            assert.deepEqual(await readiness(apiScratchUrl), STRUCTURE(assertion), `${name} ${label}`);
          } finally {
            await scratch.client.query(`DROP INDEX IF EXISTS "public"."${name}"`);
            await scratch.client.query(restore);
          }
          assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, `restored after ${name} ${label}`);
        }
      }
      await scratch.client.query(`ALTER TABLE ${table} DROP CONSTRAINT "RateLimitEvidence_pkey"`);
      try {
        assert.deepEqual(await readiness(apiScratchUrl), STRUCTURE("RLE.pk"), "primary key missing");
      } finally {
        await scratch.client.query(`ALTER TABLE ${table} ADD CONSTRAINT "RateLimitEvidence_pkey" PRIMARY KEY ("id")`);
      }
      assert.deepEqual(await readiness(apiScratchUrl), { ready: true }, "restored after the primary key");
      // Last: the table itself. The scratch database is dropped afterwards.
      await scratch.client.query(`DROP TABLE ${table}`);
      assert.deepEqual(await readiness(apiScratchUrl), STRUCTURE("RLE.table"), "table missing");
    });
  });
});
