import { assertServerBaseline } from "./baseline.js";
import { connectGuarded, requireTestUrl } from "./guard.js";

// Runs first in every `test:db` script: both variables must be set and both
// must pass the full guard. It fails loudly; it never skips.

async function main(): Promise<void> {
  const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
  const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
  const api = await connectGuarded({ url: apiUrl, mode: "api", applicationName: "irs-test-preflight" });
  await api.close();
  const admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-preflight" });
  try {
    await assertServerBaseline(admin.client);
  } finally {
    await admin.close();
  }
  for (const target of [api.target, admin.target]) {
    process.stdout.write(
      `[preflight] guard passed: ${target.host}:${target.port}/${target.database} as ${target.user}\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[preflight] FAILED: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
