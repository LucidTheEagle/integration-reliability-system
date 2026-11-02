import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { openDispatchProbe, openDispatchQueue, publishDispatchJob, startDispatchWorker } from "./dispatch-queue/index.js";
import type { DispatchJobRecord } from "./dispatch-queue/index.js";
import { waitUntil } from "./test-support/dispatch-redis.js";
import { PROBE_HANDLE_METHODS, handleSurfaceProblems } from "./test-support/handle-surface.js";
import { guardedDispatchSettings, issueTestNamespace } from "./test-support/redis-guard.js";

// Task 012B-3 (FD-17, FD-18 B-2, FD-19; RC-3, RC-4; FD-18 E10): the live job
// fingerprint cases, against the test Redis, each under its own key
// namespace, cleaned up after the test (D-F2). Every expectation is derived
// by the test itself, never captured from Redis: attempts made 0 or 1, both
// times within the test's own clock window, digests computed here from the
// known texts. A JOB_HASH_FORMAT here is the observation that a stored form
// is not canonical: a STOP finding, with no re-run (RC-3). Transport,
// retirement and reconnect proofs are 012B-5's; nothing here claims them.

/** SHA-256 of the 4 bytes `null`, what the library stores for a job that returns nothing (FD-18 B-2; RC-4). */
const NULL_TEXT_DIGEST = createHash("sha256").update(Buffer.from("null")).digest("hex");
const FAILURE_MESSAGE = "deliberate fingerprint failure planted-marker-7f3a";
const MARKER = "planted-marker-7f3a";
const BASE = { removeOnFail: false, removeOnComplete: { age: 3600, count: 5000 } };

function sortedKeys(record: DispatchJobRecord): string[] {
  return Object.keys(record).sort();
}

function withinWindow(value: number | undefined, from: number, to: number): number {
  assert.ok(value !== undefined && Number.isSafeInteger(value), "a safe-integer epoch time");
  assert.ok(from <= value && value <= to, "within the test's own clock window");
  return value;
}

describe("dispatch queue (Redis): job fingerprints (Task 012B-3)", () => {
  it("a job never finished: exactly the five base keys, attemptsMade 0", async (t) => {
    const settings = await guardedDispatchSettings(issueTestNamespace(t, "dispatch-fingerprint"));
    const queue = openDispatchQueue(settings);
    try {
      const eventId = randomUUID();
      const data = { eventId };
      await publishDispatchJob(queue, eventId, data);
      assert.deepEqual(await queue.getJob(eventId), { id: eventId, data, attemptsMade: 0, ...BASE });
    } finally {
      await queue.close();
    }
  });

  it("a job completed with no return value: attempts 1, both times in the window, the 4-byte null digest", async (t) => {
    const settings = await guardedDispatchSettings(issueTestNamespace(t, "dispatch-fingerprint"));
    const queue = openDispatchQueue(settings);
    try {
      const eventId = randomUUID();
      const t0 = Date.now();
      await publishDispatchJob(queue, eventId, { eventId });
      const worker = startDispatchWorker(settings, async () => undefined);
      try {
        await waitUntil(async () => (await queue.getJobState(eventId)) === "completed", "the job to complete");
      } finally {
        await worker.close();
      }
      const t1 = Date.now();
      const record = await queue.getJob(eventId);
      assert.ok(record !== undefined);
      assert.equal(record.attemptsMade, 1);
      const processedOn = withinWindow(record.processedOn, t0, t1);
      const finishedOn = withinWindow(record.finishedOn, t0, t1);
      assert.ok(processedOn <= finishedOn);
      assert.equal(record.returnValueSha256, NULL_TEXT_DIGEST);
      assert.deepEqual(sortedKeys(record), [
        "attemptsMade",
        "data",
        "finishedOn",
        "id",
        "processedOn",
        "removeOnComplete",
        "removeOnFail",
        "returnValueSha256",
      ]);
    } finally {
      await queue.close();
    }
  });

  it("a job failed with a known message: attempts 1, both times in the window, the message's digest, no text", async (t) => {
    const settings = await guardedDispatchSettings(issueTestNamespace(t, "dispatch-fingerprint"));
    const queue = openDispatchQueue(settings);
    try {
      const eventId = randomUUID();
      const t0 = Date.now();
      await publishDispatchJob(queue, eventId, { eventId });
      const worker = startDispatchWorker(settings, async () => {
        throw new Error(FAILURE_MESSAGE);
      });
      try {
        await waitUntil(async () => (await queue.getJobState(eventId)) === "failed", "the job to fail");
      } finally {
        await worker.close();
      }
      const t1 = Date.now();
      const record = await queue.getJob(eventId);
      assert.ok(record !== undefined);
      assert.equal(record.attemptsMade, 1);
      const processedOn = withinWindow(record.processedOn, t0, t1);
      const finishedOn = withinWindow(record.finishedOn, t0, t1);
      assert.ok(processedOn <= finishedOn);
      assert.equal(record.failedReasonSha256, createHash("sha256").update(Buffer.from(FAILURE_MESSAGE, "utf8")).digest("hex"));
      assert.deepEqual(sortedKeys(record), [
        "attemptsMade",
        "data",
        "failedReasonSha256",
        "finishedOn",
        "id",
        "processedOn",
        "removeOnComplete",
        "removeOnFail",
      ]);
      assert.ok(!JSON.stringify(record).includes(MARKER), "the failure text appears in no record field");
    } finally {
      await queue.close();
    }
  });

  it("the probe connection: ping() resolves undefined, the handle exposes only its designed methods, close() resolves", async (t) => {
    const settings = await guardedDispatchSettings(issueTestNamespace(t, "dispatch-fingerprint"));
    const probe = openDispatchProbe(settings);
    try {
      assert.deepEqual(handleSurfaceProblems(probe, PROBE_HANDLE_METHODS), []);
      assert.equal(await probe.ping(), undefined);
    } finally {
      await probe.close();
    }
  });
});
