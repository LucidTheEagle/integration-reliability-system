import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootstrapMain, bootstrapShadow } from "./bootstrap.js";
import { collectEvidence } from "./evidence.js";
import { connectGuarded, requireTestUrl } from "./guard.js";
import { REPO_ROOT, runPrismaCli } from "./prisma-cli.js";
import { provision } from "./provision.js";

// Test-database setup CLI (run by hand, never by tests):
//   node dist/test-support/setup.js bootstrap
//   node dist/test-support/setup.js author prisma/migrations/<dir>/migration.sql
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

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case "bootstrap":
      return bootstrap();
    case "author":
      return author(argument);
    case "provision": {
      const evidence = await provision(requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL"));
      for (const line of evidence) process.stdout.write(`[provision] ${line}\n`);
      return;
    }
    case "evidence":
      process.stdout.write(`${await collectEvidence(requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL"))}\n`);
      return;
    default:
      throw new Error("usage: setup.js bootstrap | author <path> | provision | evidence");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[setup] STOPPED: ${error instanceof Error ? error.message : "unknown error"}\n`);
  if (error instanceof Error && "state" in error) {
    process.stderr.write(`[setup] state: ${JSON.stringify((error as { state: unknown }).state)}\n`);
  }
  process.exitCode = 1;
});
