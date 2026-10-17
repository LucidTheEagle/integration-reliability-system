import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// M1 (Addendum VPF-6): the committed init migration contains both TD-3
// CHECKs and the VPF-3a function. Catches an accidentally regenerated
// migration, which would silently drop the raw SQL.

const MIGRATIONS = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));

function initMigration(): { readonly name: string; readonly sql: string } {
  const directories = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(directories.length, 1, `expected exactly one migration, found ${directories.join(", ")}`);
  const name = directories[0] ?? "";
  assert.match(name, /^\d{14}_init$/);
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
