/**
 * The Task 011A evidence consumer (design Revision 1.4 §7.1, §8.1 – §8.3,
 * §9; AN4 E1, E2, E4, E5/E5a). It owns the limiter's evidence capability
 * and the recorder's control capability, and is the only writer of
 * RateLimitEvidence for its instance.
 *
 * - startup (SLOT A, B6): recovery of earlier instances (Cases A / B / C),
 *   then registration, within one retry budget, honouring the abort signal;
 *   it resolves only after recorder.start() and consumer.start().
 * - running (B7 / B7a / B7b): pairing every interval; segments frozen
 *   before their first write and retried byte-identically; forward gaps
 *   recorded atomically; anomalies halt the consumer.
 * - finalize (SLOT B, B8): one absolute D3 deadline for every step; no
 *   store call starts at or after it; exactly one final-write branch.
 *
 * Logs carry error classes, result kinds and sequence numbers only.
 */
import { randomUUID } from "node:crypto";
import {
  deriveMissingRateLimitDelta,
  foldAudit,
  freezeDiscontinuityGap,
  freezeInstanceClosed,
  freezeInstanceStarted,
  freezeSummary,
  freezeUncleanGap,
  mergeEvidenceSummaries,
} from "./evidence-records.js";
import type {
  AuditRecorderSnapshot,
  EvidenceSummary,
  FrozenEvidenceRecord,
  GapCause,
} from "./evidence-records.js";
import { classifyRegistrationVerification, storeErrorOutcome } from "./evidence-store.js";
import type { EvidenceStore, RegistrationAttempt, RecoveryCandidate, WriteResult } from "./evidence-store.js";
import type { IntakeBarrierResult, RegistrationVerification, StartupSlotFailure } from "./lifecycle.js";
import type { Counters, RateLimitEvidence, RateLimitSummary } from "./rate-limit.js";
import { DEFAULT_EVIDENCE_CLOCK, DEFAULT_EVIDENCE_SCHEDULER, fullJitterDelay } from "./rejection-audit.js";
import type { EvidenceClock, EvidenceLogger, EvidenceScheduler, RecorderControl } from "./rejection-audit.js";

/** Provisional (AD-7, AD-9; §9.1). */
export interface EvidencePolicies {
  readonly pairingIntervalMs: number;
  /** An all-zero open segment is frozen once its covered interval reaches this. */
  readonly segmentMaxIntervalMs: number;
  readonly evidenceRetry: { readonly baseMs: number; readonly capMs: number };
  readonly startupRetry: { readonly baseMs: number; readonly capMs: number };
  readonly startupBudgetMs: number;
  /** An attempt starts only if this window still fits before the startup budget ends. */
  readonly startupAttemptWindowMs: number;
  /** Case A re-derivations after STALE_STATE; one more STALE_STATE fails closed. */
  readonly maxStaleRederivations: number;
}

export const DEFAULT_EVIDENCE_POLICIES: EvidencePolicies = Object.freeze({
  pairingIntervalMs: 60_000,
  segmentMaxIntervalMs: 15 * 60_000,
  evidenceRetry: Object.freeze({ baseMs: 500, capMs: 30_000 }),
  startupRetry: Object.freeze({ baseMs: 500, capMs: 5_000 }),
  startupBudgetMs: 30_000,
  startupAttemptWindowMs: 5_000,
  maxStaleRederivations: 3,
});

/** §7.1: the single return contract used by the timer and by finalization. */
export type PairOutcome =
  | { readonly kind: "NO_PAIR"; readonly reason: "RECORDER_SNAPSHOT_FAILED" | "DRAIN_FAILED" }
  | { readonly kind: "CONTIGUOUS"; readonly summary: EvidenceSummary }
  | {
      readonly kind: "FORWARD_GAP";
      readonly initial: boolean;
      readonly missingFrom: number;
      readonly missingTo: number;
      readonly cause: GapCause;
      readonly summary: EvidenceSummary;
      readonly rateLimitDelta: Counters | "NOT_DERIVABLE";
    }
  | { readonly kind: "SEQUENCE_ANOMALY"; readonly expected: number; readonly observedFirst: number; readonly observedLast: number };

export type ConsumerState = "IDLE" | "RUNNING" | "FAULTED" | "HALTED" | "FINALIZING" | "FINALIZED";

/** §8.3 outcomes, with AN4 E1 (F-D′) and E4 F-19(b) Option B (F-S). */
export type FinalizationOutcome = "F-A" | "F-B" | "F-C" | "F-D" | "F-D′" | "F-P" | "F-H" | "F-S";

export interface ConsumerFinalization {
  readonly outcome: FinalizationOutcome;
  /** Only F-A and F-B allow a successful exit. */
  readonly successAllowed: boolean;
}

/** SLOT A's rejection when the startup steps do not complete (lifecycle StartupSlotFailure). */
export class StartupSlotError extends Error implements StartupSlotFailure {
  override readonly name = "StartupSlotError";
  constructor(
    readonly finalizationRequired: boolean,
    readonly reason: "BUDGET" | "ABORTED" | "UNRESOLVED" | "REGISTRATION_REJECTED" | "ABORTED_AFTER_REGISTRATION",
  ) {
    super(`evidence startup did not complete: ${reason}`);
  }
}

export interface EvidenceConsumer {
  /** SLOT A. Rejects with StartupSlotError when the steps do not complete; any other error is unexpected (U3). */
  startup(signal: AbortSignal): Promise<void>;
  /** Arms the pairing timer (called by startup after recorder.start). */
  start(): void;
  stopTimer(): void;
  /** @internal — one timer tick, synchronously: pairs (when permitted) and starts the resulting write. */
  pairNow(): PairOutcome | null;
  /** SLOT B's evidence finalization (§8.3 step 3), after recorder.finalize. `deadline` is absolute (clock.monotonicNow). */
  finalize(options: { readonly intake: IntakeBarrierResult; readonly deadline: number }): Promise<ConsumerFinalization>;
  /** U3 (AN4 E5a). */
  verifyRegistration(deadline: number): Promise<RegistrationVerification>;
  readonly registrationAttempts: readonly RegistrationAttempt[];
  readonly recorderAndConsumerStarted: boolean;
  readonly state: ConsumerState;
  /** @internal — test diagnostics. */
  diagnostics(): {
    readonly expectedNextSequence: number;
    readonly drainFailuresSinceAccepted: number;
    readonly heldSnapshot: AuditRecorderSnapshot | null;
    readonly openSegment: EvidenceSummary | null;
    readonly frozen: readonly FrozenEvidenceRecord[] | null;
  };
}

type Resolution = "RESOLVED" | "UNRESOLVED" | "BUDGET" | "ABORTED";

function isConfirmed(results: readonly WriteResult[]): boolean {
  return results.every((result) => result === "CREATED" || result === "IDENTICAL_EXISTS");
}

function hasActivity(summary: EvidenceSummary): boolean {
  const rl = summary.rateLimit.delta;
  const layerActive = (["L1", "L2", "L3"] as const).some((layer) =>
    Object.values(rl.layers[layer]).some((value) => value !== 0),
  );
  return (
    layerActive ||
    rl.abortedBeforeResponse !== 0 ||
    rl.limiterFaults !== 0 ||
    rl.logLinesSuppressed !== 0 ||
    Object.values(summary.audit.delta).some((value) => value !== 0) ||
    summary.pairingFaults !== 0
  );
}

function errorClass(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}

export function createEvidenceConsumer(options: {
  readonly evidence: RateLimitEvidence;
  readonly recorderControl: RecorderControl;
  readonly store: EvidenceStore;
  readonly scope: string;
  /** Recorded in INSTANCE_STARTED (§7.3). */
  readonly rateLimitPolicies: unknown;
  readonly auditPolicies: unknown;
  readonly policies?: EvidencePolicies;
  readonly clock?: EvidenceClock;
  readonly scheduler?: EvidenceScheduler;
  readonly logger?: EvidenceLogger;
  readonly random?: () => number;
  readonly newId?: () => string;
  /** @internal — order spies (A-T1, A-T18). */
  readonly trace?: (event: "RECORDER_START" | "CONSUMER_START") => void;
}): EvidenceConsumer {
  const { evidence, recorderControl, store, scope } = options;
  const policies = options.policies ?? DEFAULT_EVIDENCE_POLICIES;
  const clock = options.clock ?? DEFAULT_EVIDENCE_CLOCK;
  const scheduler = options.scheduler ?? DEFAULT_EVIDENCE_SCHEDULER;
  const random = options.random ?? Math.random;
  const newId = options.newId ?? (() => randomUUID());
  const self = evidence.limiterInstanceId;
  const wallIso = (): string => clock.wallNow().toISOString();

  let state: ConsumerState = "IDLE";
  let startupCalled = false;
  let recorderAndConsumerStarted = false;
  const attempts: RegistrationAttempt[] = [];

  // §7.1 sequence state.
  let expectedNextSequence = 1;
  let observedAny = false;
  let drainFailuresSinceAccepted = 0;
  let pairingFaultsPending = 0;
  let held: AuditRecorderSnapshot | null = null;
  let lastAccepted: RateLimitSummary | null = null;

  // §8.2 / §9.1 segments.
  let open: EvidenceSummary | null = null;
  let frozen: readonly FrozenEvidenceRecord[] | null = null;
  let writeInFlight: Promise<void> | undefined;
  let retryTimer: unknown;
  let retryAttempt = 0;
  let pairingTimer: unknown;
  let finalizing: Promise<ConsumerFinalization> | undefined;

  function log(level: "warn" | "error", object: Record<string, unknown>, message: string): void {
    try {
      options.logger?.[level](object, message);
    } catch {
      // A throwing logger never changes evidence state (A-T17).
    }
  }

  function halt(cause: string, details: Record<string, unknown> = {}): void {
    if (state !== "HALTED") log("error", { event: "EVIDENCE_HALTED", cause, ...details }, "evidence consumer halted");
    state = "HALTED";
    if (pairingTimer !== undefined) {
      scheduler.clearTimeout(pairingTimer);
      pairingTimer = undefined;
    }
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const onAbort = () => {
        scheduler.clearTimeout(handle);
        resolve();
      };
      const handle = scheduler.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // §7.1 pairing

  function pair(): PairOutcome {
    let audit: AuditRecorderSnapshot;
    try {
      audit = recorderControl.drainCounters();
    } catch {
      pairingFaultsPending += 1;
      return { kind: "NO_PAIR", reason: "RECORDER_SNAPSHOT_FAILED" };
    }
    if (held !== null) {
      audit = foldAudit(held, audit);
      held = null;
    }
    let rateLimit: RateLimitSummary;
    try {
      rateLimit = evidence.drain();
    } catch {
      pairingFaultsPending += 1;
      drainFailuresSinceAccepted += 1;
      held = audit;
      return { kind: "NO_PAIR", reason: "DRAIN_FAILED" };
    }
    return classify(rateLimit, audit);
  }

  function classify(rateLimit: RateLimitSummary, audit: AuditRecorderSnapshot): PairOutcome {
    const f = rateLimit.firstSequence;
    const l = rateLimit.lastSequence;
    const wellFormed = Number.isSafeInteger(f) && Number.isSafeInteger(l) && f >= 1 && l >= f;
    if (!wellFormed || f < expectedNextSequence || rateLimit.limiterInstanceId !== self) {
      return { kind: "SEQUENCE_ANOMALY", expected: expectedNextSequence, observedFirst: f, observedLast: l };
    }
    const contiguous = f === expectedNextSequence;
    const summary: EvidenceSummary = {
      schemaVersion: 1,
      rateLimit,
      audit,
      pairingFaults: pairingFaultsPending,
      alignment: contiguous ? "ALIGNED" : "UNVERIFIED",
    };
    let outcome: PairOutcome;
    if (contiguous) {
      outcome = { kind: "CONTIGUOUS", summary };
    } else {
      const initial = !observedAny;
      const missingFrom = initial ? 1 : expectedNextSequence;
      const missingTo = f - 1;
      const k = missingTo - missingFrom + 1;
      outcome = {
        kind: "FORWARD_GAP",
        initial,
        missingFrom,
        missingTo,
        cause: k >= 1 && k <= drainFailuresSinceAccepted ? "DRAIN_CONTRACT_VIOLATION" : "SEQUENCE_DISCONTINUITY",
        summary,
        rateLimitDelta: deriveMissingRateLimitDelta(rateLimit, initial ? null : lastAccepted),
      };
    }
    // Accepted (S-A, S-B, S-C).
    expectedNextSequence = l + 1;
    observedAny = true;
    drainFailuresSinceAccepted = 0;
    pairingFaultsPending = 0;
    lastAccepted = rateLimit;
    return outcome;
  }

  function freezeSummaryRecord(summary: EvidenceSummary): FrozenEvidenceRecord {
    return freezeSummary({ id: newId(), scope, recordedAt: wallIso(), summary });
  }

  /** [open segment, if any] + gap + summary (§9.2 step 3); clears the open segment. */
  function recoveryGroup(outcome: PairOutcome & { kind: "FORWARD_GAP" }): FrozenEvidenceRecord[] {
    const records: FrozenEvidenceRecord[] = [];
    if (open !== null) records.push(freezeSummaryRecord(open));
    open = null;
    const now = wallIso();
    records.push(
      freezeDiscontinuityGap({
        id: newId(),
        limiterInstanceId: self,
        scope,
        recordedAt: now,
        missingFrom: outcome.missingFrom,
        missingTo: outcome.missingTo,
        initial: outcome.initial,
        cause: outcome.cause,
        rateLimitDelta: outcome.rateLimitDelta,
        detectedAt: now,
      }),
    );
    records.push(freezeSummaryRecord(outcome.summary));
    return records;
  }

  // -------------------------------------------------------------------------
  // Running-time writes (B7 / B7b): identical retries until confirmed.

  type WriteStatus = "CONFIRMED" | "REJECTED" | "FAILED";

  function applyResults(results: readonly WriteResult[]): WriteStatus {
    if (isConfirmed(results)) {
      frozen = null;
      retryAttempt = 0;
      if (state === "FAULTED") state = "RUNNING";
      return "CONFIRMED";
    }
    // CONFLICT / OVERLAP / SEALED (or any other definitive result): a retry cannot change it.
    frozen = null;
    halt("WRITE_REJECTED", { results: results.filter((result) => result !== "CREATED" && result !== "IDENTICAL_EXISTS") });
    return "REJECTED";
  }

  function startWrite(): void {
    if (frozen === null || writeInFlight !== undefined || state === "FINALIZING" || state === "FINALIZED") return;
    const records = frozen;
    writeInFlight = (async () => {
      try {
        const results = await store.writeEvidenceGroup(records);
        if (frozen === records) applyResults(results);
      } catch (error) {
        log("warn", { event: "EVIDENCE_WRITE_FAILED", errorClass: errorClass(error), outcome: storeErrorOutcome(error) }, "evidence write not confirmed; retrying the identical records");
        // The state may have changed while the write was awaited.
        const now = state as ConsumerState;
        if (frozen === records && now !== "FINALIZING" && now !== "FINALIZED") {
          const delay = fullJitterDelay(retryAttempt, policies.evidenceRetry, random);
          retryAttempt += 1;
          retryTimer = scheduler.setTimeout(() => {
            retryTimer = undefined;
            startWrite();
          }, delay);
        }
      } finally {
        writeInFlight = undefined;
      }
    })();
  }

  function freezeAndWrite(records: readonly FrozenEvidenceRecord[]): void {
    frozen = Object.freeze([...records]);
    retryAttempt = 0;
    startWrite();
  }

  function tick(): PairOutcome | null {
    if (state !== "RUNNING" || frozen !== null || writeInFlight !== undefined) return null;
    const outcome = pair();
    switch (outcome.kind) {
      case "NO_PAIR":
        break;
      case "CONTIGUOUS": {
        if (open === null) {
          open = outcome.summary;
        } else {
          const merged = mergeEvidenceSummaries(open, outcome.summary);
          if (!merged.ok) {
            halt("MERGE_FAILED", { reason: merged.reason });
            break;
          }
          open = merged.summary;
        }
        if (hasActivity(open) || open.rateLimit.intervalMs >= policies.segmentMaxIntervalMs) {
          const segment = freezeSummaryRecord(open);
          open = null;
          freezeAndWrite([segment]);
        }
        break;
      }
      case "FORWARD_GAP":
        state = "FAULTED";
        log("error", { event: "EVIDENCE_FORWARD_GAP", missingFrom: outcome.missingFrom, missingTo: outcome.missingTo }, "evidence sequence gap recorded");
        freezeAndWrite(recoveryGroup(outcome));
        break;
      case "SEQUENCE_ANOMALY": {
        halt("SEQUENCE_ANOMALY", {
          expected: outcome.expected,
          observedFirst: outcome.observedFirst,
          observedLast: outcome.observedLast,
        });
        if (open !== null) {
          const segment = freezeSummaryRecord(open);
          open = null;
          freezeAndWrite([segment]);
        }
        break;
      }
    }
    return outcome;
  }

  function armPairing(): void {
    pairingTimer = scheduler.setTimeout(() => {
      pairingTimer = undefined;
      if (state === "HALTED" || state === "FINALIZING" || state === "FINALIZED" || state === "IDLE") return;
      tick();
      if (state === "RUNNING" || state === "FAULTED") armPairing();
    }, policies.pairingIntervalMs);
  }

  // -------------------------------------------------------------------------
  // Startup (§8.1)

  async function startup(signal: AbortSignal): Promise<void> {
    if (startupCalled) throw new TypeError("startup runs once");
    startupCalled = true;
    const budgetEnd = clock.monotonicNow() + policies.startupBudgetMs;

    async function retry<T>(
      operation: () => Promise<T>,
      onAttempt?: (result: { ok: true; value: T } | { ok: false; error: unknown }) => void,
    ): Promise<{ ok: true; value: T } | { ok: false; reason: "BUDGET" | "ABORTED" }> {
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) return { ok: false, reason: "ABORTED" };
        if (clock.monotonicNow() + policies.startupAttemptWindowMs > budgetEnd) return { ok: false, reason: "BUDGET" };
        try {
          // Awaited, never raced: no step returns while its write is in flight (AN4 E5).
          const value = await operation();
          onAttempt?.({ ok: true, value });
          return { ok: true, value };
        } catch (error) {
          onAttempt?.({ ok: false, error });
          log("warn", { event: "EVIDENCE_STARTUP_RETRY", errorClass: errorClass(error), outcome: storeErrorOutcome(error) }, "evidence startup step failed; retrying");
        }
        await sleep(fullJitterDelay(attempt, policies.startupRetry, random), signal);
      }
    }

    async function caseB(candidate: RecoveryCandidate): Promise<Resolution> {
      const verdict = await retry(() => store.validateHistoricalGap(candidate.limiterInstanceId, scope));
      if (!verdict.ok) return verdict.reason;
      if (verdict.value.valid) return "RESOLVED";
      log("error", { event: "EVIDENCE_GAP_INVALID", reason: verdict.value.reason }, "historical gap is invalid; startup fails closed");
      return "UNRESOLVED";
    }

    async function caseA(candidate: RecoveryCandidate): Promise<Resolution> {
      let stale = 0;
      for (;;) {
        const read = await retry(() => store.readDurableState(candidate.limiterInstanceId));
        if (!read.ok) return read.reason;
        const durable = read.value;
        let gap: FrozenEvidenceRecord;
        try {
          const now = wallIso();
          gap = freezeUncleanGap({
            id: newId(),
            limiterInstanceId: candidate.limiterInstanceId,
            scope,
            recordedAt: now,
            lastDurableSequence: durable.lastDurableSequence,
            cumulativeAsOfLastDurable:
              durable.cumulativeAsOfLastDurable === null || durable.auditCumulativeAsOfLastDurable === null
                ? null
                : { rateLimit: durable.cumulativeAsOfLastDurable, audit: durable.auditCumulativeAsOfLastDurable },
            detectedAt: now,
            detectedByInstanceId: self,
          });
        } catch {
          return "UNRESOLVED";
        }
        // The identical frozen gap is retried after a thrown write (§8.1 Case A step 2).
        const written = await retry(() => store.writeUncleanGap(gap, durable));
        if (!written.ok) return written.reason;
        switch (written.value) {
          case "CREATED":
          case "IDENTICAL_EXISTS":
          case "CLOSED_EXISTS":
            return "RESOLVED";
          case "STALE_STATE":
            stale += 1;
            if (stale > policies.maxStaleRederivations) return "UNRESOLVED";
            continue;
          case "CONFLICT":
            return caseB(candidate);
          default:
            return "UNRESOLVED";
        }
      }
    }

    const discovered = await retry(() => store.findRecoveryCandidates(scope, self));
    if (!discovered.ok) throw new StartupSlotError(false, discovered.reason);
    for (const candidate of discovered.value) {
      const resolution = candidate.hasUncleanGap ? await caseB(candidate) : await caseA(candidate);
      if (resolution !== "RESOLVED") throw new StartupSlotError(false, resolution);
    }

    const started = freezeInstanceStarted({
      id: newId(),
      limiterInstanceId: self,
      scope,
      recordedAt: wallIso(),
      instanceStartedAt: evidence.instanceStartedAt,
      rateLimitPolicies: options.rateLimitPolicies,
      auditPolicies: options.auditPolicies,
    });
    const registration = await retry(
      () => store.writeEvidenceGroup([started]),
      (result) => {
        attempts.push({
          outcome: result.ok ? (isConfirmed(result.value) ? "CONFIRMED" : "NOT_COMMITTED") : storeErrorOutcome(result.error),
        });
      },
    );
    if (!registration.ok) throw new StartupSlotError(false, registration.reason);
    if (!isConfirmed(registration.value)) throw new StartupSlotError(false, "REGISTRATION_REJECTED");
    // Registered. Never start the recorder or consumer after the signal (AN4 E5).
    if (signal.aborted) throw new StartupSlotError(true, "ABORTED_AFTER_REGISTRATION");
    recorderControl.start();
    options.trace?.("RECORDER_START");
    consumer.start();
    options.trace?.("CONSUMER_START");
    recorderAndConsumerStarted = true;
  }

  // -------------------------------------------------------------------------
  // Finalization (§8.3 step 3)

  async function finalize(intake: IntakeBarrierResult, deadline: number): Promise<ConsumerFinalization> {
    stopTimer();
    const wasHalted = state === "HALTED";
    state = "FINALIZING";
    const remaining = (): number => deadline - clock.monotonicNow();

    /** Races `promise` against the D3 deadline; the timer is cleared when the promise wins. */
    async function raceDeadline<T>(promise: Promise<T>): Promise<{ kind: "settled"; value: T } | { kind: "failed"; error: unknown } | { kind: "deadline" }> {
      let handle: unknown;
      const timeout = new Promise<{ kind: "deadline" }>((resolve) => {
        handle = scheduler.setTimeout(() => resolve({ kind: "deadline" }), Math.max(0, remaining()));
      });
      const settled = promise.then(
        (value) => ({ kind: "settled" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const first = await Promise.race([settled, timeout]);
      scheduler.clearTimeout(handle);
      if (first.kind === "deadline") {
        // B-2: a detached write may still settle; it changes nothing, and is logged once.
        void settled.then((late) => log("warn", { event: "EVIDENCE_WRITE_DETACHED", settled: late.kind }, "an evidence write settled after the finalization deadline"));
      }
      return first;
    }

    /** Identical retries until confirmed, rejected, or no attempt can start before the deadline. */
    async function writeUntilSettled(records: readonly FrozenEvidenceRecord[]): Promise<"CONFIRMED" | "REJECTED" | "UNCONFIRMED"> {
      for (let attempt = 0; ; attempt += 1) {
        if (remaining() <= 0) return "UNCONFIRMED";
        const result = await raceDeadline(store.writeEvidenceGroup(records));
        if (result.kind === "deadline") return "UNCONFIRMED";
        if (result.kind === "settled") return isConfirmed(result.value) ? "CONFIRMED" : "REJECTED";
        const delay = fullJitterDelay(attempt, policies.evidenceRetry, random);
        if (delay >= remaining()) return "UNCONFIRMED";
        await sleep(delay);
      }
    }

    // A write the timer started may still be in flight: its outcome counts (§8.3 step 3a).
    if (writeInFlight !== undefined) {
      const inFlight = await raceDeadline(writeInFlight);
      if (inFlight.kind === "deadline") return done("F-C");
    }
    const halted = wasHalted || (state as ConsumerState) === "HALTED";

    // 3a. Resolve pending.
    if (frozen !== null) {
      const pending = await writeUntilSettled(frozen);
      if (pending === "UNCONFIRMED") return done("F-C");
      if (pending === "REJECTED") return done("F-H");
      frozen = null;
    }

    // 3b – 3d. Exactly one branch.
    let finalSummary: EvidenceSummary;
    let branchOutcome: "F-A" | "F-B";
    if (halted) {
      return branchC("F-H");
    }
    const outcome = pair();
    if (outcome.kind === "NO_PAIR") return branchC("F-P");
    if (outcome.kind === "SEQUENCE_ANOMALY") {
      log("error", { event: "EVIDENCE_HALTED", cause: "SEQUENCE_ANOMALY", expected: outcome.expected, observedFirst: outcome.observedFirst, observedLast: outcome.observedLast }, "evidence consumer halted");
      return branchC("F-H");
    }
    let records: FrozenEvidenceRecord[];
    if (outcome.kind === "CONTIGUOUS") {
      // Branch A: merged into the open segment when one exists.
      if (open !== null) {
        const merged = mergeEvidenceSummaries(open, outcome.summary);
        if (!merged.ok) return done("F-H");
        finalSummary = merged.summary;
      } else {
        finalSummary = outcome.summary;
      }
      open = null;
      records = [freezeSummaryRecord(finalSummary)];
      branchOutcome = "F-A";
    } else {
      // Branch B: the recovery group IS the final write.
      finalSummary = outcome.summary;
      records = recoveryGroup(outcome);
      branchOutcome = "F-B";
    }
    const finalWrite = await writeUntilSettled(records);
    if (finalWrite === "UNCONFIRMED") return done("F-D");
    if (finalWrite === "REJECTED") return done("F-H");

    // 3e. The close record (F-19(b) Option B: suppressed after a barrier failure).
    if (typeof intake.forced !== "boolean") return done("F-S");
    const closedAt = wallIso();
    const close = freezeInstanceClosed({
      id: newId(),
      limiterInstanceId: self,
      scope,
      recordedAt: closedAt,
      finalSequence: outcome.summary.rateLimit.lastSequence,
      cumulative: { rateLimit: outcome.summary.rateLimit.cumulative, audit: outcome.summary.audit.cumulative },
      forcedClose: intake.forced,
      closedAt,
    });
    const closeWrite = await writeUntilSettled([close]);
    if (closeWrite === "UNCONFIRMED") return done("F-D′");
    if (closeWrite === "REJECTED") return done("F-H");
    return done(branchOutcome);

    /** Branch C: no final summary; an open segment is written alone; never a close. */
    async function branchC(result: "F-P" | "F-H"): Promise<ConsumerFinalization> {
      if (open !== null) {
        const segment = freezeSummaryRecord(open);
        open = null;
        await writeUntilSettled([segment]);
      }
      return done(result);
    }

    function done(result: FinalizationOutcome): ConsumerFinalization {
      state = "FINALIZED";
      log(result === "F-A" || result === "F-B" ? "warn" : "error", { event: "EVIDENCE_FINALIZED", outcome: result }, "evidence finalization outcome");
      return Object.freeze({ outcome: result, successAllowed: result === "F-A" || result === "F-B" });
    }
  }

  function stopTimer(): void {
    if (pairingTimer !== undefined) {
      scheduler.clearTimeout(pairingTimer);
      pairingTimer = undefined;
    }
    if (retryTimer !== undefined) {
      scheduler.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  const consumer: EvidenceConsumer = {
    startup,
    start(): void {
      if (state !== "IDLE") return;
      state = "RUNNING";
      armPairing();
    },
    stopTimer,
    pairNow: () => tick(),
    finalize({ intake, deadline }) {
      finalizing ??= finalize(intake, deadline);
      return finalizing;
    },
    async verifyRegistration(deadline: number): Promise<RegistrationVerification> {
      const read = await store.verifyRegistration(self, deadline).then(
        (value) => ({ ok: true as const, present: value.present }),
        () => ({ ok: false as const }),
      );
      return classifyRegistrationVerification({ attempts: [...attempts], recorderAndConsumerStarted }, read);
    },
    get registrationAttempts() {
      return Object.freeze([...attempts]);
    },
    get recorderAndConsumerStarted() {
      return recorderAndConsumerStarted;
    },
    get state() {
      return state;
    },
    diagnostics() {
      return {
        expectedNextSequence,
        drainFailuresSinceAccepted,
        heldSnapshot: held,
        openSegment: open,
        frozen,
      };
    },
  };
  return consumer;
}
