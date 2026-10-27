import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDispatchQueue, publishDispatchJob, startDispatchWorker } from "./dispatch-queue/index.js";
import { QUEUE_HANDLE_METHODS, WORKER_HANDLE_METHODS, handleSurfaceProblems } from "./test-support/handle-surface.js";
import { waitUntil } from "./test-support/dispatch-redis.js";
import { guardedDispatchSettings, issueTestNamespace } from "./test-support/redis-guard.js";

// 012A-3 step 4a, against the test Redis (127.0.0.1:46379), under this test's
// own key namespace, cleaned up after the test (D-F2). Publication only
// through publishDispatchJob; every read through the queue handle's
// read-only inspection.

describe("dispatch queue (Redis): smoke", () => {
  it("publishes, reads back by id, suppresses a second publish of the same event, and exposes only the designed methods", async (t) => {
    const settings = await guardedDispatchSettings(issueTestNamespace(t, "dispatch-smoke"));
    const queue = openDispatchQueue(settings);
    try {
      assert.deepEqual(handleSurfaceProblems(queue, QUEUE_HANDLE_METHODS), []);

      const eventId = randomUUID();
      const first = { eventId, publication: "first" };
      assert.equal(await publishDispatchJob(queue, eventId, first), eventId);
      assert.deepEqual(await queue.getJob(eventId), {
        id: eventId,
        data: first,
        attemptsMade: 0,
        removeOnFail: false,
        removeOnComplete: { age: 3600, count: 5000 },
      });
      assert.equal(await queue.getJobState(eventId), "waiting");

      // Same event id again, with different data: suppressed, the stored job unchanged.
      assert.equal(await publishDispatchJob(queue, eventId, { eventId, publication: "second" }), eventId);
      assert.deepEqual((await queue.getJob(eventId))?.data, first);
      assert.equal((await queue.getJobCounts()).waiting, 1);

      const processed: string[] = [];
      const worker = startDispatchWorker(settings, async (job) => {
        processed.push(job.id);
      });
      try {
        await worker.waitUntilReady();
        assert.deepEqual(handleSurfaceProblems(worker, WORKER_HANDLE_METHODS), []);
        await waitUntil(async () => (await queue.getJobState(eventId)) === "completed", "the job to complete");
        assert.deepEqual(processed, [eventId]);
      } finally {
        await worker.close();
      }

      // A completed job is retained, so a later publish is still suppressed.
      assert.equal(await publishDispatchJob(queue, eventId, { eventId, publication: "third" }), eventId);
      assert.equal(await queue.getJobState(eventId), "completed");
      assert.deepEqual((await queue.getJob(eventId))?.data, first);
    } finally {
      await queue.close();
    }
  });
});
