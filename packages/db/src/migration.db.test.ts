import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertServerBaseline } from "./test-support/baseline.js";
import { bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { connectGuarded, requireTestUrl, withDatabase } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { sqlState } from "./test-support/pg.js";
import type { PgClient } from "./test-support/pg.js";
import { runPrismaCli } from "./test-support/prisma-cli.js";
import { SHADOW_DATABASE, STATUS_FUNCTION } from "./test-support/registry.js";
import {
  DISPATCH_CHECK_DEFINITION,
  DISPATCH_COLUMNS,
  DISPATCH_INDEX_DEFINITION,
  RATE_LIMIT_EVIDENCE_INDEXES,
  REQUIRED_MIGRATIONS,
} from "./schema-readiness.js";

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

/**
 * Task 011A (RD-5): golden PostgreSQL 17 text of the four RateLimitEvidence
 * CHECKs, captured once (2026-10-21, r5-011a/db-stage2-capture.txt) and
 * changed only by deliberate review. The four indexes' golden text is
 * RATE_LIMIT_EVIDENCE_INDEXES, which readiness (RD-7) also pins.
 */
const GOLDEN_RLE_CHECKS = {
  rle_gap_reason_ck: `CHECK (((kind <> 'EVIDENCE_GAP'::text) OR (("gapReason" IS NOT NULL) AND ("gapReason" = ANY (ARRAY['SEQUENCE_DISCONTINUITY'::text, 'UNCLEAN_TERMINATION'::text])))))`,
  rle_gap_shape_ck: `CHECK (((kind <> 'EVIDENCE_GAP'::text) OR ("gapReason" IS DISTINCT FROM 'SEQUENCE_DISCONTINUITY'::text) OR (("missingFrom" IS NOT NULL) AND ("missingTo" IS NOT NULL) AND ("missingFrom" >= 1) AND ("missingTo" >= "missingFrom"))))`,
  rle_kind_ck: `CHECK ((kind = ANY (ARRAY['INSTANCE_STARTED'::text, 'SUMMARY'::text, 'EVIDENCE_GAP'::text, 'INSTANCE_CLOSED'::text])))`,
  rle_summary_shape_ck: `CHECK (((kind <> 'SUMMARY'::text) OR (("firstSequence" IS NOT NULL) AND ("lastSequence" IS NOT NULL) AND ("firstSequence" >= 1) AND ("lastSequence" >= "firstSequence"))))`,
};

/**
 * Task 012B (B1-5, PL-2): golden PostgreSQL 17.11 text of the trigger function
 * (pg_get_functiondef) and of the trigger (pg_get_triggerdef, in this file's
 * fixed api-mode test session), captured once (012B-2 RUN A, A6) and changed
 * only by deliberate review. The CHECK's and the index's golden text is in
 * schema-readiness.ts, which readiness also pins. Placeholders until captured.
 */
const GOLDEN_DISPATCH_FUNCTIONDEF = "CREATE OR REPLACE FUNCTION public.irs_event_dispatch_marker_guard()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog', 'pg_temp'\nAS $function$\nBEGIN\n  IF TG_OP = 'INSERT' THEN\n    IF NEW.\"dispatchAnomalyAt\" IS NOT NULL OR NEW.\"dispatchAnomalyKind\" IS NOT NULL THEN\n      RAISE EXCEPTION 'irs dispatch marker rule T0' USING ERRCODE = 'IRST0';\n    END IF;\n    RETURN NEW;\n  END IF;\n  IF OLD.\"dispatchAnomalyAt\" IS NOT NULL\n     AND (NEW.\"dispatchAnomalyAt\" IS DISTINCT FROM OLD.\"dispatchAnomalyAt\"\n          OR NEW.\"dispatchAnomalyKind\" IS DISTINCT FROM OLD.\"dispatchAnomalyKind\") THEN\n    RAISE EXCEPTION 'irs dispatch marker rule T2' USING ERRCODE = 'IRST2';\n  END IF;\n  IF OLD.\"dispatchAnomalyAt\" IS NULL AND NEW.\"dispatchAnomalyAt\" IS NOT NULL\n     AND NOT (OLD.\"status\" = 'QUEUED'::\"public\".\"EventState\"\n              AND NEW.\"status\" = 'QUEUED'::\"public\".\"EventState\"\n              AND NEW.\"dispatchAnomalyKind\" IS NOT NULL) THEN\n    RAISE EXCEPTION 'irs dispatch marker rule T1' USING ERRCODE = 'IRST1';\n  END IF;\n  IF NEW.\"status\" = 'PROCESSING'::\"public\".\"EventState\"\n     AND (OLD.\"dispatchAnomalyAt\" IS NOT NULL OR NEW.\"dispatchAnomalyAt\" IS NOT NULL) THEN\n    RAISE EXCEPTION 'irs dispatch marker rule T3' USING ERRCODE = 'IRST3';\n  END IF;\n  RETURN NEW;\nEND\n$function$\n";
const GOLDEN_DISPATCH_TRIGGERDEF = "CREATE TRIGGER irs_event_dispatch_marker_guard BEFORE INSERT OR UPDATE ON public.\"Event\" FOR EACH ROW EXECUTE FUNCTION irs_event_dispatch_marker_guard()";
/** ADD §6: T3's exact predicate (the partner's), asserted in the golden definition. */
const T3_PREDICATE = [
  `  IF NEW."status" = 'PROCESSING'::"public"."EventState"`,
  `     AND (OLD."dispatchAnomalyAt" IS NOT NULL OR NEW."dispatchAnomalyAt" IS NOT NULL) THEN`,
  `    RAISE EXCEPTION 'irs dispatch marker rule T3' USING ERRCODE = 'IRST3';`,
].join("\n");
const DISPATCH_FUNCTION = "irs_event_dispatch_marker_guard";
const DISPATCH_CHECK = "Event_dispatchAnomaly_consistency_check";

async function dispatchColumns(client: PgClient): Promise<unknown[]> {
  const result = await client.query(
    `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            pg_get_expr(d.adbin, d.adrelid) AS column_default
       FROM pg_catalog.pg_attribute a
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public."Event"'::regclass AND NOT a.attisdropped
        AND a.attname IN (${DISPATCH_COLUMNS.map((column) => `'${column.column_name}'`).join(", ")})
      ORDER BY a.attname`,
  );
  return result.rows;
}

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
  it("applies every committed migration (init, then Task 011A's) to an empty registered scratch database; the catalog matches", async () => {
    assert.ok(MIGRATION_NAME !== undefined);
    const scratchUrl = await bootstrapScratch(admin, adminUrl, "migt1");
    try {
      const deploy = await runPrismaCli(["migrate", "deploy", "--config", "prisma7.config.ts"], {
        DATABASE_URL: scratchUrl,
      });
      assert.equal(deploy.exitCode, 0, deploy.stderr);
      assert.match(deploy.stdout, new RegExp(`Applying migration \`${MIGRATION_NAME}\``));
      for (const name of REQUIRED_MIGRATIONS) assert.match(deploy.stdout, new RegExp(`Applying migration \`${name}\``));

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
        // Task 012B (PL-2): the new enum's labels, in order.
        const anomalyLabels = await c.query<{ labels: string }>(
          `SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_catalog.pg_enum e
            WHERE e.enumtypid = 'public."DispatchAnomalyKind"'::regtype`,
        );
        assert.equal(anomalyLabels.rows[0]?.labels, "COMPLETED_WHILE_QUEUED,FAILED_WHILE_QUEUED");

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
        // Task 012B (PL-2): the nine dispatch columns, type, NOT NULL and default.
        assert.deepEqual(await dispatchColumns(c), DISPATCH_COLUMNS.map((column) => ({ ...column })));

        const checks = await checkConstraints(c);
        assert.deepEqual(checks, {
          [DISPATCH_CHECK]: { def: DISPATCH_CHECK_DEFINITION, validated: true },
          Event_rawBodySha256_format_check: { def: GOLDEN_CHECKS.Event_rawBodySha256_format_check, validated: true },
          Event_rawBody_length_check: { def: GOLDEN_CHECKS.Event_rawBody_length_check, validated: true },
        });

        // Task 012B (PL-2): the index's golden text; the function; the trigger on it, not internal, origin-enabled.
        const dispatchIndex = await c.query<{ def: string }>(
          `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_catalog.pg_index i
             JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid WHERE x.relname = 'Event_status_receivedAt_idx'`,
        );
        assert.deepEqual(dispatchIndex.rows, [{ def: DISPATCH_INDEX_DEFINITION }]);
        const trigger = await c.query<{ fn: string; tgisinternal: boolean; tgenabled: string }>(
          `SELECT tg.tgfoid::regproc::text AS fn, tg.tgisinternal, tg.tgenabled::text AS tgenabled
             FROM pg_catalog.pg_trigger tg WHERE tg.tgrelid = 'public."Event"'::regclass AND tg.tgname = $1`,
          [DISPATCH_FUNCTION],
        );
        assert.deepEqual(trigger.rows, [{ fn: DISPATCH_FUNCTION, tgisinternal: false, tgenabled: "O" }]);

        const absent = await c.query<{ rle: string | null; fn: string | null }>(
          `SELECT to_regclass('public."RateLimitEvidence"')::text AS rle,
                  to_regprocedure('public.${STATUS_FUNCTION}(uuid)')::text AS fn`,
        );
        assert.equal(absent.rows[0]?.rle, `"RateLimitEvidence"`);
        assert.equal(absent.rows[0]?.fn, `${STATUS_FUNCTION}(uuid)`);

        const ledger = await c.query(
          `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at FROM "public"."_prisma_migrations"
            ORDER BY migration_name`,
        );
        assert.deepEqual(
          ledger.rows,
          REQUIRED_MIGRATIONS.map((name) => ({ migration_name: name, finished: true, rolled_back_at: null })),
        );
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

describe("MIG-T3 blindness for Task 011A's raw SQL (IRS-C-055; documentation)", () => {
  // Documents, does not fix: the drift check compares the migration history with
  // the Prisma schema, and Prisma does not model partial unique indexes (without
  // a preview feature) or CHECKs. The 011A migration holds eight such raw objects
  // that the schema does not declare, and the drift check still reports nothing.
  // M1 (content), M2 (catalog golden text) and RD-7 (readiness) guard them instead.
  it("the 011A migration holds the four rle_* indexes and four CHECKs, the schema names none, and the drift script mentions none", async () => {
    const migrations = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));
    const name = REQUIRED_MIGRATIONS.find((entry) => entry.endsWith("_rate_limit_evidence")) ?? "";
    const sql = readFileSync(`${migrations}${name}/migration.sql`, "utf8");
    const schema = readFileSync(fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url)), "utf8");
    const objects = [...Object.values(RATE_LIMIT_EVIDENCE_INDEXES).map((def) => /INDEX (\S+) ON/.exec(def)?.[1] ?? "?"), ...Object.keys(GOLDEN_RLE_CHECKS)];
    assert.equal(objects.length, 8);
    for (const object of objects) {
      assert.ok(sql.includes(object), `${object} in the migration`);
      assert.ok(!schema.includes(object), `${object} not in the schema`);
    }
    const shadowUrl = withDatabase(adminUrl, SHADOW_DATABASE);
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
    process.stdout.write(`[IRS-C-055] --script: exit ${script.exitCode}; ${(script.stdout + script.stderr).trim()}\n`);
    assert.equal(script.exitCode, 0, script.stderr);
    assert.match(script.stdout, /empty migration/i);
    for (const object of objects) assert.ok(!script.stdout.includes(object), `${object} not in the drift script`);
  });

  it("Task 012B (PL-2): the event_dispatch migration's CHECK and trigger function are in the migration, absent from the schema and from the drift script", async () => {
    const migrations = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));
    const name = REQUIRED_MIGRATIONS.find((entry) => entry.endsWith("_event_dispatch")) ?? "";
    assert.notEqual(name, "");
    const sql = readFileSync(`${migrations}${name}/migration.sql`, "utf8");
    const schema = readFileSync(fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url)), "utf8");
    const objects = [DISPATCH_CHECK, DISPATCH_FUNCTION];
    for (const object of objects) {
      assert.ok(sql.includes(object), `${object} in the migration`);
      assert.ok(!schema.includes(object), `${object} not in the schema`);
    }
    // Positive control: the Prisma-modelled index is in both the migration and the schema's model.
    assert.ok(sql.includes("Event_status_receivedAt_idx"));
    assert.match(schema, /@@index\(\[status, receivedAt\]\)/);
    const shadowUrl = withDatabase(adminUrl, SHADOW_DATABASE);
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
    process.stdout.write(`[IRS-C-055 012B] --script: exit ${script.exitCode}; ${(script.stdout + script.stderr).trim()}\n`);
    assert.equal(script.exitCode, 0, script.stderr);
    assert.match(script.stdout, /empty migration/i);
    for (const object of objects) assert.ok(!script.stdout.includes(object), `${object} not in the drift script`);
  });
});

describe("M2: TD-3 CHECKs in the catalog", () => {
  it("pg_constraint holds the three Event CHECKs (both TD-3 and Task 012B's), validated, with the golden PostgreSQL 17 text", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      assert.deepEqual(await checkConstraints(api.client), {
        [DISPATCH_CHECK]: { def: DISPATCH_CHECK_DEFINITION, validated: true },
        Event_rawBodySha256_format_check: { def: GOLDEN_CHECKS.Event_rawBodySha256_format_check, validated: true },
        Event_rawBody_length_check: { def: GOLDEN_CHECKS.Event_rawBody_length_check, validated: true },
      });
    } finally {
      await api.close();
    }
  });

  it("Task 012B (PL-2): the trigger function and the trigger match their golden PostgreSQL 17.11 text, T3's exact predicate included", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      const fn = await api.client.query<{ def: string }>(
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
        [DISPATCH_FUNCTION],
      );
      assert.deepEqual(fn.rows, [{ def: GOLDEN_DISPATCH_FUNCTIONDEF }]);
      assert.ok(GOLDEN_DISPATCH_FUNCTIONDEF.includes(T3_PREDICATE), "T3's exact predicate is in the golden definition");
      const trigger = await api.client.query<{ def: string }>(
        `SELECT pg_get_triggerdef(tg.oid) AS def FROM pg_catalog.pg_trigger tg
          WHERE tg.tgrelid = 'public."Event"'::regclass AND tg.tgname = $1`,
        [DISPATCH_FUNCTION],
      );
      assert.deepEqual(trigger.rows, [{ def: GOLDEN_DISPATCH_TRIGGERDEF }]);
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

  it("Task 011A (RD-5): the four RateLimitEvidence natural-key indexes match their golden pg_get_indexdef() text", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      const result = await api.client.query<{ name: string; def: string; indisunique: boolean; indisvalid: boolean }>(
        `SELECT x.relname AS name, pg_get_indexdef(i.indexrelid) AS def, i.indisunique, i.indisvalid
           FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
          WHERE i.indrelid = 'public."RateLimitEvidence"'::regclass AND x.relname LIKE 'rle\\_%' ORDER BY x.relname`,
      );
      const expected = Object.values(RATE_LIMIT_EVIDENCE_INDEXES)
        .map((def) => ({ name: /INDEX (\S+) ON/.exec(def)?.[1] ?? "?", def, indisunique: true, indisvalid: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(result.rows, expected);
    } finally {
      await api.close();
    }
  });

  it("Task 011A (RD-5): the four RateLimitEvidence CHECKs exist, validated, with their golden pg_get_constraintdef() text", async () => {
    const api = await connectGuarded({ url: apiUrl, mode: "api" });
    try {
      const result = await api.client.query<{ conname: string; def: string; convalidated: boolean }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_catalog.pg_constraint
          WHERE conrelid = 'public."RateLimitEvidence"'::regclass AND contype = 'c' ORDER BY conname`,
      );
      assert.deepEqual(
        Object.fromEntries(result.rows.map((row) => [row.conname, { def: row.def, validated: row.convalidated }])),
        Object.fromEntries(Object.entries(GOLDEN_RLE_CHECKS).map(([name, def]) => [name, { def, validated: true }])),
      );
    } finally {
      await api.close();
    }
  });
});
