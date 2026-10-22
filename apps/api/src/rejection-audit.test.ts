import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryEvidenceStore } from "./evidence-store.js";
import type { EvidenceStore } from "./evidence-store.js";
import { EvidenceCutoffError } from "./evidence-store-postgres.js";
import { DEFAULT_AUDIT_POLICIES, createRejectionAuditRecorder, fullJitterDelay } from "./rejection-audit.js";
import type { AuditPolicies, AuditRecorderCounters, AuditRecorderSnapshot, RejectionCandidate } from "./rejection-audit.js";
import { ManualClock, ManualScheduler, settleTurns } from "./test-helpers.js";

// Task 011A recorder (design §6): A-T9, A-T10, A-T11 (recorder half),
// A-T13 (a), A-T17, the §6.2 invariants, and the PA-3 addition (e). Manual
// clock and scheduler; the in-memory store (state-machine tests).

const INSTANCE = "5b0c3a1e-2d4f-4a6b-8c7d-9e0f1a2b3c4d";

function candidate(changes: Partial<RejectionCandidate> = {}): RejectionCandidate {
  return {
    requestId: randomUUID(),
    receivedAt: "2026-10-21T10:00:00.000Z",
    stage: "VERIFIER",
    httpStatus: 401,
    errorCode: "UNAUTHORIZED",
    claimedIntegrationId: "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61",
    verifierReason: "SIGNATURE_MISMATCH",
    responseCompletion: "FINISH_OBSERVED",
    ...changes,
  };
}

function setup(options: { policies?: Partial<AuditPolicies>; store?: EvidenceStore; logger?: { warn: () => void; error: () => void } } = {}) {
  const clock = new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const memory = createInMemoryEvidenceStore({ now: clock.now });
  const store = options.store ?? memory;
  const recorder = createRejectionAuditRecorder({
    store,
    limiterInstanceId: INSTANCE,
    policies: { ...DEFAULT_AUDIT_POLICIES, ...options.policies },
    clock: { monotonicNow: clock.now, wallNow: clock.wall },
    scheduler,
    random: () => 0.5,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { clock, scheduler, memory, recorder };
}

/** §6.2: the three invariants on a snapshot (non-fault paths). */
function assertInvariants(counters: AuditRecorderCounters, queueDepth: number): void {
  assert.equal(counters.submitted, counters.finishObserved + counters.closeBeforeFinish, "submitted = finish + close");
  assert.equal(
    counters.submitted,
    counters.ineligibleNonWebhook + counters.suppressedByCeiling + counters.droppedQueueFull + counters.admitted,
    "submitted = ineligible + suppressed + dropped + admitted",
  );
  assert.equal(
    counters.admitted,
    counters.persisted + counters.conflicts + counters.notAttemptedAtShutdown + counters.outcomeUnknownAtShutdown + queueDepth,
    "admitted = persisted + conflicts + notAttempted + unknown + queueDepth",
  );
}

function check(snapshot: AuditRecorderSnapshot): void {
  assertInvariants(snapshot.cumulative, snapshot.gauges.queueDepth);
}

describe("recorder admission (§6.1)", () => {
  it("before start(), admitted records only queue: no store call, no timer", async () => {
    const { memory, recorder, scheduler } = setup();
    recorder.sink.submit(candidate());
    await settleTurns();
    assert.equal(memory.calls.length, 0);
    assert.equal(scheduler.pending, 0);
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.admitted, snapshot.gauges.queueDepth], [1, 1]);
    check(snapshot);
  });

  it("ROUTER and NOT_FOUND are counted ineligibleNonWebhook and never queued or written (AD-3)", async () => {
    const { memory, recorder } = setup();
    recorder.control.start();
    recorder.sink.submit(candidate({ stage: "ROUTER", claimedIntegrationId: null, verifierReason: null }));
    recorder.sink.submit(candidate({ stage: "NOT_FOUND", httpStatus: 404, errorCode: "NOT_FOUND", claimedIntegrationId: null, verifierReason: null }));
    await settleTurns();
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.submitted, snapshot.cumulative.ineligibleNonWebhook, snapshot.cumulative.admitted], [2, 2, 0]);
    assert.equal(memory.calls.length, 0);
    check(snapshot);
  });

  it("A-T9: capacity k, frozen clock, N > k → exactly k admitted, N − k suppressedByCeiling", async () => {
    const { recorder } = setup({ policies: { writeBucket: { capacity: 3, refillPerSecond: 10 } } });
    for (let i = 0; i < 7; i += 1) recorder.sink.submit(candidate({ responseCompletion: i % 2 === 0 ? "FINISH_OBSERVED" : "CLOSE_BEFORE_FINISH" }));
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual(
      [snapshot.cumulative.submitted, snapshot.cumulative.admitted, snapshot.cumulative.suppressedByCeiling],
      [7, 3, 4],
    );
    assert.deepEqual([snapshot.cumulative.finishObserved, snapshot.cumulative.closeBeforeFinish], [4, 3]);
    check(snapshot);
  });

  it("the ceiling refills over time (10 per second)", () => {
    const { clock, recorder } = setup({ policies: { writeBucket: { capacity: 1, refillPerSecond: 10 } } });
    recorder.sink.submit(candidate());
    recorder.sink.submit(candidate());
    clock.advance(100);
    recorder.sink.submit(candidate());
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.admitted, snapshot.cumulative.suppressedByCeiling], [2, 1]);
  });

  it("A-T10: store failing, queue capacity q, M > q → queueDepth ≤ q, droppedQueueFull = M − q; in-flight records stay in queueDepth; after recovery each is written once", async () => {
    const { memory, recorder, scheduler } = setup({ policies: { queueCapacity: 4, batchSize: 2 } });
    memory.faults.failNext(3, { methods: ["writeRejections"] });
    recorder.control.start();
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const c = candidate();
      ids.push(c.requestId);
      recorder.sink.submit(c);
      const snapshot = recorder.control.drainCounters();
      assert.ok(snapshot.gauges.queueDepth <= 4);
      check(snapshot);
    }
    let snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.admitted, snapshot.cumulative.droppedQueueFull, snapshot.gauges.queueDepth], [4, 3, 4]);
    // The writer retries with backoff until the store recovers.
    for (let step = 0; step < 10; step += 1) {
      await scheduler.advance(30_000);
      snapshot = recorder.control.drainCounters();
      check(snapshot);
      assert.ok(snapshot.gauges.queueDepth <= 4);
    }
    assert.deepEqual([snapshot.cumulative.persisted, snapshot.gauges.queueDepth], [4, 0]);
    const rows = memory.raw.rejectionRows();
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.id).sort(), ids.slice(0, 4).sort());
  });

  it("an in-flight batch's records remain in queueDepth until its result is applied", async () => {
    const { memory, recorder } = setup({ policies: { batchSize: 2 } });
    const hang = memory.faults.hang({ methods: ["writeRejections"] });
    recorder.control.start();
    recorder.sink.submit(candidate());
    recorder.sink.submit(candidate());
    await hang.reached;
    let snapshot = recorder.control.drainCounters();
    assert.equal(snapshot.gauges.queueDepth, 2);
    check(snapshot);
    hang.release();
    await settleTurns();
    snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.persisted, snapshot.gauges.queueDepth], [2, 0]);
  });
});

describe("A-T11 (recorder half): idempotent EVENT_REJECTED persistence", () => {
  it("commit-then-throw → the identical retry is IDENTICAL_EXISTS: persisted once, one row; createdAt is the frozen admission time", async () => {
    const { clock, memory, recorder, scheduler } = setup();
    memory.faults.commitThenThrow({ methods: ["writeRejections"] });
    const admittedAt = clock.wall().toISOString();
    const c = candidate();
    recorder.control.start();
    recorder.sink.submit(c);
    await settleTurns();
    assert.equal(memory.raw.rejectionRows().length, 1, "the first attempt committed");
    await scheduler.advance(30_000);
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.persisted, snapshot.cumulative.conflicts, snapshot.gauges.queueDepth], [1, 0, 0]);
    const row = memory.raw.rejectionRow(c.requestId);
    assert.equal(row?.createdAt, admittedAt, "createdAt was frozen at admission, before the clock advanced");
    assert.deepEqual(row?.metadata, {
      schemaVersion: 1,
      limiterInstanceId: INSTANCE,
      stage: c.stage,
      httpStatus: c.httpStatus,
      errorCode: c.errorCode,
      claimedIntegrationId: c.claimedIntegrationId,
      verifierReason: c.verifierReason,
      responseCompletion: c.responseCompletion,
      receivedAt: c.receivedAt,
    });
    assert.deepEqual(
      [row?.id, row?.entityId, row?.actorType, row?.actorId, row?.action, row?.entityType],
      [c.requestId, c.requestId, "EXTERNAL_SENDER", null, "EVENT_REJECTED", "WEBHOOK_DELIVERY"],
    );
  });

  it("a stored row with the same id and different content → CONFLICT: conflicts++, never overwritten, logged once", async () => {
    const errors: Record<string, unknown>[] = [];
    const { memory, recorder } = setup({ logger: { warn: () => undefined, error: (object: Record<string, unknown>) => errors.push(object) } as never });
    const c = candidate();
    memory.raw.seedRejection({
      id: c.requestId,
      actorType: "EXTERNAL_SENDER",
      actorId: null,
      action: "EVENT_REJECTED",
      entityType: "WEBHOOK_DELIVERY",
      entityId: c.requestId,
      metadata: { schemaVersion: 1, other: true },
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    recorder.control.start();
    recorder.sink.submit(c);
    await settleTurns();
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.conflicts, snapshot.cumulative.persisted, snapshot.gauges.queueDepth], [1, 0, 0]);
    assert.deepEqual(memory.raw.rejectionRow(c.requestId)?.metadata, { schemaVersion: 1, other: true });
    assert.deepEqual(errors.map((object) => object.event), ["REJECTION_CONFLICT"]);
    check(snapshot);
  });
});

describe("A-T13 (a): recorder finalization accounting", () => {
  it("q queued, k in a batch sent and never confirmed: at the deadline notAttempted = q − k, unknown = k, queueDepth 0; a detached batch resolving later changes nothing", async () => {
    const { memory, recorder, scheduler } = setup({ policies: { batchSize: 2 } });
    const hang = memory.faults.hang({ methods: ["writeRejections"] });
    // Two queued before start(): the first batch takes exactly k = 2; three more stay unattempted.
    for (let i = 0; i < 2; i += 1) recorder.sink.submit(candidate());
    recorder.control.start();
    await hang.reached;
    for (let i = 0; i < 3; i += 1) recorder.sink.submit(candidate());
    const finalized = recorder.control.finalize(5_000);
    await scheduler.advance(5_000);
    await finalized;
    assert.equal(recorder.control.state, "FINALIZED");
    const frozenSnapshot = recorder.control.drainCounters();
    assert.deepEqual(
      [frozenSnapshot.cumulative.notAttemptedAtShutdown, frozenSnapshot.cumulative.outcomeUnknownAtShutdown, frozenSnapshot.gauges.queueDepth],
      [3, 2, 0],
    );
    check(frozenSnapshot);
    hang.release();
    await settleTurns();
    assert.equal(memory.raw.rejectionRows().length, 2, "the detached batch did commit");
    const later = recorder.control.drainCounters();
    assert.deepEqual(later.cumulative, frozenSnapshot.cumulative, "no counter changed");
    assert.equal(Object.values(later.delta).every((value) => value === 0), true);
  });

  it("PA-3 addition (e): a detached batch later refused NOT_STARTED by the adapter's cutoff changes no frozen counter", async () => {
    const clockHolder: { refuse?: (error: unknown) => void } = {};
    const refusing: EvidenceStore = {
      ...createInMemoryEvidenceStore(),
      writeRejections: () =>
        new Promise((_resolve, reject) => {
          clockHolder.refuse = reject;
        }),
    };
    const { recorder, scheduler } = setup({ store: refusing, policies: { batchSize: 10 } });
    for (let i = 0; i < 3; i += 1) recorder.sink.submit(candidate());
    recorder.control.start();
    await settleTurns();
    const finalized = recorder.control.finalize(5_000);
    await scheduler.advance(5_000);
    await finalized;
    const frozenSnapshot = recorder.control.drainCounters();
    assert.deepEqual([frozenSnapshot.cumulative.outcomeUnknownAtShutdown, frozenSnapshot.cumulative.notAttemptedAtShutdown], [3, 0]);
    clockHolder.refuse?.(new EvidenceCutoffError());
    await settleTurns();
    assert.deepEqual(recorder.control.drainCounters().cumulative, frozenSnapshot.cumulative);
  });

  it("finalize drains the queue within the budget when the store works; later submissions count only afterFinalize", async () => {
    const { memory, recorder, scheduler } = setup();
    for (let i = 0; i < 3; i += 1) recorder.sink.submit(candidate());
    // Never started: finalize still drains (§6.1 finalize step 2).
    const finalized = recorder.control.finalize(5_000);
    await scheduler.advance(0);
    await finalized;
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.persisted, snapshot.cumulative.notAttemptedAtShutdown, snapshot.gauges.queueDepth], [3, 0, 0]);
    assert.equal(memory.raw.rejectionRows().length, 3);
    assert.equal(scheduler.pending, 0, "no timer remains");
    recorder.sink.submit(candidate());
    assert.equal(recorder.control.afterFinalize, 1);
    assert.equal(recorder.control.drainCounters().cumulative.submitted, 3);
    assert.equal(recorder.control.finalize(5_000), finalized, "finalize runs once");
  });

  it("a pending backoff is cut short at finalize: the writer retries within the budget", async () => {
    const { memory, recorder, scheduler } = setup();
    memory.faults.failNext(1, { methods: ["writeRejections"] });
    recorder.control.start();
    recorder.sink.submit(candidate());
    await settleTurns();
    assert.equal(scheduler.pending, 1, "a backoff timer is armed");
    const finalized = recorder.control.finalize(5_000);
    await settleTurns();
    await finalized;
    assert.equal(recorder.control.drainCounters().cumulative.persisted, 1);
    assert.equal(scheduler.pending, 0);
  });
});

describe("drainCounters and robustness", () => {
  it("delta resets at each snapshot; cumulative carries; interval boundaries chain", () => {
    const { clock, recorder } = setup();
    recorder.sink.submit(candidate());
    clock.advance(1_000);
    const first = recorder.control.drainCounters();
    recorder.sink.submit(candidate());
    clock.advance(1_000);
    const second = recorder.control.drainCounters();
    assert.deepEqual([first.delta.submitted, second.delta.submitted, second.cumulative.submitted], [1, 1, 2]);
    assert.equal(second.intervalStartedAt, first.intervalEndedAt);
    assert.ok(Object.isFrozen(second.delta) && Object.isFrozen(second.cumulative));
  });

  it("A-T17: a throwing logger is swallowed; submit never throws; a malformed candidate counts sinkFaults", async () => {
    const throwing = { warn: () => { throw new Error("logger down"); }, error: () => { throw new Error("logger down"); } };
    const { memory, recorder, scheduler } = setup({ logger: throwing });
    memory.faults.failNext(1, { methods: ["writeRejections"] });
    recorder.control.start();
    assert.doesNotThrow(() => recorder.sink.submit(candidate()));
    assert.doesNotThrow(() => recorder.sink.submit(candidate({ requestId: "not-a-uuid" })));
    await scheduler.advance(30_000);
    const snapshot = recorder.control.drainCounters();
    assert.deepEqual([snapshot.cumulative.persisted, snapshot.cumulative.sinkFaults], [1, 1]);
  });

  it("full jitter stays below min(cap, base × 2^n)", () => {
    const policy = { baseMs: 500, capMs: 30_000 };
    assert.equal(fullJitterDelay(0, policy, () => 0.999), 499);
    assert.equal(fullJitterDelay(3, policy, () => 0.5), 2_000);
    assert.equal(fullJitterDelay(20, policy, () => 0.999), 29_970);
    assert.equal(fullJitterDelay(5, policy, () => 0), 0);
  });
});
