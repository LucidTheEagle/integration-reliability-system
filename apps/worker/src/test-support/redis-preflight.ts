import { pathToFileURL } from "node:url";
import { checkGuardedEndpoint, readServerBaseline, safeReason, usedMemoryBytes } from "./redis-guard.js";
import type { ServerBaseline } from "./redis-guard.js";
import {
  EXPECTED_REDIS_VERSION,
  EXPECTED_SERVER_CONFIG,
  MAIN_DATABASE_INDEX,
  TEST_REDIS_HOST,
  TEST_REDIS_PORT,
  USED_MEMORY_LIMIT_BYTES,
} from "./redis-registry.js";

// Runs first in `test:redis`, through the suite runner (redis-suite.ts): a
// guarded connection to the registered test Redis (pre-connect checks,
// connection, sentinel), then the server baseline, then used_memory against
// the D-F2 threshold. It fails loudly; it never skips. The listener audit of
// the port is not done here. It also runs on its own, after the build:
//
//   node apps/worker/dist/test-support/redis-preflight.js

export class PreflightFailure extends Error {
  override readonly name = "PreflightFailure";
}

/** D-F2 item 4: passes at or below USED_MEMORY_LIMIT_BYTES, refuses above it. */
export function withinUsedMemoryLimit(usedMemory: number): boolean {
  return usedMemory <= USED_MEMORY_LIMIT_BYTES;
}

/** The preflight's reads; the guarded ones in runPreflight, injected values in unit tests. */
export interface PreflightReads {
  checkEndpoint(): Promise<void>;
  serverBaseline(): Promise<ServerBaseline>;
  usedMemory(): Promise<number>;
}

export interface PreflightResult {
  /** INFO memory used_memory before the suite, in bytes. */
  readonly usedMemory: number;
}

export async function runPreflightWith(reads: PreflightReads): Promise<PreflightResult> {
  await reads.checkEndpoint();
  const baseline = await reads.serverBaseline();
  if (baseline.redisVersion !== EXPECTED_REDIS_VERSION) {
    throw new PreflightFailure(`redis_version is not ${EXPECTED_REDIS_VERSION}`);
  }
  for (const [name, expected] of Object.entries(EXPECTED_SERVER_CONFIG)) {
    const reply = baseline.config[name];
    if (!Array.isArray(reply) || reply.length !== 2 || reply[0] !== name || reply[1] !== expected) {
      throw new PreflightFailure(`CONFIG GET ${name} is not ${expected}`);
    }
  }
  const usedMemory = await reads.usedMemory();
  if (!Number.isSafeInteger(usedMemory) || usedMemory < 0) {
    throw new PreflightFailure("used_memory is not a byte count");
  }
  if (!withinUsedMemoryLimit(usedMemory)) {
    throw new PreflightFailure(
      `used_memory ${usedMemory} is above ${USED_MEMORY_LIMIT_BYTES} bytes: founder reset required`,
    );
  }
  return { usedMemory };
}

const GUARDED_READS: PreflightReads = Object.freeze({
  checkEndpoint: () => checkGuardedEndpoint(),
  serverBaseline: readServerBaseline,
  usedMemory: usedMemoryBytes,
});

export function runPreflight(): Promise<PreflightResult> {
  return runPreflightWith(GUARDED_READS);
}

/** The lines a passed preflight prints. */
export function preflightReport(result: PreflightResult): string[] {
  return [
    `[redis-preflight] guard passed: ${TEST_REDIS_HOST}:${TEST_REDIS_PORT} db ${MAIN_DATABASE_INDEX}, sentinel present`,
    `[redis-preflight] redis_version ${EXPECTED_REDIS_VERSION}`,
    ...Object.entries(EXPECTED_SERVER_CONFIG).map(([name, expected]) => `[redis-preflight] ${name} ${expected}`),
    `[redis-preflight] used_memory ${result.usedMemory} bytes (limit ${USED_MEMORY_LIMIT_BYTES}): within the limit`,
  ];
}

/** A printable reason for a failed preflight; never a value read from a file. */
export function preflightFailureReason(error: unknown): string {
  return error instanceof PreflightFailure ? error.message : safeReason(error);
}

async function main(): Promise<void> {
  const result = await runPreflight();
  for (const line of preflightReport(result)) process.stdout.write(`${line}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[redis-preflight] FAILED: ${preflightFailureReason(error)}\n`);
    process.exitCode = 1;
  });
}
