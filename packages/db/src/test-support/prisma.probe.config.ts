// Test-only Prisma config for RD-T4: `migrate deploy` of a temporary
// migrations directory (the init migration plus a deliberately failing one)
// into a registered scratch database. The URL reaches this config only
// through runPrismaCli (path P4), which checks it with the guard. The
// migrations directory is a temporary copy outside the repository.
import { defineConfig } from "prisma/config";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

export default defineConfig({
  schema: "../../../../prisma/schema.prisma",
  migrations: { path: required("IRS_PROBE_MIGRATIONS_DIR") },
  datasource: { url: required("IRS_PROBE_DATASOURCE_URL") },
});
