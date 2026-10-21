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
}

export interface PostgresEvidenceStore extends EvidenceStore, EvidenceConnectionCap {}

interface Limiter extends EvidenceConnectionCap {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

function createLimiter(limit: number): Limiter {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("the evidence connection limit must be an integer >= 1");
  let inFlight = 0;
  let highWaterMark = 0;
  const queue: (() => void)[] = [];

  function acquire(): Promise<void> {
    if (inFlight < limit) {
      inFlight += 1;
      highWaterMark = Math.max(highWaterMark, inFlight);
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  // A released slot passes straight to the next waiter (inFlight unchanged),
  // so no new caller can take it in between.
  function release(): void {
    const next = queue.shift();
    if (next === undefined) inFlight -= 1;
    else next();
  }

  return {
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
}): PostgresEvidenceStore {
  const { db, hooks = {} } = options;
  const limiter = createLimiter(options.limit ?? DEFAULT_EVIDENCE_CONNECTION_LIMIT);
  return {
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
  };
}
