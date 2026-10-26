import { setTimeout as sleep } from "node:timers/promises";
import type { DispatchSettings } from "../dispatch-queue/index.js";
import { loadRedisPassword } from "../redis-password.js";
import { REPOSITORY_ROOT } from "../repository-root.js";
import { REGISTERED_TARGET, connectGuarded } from "./redis-guard.js";
import { testQueueName } from "./redis-registry.js";

// Settings for the dispatch-queue Redis tests. The registered target passes
// the full guard (pre-connect checks, connection, sentinel) before its
// settings are handed to the module; the password is the test password,
// loaded in-process through the D6 loader and never displayed. Each call
// gives a new key prefix, so tests never share keys and nothing is flushed.

export async function guardedDispatchSettings(label: string): Promise<DispatchSettings> {
  const guarded = await connectGuarded(REGISTERED_TARGET);
  await guarded.close();
  const password = loadRedisPassword({ REDIS_PASSWORD_FILE: REGISTERED_TARGET.passwordFile }, REPOSITORY_ROOT);
  return {
    host: REGISTERED_TARGET.host,
    port: REGISTERED_TARGET.port,
    password,
    prefix: testQueueName(label),
  };
}

/** INFO memory used_memory of the test Redis, through a guarded connection. */
export async function usedMemoryBytes(): Promise<number> {
  const guarded = await connectGuarded(REGISTERED_TARGET);
  try {
    const info = await guarded.client.info("memory");
    const value = /^used_memory:(\d+)\r?$/m.exec(info)?.[1];
    if (value === undefined) throw new Error("INFO memory has no used_memory line");
    return Number(value);
  } finally {
    await guarded.close();
  }
}

/** Polls until `condition` holds; fails after `timeoutMs`, naming `what`. */
export async function waitUntil(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
  everyMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}
