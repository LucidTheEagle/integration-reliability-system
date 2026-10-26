import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDispatchQueue, publishDispatchJob, startDispatchWorker } from "./dispatch-queue/index.js";
import type { DispatchJobView, DispatchQueueHandle } from "./dispatch-queue/index.js";
import { guardedDispatchSettings, waitUntil } from "./test-support/dispatch-redis.js";

// 012A-3 step 4b (addendum §3.2 rule 6b): a failed dispatch job, failed
// through startDispatchWorker, survives repeated later failures and repeated
// later completions made through every sanctioned path: two queue handles
// from openDispatchQueue publishing through publishDispatchJob, and two
// successive workers from startDispatchWorker. In the original probes (P1e
// E3, cases 1 and 2) a single later failure under a count- or age-based
// policy was enough to evict; this test makes 25 later failures and 25 later
// completions (more than the 21 failures of P1e's case-3 control).

const LATER_FAILURES = 25;
const LATER_COMPLETIONS = 25;

async function deliberateOutcome(job: DispatchJobView): Promise<void> {
  const data = job.data;
  if (typeof data === "object" && data !== null && Object.getOwnPropertyDescriptor(data, "outcome")?.value === "fail") {
    throw new Error("deliberate dispatch failure (test)");
  }
}

async function settled(queue: DispatchQueueHandle, ids: readonly string[]): Promise<boolean> {
  for (const id of ids) {
    const state = await queue.getJobState(id);
    if (state !== "failed" && state !== "completed") return false;
  }
  return true;
}

describe("dispatch queue (Redis): failed-job retention", () => {
  it("keeps the first failed job through later failures and completions", async () => {
    const settings = await guardedDispatchSettings("dispatch-failed-retention");
    const first = openDispatchQueue(settings);
    const second = openDispatchQueue(settings);
    try {
      const failedId = randomUUID();
      const failedData = { eventId: failedId, outcome: "fail" };
      await publishDispatchJob(first, failedId, failedData);
      const workerA = startDispatchWorker(settings, deliberateOutcome);
      try {
        await waitUntil(async () => (await first.getJobState(failedId)) === "failed", "the first job to fail");
      } finally {
        await workerA.close();
      }

      const workerB = startDispatchWorker({ ...settings, concurrency: 5 }, deliberateOutcome);
      const later: string[] = [];
      try {
        for (let n = 0; n < Math.max(LATER_FAILURES, LATER_COMPLETIONS); n++) {
          const via = n % 2 === 0 ? first : second;
          if (n < LATER_FAILURES) {
            const id = randomUUID();
            later.push(await publishDispatchJob(via, id, { eventId: id, outcome: "fail" }));
          }
          if (n < LATER_COMPLETIONS) {
            const id = randomUUID();
            later.push(await publishDispatchJob(via, id, { eventId: id, outcome: "complete" }));
          }
        }
        await waitUntil(() => settled(first, later), "every later job to finish", 60_000);
      } finally {
        await workerB.close();
      }

      assert.equal(await first.getJobState(failedId), "failed");
      assert.equal(await second.getJobState(failedId), "failed");
      assert.deepEqual(await first.getJob(failedId), {
        id: failedId,
        data: failedData,
        attemptsMade: 1,
        removeOnFail: false,
        removeOnComplete: { age: 3600, count: 5000 },
      });
      const counts = await first.getJobCounts();
      assert.equal(counts.failed, 1 + LATER_FAILURES);
      assert.equal(counts.completed, LATER_COMPLETIONS);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
