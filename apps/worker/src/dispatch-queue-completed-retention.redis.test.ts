import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDispatchQueue, publishDispatchJob, startDispatchWorker } from "./dispatch-queue/index.js";
import type { DispatchJobView } from "./dispatch-queue/index.js";
import { waitUntil } from "./test-support/dispatch-redis.js";
import { guardedDispatchSettings, issueTestNamespace, usedMemoryBytes } from "./test-support/redis-guard.js";

// 012A-3 step 4c (addendum §3.2 rule 6c, §3.4): with the module's own
// removeOnComplete { age: 3600, count: 5000 }, 5,200 jobs complete after a
// failed job exists. Completed-job cleanup then trims the completed set on
// each of the last 200 completions; the failed job must still be retained and
// the completed count must not exceed 5,000. Bounded at 5 minutes; the Redis
// memory this run adds is bounded at 32 MiB (estimated about 8-10 MB). The
// keys live under this test's own namespace, cleaned up after it (D-F2).

const COMPLETIONS = 5_200;
const POLICY_COUNT = 5_000;
const PUBLISH_BATCH = 200;
const MEMORY_BOUND_BYTES = 32 * 1024 * 1024;

describe("dispatch queue (Redis): completed-job cleanup never removes a failed job", () => {
  it(`completes ${COMPLETIONS} jobs after a failure; the failed job stays, completed <= ${POLICY_COUNT}`, { timeout: 300_000 }, async (t) => {
    const settings = await guardedDispatchSettings(issueTestNamespace(t, "dispatch-completed-retention"));
    const memoryBefore = await usedMemoryBytes();
    const started = Date.now();
    const queue = openDispatchQueue(settings);
    let completed = 0;
    const worker = startDispatchWorker({ ...settings, concurrency: 20 }, async (job: DispatchJobView) => {
      const data = job.data;
      if (typeof data === "object" && data !== null && Object.getOwnPropertyDescriptor(data, "outcome")?.value === "fail") {
        throw new Error("deliberate dispatch failure (test)");
      }
      completed++;
    });
    try {
      const failedId = randomUUID();
      await publishDispatchJob(queue, failedId, { eventId: failedId, outcome: "fail" });
      await waitUntil(async () => (await queue.getJobState(failedId)) === "failed", "the failed job");

      for (let published = 0; published < COMPLETIONS; published += PUBLISH_BATCH) {
        const batch = Math.min(PUBLISH_BATCH, COMPLETIONS - published);
        await Promise.all(
          Array.from({ length: batch }, () => {
            const id = randomUUID();
            return publishDispatchJob(queue, id, { eventId: id, outcome: "complete" });
          }),
        );
      }
      await waitUntil(
        async () => {
          if (completed < COMPLETIONS) return false;
          const counts = await queue.getJobCounts();
          return counts.waiting + counts.active + counts.delayed + counts.prioritized === 0;
        },
        `${COMPLETIONS} completions`,
        240_000,
        200,
      );

      const counts = await queue.getJobCounts();
      const memoryAfter = await usedMemoryBytes();
      t.diagnostic(`duration_ms=${Date.now() - started}`);
      t.diagnostic(`completed_by_processor=${completed} completed_retained=${counts.completed} failed_retained=${counts.failed}`);
      t.diagnostic(`used_memory_before=${memoryBefore} used_memory_after=${memoryAfter} delta=${memoryAfter - memoryBefore}`);

      assert.equal(completed, COMPLETIONS);
      assert.equal(await queue.getJobState(failedId), "failed");
      assert.equal((await queue.getJob(failedId))?.id, failedId);
      assert.equal(counts.failed, 1);
      assert.ok(counts.completed <= POLICY_COUNT, "the completed count does not exceed the policy");
      assert.ok(counts.completed > 0);
      assert.ok(memoryAfter - memoryBefore < MEMORY_BOUND_BYTES, "the run stays within its memory bound");
    } finally {
      await worker.close();
      await queue.close();
    }
  });
});
