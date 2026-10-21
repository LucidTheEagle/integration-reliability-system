import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REQUIRED_MIGRATIONS } from "./schema-readiness.js";

// M1 (Addendum VPF-6): the committed init migration contains both TD-3
// CHECKs and the VPF-3a function. Catches an accidentally regenerated
// migration, which would silently drop the raw SQL. Tightened for Task 011A
// (RD-4, RD-5): the directories equal REQUIRED_MIGRATIONS, the init
// migration and the lock file are byte-identical, and 011A's raw SQL is present.

const MIGRATIONS = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));

/** The init migration's SHA-256, fixed since Task 011 (R5 baseline). */
const INIT_MIGRATION_SHA256 = "51aea0ee42fe50ebd31d04740fbad303dfa8aae03b387d938407817efb70f47b";
/** migration_lock.toml's SHA-256 (R5 baseline). */
const MIGRATION_LOCK_SHA256 = "99836963713b4f5b269ad49af0ed3d7b0b2e336115c2f92dc9ac683d139d0900";

function directories(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function initMigration(): { readonly name: string; readonly sql: string } {
  const name = REQUIRED_MIGRATIONS[0] ?? "";
  assert.match(name, /^\d{14}_init$/);
  return { name, sql: readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8") };
}

function rateLimitEvidenceMigration(): { readonly name: string; readonly sql: string } {
  const name = REQUIRED_MIGRATIONS.find((entry) => /^\d{14}_rate_limit_evidence$/.test(entry)) ?? "";
  assert.notEqual(name, "", "REQUIRED_MIGRATIONS names the Task 011A migration");
  return { name, sql: readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8") };
}

describe("M1: init migration content", () => {
  it("contains both TD-3 CHECKs, named, with the Rev 1.7 §10.2 expressions", () => {
    const { sql } = initMigration();
    assert.ok(
      sql.includes(
        `ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_rawBody_length_check" CHECK (octet_length("rawBody") BETWEEN 1 AND 1048576);`,
      ),
    );
    assert.ok(
      sql.includes(
        `ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_rawBodySha256_format_check" CHECK ("rawBodySha256" ~ '^[0-9a-f]{64}$');`,
      ),
    );
  });

  it("contains the VPF-3a function exactly as specified, with EXECUTE revoked from PUBLIC", () => {
    const { sql } = initMigration();
    const fn = [
      `CREATE FUNCTION "public"."irs_integration_config_status_for_share"(p_integration_id uuid)`,
      `  RETURNS "public"."IntegrationConfigState"`,
      `  LANGUAGE sql`,
      `  VOLATILE                      -- a locking clause is not allowed in a non-volatile function`,
      `  SECURITY DEFINER`,
      `  SET search_path = pg_catalog, pg_temp`,
      `AS $$`,
      `  SELECT "configStatus" FROM "public"."Integration" WHERE "id" = p_integration_id FOR SHARE`,
      `$$;`,
      `REVOKE ALL ON FUNCTION "public"."irs_integration_config_status_for_share"(uuid) FROM PUBLIC;`,
    ].join("\n");
    assert.ok(sql.replace(/\r\n/g, "\n").includes(fn));
  });

  it("names no role, grants nothing, and has no Task 011A objects", () => {
    const { sql } = initMigration();
    assert.doesNotMatch(sql, /\bGRANT\b/);
    assert.doesNotMatch(sql, /OWNER TO/);
    assert.doesNotMatch(sql, /irs_test/);
    assert.doesNotMatch(sql, /RateLimitEvidence/);
  });

  it("migration_lock.toml names postgresql", () => {
    const lock = readFileSync(`${MIGRATIONS}migration_lock.toml`, "utf8");
    assert.match(lock, /^provider = "postgresql"$/m);
  });
});

describe("M1, tightened for Task 011A (RD-4)", () => {
  it("the migration directories equal REQUIRED_MIGRATIONS, in order", () => {
    assert.deepEqual(directories(), [...REQUIRED_MIGRATIONS]);
  });

  it("the init migration and migration_lock.toml are byte-identical to the baseline (SHA-256)", () => {
    assert.equal(sha256(`${MIGRATIONS}${initMigration().name}/migration.sql`), INIT_MIGRATION_SHA256);
    assert.equal(sha256(`${MIGRATIONS}migration_lock.toml`), MIGRATION_LOCK_SHA256);
  });
});

describe("M1: Task 011A migration content (RD-5)", () => {
  it("contains the four natural-key partial unique indexes and the four CHECKs exactly as A14 §7.4", () => {
    const sql = rateLimitEvidenceMigration().sql.replace(/\r\n/g, "\n");
    const statements = [
      `CREATE UNIQUE INDEX rle_instance_lifecycle_uq ON "RateLimitEvidence" ("limiterInstanceId", "kind")\n  WHERE "kind" IN ('INSTANCE_STARTED', 'INSTANCE_CLOSED');`,
      `CREATE UNIQUE INDEX rle_summary_range_uq ON "RateLimitEvidence" ("limiterInstanceId", "firstSequence", "lastSequence")\n  WHERE "kind" = 'SUMMARY';`,
      `CREATE UNIQUE INDEX rle_gap_discontinuity_uq ON "RateLimitEvidence" ("limiterInstanceId", "missingFrom", "missingTo")\n  WHERE "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'SEQUENCE_DISCONTINUITY';`,
      `CREATE UNIQUE INDEX rle_gap_unclean_uq ON "RateLimitEvidence" ("limiterInstanceId")\n  WHERE "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'UNCLEAN_TERMINATION';`,
      `ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_kind_ck\n  CHECK ("kind" IN ('INSTANCE_STARTED','SUMMARY','EVIDENCE_GAP','INSTANCE_CLOSED'));`,
      `ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_summary_shape_ck\n  CHECK ("kind" <> 'SUMMARY'\n         OR ("firstSequence" IS NOT NULL AND "lastSequence" IS NOT NULL\n             AND "firstSequence" >= 1 AND "lastSequence" >= "firstSequence"));`,
      `ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_gap_shape_ck\n  CHECK ("kind" <> 'EVIDENCE_GAP' OR "gapReason" IS DISTINCT FROM 'SEQUENCE_DISCONTINUITY'\n         OR ("missingFrom" IS NOT NULL AND "missingTo" IS NOT NULL\n             AND "missingFrom" >= 1 AND "missingTo" >= "missingFrom"));`,
      `ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_gap_reason_ck\n  CHECK ("kind" <> 'EVIDENCE_GAP'\n         OR ("gapReason" IS NOT NULL AND "gapReason" IN ('SEQUENCE_DISCONTINUITY', 'UNCLEAN_TERMINATION')));`,
    ];
    for (const statement of statements) assert.ok(sql.includes(statement), statement.split("\n")[0]);
  });

  it("names no role, grants nothing and installs no extension; the schema enables no preview feature", () => {
    const { sql } = rateLimitEvidenceMigration();
    assert.doesNotMatch(sql, /\bGRANT\b/);
    assert.doesNotMatch(sql, /OWNER TO/);
    assert.doesNotMatch(sql, /irs_test/);
    assert.doesNotMatch(sql, /CREATE EXTENSION/i);
    assert.doesNotMatch(sql, /btree_gist/i);
    const schema = readFileSync(fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url)), "utf8");
    assert.doesNotMatch(schema, /previewFeatures/);
  });
});
