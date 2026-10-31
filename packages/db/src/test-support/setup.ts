import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootstrapMain, bootstrapRoles, bootstrapShadow } from "./bootstrap.js";
import { collectEvidence } from "./evidence.js";
import { connectGuarded, requireTestUrl, withDatabase } from "./guard.js";
import { REPO_ROOT, runPrismaCli } from "./prisma-cli.js";
import { provision } from "./provision.js";
import { SHADOW_DATABASE } from "./registry.js";

// Test-database setup CLI (run by hand, never by tests):
//   node dist/test-support/setup.js bootstrap
//   node dist/test-support/setup.js bootstrap-roles   (Task 012B: the incremental role step; then provision)
//   node dist/test-support/setup.js author prisma/migrations/<dir>/migration.sql
//   node dist/test-support/setup.js author-next prisma/migrations/<dir>/migration.sql
//   node dist/test-support/setup.js provision
//   node dist/test-support/setup.js evidence

async function bootstrap(): Promise<void> {
  const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
  const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
  const main = await bootstrapMain(adminUrl);
  let shadowEvidence: string[];
  try {
    shadowEvidence = await bootstrapShadow(main.client, adminUrl);
  } finally {
    await main.client.end().catch(() => undefined);
  }
  for (const line of [...main.evidence, ...shadowEvidence]) process.stdout.write(`[bootstrap] ${line}\n`);
  // First connection with IRS_TEST_DATABASE_URL, before any application grant.
  const api = await connectGuarded({ url: apiUrl, mode: "api", applicationName: "irs-test-first-api" });
  process.stdout.write(
    `[bootstrap] api mode passed the full guard: ${api.target.database} as ${api.target.user}\n`,
  );
  await api.close();
}

/** Authors the init migration with the fallback form (Prompt B §4.3): prisma7.config.ts and a guarded URL. */
async function author(relativePath: string | undefined): Promise<void> {
  if (relativePath === undefined || !/^prisma\/migrations\/\d{14}_init\/migration\.sql$/.test(relativePath)) {
    throw new Error("usage: author prisma/migrations/<YYYYMMDDHHMMSS>_init/migration.sql");
  }
  const target = join(REPO_ROOT, relativePath);
  if (existsSync(target)) throw new Error(`${relativePath} already exists; not overwriting`);
  const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
  const run = await runPrismaCli(
    ["migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script", "--config", "prisma7.config.ts"],
    { DATABASE_URL: adminUrl },
  );
  process.stdout.write(`[author] exit ${run.exitCode}; stderr: ${run.stderr.trim()}\n`);
  if (run.exitCode !== 0 || run.stdout.trim() === "") throw new Error("migrate diff produced no migration");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, run.stdout);
  process.stdout.write(`[author] wrote ${relativePath} (${run.stdout.length} chars)\n`);
}

const NEXT_MIGRATION_PATH = /^prisma\/migrations\/(\d{14})_([a-z0-9_]+)\/migration\.sql$/;

/**
 * Authors a later migration (Task 011A, RD-4): the difference between the
 * committed history, replayed into the dedicated shadow database, and the
 * schema. Through P4 with the drift config; the `_init` path above is unchanged.
 * Raw SQL is appended to the written file by hand afterwards.
 */
async function authorNext(relativePath: string | undefined): Promise<void> {
  const match = relativePath === undefined ? null : NEXT_MIGRATION_PATH.exec(relativePath);
  if (relativePath === undefined || match === null || match[2] === "init") {
    throw new Error("usage: author-next prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql (not _init)");
  }
  const target = join(REPO_ROOT, relativePath);
  if (existsSync(dirname(target))) throw new Error(`${dirname(relativePath)} already exists; not overwriting`);
  const timestamp = match[1] ?? "";
  const existing = readdirSync(join(REPO_ROOT, "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (existing.some((name) => name.slice(0, 14) >= timestamp)) {
    throw new Error("the timestamp must be later than every existing migration");
  }
  const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
  const run = await runPrismaCli(
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
    { IRS_DRIFT_DATASOURCE_URL: adminUrl, IRS_DRIFT_SHADOW_DATABASE_URL: withDatabase(adminUrl, SHADOW_DATABASE) },
  );
  process.stdout.write(`[author-next] exit ${run.exitCode}; stderr: ${run.stderr.trim()}\n`);
  if (run.exitCode !== 0 || run.stdout.trim() === "" || /empty migration/i.test(run.stdout)) {
    throw new Error("migrate diff produced no migration");
  }
  mkdirSync(dirname(target));
  writeFileSync(target, run.stdout);
  process.stdout.write(`[author-next] wrote ${relativePath} (${run.stdout.length} chars)\n`);
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case "bootstrap":
      return bootstrap();
    case "bootstrap-roles": {
      const evidence = await bootstrapRoles(requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL"));
      for (const line of evidence) process.stdout.write(`[bootstrap-roles] ${line}\n`);
      return;
    }
    case "author":
      return author(argument);
    case "author-next":
      return authorNext(argument);
    case "provision": {
      const evidence = await provision(requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL"));
      for (const line of evidence) process.stdout.write(`[provision] ${line}\n`);
      return;
    }
    case "evidence":
      process.stdout.write(`${await collectEvidence(requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL"))}\n`);
      return;
    default:
      throw new Error("usage: setup.js bootstrap | bootstrap-roles | author <path> | author-next <path> | provision | evidence");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[setup] STOPPED: ${error instanceof Error ? error.message : "unknown error"}\n`);
  if (error instanceof Error && "state" in error) {
    process.stderr.write(`[setup] state: ${JSON.stringify((error as { state: unknown }).state)}\n`);
  }
  process.exitCode = 1;
});
