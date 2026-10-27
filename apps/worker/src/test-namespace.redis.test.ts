import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDispatchQueue, publishDispatchJob } from "./dispatch-queue/index.js";
import {
  checkGuardedEndpoint,
  guardedDispatchSettings,
  issueTestNamespace,
  namespaceKeyCount,
} from "./test-support/redis-guard.js";
import type { TestNamespace } from "./test-support/test-namespace.js";

// D-F2 "only its own keys", against the test Redis (127.0.0.1:46379). The
// parent test holds namespace B; its subtest holds namespace A. Both get keys
// through the dispatch queue. When the subtest ends, its own after-hook
// removes every A key; every B key and the sentinel are untouched. B is
// removed by the parent's own after-hook when the parent ends.

async function publishOne(namespace: TestNamespace): Promise<void> {
  const queue = openDispatchQueue(await guardedDispatchSettings(namespace));
  try {
    const eventId = randomUUID();
    await publishDispatchJob(queue, eventId, { eventId });
  } finally {
    await queue.close();
  }
}

describe("test namespaces (Redis): cleanup removes only its own keys", () => {
  it("A's after-hook removes every A key; B's keys and the sentinel are untouched", async (t) => {
    const namespaceB = issueTestNamespace(t, "namespace-b");
    await publishOne(namespaceB);
    assert.ok((await namespaceKeyCount(namespaceB)) > 0, "B has keys");

    let namespaceA: TestNamespace | undefined;
    let keysBBeforeCleanup = -1;
    await t.test("subtest A", async (a) => {
      namespaceA = issueTestNamespace(a, "namespace-a");
      await publishOne(namespaceA);
      assert.ok((await namespaceKeyCount(namespaceA)) > 0, "A has keys");
      // The last count before A's after-hook runs.
      keysBBeforeCleanup = await namespaceKeyCount(namespaceB);
    });
    // The subtest, and its after-hook, have finished.
    assert.ok(namespaceA !== undefined);
    assert.equal(await namespaceKeyCount(namespaceA), 0, "every A key is removed");
    assert.equal(await namespaceKeyCount(namespaceB), keysBBeforeCleanup, "no B key is removed");
    await checkGuardedEndpoint();
    await assert.rejects(guardedDispatchSettings(namespaceA), /not-issued/);
  });
});
