// Test-only Prisma config for MIG-T3, the drift check (VP-011 I-6 pattern).
// `migrate diff --from-migrations` needs a shadow database and resets its
// public schema, so the shadow is the dedicated irs_011_shadow_test. Both
// URLs reach this config only through runPrismaCli (path P4), which checks
// them with the guard and passes them in that child's environment only.
// Relative paths resolve against this file's directory.
import { defineConfig } from "prisma/config";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

export default defineConfig({
  schema: "../../../../prisma/schema.prisma",
  migrations: { path: "../../../../prisma/migrations" },
  datasource: {
    url: required("IRS_DRIFT_DATASOURCE_URL"),
    shadowDatabaseUrl: required("IRS_DRIFT_SHADOW_DATABASE_URL"),
  },
});
