import { pathToFileURL } from "node:url";
import { connectUnverified, safeReason, verifySentinel } from "./redis-guard.js";
import { SENTINEL_KEY, SENTINEL_MARKER } from "./redis-registry.js";

// Sentinel bootstrap (DR-11). Writes the sentinel into the main test database
// only when the key is absent; any other value is refused, never overwritten.
// Run once against a new test Redis:
//
//   pnpm --filter @irs/worker run build && node apps/worker/dist/test-support/redis-bootstrap.js

export type BootstrapOutcome = "written" | "present";

export async function bootstrapSentinel(): Promise<BootstrapOutcome> {
  const guarded = await connectUnverified();
  try {
    const reply = await guarded.client.set(SENTINEL_KEY, SENTINEL_MARKER, "NX");
    // Either way, the key must now hold the marker; anything else is refused.
    await verifySentinel(guarded.client);
    return reply === "OK" ? "written" : "present";
  } finally {
    await guarded.close();
  }
}

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
