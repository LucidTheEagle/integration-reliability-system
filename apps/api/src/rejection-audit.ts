/**
 * Task 011A individual rejection auditing (design Revision 1.4 §5, §6;
 * AN4 E6/E7). The request path gets only the sink; the recorder admits,
 * queues and writes EVENT_REJECTED rows off the request path.
 *
 * Admission (§6.1): FINALIZED → afterFinalize; otherwise submitted, then
 * ineligible stage, write ceiling, queue capacity, freeze and enqueue.
 * Persistence: one batch in flight at most; records stay in the queue
 * (and in queueDepth) until a result is applied; a thrown or timed-out
 * write keeps the batch at the head and retries the identical frozen
 * records with full-jitter backoff. finalize() is the one-way terminal
 * transition that classifies every queued record exactly once.
 *
 * Logs name error classes and result kinds only; never request data.
 */
import {
  ZERO_AUDIT_COUNTERS,
  buildRejectionRecord,
  sumAuditCounters,
} from "./evidence-records.js";
import type {
  AuditRecorderCounters,
  AuditRecorderGauges,
  AuditRecorderSnapshot,
  FrozenRejectionRecord,
} from "./evidence-records.js";
import type { EvidenceStore } from "./evidence-store.js";

export type { AuditRecorderCounters, AuditRecorderGauges, AuditRecorderSnapshot } from "./evidence-records.js";

/** Where in the pipeline the rejection was decided (A14 §5.2; AN4 E6, E7). */
export type RejectionStage =
  | "ROUTER"
  | "NOT_FOUND"
  | "ROUTE_GUARD"
  | "BODY"
  | "HANDLER"
  | "VERIFIER"
  | "INGESTION_PAYLOAD"
  | "INGESTION_INTEGRATION";

export type EligibleErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNPROCESSABLE_PAYLOAD";

/**
 * What the server observed about its own response, never an inference
 * about the client: FINISH_OBSERVED is not proof of receipt, and
 * CLOSE_BEFORE_FINISH does not prove that no byte reached the client.
 */
export type ResponseCompletion = "FINISH_OBSERVED" | "CLOSE_BEFORE_FINISH";

export interface RejectionCandidate {
  /** Server-generated request ID. */
  readonly requestId: string;
  /** ISO, server wall clock, captured per stage (B-7). */
  readonly receivedAt: string;
  readonly stage: RejectionStage;
  readonly httpStatus: 400 | 401 | 404 | 413 | 415 | 422;
  readonly errorCode: EligibleErrorCode;
  /** Only a canonical UUID returned by parseIntegrationId; never the raw path parameter. */
  readonly claimedIntegrationId: string | null;
  /** Only for VERIFIER: the verifier's fixed rejection-reason value. */
  readonly verifierReason: string | null;
  readonly responseCompletion: ResponseCompletion;
}

/** Request-path capability, given to buildServer only. No drain, flush or counter access. */
export interface RejectionAuditSink {
  /** Synchronous, O(1), never throws, never awaits I/O. */
  submit(candidate: RejectionCandidate): void;
}

/** Supplied by each rejectWith call site (§5.3). */
export interface RejectionContext {
  readonly stage: RejectionStage;
  readonly verifierReason?: string | null;
  /**
   * RD-15: present when a setErrorHandler rejection on the webhook route was
   * mapped to HANDLER by fallback; the Fastify error code, or null if none.
   */
  readonly unmappedCode?: string | null;
}

/** Provisional (AD-5). */
export interface AuditPolicies {
  readonly writeBucket: { readonly capacity: number; readonly refillPerSecond: number };
  readonly queueCapacity: number;
  readonly batchSize: number;
  readonly writerRetry: { readonly baseMs: number; readonly capMs: number };
}

export const DEFAULT_AUDIT_POLICIES: AuditPolicies = Object.freeze({
  writeBucket: Object.freeze({ capacity: 100, refillPerSecond: 10 }),
  queueCapacity: 1_000,
  batchSize: 50,
  writerRetry: Object.freeze({ baseMs: 500, capMs: 30_000 }),
});

/** Timers for 011A; the default unrefs them. */
export interface EvidenceScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const DEFAULT_EVIDENCE_SCHEDULER: EvidenceScheduler = Object.freeze({
  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  },
});

export interface EvidenceClock {
  /** Monotonic ms. */
  readonly monotonicNow: () => number;
  readonly wallNow: () => Date;
}

export const DEFAULT_EVIDENCE_CLOCK: EvidenceClock = Object.freeze({
  monotonicNow: () => performance.now(),
  wallNow: () => new Date(),
});

/** The logger subset 011A uses (pino-compatible). Every call is swallowed if it throws. */
export interface EvidenceLogger {
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export type RecorderState = "CREATED" | "RUNNING" | "DRAINING" | "FINALIZED";

export interface RecorderControl {
  /** Starts the writer (§8.1 step 3a). Idempotent. Never called after finalize. */
  start(): void;
  /** The one-way terminal transition (§6.1). Runs once; later calls return the same promise. */
  finalize(budgetMs: number): Promise<void>;
  /** Failure-atomic: builds the snapshot, then swaps in fresh deltas in one assignment. */
  drainCounters(): AuditRecorderSnapshot;
  /** @internal — read-only cumulative counters, for per-run counts (Stage 8). */
  cumulative(): AuditRecorderCounters;
  /** @internal — submissions after FINALIZED (memory only; §6.2). */
  readonly afterFinalize: number;
  readonly state: RecorderState;
}

export interface RejectionAuditRecorder {
  readonly sink: RejectionAuditSink;
  readonly control: RecorderControl;
}

const NON_WEBHOOK: ReadonlySet<RejectionStage> = new Set(["ROUTER", "NOT_FOUND"]);

type MutableCounters = { -readonly [K in keyof AuditRecorderCounters]: number };

interface QueuedRecord {
  readonly record: FrozenRejectionRecord;
  attempted: boolean;
}

/** Full jitter: a uniform delay in [0, min(cap, base × 2^attempt)). */
export function fullJitterDelay(attempt: number, policy: { baseMs: number; capMs: number }, random: () => number): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

export function createRejectionAuditRecorder(options: {
  readonly store: EvidenceStore;
  readonly limiterInstanceId: string;
  readonly policies?: AuditPolicies;
  readonly clock?: EvidenceClock;
  readonly scheduler?: EvidenceScheduler;
  readonly logger?: EvidenceLogger;
  readonly random?: () => number;
}): RejectionAuditRecorder {
  const { store, limiterInstanceId } = options;
  const policies = options.policies ?? DEFAULT_AUDIT_POLICIES;
  const clock = options.clock ?? DEFAULT_EVIDENCE_CLOCK;
  const scheduler = options.scheduler ?? DEFAULT_EVIDENCE_SCHEDULER;
  const random = options.random ?? Math.random;

  let state: RecorderState = "CREATED";
  let delta: MutableCounters = { ...ZERO_AUDIT_COUNTERS };
  const total: MutableCounters = { ...ZERO_AUDIT_COUNTERS };
  let intervalStartedAt = clock.wallNow().toISOString();
  let afterFinalize = 0;

  // Write ceiling: a token bucket, starting full.
  let tokens = policies.writeBucket.capacity;
  let refilledAt = clock.monotonicNow();

  const queue: QueuedRecord[] = [];
  let batchInFlight: { readonly entries: readonly QueuedRecord[]; detached: boolean } | undefined;
  let retryTimer: unknown;
  let retryAttempt = 0;
  let finalizing: Promise<void> | undefined;
  let finishDrain: (() => void) | undefined;

  function log(level: "warn" | "error", object: Record<string, unknown>, message: string): void {
    try {
      options.logger?.[level](object, message);
    } catch {
      // A throwing logger never changes evidence state (A-T17).
    }
  }

  function count(field: keyof AuditRecorderCounters, by = 1): void {
    delta[field] += by;
    total[field] += by;
  }

  function takeToken(): boolean {
    const now = clock.monotonicNow();
    const elapsed = Math.max(0, now - refilledAt);
    tokens = Math.min(policies.writeBucket.capacity, tokens + (elapsed * policies.writeBucket.refillPerSecond) / 1000);
    refilledAt = Math.max(refilledAt, now);
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function admit(candidate: RejectionCandidate): void {
    // 0. Terminal.
    if (state === "FINALIZED") {
      afterFinalize += 1;
      return;
    }
    // 1. Submitted.
    count("submitted");
    count(candidate.responseCompletion === "CLOSE_BEFORE_FINISH" ? "closeBeforeFinish" : "finishObserved");
    // 2. Not a webhook delivery (AD-3).
    if (NON_WEBHOOK.has(candidate.stage)) {
      count("ineligibleNonWebhook");
      return;
    }
    // 3. Write ceiling.
    if (!takeToken()) {
      count("suppressedByCeiling");
      return;
    }
    // 4. Queue bound (the token stays consumed).
    if (queue.length >= policies.queueCapacity) {
      count("droppedQueueFull");
      return;
    }
    // 5. Freeze once; never rebuilt.
    const record = buildRejectionRecord({
      id: candidate.requestId,
      actorType: "EXTERNAL_SENDER",
      actorId: null,
      action: "EVENT_REJECTED",
      entityType: "WEBHOOK_DELIVERY",
      entityId: candidate.requestId,
      metadata: {
        schemaVersion: 1,
        limiterInstanceId,
        stage: candidate.stage,
        httpStatus: candidate.httpStatus,
        errorCode: candidate.errorCode,
        claimedIntegrationId: candidate.claimedIntegrationId,
        verifierReason: candidate.verifierReason,
        responseCompletion: candidate.responseCompletion,
        receivedAt: candidate.receivedAt,
      },
      createdAt: clock.wallNow().toISOString(),
    });
    queue.push({ record, attempted: false });
    count("admitted");
    kick();
  }

  const sink: RejectionAuditSink = Object.freeze({
    submit(candidate: RejectionCandidate): void {
      try {
        admit(candidate);
      } catch {
        try {
          count("sinkFaults");
        } catch {
          // Nothing escapes submit().
        }
      }
    },
  });

  function writerActive(): boolean {
    return state === "RUNNING" || state === "DRAINING";
  }

  /** Starts the next batch if the writer may run and none is in flight or backing off. */
  function kick(): void {
    if (!writerActive() || batchInFlight !== undefined || retryTimer !== undefined) return;
    if (queue.length === 0) {
      if (state === "DRAINING") finishDrain?.();
      return;
    }
    const entries = queue.slice(0, policies.batchSize);
    for (const entry of entries) entry.attempted = true;
    const batch = { entries, detached: false };
    batchInFlight = batch;
    let pending: Promise<readonly string[]>;
    try {
      pending = store.writeRejections(entries.map((entry) => entry.record));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (results) => settleBatch(batch, results, undefined),
      (error: unknown) => settleBatch(batch, undefined, error),
    );
  }

  function settleBatch(
    batch: { readonly entries: readonly QueuedRecord[]; detached: boolean },
    results: readonly string[] | undefined,
    error: unknown,
  ): void {
    try {
      if (batch.detached) {
        // §6.1 step 4: changes no counter and no snapshot; its outcome is logged once.
        log(
          "warn",
          { event: "REJECTION_BATCH_DETACHED_OUTCOME", outcome: error === undefined ? "RESOLVED" : "REJECTED", errorClass: error instanceof Error ? error.name : null },
          "a detached rejection batch settled after finalization",
        );
        return;
      }
      batchInFlight = undefined;
      const valid =
        error === undefined &&
        results !== undefined &&
        results.length === batch.entries.length &&
        results.every((result) => result === "CREATED" || result === "IDENTICAL_EXISTS" || result === "CONFLICT");
      if (!valid || results === undefined) {
        log("warn", { event: "REJECTION_WRITE_FAILED", errorClass: error instanceof Error ? error.name : null }, "rejection batch not confirmed; retrying");
        const delay = fullJitterDelay(retryAttempt, policies.writerRetry, random);
        retryAttempt += 1;
        retryTimer = scheduler.setTimeout(() => {
          retryTimer = undefined;
          kick();
        }, delay);
        return;
      }
      retryAttempt = 0;
      let conflicts = 0;
      for (const [index, entry] of batch.entries.entries()) {
        const position = queue.indexOf(entry);
        if (position !== -1) queue.splice(position, 1);
        if (results[index] === "CONFLICT") {
          count("conflicts");
          conflicts += 1;
        } else {
          count("persisted");
        }
      }
      if (conflicts > 0) {
        log("error", { event: "REJECTION_CONFLICT", count: conflicts }, "rejection record conflicts with a stored row; never overwritten");
      }
      kick();
    } catch {
      count("sinkFaults");
    }
  }

  function terminate(): void {
    if (state === "FINALIZED") return;
    state = "FINALIZED";
    if (retryTimer !== undefined) {
      scheduler.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    for (const entry of queue) count(entry.attempted ? "outcomeUnknownAtShutdown" : "notAttemptedAtShutdown");
    queue.length = 0;
    if (batchInFlight !== undefined) {
      batchInFlight.detached = true;
      batchInFlight = undefined;
    }
  }

  const control: RecorderControl = {
    start(): void {
      if (state !== "CREATED") return;
      state = "RUNNING";
      kick();
    },
    finalize(budgetMs: number): Promise<void> {
      if (finalizing !== undefined) return finalizing;
      finalizing = new Promise<void>((resolve) => {
        if (state === "FINALIZED") {
          resolve();
          return;
        }
        state = "DRAINING";
        let deadlineTimer: unknown;
        finishDrain = () => {
          finishDrain = undefined;
          if (deadlineTimer !== undefined) scheduler.clearTimeout(deadlineTimer);
          terminate();
          resolve();
        };
        deadlineTimer = scheduler.setTimeout(() => {
          deadlineTimer = undefined;
          finishDrain?.();
        }, Math.max(0, budgetMs));
        // A pending backoff is cut short: the writer retries now, within the budget.
        if (retryTimer !== undefined) {
          scheduler.clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        kick();
      });
      return finalizing;
    },
    drainCounters(): AuditRecorderSnapshot {
      const endedAt = clock.wallNow().toISOString();
      const snapshot: AuditRecorderSnapshot = Object.freeze({
        intervalStartedAt,
        intervalEndedAt: endedAt,
        delta: sumAuditCounters(ZERO_AUDIT_COUNTERS, delta),
        cumulative: sumAuditCounters(ZERO_AUDIT_COUNTERS, total),
        gauges: Object.freeze({ queueDepth: queue.length, queueCapacity: policies.queueCapacity }),
      });
      // Commit by assignment, after everything that can throw.
      delta = { ...ZERO_AUDIT_COUNTERS };
      intervalStartedAt = endedAt;
      return snapshot;
    },
    cumulative(): AuditRecorderCounters {
      return sumAuditCounters(ZERO_AUDIT_COUNTERS, total);
    },
    get afterFinalize() {
      return afterFinalize;
    },
    get state() {
      return state;
    },
  };

  return Object.freeze({ sink, control });
}
