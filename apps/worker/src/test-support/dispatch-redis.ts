import { setTimeout as sleep } from "node:timers/promises";

// Helpers for the dispatch-queue Redis tests. Their settings, key namespaces
// and memory readings come from redis-guard.ts (guardedDispatchSettings,
// issueTestNamespace, usedMemoryBytes), the only module that connects.

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
