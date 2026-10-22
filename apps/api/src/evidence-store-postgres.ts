/**
 * The PostgreSQL EvidenceStore: Task 011A's port mapped onto the @irs/db
 * evidence primitives (addendum RD-2), behind the RD-3 connection cap.
 *
 * RD-3: every 011A database operation (rejection writes, consumer writes,
 * startup, finalization and U3 verification) passes through one counting
 * limiter, limit 2 by default. A slot is taken before the primitive is
 * called, so before it can request a pool connection; it is released only
 * when the primitive's promise settles. A caller that stops waiting (the
 * D3 race, an UNKNOWN outcome) releases nothing: a detached or stalled
 * write keeps its slot until it truly settles. Waiters are served in order.
 *
 * PA-3 (resolves P-011A-13): an adapter-only, sticky cutoff. Once the D3
 * cutoff is reached, no queued or newly submitted operation may start: the
 * adapter checks the absolute monotonic deadline (db.monotonicNow)
 * immediately before every dispatch, and the cutoff stays in force once
 * triggered. Such an operation is rejected { phase: "NOT_STARTED",
 * outcome: "NOT_COMMITTED" } and its primitive is never called. The
 * queue-expiration timer settles waiting operations as definitely not
 * started, exactly once. Operations already running are unaffected: they
 * keep their RD-3 slots until their promises settle and may commit after
 * D3 (B-2), so their outcomes stay genuinely uncertain.
 */
import {
  findEvidenceRecoveryCandidates,
  readEvidenceDurableState,
  readEvidenceRegistration,
  validateEvidenceHistoricalGap,
  writeEvidenceGroup,
  writeEvidenceUncleanGap,
  writeRejectionAuditRows,
} from "@irs/db";
import type {
  Database,
  EvidenceDurableState as PlainDurableState,
  EvidenceJson,
  EvidenceRecordRow,
  EvidenceStoreHooks,
  RejectionAuditRow,
} from "@irs/db";
import type { AuditRecorderCounters, FrozenEvidenceRecord, FrozenRejectionRecord } from "./evidence-records.js";
import type { DurableInstanceState, EvidenceStore } from "./evidence-store.js";
import type { Counters } from "./rate-limit.js";

export const DEFAULT_EVIDENCE_CONNECTION_LIMIT = 2;

/** The RD-3 limiter's observable state, read-only, for tests. */
export interface EvidenceConnectionCap {
  /** Operations holding a slot (started and not yet settled). */
  readonly inFlight: number;
  /** The most slots ever held at once. */
  readonly highWaterMark: number;
  /** Operations waiting for a slot. */
  readonly waiting: number;
  /** PA-3: operations the cutoff refused before their primitive was called (each counted once). */
  readonly refusedByCutoff: number;
}

/** PA-3: the adapter-only cutoff. Not part of the EvidenceStore port. */
export interface EvidenceStoreCutoff {
  /**
   * From `deadline` (absolute, on db.monotonicNow) no operation starts.
   * Sticky: the earliest deadline given applies, and it never lifts.
   */
  cutoffAt(deadline: number): void;
}

export interface PostgresEvidenceStore extends EvidenceStore, EvidenceConnectionCap, EvidenceStoreCutoff {}

/** Thrown for an operation the cutoff stopped before its primitive was called. */
export class EvidenceCutoffError extends Error {
  override readonly name = "EvidenceCutoffError";
  readonly phase = "NOT_STARTED" as const;
  readonly outcome = "NOT_COMMITTED" as const;
  constructor() {
    super("evidence store cutoff: the operation was not started");
  }
}

/** The cutoff's timer; injectable for tests. Default setTimeout, unref'd. */
export interface CutoffTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: CutoffTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

interface Limiter extends EvidenceConnectionCap, EvidenceStoreCutoff {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

interface Waiter {
  readonly start: () => void;
  readonly refuse: (error: EvidenceCutoffError) => void;
}

function createLimiter(limit: number, now: () => number, timers: CutoffTimers): Limiter {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("the evidence connection limit must be an integer >= 1");
  let inFlight = 0;
  let highWaterMark = 0;
  const queue: Waiter[] = [];
  let cutoff: number | undefined;
  let expired = false;
  let timer: unknown;
  let refusedByCutoff = 0;

  function refused(): EvidenceCutoffError {
    refusedByCutoff += 1;
    return new EvidenceCutoffError();
  }

  function pastCutoff(): boolean {
    if (!expired && cutoff !== undefined && now() >= cutoff) expire();
    return expired;
  }

  /** Rejects every queued operation; from now on nothing starts. */
  function expire(): void {
    expired = true;
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
    for (const waiter of queue.splice(0)) waiter.refuse(refused());
  }

  function acquire(): Promise<void> {
    if (pastCutoff()) return Promise.reject(refused());
    if (inFlight < limit) {
      inFlight += 1;
      highWaterMark = Math.max(highWaterMark, inFlight);
      return Promise.resolve();
    }
    return new Promise((start, refuse) => queue.push({ start, refuse }));
  }

  // A released slot passes straight to the next waiter (inFlight unchanged),
  // so no new caller can take it in between. Past the cutoff, the waiters
  // are refused and the slot is freed.
  function release(): void {
    if (!pastCutoff()) {
      const next = queue.shift();
      if (next !== undefined) {
        next.start();
        return;
      }
    }
    inFlight -= 1;
  }

  return {
    cutoffAt(deadline: number): void {
      if (typeof deadline !== "number" || Number.isNaN(deadline)) throw new RangeError("cutoffAt: deadline must be a number");
      if (expired) return;
      if (cutoff !== undefined && cutoff <= deadline) return;
      cutoff = deadline;
      if (pastCutoff()) return;
      if (timer !== undefined) timers.clear(timer);
      timer = timers.set(expire, Math.max(0, deadline - now()));
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      await acquire();
      let pending: Promise<T>;
      try {
        pending = operation();
      } catch (error) {
        release();
        throw error;
      }
      pending.then(release, release);
      return pending;
    },
    get inFlight() {
      return inFlight;
    },
    get highWaterMark() {
      return highWaterMark;
    },
    get waiting() {
      return queue.length;
    },
    get refusedByCutoff() {
      return refusedByCutoff;
    },
  };
}

function toRow(record: FrozenEvidenceRecord): EvidenceRecordRow {
  return {
    id: record.id,
    limiterInstanceId: record.limiterInstanceId,
    scope: record.scope,
    kind: record.kind,
    gapReason: record.gapReason,
    firstSequence: record.firstSequence,
    lastSequence: record.lastSequence,
    missingFrom: record.missingFrom,
    missingTo: record.missingTo,
    payload: record.payload as EvidenceJson,
    recordSha256: record.recordSha256,
    recordedAt: record.recordedAt,
  };
}

function toRejectionRow(record: FrozenRejectionRecord): RejectionAuditRow {
  return {
    id: record.id,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    metadata: record.metadata as unknown as EvidenceJson,
    createdAt: record.createdAt,
  };
}

/** The primitive validated both cumulative shapes before returning them. */
function toPortState(state: PlainDurableState): DurableInstanceState {
  return Object.freeze({
    limiterInstanceId: state.limiterInstanceId,
    startedScope: state.startedScope,
    lastDurableSequence: state.lastDurableSequence,
    cumulativeAsOfLastDurable: state.cumulativeAsOfLastDurable as unknown as Counters | null,
    auditCumulativeAsOfLastDurable: state.auditCumulativeAsOfLastDurable as unknown as AuditRecorderCounters | null,
  });
}

function toPlainState(state: DurableInstanceState): PlainDurableState {
  return {
    limiterInstanceId: state.limiterInstanceId,
    startedScope: state.startedScope,
    lastDurableSequence: state.lastDurableSequence,
    cumulativeAsOfLastDurable: state.cumulativeAsOfLastDurable as unknown as EvidenceJson | null,
    auditCumulativeAsOfLastDurable: state.auditCumulativeAsOfLastDurable as unknown as EvidenceJson | null,
  };
}

/**
 * The store uses the composition's one Database; it creates no client and
 * changes no pool setting. `hooks` are @irs/db's @internal test seams.
 */
export function createPostgresEvidenceStore(options: {
  readonly db: Database;
  readonly hooks?: EvidenceStoreHooks;
  readonly limit?: number;
  /** @internal — test seam for the cutoff timer. */
  readonly timers?: CutoffTimers;
}): PostgresEvidenceStore {
  const { db, hooks = {} } = options;
  const limiter = createLimiter(
    options.limit ?? DEFAULT_EVIDENCE_CONNECTION_LIMIT,
    () => db.monotonicNow(),
    options.timers ?? DEFAULT_TIMERS,
  );
  return {
    cutoffAt: (deadline) => limiter.cutoffAt(deadline),
    findRecoveryCandidates: (scope, excludeInstanceId) =>
      limiter.run(() => findEvidenceRecoveryCandidates(db, scope, excludeInstanceId, hooks)),
    readDurableState: (limiterInstanceId) =>
      limiter.run(async () => toPortState(await readEvidenceDurableState(db, limiterInstanceId, hooks))),
    writeUncleanGap: (gap, derivedFrom) =>
      limiter.run(() => writeEvidenceUncleanGap(db, toRow(gap), toPlainState(derivedFrom), hooks)),
    validateHistoricalGap: (limiterInstanceId, scope) =>
      limiter.run(() => validateEvidenceHistoricalGap(db, limiterInstanceId, scope, hooks)),
    writeEvidenceGroup: (records) => limiter.run(() => writeEvidenceGroup(db, records.map(toRow), hooks)),
    writeRejections: (records) => limiter.run(() => writeRejectionAuditRows(db, records.map(toRejectionRow), hooks)),
    verifyRegistration: (limiterInstanceId, deadline) =>
      limiter.run(() => readEvidenceRegistration(db, limiterInstanceId, deadline, hooks)),
    get inFlight() {
      return limiter.inFlight;
    },
    get highWaterMark() {
      return limiter.highWaterMark;
    },
    get waiting() {
      return limiter.waiting;
    },
    get refusedByCutoff() {
      return limiter.refusedByCutoff;
    },
  };
}
