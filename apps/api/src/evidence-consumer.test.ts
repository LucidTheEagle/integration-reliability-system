import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCoverage } from "./coverage.js";
import { StartupSlotError, createEvidenceConsumer } from "./evidence-consumer.js";
import type { EvidenceConsumer, EvidencePolicies } from "./evidence-consumer.js";
import { buildEvidenceRecord, canonicalJson, freezeSummary, freezeUncleanGap, recordHash } from "./evidence-records.js";
import type { EvidenceSummary, FrozenEvidenceRecord, JsonValue } from "./evidence-records.js";
import { createInMemoryEvidenceStore, evidenceRowFields } from "./evidence-store.js";
import type { EvidenceRow, EvidenceStore, InMemoryEvidenceStore } from "./evidence-store.js";
import { contractCounters, contractSummary } from "./evidence-store-contract.js";
import { createRateLimiter } from "./rate-limit.js";
import type { RateLimitEvidence, RateLimiter, RateLimitSummary } from "./rate-limit.js";
import { createRejectionAuditRecorder } from "./rejection-audit.js";
import type { RecorderControl, RejectionAuditRecorder } from "./rejection-audit.js";
import { ManualClock, ManualScheduler, settleTurns } from "./test-helpers.js";

// The Task 011A evidence consumer (design §7.1, §8.1 – §8.3, §9; AN4).
// Every test here is a STATE-MACHINE test on the in-memory store, driven by
// a manual clock and scheduler; none is evidence of PostgreSQL behaviour
// (AN4 E3). The PostgreSQL runs are Stage 4 (store level) and Stage 7
// (composed).

const SCOPE = "consumer-tests";

// ---------------------------------------------------------------------------
// Environment: one clock, scheduler and store shared by several instances

interface Env {
  readonly clock: ManualClock;
  readonly scheduler: ManualScheduler;
  readonly memory: InMemoryEvidenceStore;
  /** Wraps the in-memory store; records every evidence write's records and time. */
  readonly store: EvidenceStore;
  readonly writes: { readonly method: string; readonly records: readonly FrozenEvidenceRecord[]; readonly at: number }[];
}

function env(): Env {
  const clock = new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const memory = createInMemoryEvidenceStore({ now: clock.now });
  const writes: Env["writes"][number][] = [];
  const store: EvidenceStore = {
    findRecoveryCandidates: (...args) => memory.findRecoveryCandidates(...args),
    readDurableState: (...args) => memory.readDurableState(...args),
    validateHistoricalGap: (...args) => memory.validateHistoricalGap(...args),
    writeRejections: (...args) => memory.writeRejections(...args),
    verifyRegistration: (...args) => memory.verifyRegistration(...args),
    writeUncleanGap: (gap, derivedFrom) => {
      writes.push({ method: "writeUncleanGap", records: [gap], at: clock.now() });
      return memory.writeUncleanGap(gap, derivedFrom);
    },
    writeEvidenceGroup: (records) => {
      writes.push({ method: "writeEvidenceGroup", records, at: clock.now() });
      return memory.writeEvidenceGroup(records);
    },
  };
  return { clock, scheduler, memory, store, writes };
}

interface Instance {
  readonly id: string;
  readonly limiter: RateLimiter | undefined;
  readonly evidence: RateLimitEvidence;
  readonly recorder: RejectionAuditRecorder;
  readonly control: RecorderControl;
  readonly consumer: EvidenceConsumer;
  readonly trace: string[];
  readonly logs: Record<string, unknown>[];
}

function instance(
  e: Env,
  options: {
    evidence?: RateLimitEvidence;
    wrapControl?: (control: RecorderControl) => RecorderControl;
    scope?: string;
    policies?: Partial<EvidencePolicies>;
    throwingLogger?: boolean;
  } = {},
): Instance {
  const pair = options.evidence === undefined ? createRateLimiter({ monotonicNow: e.clock.now, wallNow: e.clock.wall }) : undefined;
  const evidence = options.evidence ?? (pair as { evidence: RateLimitEvidence }).evidence;
  const clock = { monotonicNow: e.clock.now, wallNow: e.clock.wall };
  const logs: Record<string, unknown>[] = [];
  const logger = options.throwingLogger
    ? { warn: () => { throw new Error("logger down"); }, error: () => { throw new Error("logger down"); } }
    : { warn: (object: Record<string, unknown>) => logs.push(object), error: (object: Record<string, unknown>) => logs.push(object) };
  const recorder = createRejectionAuditRecorder({
    store: e.store,
    limiterInstanceId: evidence.limiterInstanceId,
    clock,
    scheduler: e.scheduler,
    random: () => 0.5,
    logger,
  });
  const control = options.wrapControl?.(recorder.control) ?? recorder.control;
  const trace: string[] = [];
  const consumer = createEvidenceConsumer({
    evidence,
    recorderControl: control,
    store: e.store,
    scope: options.scope ?? SCOPE,
    rateLimitPolicies: { note: "test" },
    auditPolicies: { queueCapacity: 1_000 },
    policies: { ...defaultPolicies(), ...options.policies },
    clock,
    scheduler: e.scheduler,
    random: () => 0.5,
    logger,
    trace: (event) => trace.push(event),
  });
  return { id: evidence.limiterInstanceId, limiter: pair?.limiter, evidence, recorder, control, consumer, trace, logs };
}

function defaultPolicies(): EvidencePolicies {
  return {
    pairingIntervalMs: 60_000,
    segmentMaxIntervalMs: 15 * 60_000,
    evidenceRetry: { baseMs: 500, capMs: 30_000 },
    startupRetry: { baseMs: 500, capMs: 5_000 },
    startupBudgetMs: 30_000,
    startupAttemptWindowMs: 5_000,
    maxStaleRederivations: 3,
  };
}

/** Runs startup to settlement, advancing the manual scheduler while it is pending. */
async function startup(e: Env, i: Instance, signal = new AbortController().signal): Promise<{ ok: true } | { ok: false; error: unknown }> {
  let settled: { ok: true } | { ok: false; error: unknown } | undefined;
  i.consumer.startup(signal).then(
    () => {
      settled = { ok: true };
    },
    (error: unknown) => {
      settled = { ok: false, error };
    },
  );
  for (let step = 0; step < 40 && settled === undefined; step += 1) await e.scheduler.advance(1_000);
  assert.ok(settled !== undefined, "startup settled");
  return settled;
}

async function registered(e: Env, options: Parameters<typeof instance>[1] = {}): Promise<Instance> {
  const i = instance(e, options);
  const result = await startup(e, i);
  assert.equal(result.ok, true, "startup completed");
  i.consumer.stopTimer(); // tests drive pairing with pairNow()
  return i;
}

/** L2 grant: a non-zero delta counter. */
function activity(i: Instance): void {
  const limiter = i.limiter as RateLimiter;
  limiter.consumeRejectionAllowance(limiter.peerKey("127.0.0.1"));
}

async function pairAndSettle(e: Env, i: Instance): Promise<void> {
  i.consumer.pairNow();
  await settleTurns();
  await e.scheduler.advance(0);
}

function rowsOf(e: Env, instanceId: string): EvidenceRow[] {
  return [...e.memory.raw.evidenceRows(instanceId)].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function recordsOf(e: Env, instanceId: string): FrozenEvidenceRecord[] {
  return e.memory.raw.evidenceRows(instanceId).map((row) => buildEvidenceRecord(evidenceRowFields(row)));
}

function kindsWritten(e: Env, from = 0): string[] {
  return e.writes.slice(from).flatMap((write) => write.records.map((record) => record.kind));
}

/** An instance P registered with summaries 1..n (activity each), then abandoned (crash). */
async function predecessor(e: Env, summaries: number): Promise<Instance> {
  const p = await registered(e);
  for (let n = 0; n < summaries; n += 1) {
    activity(p);
    await pairAndSettle(e, p);
  }
  assert.equal(rowsOf(e, p.id).filter((row) => row.kind === "SUMMARY").length, summaries);
  return p;
}

function rehashed(row: EvidenceRow, changes: Partial<EvidenceRow>): Partial<EvidenceRow> {
  const next = { ...row, ...changes };
  return { ...changes, recordSha256: recordHash(evidenceRowFields(next)) };
}

function expectSlotFailure(result: { ok: boolean; error?: unknown }, finalizationRequired: boolean): StartupSlotError {
  assert.equal(result.ok, false);
  const error = (result as { error: unknown }).error;
  assert.ok(error instanceof StartupSlotError, `a StartupSlotError, got ${String(error)}`);
  assert.equal(error.finalizationRequired, finalizationRequired);
  return error;
}

// Scripted (non-conforming) evidence doubles for A-T3, A-T5 and A-T19.
type Step = { readonly first: number; readonly last: number; readonly cumulative?: number; readonly zero?: boolean } | "THROW";

function scripted(e: Env): { evidence: RateLimitEvidence; script: Step[]; readonly calls: number } {
  const id = randomUUID();
  const startedAt = e.clock.wall().toISOString();
  const script: Step[] = [];
  let calls = 0;
  const evidence: RateLimitEvidence = {
    limiterInstanceId: id,
    instanceStartedAt: startedAt,
    drain(): RateLimitSummary {
      calls += 1;
      const step = script.shift();
      if (step === undefined || step === "THROW") throw new Error("scripted drain failure");
      const summary = contractSummary(id, step.first, step.last, step.cumulative ?? step.last).rateLimit;
      return step.zero === true ? { ...summary, delta: contractCounters(0), cumulative: contractCounters(step.cumulative ?? 0) } : summary;
    },
  };
  return {
    evidence,
    script,
    get calls() {
      return calls;
    },
  };
}

async function finalize(e: Env, i: Instance, forced: boolean | "BARRIER_FAILED" | "NOT_REPORTED" = false, d3 = 5_000) {
  await i.control.finalize(0).catch(() => undefined);
  const deadline = e.clock.now() + d3;
  const from = e.writes.length;
  let result: Awaited<ReturnType<EvidenceConsumer["finalize"]>> | undefined;
  i.consumer.finalize({ intake: { forced }, deadline }).then((value) => {
    result = value;
  });
  for (let step = 0; step < 20 && result === undefined; step += 1) await e.scheduler.advance(500);
  assert.ok(result !== undefined, "finalization settled");
  // A-T13 (h) / PA-3 A-T13 part 1: no store call starts at or after the D3 deadline.
  for (const write of e.writes.slice(from)) assert.ok(write.at < deadline, `a ${write.method} started at ${write.at} ≥ deadline ${deadline}`);
  return { result, deadline, from };
}

// ---------------------------------------------------------------------------

describe("A-T1: Case A and the startup order", () => {
  it("P (summaries 1–3, no close) gets a confirmed gap before INSTANCE_STARTED(Q); recorder.start → consumer.start → listen; R later writes nothing for P", async () => {
    const e = env();
    const p = await predecessor(e, 3);
    const pRows = rowsOf(e, p.id);
    const q = instance(e);
    const from = e.writes.length;
    const result = await startup(e, q);
    q.trace.push("LISTEN");
    assert.equal(result.ok, true);
    assert.deepEqual(q.trace, ["RECORDER_START", "CONSUMER_START", "LISTEN"]);
    // The gap write precedes Q's registration, and was confirmed.
    assert.deepEqual(e.writes.slice(from).map((write) => [write.method, write.records[0]?.kind, write.records[0]?.limiterInstanceId]), [
      ["writeUncleanGap", "EVIDENCE_GAP", p.id],
      ["writeEvidenceGroup", "INSTANCE_STARTED", q.id],
    ]);
    const gap = rowsOf(e, p.id).find((row) => row.kind === "EVIDENCE_GAP") as EvidenceRow;
    const lastSummary = pRows.filter((row) => row.kind === "SUMMARY").sort((a, b) => (b.lastSequence ?? 0) - (a.lastSequence ?? 0))[0] as EvidenceRow;
    const summaryPayload = lastSummary.payload as unknown as EvidenceSummary;
    assert.deepEqual(gap.payload, {
      schemaVersion: 1,
      lastDurableSequence: 3,
      cumulativeAsOfLastDurable: { rateLimit: summaryPayload.rateLimit.cumulative, audit: summaryPayload.audit.cumulative },
      detectedAt: gap.recordedAt,
      detectedByInstanceId: q.id,
    });
    assert.equal(rowsOf(e, q.id).filter((row) => row.kind === "EVIDENCE_GAP").length, 0, "no gap for Q");
    // A re-scan while Q is live does not return Q.
    assert.deepEqual(await e.store.findRecoveryCandidates(SCOPE, q.id), [{ limiterInstanceId: p.id, hasUncleanGap: true }]);
    // Q closes cleanly; R and S find P with its gap, validate it, and write nothing for P.
    assert.equal((await finalize(e, q)).result.outcome, "F-A");
    for (let n = 0; n < 2; n += 1) {
      const before = rowsOf(e, p.id);
      const later = instance(e);
      const writesBefore = e.writes.length;
      assert.equal((await startup(e, later)).ok, true);
      assert.deepEqual(e.writes.slice(writesBefore).map((write) => write.records[0]?.limiterInstanceId), [later.id]);
      assert.deepEqual(rowsOf(e, p.id), before);
      later.consumer.stopTimer();
      assert.equal((await finalize(e, later)).result.outcome, "F-A");
    }
    assert.equal(rowsOf(e, p.id).filter((row) => row.kind === "EVIDENCE_GAP").length, 1, "no duplicate gap");
  });
});

describe("A-T1b: existing and contested gaps", () => {
  /** P with summaries 1–2 and a gap written by a first startup Q0 (then cleanly closed). */
  async function withGap(): Promise<{ e: Env; p: Instance; gap: EvidenceRow }> {
    const e = env();
    const p = await predecessor(e, 2);
    const q0 = await registered(e);
    assert.equal((await finalize(e, q0)).result.outcome, "F-A");
    const gap = rowsOf(e, p.id).find((row) => row.kind === "EVIDENCE_GAP") as EvidenceRow;
    assert.ok(gap !== undefined);
    return { e, p, gap };
  }

  /** The failing-case assertions: rows unchanged, no INSTANCE_STARTED(Q), nothing started, fail closed, not retried. */
  async function assertFailsClosed(e: Env, mutate?: () => void): Promise<void> {
    const before = e.memory.raw.evidenceRows();
    mutate?.();
    const afterMutation = e.memory.raw.evidenceRows();
    const q = instance(e);
    const validationsBefore = e.memory.calls.filter((call) => call.method === "validateHistoricalGap").length;
    const result = await startup(e, q);
    expectSlotFailure(result, false);
    assert.deepEqual(e.memory.raw.evidenceRows(), afterMutation, "stored rows byte-unchanged by the failed startup");
    assert.ok(before.length <= afterMutation.length);
    assert.equal(rowsOf(e, q.id).length, 0, "no INSTANCE_STARTED(Q)");
    assert.deepEqual(q.trace, [], "recorder.start and consumer.start never called");
    assert.equal(q.control.state, "CREATED");
    const validations = e.memory.calls.filter((call) => call.method === "validateHistoricalGap").length - validationsBefore;
    assert.ok(validations <= 1, "a content conflict is not retried");
  }

  it("(a) a valid historical gap differing only in id, recordedAt, detectedAt, detectedByInstanceId, recordSha256 → valid; nothing written; Q registers", async () => {
    const { e, p } = await withGap();
    const before = rowsOf(e, p.id);
    const q = instance(e);
    assert.equal((await startup(e, q)).ok, true);
    assert.deepEqual(rowsOf(e, p.id), before);
  });

  it("(b) durable facts mismatch: P gains summary 3 after its gap (out of protocol) → fail closed", async () => {
    const { e, p } = await withGap();
    await assertFailsClosed(e, () => {
      const record = freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: e.clock.wall().toISOString(), summary: contractSummary(p.id, 3, 3) });
      e.memory.raw.seedEvidence({ ...evidenceRowFields(record as unknown as EvidenceRow), recordSha256: record.recordSha256 } as EvidenceRow);
    });
  });

  it("(c) corrupt hash → fail closed", async () => {
    const { e, gap } = await withGap();
    await assertFailsClosed(e, () => e.memory.raw.alterOutsideProtocol(gap.id, { recordSha256: "0".repeat(64) }));
  });

  it("(d) unreadable row → fail closed", async () => {
    const { e, gap } = await withGap();
    await assertFailsClosed(e, () => e.memory.raw.alterOutsideProtocol(gap.id, rehashed(gap, { payload: "unreadable" })));
  });

  it("(e) scope or identity mismatch → fail closed", async () => {
    for (const changes of [{ scope: "another-scope" }, { missingFrom: 1 }] as Partial<EvidenceRow>[]) {
      const { e, gap } = await withGap();
      await assertFailsClosed(e, () => e.memory.raw.alterOutsideProtocol(gap.id, rehashed(gap, changes)));
    }
  });

  it("(f) payload version missing, 2 or non-integer → fail closed", async () => {
    for (const version of [undefined, 2, 1.5]) {
      const { e, gap } = await withGap();
      const payload = { ...(gap.payload as Record<string, JsonValue>) };
      if (version === undefined) delete payload.schemaVersion;
      else payload.schemaVersion = version;
      await assertFailsClosed(e, () => e.memory.raw.alterOutsideProtocol(gap.id, rehashed(gap, { payload })));
    }
  });

  it("(g) a state change between discovery and validation is caught by the locked fresh read → fail closed", async () => {
    const { e, p } = await withGap();
    e.memory.faults.afterCall("findRecoveryCandidates", () => {
      const record = freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: e.clock.wall().toISOString(), summary: contractSummary(p.id, 3, 3) });
      e.memory.raw.seedEvidence({ ...evidenceRowFields(record as unknown as EvidenceRow), recordSha256: record.recordSha256 } as EvidenceRow);
    });
    const q = instance(e);
    expectSlotFailure(await startup(e, q), false);
    assert.equal(rowsOf(e, q.id).length, 0);
  });

  it("(h) the protocol prevents the change: a write for P issued while validation is under way waits for it, then is SEALED; validation is valid", async () => {
    const { e, p } = await withGap();
    const before = rowsOf(e, p.id);
    const validation = e.store.validateHistoricalGap(p.id, SCOPE);
    const late = e.store.writeEvidenceGroup([freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: e.clock.wall().toISOString(), summary: contractSummary(p.id, 3, 3) })]);
    assert.deepEqual(await validation, { valid: true });
    assert.deepEqual(await late, ["SEALED"]);
    assert.deepEqual(rowsOf(e, p.id), before);
  });

  it("(i) a different valid gap committed before writeUncleanGap → CONFLICT → valid → RESOLVED, Q's candidate discarded; with an invalid stored gap → fail closed", async () => {
    for (const valid of [true, false]) {
      const e = env();
      const p = await predecessor(e, 2);
      const competitor = instance(e);
      e.memory.faults.afterCall("readDurableState", async () => {
        const state = await e.memory.readDurableState(p.id);
        const record = freezeUncleanGap({
          id: randomUUID(),
          limiterInstanceId: p.id,
          scope: SCOPE,
          recordedAt: e.clock.wall().toISOString(),
          lastDurableSequence: valid ? state.lastDurableSequence : 1,
          cumulativeAsOfLastDurable: { rateLimit: state.cumulativeAsOfLastDurable as never, audit: state.auditCumulativeAsOfLastDurable as never },
          detectedAt: e.clock.wall().toISOString(),
          detectedByInstanceId: competitor.id,
        });
        e.memory.raw.seedEvidence({ ...evidenceRowFields(record as unknown as EvidenceRow), recordSha256: record.recordSha256 } as EvidenceRow);
      });
      const q = instance(e);
      const result = await startup(e, q);
      const gaps = rowsOf(e, p.id).filter((row) => row.kind === "EVIDENCE_GAP");
      assert.equal(gaps.length, 1, "only the competitor's gap");
      assert.notEqual((gaps[0]?.payload as { detectedByInstanceId: string }).detectedByInstanceId, q.id);
      if (valid) assert.equal(result.ok, true);
      else {
        expectSlotFailure(result, false);
        assert.equal(rowsOf(e, q.id).length, 0);
      }
    }
  });

  it("(j) a write for P between readDurableState and the locked re-check → STALE_STATE → re-derived → CREATED; four consecutive STALE_STATE → fail closed", async () => {
    const e = env();
    const p = await predecessor(e, 2);
    const addSummary = (n: number) => () => {
      void e.memory.writeEvidenceGroup([freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: e.clock.wall().toISOString(), summary: contractSummary(p.id, n, n) })]);
    };
    e.memory.faults.afterCall("readDurableState", addSummary(3));
    const q = instance(e);
    assert.equal((await startup(e, q)).ok, true);
    const gap = rowsOf(e, p.id).find((row) => row.kind === "EVIDENCE_GAP") as EvidenceRow;
    assert.equal((gap.payload as { lastDurableSequence: number }).lastDurableSequence, 3);

    const e2 = env();
    const p2 = await predecessor(e2, 1);
    for (let n = 2; n <= 5; n += 1) {
      e2.memory.faults.afterCall("readDurableState", () => {
        void e2.memory.writeEvidenceGroup([freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: e2.clock.wall().toISOString(), summary: contractSummary(p2.id, n, n) })]);
      });
    }
    const q2 = instance(e2);
    expectSlotFailure(await startup(e2, q2), false);
    assert.equal(rowsOf(e2, p2.id).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
    assert.equal(rowsOf(e2, q2.id).length, 0);
  });
});

describe("A-T2: fail-closed startup within the retry budget", () => {
  it("a gap write that keeps throwing: no registration, nothing started, StartupSlotError; no attempt starts after the budget", async () => {
    const e = env();
    await predecessor(e, 1);
    e.memory.faults.failNext(1_000, { methods: ["writeUncleanGap"] });
    const q = instance(e);
    const begin = e.clock.now();
    const error = expectSlotFailure(await startup(e, q), false);
    assert.equal(error.reason, "BUDGET");
    assert.equal(rowsOf(e, q.id).length, 0);
    assert.deepEqual(q.trace, []);
    const gapCalls = e.writes.filter((write) => write.method === "writeUncleanGap");
    assert.ok(gapCalls.length > 1, "retried");
    for (const call of gapCalls) assert.ok(call.at + 5_000 <= begin + 30_000, "every attempt's window fits the budget");
  });

  it("a registration write that keeps throwing: StartupSlotError; every attempt NOT_COMMITTED, so verification is CONFIRMED_ABSENT", async () => {
    const e = env();
    e.memory.faults.failNext(1_000, { methods: ["writeEvidenceGroup"] });
    const q = instance(e);
    expectSlotFailure(await startup(e, q), false);
    assert.ok(q.consumer.registrationAttempts.length > 1);
    assert.ok(q.consumer.registrationAttempts.every((attempt) => attempt.outcome === "NOT_COMMITTED"));
    assert.deepEqual(await q.consumer.verifyRegistration(e.clock.now() + 1_000), { kind: "CONFIRMED_ABSENT" });
  });

  it("the abort signal stops retries promptly, and the recorder and consumer are never started after it", async () => {
    const e = env();
    e.memory.faults.failNext(1_000, { methods: ["findRecoveryCandidates"] });
    const q = instance(e);
    const abort = new AbortController();
    let settled: unknown;
    q.consumer.startup(abort.signal).catch((error: unknown) => {
      settled = error;
    });
    await e.scheduler.advance(2_000);
    abort.abort();
    await settleTurns();
    assert.ok(settled instanceof StartupSlotError && settled.reason === "ABORTED");
    assert.deepEqual(q.trace, []);
  });
});

describe("A-T3 / A-T5 / A-T19 (f): forward-gap recovery groups", () => {
  async function scriptedInstance(e: Env) {
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    return { s, i };
  }

  it("A-T3 / A-T5 (a): S1 open (1–2), R at 4 → FAULTED; a rolled-back first attempt leaves none of S1, gap(3–3), R durable; the identical retry commits all three; pairing resumes at 5", async () => {
    const e = env();
    const { s, i } = await scriptedInstance(e);
    s.script.push({ first: 1, last: 1, zero: true }, { first: 2, last: 2, zero: true, cumulative: 0 });
    await pairAndSettle(e, i);
    await pairAndSettle(e, i);
    assert.ok(i.consumer.diagnostics().openSegment !== null, "S1 is open (no activity)");
    e.memory.faults.throwBeforeCommit({ methods: ["writeEvidenceGroup"] });
    s.script.push({ first: 4, last: 4, cumulative: 2 });
    i.consumer.pairNow();
    await settleTurns();
    assert.equal(i.consumer.state, "FAULTED");
    assert.deepEqual(rowsOf(e, i.id).map((row) => row.kind), ["INSTANCE_STARTED"], "nothing of the group is durable");
    const firstAttempt = e.writes.at(-1)?.records.map((record) => canonicalJson(record));
    const drains = s.calls;
    assert.equal(i.consumer.pairNow(), null, "no pair while FAULTED");
    assert.equal(s.calls, drains);
    e.clock.advance(1_000);
    await e.scheduler.advance(30_000);
    assert.equal(i.consumer.state, "RUNNING");
    assert.deepEqual(e.writes.at(-1)?.records.map((record) => canonicalJson(record)), firstAttempt, "byte-identical retry");
    const records = recordsOf(e, i.id);
    const gapRow = records.find((record) => record.kind === "EVIDENCE_GAP") as FrozenEvidenceRecord;
    const gapPayload = gapRow.payload as { initial: boolean; derivedMissingDelta: { rateLimit: unknown; audit: unknown } };
    assert.deepEqual([gapRow.missingFrom, gapRow.missingTo, gapPayload.initial], [3, 3, false]);
    // R.cumulative(2) − R.delta(1) − S1.cumulative(0) = counters(1).
    assert.deepEqual(gapPayload.derivedMissingDelta, { rateLimit: contractCounters(1), audit: "NOT_ATTRIBUTABLE" });
    const r = records.find((record) => record.kind === "SUMMARY" && record.firstSequence === 4) as FrozenEvidenceRecord;
    assert.equal((r.payload as unknown as EvidenceSummary).alignment, "UNVERIFIED");
    assert.ok(records.some((record) => record.kind === "SUMMARY" && record.firstSequence === 1 && record.lastSequence === 2));
    const coverage = classifyCoverage(records, i.id);
    assert.deepEqual(coverage.segments.map((segment) => segment.kind), ["COVERED_ZERO", "KNOWN_GAP", "COVERED", "UNKNOWN_AFTER"]);
    assert.equal(coverage.complete, false);
    assert.equal(i.consumer.diagnostics().expectedNextSequence, 5);
    s.script.push({ first: 5, last: 5 });
    const outcome = i.consumer.pairNow();
    assert.equal(outcome?.kind, "CONTIGUOUS");
  });

  it("A-T5 (b): commit then throw (lost acknowledgement) → the identical retry is IDENTICAL_EXISTS for every record; no duplicate", async () => {
    const e = env();
    const { s, i } = await scriptedInstance(e);
    s.script.push({ first: 2, last: 2 });
    e.memory.faults.commitThenThrow({ methods: ["writeEvidenceGroup"] });
    i.consumer.pairNow();
    await settleTurns();
    assert.equal(i.consumer.state, "FAULTED");
    const durable = rowsOf(e, i.id);
    await e.scheduler.advance(30_000);
    assert.equal(i.consumer.state, "RUNNING");
    assert.deepEqual(rowsOf(e, i.id), durable, "no duplicate, no overwrite");
    s.script.push({ first: 3, last: 3 });
    assert.equal(i.consumer.pairNow()?.kind, "CONTIGUOUS");
  });

  it("A-T19 (f): S-C, the first drained summary 3–4 → gap(1..2) initial, exact rate-limit delta, UNVERIFIED; a rolled-back first attempt leaves neither durable", async () => {
    const e = env();
    const { s, i } = await scriptedInstance(e);
    s.script.push({ first: 3, last: 4, cumulative: 10 });
    e.memory.faults.throwBeforeCommit({ methods: ["writeEvidenceGroup"] });
    const outcome = i.consumer.pairNow();
    assert.equal(outcome?.kind, "FORWARD_GAP");
    if (outcome?.kind !== "FORWARD_GAP") return;
    assert.deepEqual([outcome.initial, outcome.missingFrom, outcome.missingTo], [true, 1, 2]);
    // R.cumulative(10) − R.delta(2) = counters(8).
    assert.deepEqual(outcome.rateLimitDelta, contractCounters(8));
    assert.equal(outcome.summary.alignment, "UNVERIFIED");
    await settleTurns();
    assert.deepEqual(rowsOf(e, i.id).map((row) => row.kind), ["INSTANCE_STARTED"]);
    await e.scheduler.advance(30_000);
    assert.deepEqual(rowsOf(e, i.id).map((row) => row.kind).sort(), ["EVIDENCE_GAP", "INSTANCE_STARTED", "SUMMARY"]);
    assert.equal(classifyCoverage(recordsOf(e, i.id), i.id).complete, false);
  });

  it("A-T5 (d): a conflicting or overlapping stored record rolls back the group, HALTED, nothing overwritten", async () => {
    for (const seeded of [{ first: 2, last: 2 }, { first: 1, last: 3 }]) {
      const e = env();
      const { s, i } = await scriptedInstance(e);
      const existing = freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: e.clock.wall().toISOString(), summary: contractSummary(i.id, seeded.first, seeded.last, 99) });
      e.memory.raw.seedEvidence({ ...evidenceRowFields(existing as unknown as EvidenceRow), recordSha256: existing.recordSha256 } as EvidenceRow);
      const before = rowsOf(e, i.id);
      s.script.push({ first: 1, last: 2 });
      i.consumer.pairNow();
      await settleTurns();
      assert.equal(i.consumer.state, "HALTED");
      assert.deepEqual(rowsOf(e, i.id), before);
      assert.equal(i.consumer.pairNow(), null, "no pairing in HALTED");
    }
  });
});

describe("A-T5 (c): immutable payloads across retries", () => {
  it("with the clock advanced between attempts, retried INSTANCE_STARTED, summary and close records are byte-identical", async () => {
    const e = env();
    e.memory.faults.failNext(1, { methods: ["writeEvidenceGroup"] });
    const i = instance(e);
    assert.equal((await startup(e, i)).ok, true);
    i.consumer.stopTimer();
    const registrations = e.writes.filter((write) => write.records[0]?.kind === "INSTANCE_STARTED");
    assert.equal(registrations.length, 2);
    assert.equal(canonicalJson(registrations[0]?.records), canonicalJson(registrations[1]?.records));
    activity(i);
    e.memory.faults.failNext(1, { methods: ["writeEvidenceGroup"] });
    i.consumer.pairNow();
    await settleTurns();
    e.clock.advance(10_000);
    await e.scheduler.advance(30_000);
    const segments = e.writes.filter((write) => write.records[0]?.kind === "SUMMARY");
    assert.equal(segments.length, 2);
    assert.equal(canonicalJson(segments[0]?.records), canonicalJson(segments[1]?.records));
    e.memory.faults.afterCall("writeEvidenceGroup", () => e.memory.faults.failNext(1, { methods: ["writeEvidenceGroup"] }));
    const { result } = await finalize(e, i);
    assert.equal(result.outcome, "F-A");
    const closes = e.writes.filter((write) => write.records[0]?.kind === "INSTANCE_CLOSED");
    assert.equal(closes.length, 2);
    assert.equal(canonicalJson(closes[0]?.records), canonicalJson(closes[1]?.records));
  });
});

describe("A-T12: the combined ledger's pairing boundary", () => {
  it("consecutive persisted summaries are ALIGNED, and both families' intervals chain at the same boundaries", async () => {
    const e = env();
    const i = await registered(e);
    for (let n = 0; n < 3; n += 1) {
      activity(i);
      e.clock.advance(60_000);
      await pairAndSettle(e, i);
    }
    const summaries = recordsOf(e, i.id)
      .filter((record) => record.kind === "SUMMARY")
      .map((record) => record.payload as unknown as EvidenceSummary)
      .sort((a, b) => a.rateLimit.firstSequence - b.rateLimit.firstSequence);
    assert.equal(summaries.length, 3);
    for (const [index, summary] of summaries.entries()) {
      assert.equal(summary.alignment, "ALIGNED");
      if (index === 0) continue;
      const previous = summaries[index - 1] as EvidenceSummary;
      assert.equal(summary.rateLimit.intervalStartedAt, previous.rateLimit.intervalEndedAt);
      assert.equal(summary.audit.intervalStartedAt, previous.audit.intervalEndedAt);
      assert.equal(summary.rateLimit.firstSequence, previous.rateLimit.lastSequence + 1);
    }
  });

  it("a zero-activity open segment absorbs pairs until 15 minutes, then is written once", async () => {
    const e = env();
    const i = await registered(e);
    for (let n = 0; n < 15; n += 1) {
      e.clock.advance(60_000);
      await pairAndSettle(e, i);
    }
    const summaries = rowsOf(e, i.id).filter((row) => row.kind === "SUMMARY");
    assert.equal(summaries.length, 1);
    assert.deepEqual([summaries[0]?.firstSequence, summaries[0]?.lastSequence], [1, 15]);
  });
});

describe("A-T13: finalization (one D3 window; no store call at or after the deadline)", () => {
  it("(b) Branch A: the final pair follows recorder.finalize and carries its terminal counters; one final summary write; the close → F-A", async () => {
    const e = env();
    const i = await registered(e);
    i.recorder.sink.submit({
      requestId: randomUUID(),
      receivedAt: e.clock.wall().toISOString(),
      stage: "VERIFIER",
      httpStatus: 401,
      errorCode: "UNAUTHORIZED",
      claimedIntegrationId: null,
      verifierReason: null,
      responseCompletion: "FINISH_OBSERVED",
    });
    e.clock.advance(60_000);
    await pairAndSettle(e, i); // the persisted rejection is audit activity: this segment is written
    activity(i);
    const { result, from } = await finalize(e, i);
    assert.deepEqual(result, { outcome: "F-A", successAllowed: true });
    assert.deepEqual(kindsWritten(e, from), ["SUMMARY", "INSTANCE_CLOSED"]);
    const summaries = recordsOf(e, i.id).filter((record) => record.kind === "SUMMARY").map((record) => record.payload as unknown as EvidenceSummary);
    const last = summaries.sort((a, b) => b.rateLimit.lastSequence - a.rateLimit.lastSequence)[0] as EvidenceSummary;
    assert.equal(last.audit.cumulative.persisted, 1, "the final pair carries the recorder's terminal counters");
    const close = recordsOf(e, i.id).find((record) => record.kind === "INSTANCE_CLOSED") as FrozenEvidenceRecord;
    assert.equal((close.payload as { finalSequence: number }).finalSequence, last.rateLimit.lastSequence);
    assert.equal(classifyCoverage(recordsOf(e, i.id), i.id).complete, true);
  });

  it("(b) Branch A with an open segment: the final summary is merged into it and written once", async () => {
    const e = env();
    const i = await registered(e);
    e.clock.advance(60_000);
    await pairAndSettle(e, i);
    assert.ok(i.consumer.diagnostics().openSegment !== null);
    const { result, from } = await finalize(e, i);
    assert.equal(result.outcome, "F-A");
    assert.deepEqual(kindsWritten(e, from), ["SUMMARY", "INSTANCE_CLOSED"]);
    const summary = rowsOf(e, i.id).find((row) => row.kind === "SUMMARY") as EvidenceRow;
    assert.deepEqual([summary.firstSequence, summary.lastSequence], [1, 2]);
  });

  it("(c) Branch B, S-B and S-C: the recovery group is the only write with the final summary; close after it → F-B; never complete", async () => {
    for (const steps of [
      [{ first: 1, last: 1, zero: true }, { first: 3, last: 3, cumulative: 1 }],
      [{ first: 3, last: 4 }],
    ] as Step[][]) {
      const e = env();
      const s = scripted(e);
      const i = await registered(e, { evidence: s.evidence });
      if (steps.length === 2) {
        s.script.push(steps[0] as Step);
        await pairAndSettle(e, i);
      }
      s.script.push(steps.at(-1) as Step);
      const { result, from } = await finalize(e, i);
      assert.deepEqual(result, { outcome: "F-B", successAllowed: true });
      const groupWrites = e.writes.slice(from).filter((write) => write.records.some((record) => record.kind === "SUMMARY"));
      assert.equal(groupWrites.length, 1, "one write contains the final summary");
      assert.ok(groupWrites[0]?.records.some((record) => record.kind === "EVIDENCE_GAP"));
      assert.equal(kindsWritten(e, from).at(-1), "INSTANCE_CLOSED");
      assert.equal(classifyCoverage(recordsOf(e, i.id), i.id).complete, false);
    }
  });

  it("(d) Branch C: P-A and P-B → F-P; S-D and HALTED → F-H; an open segment is written alone; no close; exit not allowed", async () => {
    // P-A: the recorder snapshot fails.
    {
      const e = env();
      let fail = false;
      const i = await registered(e, {
        wrapControl: (control) => ({
          ...control,
          start: () => control.start(),
          finalize: (budget) => control.finalize(budget),
          cumulative: () => control.cumulative(),
          get afterFinalize() { return control.afterFinalize; },
          get state() { return control.state; },
          drainCounters: () => {
            if (fail) throw new Error("snapshot failed");
            return control.drainCounters();
          },
        }),
      });
      e.clock.advance(60_000);
      await pairAndSettle(e, i);
      fail = true;
      const { result, from } = await finalize(e, i);
      assert.deepEqual(result, { outcome: "F-P", successAllowed: false });
      assert.deepEqual(kindsWritten(e, from), ["SUMMARY"], "the open segment, written alone");
    }
    // P-B: the drain fails.
    {
      const e = env();
      const s = scripted(e);
      const i = await registered(e, { evidence: s.evidence });
      s.script.push("THROW");
      const { result, from } = await finalize(e, i);
      assert.equal(result.outcome, "F-P");
      assert.deepEqual(kindsWritten(e, from), []);
    }
    // S-D at the final pair.
    {
      const e = env();
      const s = scripted(e);
      const i = await registered(e, { evidence: s.evidence });
      s.script.push({ first: 1, last: 2 });
      await pairAndSettle(e, i);
      s.script.push({ first: 2, last: 3 });
      const { result, from } = await finalize(e, i);
      assert.equal(result.outcome, "F-H");
      assert.deepEqual(kindsWritten(e, from), []);
    }
    // Already HALTED.
    {
      const e = env();
      const s = scripted(e);
      const i = await registered(e, { evidence: s.evidence });
      s.script.push({ first: 0, last: 0 });
      i.consumer.pairNow();
      assert.equal(i.consumer.state, "HALTED");
      const { result, from } = await finalize(e, i);
      assert.equal(result.outcome, "F-H");
      assert.equal(s.calls, 1, "no final pair in HALTED");
      assert.deepEqual(kindsWritten(e, from), []);
    }
  });

  it("(e) a pending summary is retried byte-identically within D3, no pair until confirmed, then Branch A → F-A", async () => {
    const e = env();
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    s.script.push({ first: 1, last: 1 });
    e.memory.faults.failNext(1, { methods: ["writeEvidenceGroup"] });
    i.consumer.pairNow();
    await settleTurns();
    assert.ok(i.consumer.diagnostics().frozen !== null, "frozen and unconfirmed");
    const pending = canonicalJson(e.writes.at(-1)?.records);
    s.script.push({ first: 2, last: 2 });
    const drainsBefore = s.calls;
    const { result, from } = await finalize(e, i);
    assert.equal(result.outcome, "F-A");
    assert.equal(canonicalJson(e.writes[from]?.records), pending, "3a retried the identical record first");
    assert.equal(s.calls, drainsBefore + 1, "exactly one final pair, after confirmation");
  });

  it("(f) F-C: the pending summary stays unconfirmed until the deadline → no final pair, no close", async () => {
    const e = env();
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    s.script.push({ first: 1, last: 1 });
    e.memory.faults.failNext(1_000, { methods: ["writeEvidenceGroup"] });
    i.consumer.pairNow();
    await settleTurns();
    const drainsBefore = s.calls;
    const { result, from } = await finalize(e, i);
    assert.deepEqual(result, { outcome: "F-C", successAllowed: false });
    assert.equal(s.calls, drainsBefore, "no final pair");
    assert.ok(!kindsWritten(e, from).includes("INSTANCE_CLOSED"));
  });

  it("(g) F-D: the final write unconfirmed at the deadline; F-D′: the close unconfirmed — neither claims the record written", async () => {
    for (const hangOn of ["final", "close"] as const) {
      const e = env();
      const i = await registered(e);
      activity(i);
      if (hangOn === "final") {
        e.memory.faults.hang({ methods: ["writeEvidenceGroup"] });
      } else {
        e.memory.faults.afterCall("writeEvidenceGroup", () => {
          e.memory.faults.hang({ methods: ["writeEvidenceGroup"] });
        });
      }
      const { result } = await finalize(e, i);
      assert.deepEqual(result, { outcome: hangOn === "final" ? "F-D" : "F-D′", successAllowed: false });
      assert.equal(
        i.logs.some((object) => object.event === "EVIDENCE_FINALIZED" && object.outcome === result.outcome),
        true,
      );
    }
  });

  it("(h) / PA-3 part 1: a write in flight at D3 is detached; no store call starts after the deadline, even as time runs on", async () => {
    const e = env();
    const i = await registered(e);
    activity(i);
    e.memory.faults.hang({ methods: ["writeEvidenceGroup"] });
    const { result, deadline } = await finalize(e, i);
    assert.equal(result.outcome, "F-D");
    const callsAtEnd = e.memory.calls.length;
    await e.scheduler.advance(120_000);
    assert.equal(e.memory.calls.length, callsAtEnd, "no store call after finalization");
    assert.ok(e.memory.calls.every((call) => call.at < deadline));
    assert.equal(e.scheduler.pending, 0, "no timer remains");
  });

  it("(i) forcedClose mirrors the intake barrier's { forced }; F-S: a failed barrier → no close attempted", async () => {
    for (const forced of [true, false]) {
      const e = env();
      const i = await registered(e);
      const { result } = await finalize(e, i, forced);
      assert.equal(result.outcome, "F-A");
      const close = recordsOf(e, i.id).find((record) => record.kind === "INSTANCE_CLOSED") as FrozenEvidenceRecord;
      assert.equal((close.payload as { forcedClose: boolean }).forcedClose, forced);
    }
    for (const forced of ["BARRIER_FAILED", "NOT_REPORTED"] as const) {
      const e = env();
      const i = await registered(e);
      const { result, from } = await finalize(e, i, forced);
      assert.deepEqual(result, { outcome: "F-S", successAllowed: false });
      assert.deepEqual(kindsWritten(e, from), ["SUMMARY"], "Branch A confirmed; INSTANCE_CLOSED never attempted");
    }
  });
});

describe("A-T16, A-T17", () => {
  it("A-T16: an unclosed instance of another scope is never touched", async () => {
    const e = env();
    const other = await registered(e, { scope: "another-scope" });
    const before = rowsOf(e, other.id);
    const q = instance(e);
    assert.equal((await startup(e, q)).ok, true);
    assert.deepEqual(rowsOf(e, other.id), before);
  });

  it("A-T17: a throwing logger is swallowed; retries and outcomes are unaffected", async () => {
    const e = env();
    e.memory.faults.failNext(1, { methods: ["findRecoveryCandidates"] });
    const i = instance(e, { throwingLogger: true });
    assert.equal((await startup(e, i)).ok, true);
    i.consumer.stopTimer();
    assert.equal((await finalize(e, i)).result.outcome, "F-A");
  });
});

describe("A-T19: pairing and sequence validation", () => {
  it("(a) P-A: the snapshot fails → drain not called; the next summary has pairingFaults 1 and starts at the same boundary", async () => {
    const e = env();
    const s = scripted(e);
    let fail = true;
    const i = await registered(e, {
      evidence: s.evidence,
      wrapControl: (control) => ({
        ...control,
        start: () => control.start(),
        finalize: (budget) => control.finalize(budget),
        cumulative: () => control.cumulative(),
        get afterFinalize() { return control.afterFinalize; },
        get state() { return control.state; },
        drainCounters: () => {
          if (fail) {
            fail = false;
            throw new Error("snapshot failed");
          }
          return control.drainCounters();
        },
      }),
    });
    assert.deepEqual(i.consumer.pairNow(), { kind: "NO_PAIR", reason: "RECORDER_SNAPSHOT_FAILED" });
    assert.equal(s.calls, 0);
    s.script.push({ first: 1, last: 1 });
    const outcome = i.consumer.pairNow();
    assert.equal(outcome?.kind, "CONTIGUOUS");
    if (outcome?.kind === "CONTIGUOUS") assert.equal(outcome.summary.pairingFaults, 1);
  });

  it("(b) P-B: the drain fails without side effects → held; the next pair folds onto it, is CONTIGUOUS and ALIGNED; the counter resets", async () => {
    const e = env();
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    s.script.push("THROW");
    assert.deepEqual(i.consumer.pairNow(), { kind: "NO_PAIR", reason: "DRAIN_FAILED" });
    const held = i.consumer.diagnostics().heldSnapshot;
    assert.ok(held !== null);
    assert.equal(i.consumer.diagnostics().drainFailuresSinceAccepted, 1);
    e.clock.advance(60_000);
    s.script.push({ first: 1, last: 1 });
    const outcome = i.consumer.pairNow();
    assert.equal(outcome?.kind, "CONTIGUOUS");
    if (outcome?.kind === "CONTIGUOUS") {
      assert.equal(outcome.summary.alignment, "ALIGNED");
      assert.equal(outcome.summary.audit.intervalStartedAt, held.intervalStartedAt, "from the previous pairing boundary");
    }
    assert.equal(i.consumer.diagnostics().drainFailuresSinceAccepted, 0);
    assert.equal(i.consumer.diagnostics().heldSnapshot, null);
  });

  it("(c) repeated P-B across three attempts holds exactly one snapshot object", async () => {
    const e = env();
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    let origin: string | undefined;
    for (let n = 0; n < 3; n += 1) {
      s.script.push("THROW");
      e.clock.advance(60_000);
      i.consumer.pairNow();
      const held = i.consumer.diagnostics().heldSnapshot;
      assert.ok(held !== null && !Array.isArray(held));
      origin ??= held.intervalStartedAt;
      assert.equal(held.intervalStartedAt, origin);
    }
    assert.equal(i.consumer.diagnostics().drainFailuresSinceAccepted, 3);
  });

  it("(d) S-B without a held snapshot: expected 5, observed 7–8 → gap 5–6, SEQUENCE_DISCONTINUITY, UNVERIFIED, exact rate-limit delta, audit NOT_ATTRIBUTABLE", async () => {
    const e = env();
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    s.script.push({ first: 1, last: 4, cumulative: 4 });
    await pairAndSettle(e, i);
    s.script.push({ first: 7, last: 8, cumulative: 9 });
    const outcome = i.consumer.pairNow();
    assert.equal(outcome?.kind, "FORWARD_GAP");
    if (outcome?.kind !== "FORWARD_GAP") return;
    assert.deepEqual([outcome.initial, outcome.missingFrom, outcome.missingTo, outcome.cause], [false, 5, 6, "SEQUENCE_DISCONTINUITY"]);
    assert.equal(outcome.summary.alignment, "UNVERIFIED");
    // 9 − 2 − 4 = 3.
    assert.deepEqual(outcome.rateLimitDelta, contractCounters(3));
    await settleTurns();
    const gap = recordsOf(e, i.id).find((record) => record.kind === "EVIDENCE_GAP") as FrozenEvidenceRecord;
    assert.deepEqual((gap.payload as { derivedMissingDelta: unknown }).derivedMissingDelta, { rateLimit: contractCounters(3), audit: "NOT_ATTRIBUTABLE" });
    assert.equal(classifyCoverage(recordsOf(e, i.id), i.id).complete, false, "(i) never complete");
  });

  it("(e) S-B with held snapshots: k ≤ failed drains → DRAIN_CONTRACT_VIOLATION; otherwise SEQUENCE_DISCONTINUITY", async () => {
    for (const [failures, cause] of [[2, "DRAIN_CONTRACT_VIOLATION"], [1, "SEQUENCE_DISCONTINUITY"]] as const) {
      const e = env();
      const s = scripted(e);
      const i = await registered(e, { evidence: s.evidence });
      s.script.push({ first: 1, last: 4 });
      await pairAndSettle(e, i);
      for (let n = 0; n < failures; n += 1) {
        s.script.push("THROW");
        i.consumer.pairNow();
      }
      s.script.push({ first: 7, last: 8 });
      const outcome = i.consumer.pairNow();
      assert.equal(outcome?.kind === "FORWARD_GAP" && outcome.cause, cause);
    }
  });

  it("(g) inputs that would yield a negative rate-limit field → NOT_DERIVABLE", async () => {
    const e = env();
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    s.script.push({ first: 1, last: 1, cumulative: 9 });
    await pairAndSettle(e, i);
    s.script.push({ first: 3, last: 3, cumulative: 2 });
    const outcome = i.consumer.pairNow();
    assert.equal(outcome?.kind === "FORWARD_GAP" && outcome.rateLimitDelta, "NOT_DERIVABLE");
  });

  it("(h) S-D overlap / backward / malformed → SEQUENCE_ANOMALY, no gap, R never written, HALTED, the open segment written; Branch C F-H; coverage OPEN, then UNCLEAN_TERMINATION after the next startup", async () => {
    for (const anomaly of [{ first: 4, last: 6 }, { first: 5, last: 4 }]) {
      const e = env();
      const s = scripted(e);
      const i = await registered(e, { evidence: s.evidence });
      s.script.push({ first: 1, last: 4, zero: true });
      await pairAndSettle(e, i);
      assert.ok(i.consumer.diagnostics().openSegment !== null);
      s.script.push(anomaly);
      const outcome = i.consumer.pairNow();
      assert.equal(outcome?.kind, "SEQUENCE_ANOMALY");
      assert.equal(i.consumer.state, "HALTED");
      await settleTurns();
      const summaries = rowsOf(e, i.id).filter((row) => row.kind === "SUMMARY");
      assert.deepEqual(summaries.map((row) => [row.firstSequence, row.lastSequence]), [[1, 4]], "only the open segment; R never written");
      assert.equal(rowsOf(e, i.id).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
      const drains = s.calls;
      await e.scheduler.advance(120_000);
      assert.equal(s.calls, drains, "no further pairs");
      const { result } = await finalize(e, i);
      assert.equal(result.outcome, "F-H");
      assert.equal(rowsOf(e, i.id).filter((row) => row.kind === "INSTANCE_CLOSED").length, 0);
      assert.deepEqual(classifyCoverage(recordsOf(e, i.id), i.id).segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "OPEN", lastDurableSequence: 4 });
      const next = instance(e);
      assert.equal((await startup(e, next)).ok, true);
      const after = classifyCoverage(recordsOf(e, i.id), i.id);
      assert.deepEqual(after.segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "UNCLEAN_TERMINATION", lastDurableSequence: 4 });
      assert.equal(after.complete, false);
      assert.ok(after.segments.every((segment) => segment.kind !== "COVERED_ZERO" || segment.lastSequence <= 4));
    }
  });

  it("(j) no previously confirmed record is modified and no partial group exists", async () => {
    const e = env();
    const s = scripted(e);
    const i = await registered(e, { evidence: s.evidence });
    s.script.push({ first: 1, last: 1 });
    await pairAndSettle(e, i);
    const confirmed = rowsOf(e, i.id);
    s.script.push({ first: 3, last: 3 });
    e.memory.faults.throwBeforeCommit({ methods: ["writeEvidenceGroup"] });
    i.consumer.pairNow();
    await settleTurns();
    assert.deepEqual(rowsOf(e, i.id), confirmed, "no partial group");
    await e.scheduler.advance(30_000);
    const after = rowsOf(e, i.id);
    for (const row of confirmed) assert.deepEqual(after.find((candidate) => candidate.id === row.id), row);
  });
});

describe("A-T21 in memory (state-machine tests; F-20 Option C)", () => {
  it("(a) a close committed after D3 (lost acknowledgement) → F-D′, no claim; the row is byte-identical to its freeze; discovery excludes P; coverage equals a clean close", async () => {
    const e = env();
    const p = await registered(e);
    const writesBefore = e.writes.length;
    e.memory.faults.afterCall("writeEvidenceGroup", () => {
      gate = e.memory.faults.delayCommit({ methods: ["writeEvidenceGroup"] });
    });
    let gate: ReturnType<InMemoryEvidenceStore["faults"]["delayCommit"]> | undefined;
    const { result } = await finalize(e, p);
    assert.deepEqual(result, { outcome: "F-D′", successAllowed: false });
    assert.ok(!p.logs.some((object) => object.event === "EVIDENCE_FINALIZED" && object.outcome === "F-A"));
    gate?.release();
    await settleTurns();
    const frozenClose = e.writes.slice(writesBefore).find((write) => write.records[0]?.kind === "INSTANCE_CLOSED")?.records[0] as FrozenEvidenceRecord;
    const stored = recordsOf(e, p.id).find((record) => record.kind === "INSTANCE_CLOSED") as FrozenEvidenceRecord;
    assert.equal(canonicalJson(stored), canonicalJson(frozenClose));
    assert.deepEqual(await e.store.findRecoveryCandidates(SCOPE, randomUUID()), []);
    const coverage = classifyCoverage(recordsOf(e, p.id), p.id);
    assert.equal(coverage.complete, true);
  });

  it("(b) P's close commits under the lock while Q's writeUncleanGap waits → CLOSED_EXISTS; Q registers; no gap", async () => {
    const e = env();
    const p = await registered(e);
    activity(p);
    let gate: ReturnType<InMemoryEvidenceStore["faults"]["delayCommit"]> | undefined;
    e.memory.faults.afterCall("writeEvidenceGroup", () => {
      gate = e.memory.faults.delayCommit({ methods: ["writeEvidenceGroup"] });
    });
    await p.control.finalize(0);
    const pFinal = p.consumer.finalize({ intake: { forced: false }, deadline: e.clock.now() + 5_000 });
    await settleTurns();
    assert.ok(gate !== undefined);
    await gate.reached;
    const q = instance(e);
    const qStartup = q.consumer.startup(new AbortController().signal);
    await settleTurns();
    // Q's gap write has been issued and is waiting on P's instance lock.
    assert.equal(e.writes.filter((write) => write.method === "writeUncleanGap").length, 1, "the gap write waits under the lock");
    assert.equal(rowsOf(e, q.id).length, 0, "Q is not registered while it waits");
    gate.release();
    await qStartup;
    assert.equal((await pFinal).outcome, "F-A");
    assert.equal(rowsOf(e, p.id).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
    assert.equal(e.writes.filter((write) => write.method === "writeUncleanGap").length, 1, "CLOSED_EXISTS is not retried");
  });

  it("(b′) the close commits between Q's discovery and its gap write (no lock wait) → CLOSED_EXISTS", async () => {
    const e = env();
    const p = await registered(e);
    activity(p);
    await pairAndSettle(e, p);
    const state = await e.memory.readDurableState(p.id);
    e.memory.faults.afterCall("readDurableState", async () => {
      await p.control.finalize(0);
      await p.consumer.finalize({ intake: { forced: false }, deadline: e.clock.now() + 5_000 });
    });
    const q = instance(e);
    assert.equal((await startup(e, q)).ok, true);
    assert.equal(e.writes.filter((write) => write.method === "writeUncleanGap").length, 1, "the gap write ran, after the close committed");
    assert.equal(rowsOf(e, p.id).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
    assert.equal(rowsOf(e, p.id).filter((row) => row.kind === "INSTANCE_CLOSED").length, 1);
    assert.ok(state.lastDurableSequence >= 1);
  });

  it("(c) the gap commits first; P's late finalization is SEALED → F-H; P's close never becomes durable", async () => {
    const e = env();
    const p = await registered(e);
    activity(p);
    await pairAndSettle(e, p);
    const q = instance(e);
    assert.equal((await startup(e, q)).ok, true);
    activity(p);
    const { result } = await finalize(e, p);
    assert.deepEqual(result, { outcome: "F-H", successAllowed: false });
    assert.equal(rowsOf(e, p.id).filter((row) => row.kind === "INSTANCE_CLOSED").length, 0);
  });

  it("(d) a late final segment commits during Case A → STALE_STATE, re-derived; the gap's lastDurableSequence includes it", async () => {
    const e = env();
    const p = await registered(e);
    activity(p);
    await pairAndSettle(e, p);
    e.memory.faults.afterCall("readDurableState", async () => {
      activity(p);
      p.consumer.pairNow();
      await settleTurns();
    });
    const q = instance(e);
    assert.equal((await startup(e, q)).ok, true);
    const gap = rowsOf(e, p.id).find((row) => row.kind === "EVIDENCE_GAP") as EvidenceRow;
    assert.equal((gap.payload as { lastDurableSequence: number }).lastDurableSequence, 2);
    assert.equal(e.writes.filter((write) => write.method === "writeUncleanGap").length, 2, "STALE_STATE, then the re-derived gap");
  });
});

describe("A-T22 (consumer level): a startup step unsettled while its registration write is in flight", () => {
  it("the aborted startup does not settle while the write is in flight; if it then commits, the next startup records UNCLEAN_TERMINATION", async () => {
    const e = env();
    const gate = e.memory.faults.delayCommit({ methods: ["writeEvidenceGroup"] });
    const q = instance(e);
    const abort = new AbortController();
    let settled: unknown = "pending";
    q.consumer.startup(abort.signal).then(
      () => {
        settled = "resolved";
      },
      (error: unknown) => {
        settled = error;
      },
    );
    await gate.reached;
    abort.abort();
    await e.scheduler.advance(10_000);
    assert.equal(settled, "pending", "never returns while the registration write is in flight");
    gate.release();
    await settleTurns();
    const outcome = settled as unknown;
    assert.ok(outcome instanceof StartupSlotError && outcome.finalizationRequired === true, "registered, then aborted: finalization required");
    assert.deepEqual(q.trace, [], "never started after the signal");
    // The lifecycle abandoned the slot (A-T22): no finalization. The next startup records the instance.
    const r = instance(e);
    assert.equal((await startup(e, r)).ok, true);
    const gap = rowsOf(e, q.id).find((row) => row.kind === "EVIDENCE_GAP") as EvidenceRow;
    assert.equal((gap.payload as { lastDurableSequence: number }).lastDurableSequence, 0);
  });

  it("if the in-flight registration does not commit, nothing is recorded for the instance", async () => {
    const e = env();
    e.memory.faults.throwBeforeCommit({ methods: ["writeEvidenceGroup"] });
    const q = instance(e);
    const abort = new AbortController();
    const pending = q.consumer.startup(abort.signal).catch((error: unknown) => error);
    abort.abort();
    const error = await pending;
    assert.ok(error instanceof StartupSlotError && error.finalizationRequired === false);
    const r = instance(e);
    assert.equal((await startup(e, r)).ok, true);
    assert.equal(rowsOf(e, q.id).length, 0);
  });
});
