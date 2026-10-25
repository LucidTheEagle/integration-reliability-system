import { connectGuarded, safeReason } from "./redis-guard.js";
import {
  EXPECTED_REDIS_VERSION,
  EXPECTED_SERVER_CONFIG,
  MAIN_DATABASE_INDEX,
  TEST_REDIS_HOST,
  TEST_REDIS_PORT,
} from "./redis-registry.js";

// Runs first in `test:redis`: a guarded connection to the registered test
// Redis (pre-connect checks, connection, sentinel), then the server baseline.
// It fails loudly; it never skips. The listener audit of the port is not
// done here.

class PreflightFailure extends Error {
  override readonly name = "PreflightFailure";
}

async function main(): Promise<void> {
  const guarded = await connectGuarded();
  try {
    const info = await guarded.client.info("server");
    const version = /^redis_version:([^\r\n]*)$/m.exec(info)?.[1];
    if (version !== EXPECTED_REDIS_VERSION) {
      throw new PreflightFailure(`redis_version is not ${EXPECTED_REDIS_VERSION}`);
    }
    for (const [name, expected] of Object.entries(EXPECTED_SERVER_CONFIG)) {
      const reply: unknown = await guarded.client.config("GET", name);
      if (!Array.isArray(reply) || reply.length !== 2 || reply[0] !== name || reply[1] !== expected) {
        throw new PreflightFailure(`CONFIG GET ${name} is not ${expected}`);
      }
    }
  } finally {
    await guarded.close();
  }
  process.stdout.write(
    `[redis-preflight] guard passed: ${TEST_REDIS_HOST}:${TEST_REDIS_PORT} db ${MAIN_DATABASE_INDEX}, sentinel present\n`,
  );
  process.stdout.write(`[redis-preflight] redis_version ${EXPECTED_REDIS_VERSION}\n`);
  for (const [name, expected] of Object.entries(EXPECTED_SERVER_CONFIG)) {
    process.stdout.write(`[redis-preflight] ${name} ${expected}\n`);
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof PreflightFailure ? error.message : safeReason(error);
  process.stderr.write(`[redis-preflight] FAILED: ${reason}\n`);
  process.exitCode = 1;
});
