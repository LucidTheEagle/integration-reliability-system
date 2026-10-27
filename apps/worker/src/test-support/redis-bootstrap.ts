import { pathToFileURL } from "node:url";
import { bootstrapSentinel, safeReason } from "./redis-guard.js";

// Sentinel bootstrap (DR-11). Writes the sentinel into the main test database
// only when the key is absent; any other value is refused, never overwritten
// (bootstrapSentinel, redis-guard.ts). Run once against a new test Redis:
//
//   pnpm --filter @irs/worker run build && node apps/worker/dist/test-support/redis-bootstrap.js

async function main(): Promise<void> {
  const outcome = await bootstrapSentinel();
  process.stdout.write(`[redis-bootstrap] sentinel ${outcome}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[redis-bootstrap] FAILED: ${safeReason(error)}\n`);
    process.exitCode = 1;
  });
}
