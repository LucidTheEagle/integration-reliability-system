/**
 * Task 011A evidence-store port (design Revision 1.4 §7.4, §7.5; AN4 E2
 * Option A, E3, E5a) and the in-memory store used by 011A's tests.
 *
 * The in-memory store implements the port's rules exactly as the
 * PostgreSQL store must (the shared contract suite runs against both):
 * the per-instance lock, the overlap and seal rules, complete-record
 * comparison, CLOSED_EXISTS, and the four shape constraints with the
 * table's unique keys. Its fault modes model store events for
 * state-machine tests; they are never evidence of PostgreSQL locking,
 * snapshot visibility or durability (AN4 E3).
 */
import {
  canonicalJson,
  freezeJson,
  isIsoMillis,
  readInstanceStartedPayload,
  readSummaryCumulative,
  readUncleanGapPayload,
  recordHash,
  rejectionRowCanonical,
} from "./evidence-records.js";
import type {
  AuditRecorderCounters,
  EvidenceKind,
  EvidenceRecordFields,
  FrozenEvidenceRecord,
  FrozenRejectionRecord,
  GapReason,
  JsonValue,
} from "./evidence-records.js";
import type { RegistrationVerification } from "./lifecycle.js";
import type { Counters } from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Port (§7.5, AN4 E2 Option A and E5a)

export type WriteResult =
  | "CREATED"
  | "IDENTICAL_EXISTS"
  | "CONFLICT"
  | "OVERLAP"
  | "SEALED"
  | "STALE_STATE"
  /** Returned only by writeUncleanGap (AN4 E2 Option A). */
  | "CLOSED_EXISTS";

export interface DurableInstanceState {
  readonly limiterInstanceId: string;
  /** Scope in its INSTANCE_STARTED record. */
  readonly startedScope: string;
  /** Max lastSequence of its SUMMARY rows; 0 if none. */
  readonly lastDurableSequence: number;
  /** From that SUMMARY; null if none. */
  readonly cumulativeAsOfLastDurable: Counters | null;
  /** From that SUMMARY; null if none. */
  readonly auditCumulativeAsOfLastDurable: AuditRecorderCounters | null;
}

/** Discovery only. No recovery decision is ever made from this value. */
export interface RecoveryCandidate {
  readonly limiterInstanceId: string;
  readonly hasUncleanGap: boolean;
}

export type HistoricalGapVerdict =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | "NO_GAP"
        | "UNREADABLE"
        | "HASH_MISMATCH"
        | "IDENTITY_MISMATCH"
        | "SCOPE_MISMATCH"
        | "UNSUPPORTED_PAYLOAD"
        | "DURABLE_FACTS_MISMATCH";
    };

/** AN4 E5a: what one locked read established. Never written. */
export interface RegistrationRead {
  readonly present: boolean;
}

export interface EvidenceStore {
  /** Every instance whose INSTANCE_STARTED scope = `scope`, with no INSTANCE_CLOSED, id ≠ excludeInstanceId. Unlocked. */
  findRecoveryCandidates(scope: string, excludeInstanceId: string): Promise<readonly RecoveryCandidate[]>;
  /** Unlocked read used only to freeze a Case A gap; the write re-checks it under the lock. */
  readDurableState(limiterInstanceId: string): Promise<DurableInstanceState>;
  /**
   * Case A, one locked transaction: (1a) if an INSTANCE_CLOSED exists for P →
   * CLOSED_EXISTS (nothing written); (1) if a gap exists → IDENTICAL_EXISTS if
   * identical, else CONFLICT; (2) re-read durable state; if it differs from
   * `derivedFrom` → STALE_STATE (nothing written); (3) insert → CREATED.
   * Throws on store error (outcome unknown).
   */
  writeUncleanGap(gap: FrozenEvidenceRecord, derivedFrom: DurableInstanceState): Promise<WriteResult>;
  /**
   * Case B, one locked, read-only transaction: re-read the gap row and the
   * instance's durable state and apply every §8.1 check to that fresh view.
   */
  validateHistoricalGap(limiterInstanceId: string, scope: string): Promise<HistoricalGapVerdict>;
  /**
   * One locked, atomic transaction for one instance's group. Every record
   * is classified in order against the instance's rows plus the group's
   * earlier records. If any result is CONFLICT, OVERLAP or SEALED the group
   * is rolled back and nothing is committed; a CREATED in such a group
   * means "would have been created". A shape-constraint violation throws.
   */
  writeEvidenceGroup(records: readonly FrozenEvidenceRecord[]): Promise<readonly WriteResult[]>;
  /** One transaction per batch; CREATED / IDENTICAL_EXISTS / CONFLICT per record (a CONFLICT rolls nothing back). */
  writeRejections(records: readonly FrozenRejectionRecord[]): Promise<readonly WriteResult[]>;
  /**
   * AN4 E5a: one locked, read-only check for this instance's INSTANCE_STARTED.
   * `deadline` is absolute, on the lifecycle's monotonic clock. Throws when
   * the lock or the read did not complete.
   */
  verifyRegistration(limiterInstanceId: string, deadline: number): Promise<RegistrationRead>;
}

export type StoreWriteOutcome = "NOT_COMMITTED" | "UNKNOWN";

/**
 * B-1: a thrown store error is classified by its `outcome` only, never by
 * class or name. Anything not proven NOT_COMMITTED is UNKNOWN.
 */
export function storeErrorOutcome(error: unknown): StoreWriteOutcome {
  return typeof error === "object" &&
    error !== null &&
    (error as { readonly outcome?: unknown }).outcome === "NOT_COMMITTED"
    ? "NOT_COMMITTED"
    : "UNKNOWN";
}

// ---------------------------------------------------------------------------
// U3 classification (AN4 E5a step 3)

/** How one INSTANCE_STARTED write attempt of this process ended. */
export interface RegistrationAttempt {
  readonly outcome: "CONFIRMED" | StoreWriteOutcome;
}

/** The startup steps' record of their registration attempts (E5a step 1). */
export interface RegistrationRecord {
  readonly attempts: readonly RegistrationAttempt[];
  readonly recorderAndConsumerStarted: boolean;
}

export type RegistrationReadResult =
  | { readonly ok: true; readonly present: boolean }
  | { readonly ok: false };

/**
 * Pure. CONFIRMED_PRESENT: the locked read found the row. CONFIRMED_ABSENT
 * only if the read found no row AND every recorded attempt ended
 * NOT_COMMITTED. Anything else, including a missing record, any UNKNOWN or
 * CONFIRMED attempt beside an absent row, and a failed read, is
 * STILL_UNKNOWN. A read that finds no row is never by itself absence.
 */
export function classifyRegistrationVerification(
  record: RegistrationRecord | null,
  read: RegistrationReadResult,
): RegistrationVerification {
  if (!read.ok) return Object.freeze({ kind: "STILL_UNKNOWN" });
  if (read.present) {
    return Object.freeze({
      kind: "CONFIRMED_PRESENT",
      recorderAndConsumerStarted: record?.recorderAndConsumerStarted === true,
    });
  }
  if (record !== null && record.attempts.every((attempt) => attempt.outcome === "NOT_COMMITTED")) {
    return Object.freeze({ kind: "CONFIRMED_ABSENT" });
  }
  return Object.freeze({ kind: "STILL_UNKNOWN" });
}

// ---------------------------------------------------------------------------
// Stored rows: the table's columns as plain values (also the PostgreSQL
// store's row shape). Out-of-protocol seeding and alteration may store
// content no protocol path would write.

export interface EvidenceRow {
  readonly id: string;
  readonly limiterInstanceId: string;
  readonly scope: string;
  readonly kind: string;
  readonly gapReason: string | null;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly missingFrom: number | null;
  readonly missingTo: number | null;
  readonly payload: JsonValue;
  readonly recordSha256: string;
  /** ISO 8601 UTC, millisecond precision. */
  readonly recordedAt: string;
}

export interface RejectionRow {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly metadata: JsonValue | null;
  /** ISO 8601 UTC, millisecond precision. */
  readonly createdAt: string;
}

/** Copies exactly the 11 hashed fields of a row. */
export function evidenceRowFields(row: EvidenceRow): EvidenceRecordFields {
  return {
    id: row.id,
    limiterInstanceId: row.limiterInstanceId,
    scope: row.scope,
    kind: row.kind as EvidenceKind,
    gapReason: row.gapReason as GapReason | null,
    firstSequence: row.firstSequence,
    lastSequence: row.lastSequence,
    missingFrom: row.missingFrom,
    missingTo: row.missingTo,
    recordedAt: row.recordedAt,
    payload: row.payload,
  };
}

// ---------------------------------------------------------------------------
// The protocol rules, on plain rows. Exported for the PostgreSQL contract
// fixture and for tests; the PostgreSQL store implements the same rules in
// SQL inside its locked transaction.

/** The natural key (partial unique index) a row falls under, if any. */
export function naturalKeyOf(row: {
  readonly kind: string;
  readonly gapReason: string | null;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly missingFrom: number | null;
  readonly missingTo: number | null;
}): { readonly index: string; readonly key: string } | null {
  if (row.kind === "INSTANCE_STARTED" || row.kind === "INSTANCE_CLOSED") {
    return { index: "rle_instance_lifecycle_uq", key: row.kind };
  }
  if (row.kind === "SUMMARY" && row.firstSequence !== null && row.lastSequence !== null) {
    return { index: "rle_summary_range_uq", key: `${row.firstSequence}:${row.lastSequence}` };
  }
  if (row.kind === "EVIDENCE_GAP" && row.gapReason === "SEQUENCE_DISCONTINUITY") {
    if (row.missingFrom === null || row.missingTo === null) return null;
    return { index: "rle_gap_discontinuity_uq", key: `${row.missingFrom}:${row.missingTo}` };
  }
  if (row.kind === "EVIDENCE_GAP" && row.gapReason === "UNCLEAN_TERMINATION") {
    return { index: "rle_gap_unclean_uq", key: "" };
  }
  return null;
}

/** The sequence range a SUMMARY or discontinuity gap covers; null if none or incomplete. */
export function sequenceRangeOf(row: {
  readonly kind: string;
  readonly gapReason: string | null;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly missingFrom: number | null;
  readonly missingTo: number | null;
}): { readonly from: number; readonly to: number } | null {
  if (row.kind === "SUMMARY" && row.firstSequence !== null && row.lastSequence !== null) {
    return { from: row.firstSequence, to: row.lastSequence };
  }
  if (
    row.kind === "EVIDENCE_GAP" &&
    row.gapReason === "SEQUENCE_DISCONTINUITY" &&
    row.missingFrom !== null &&
    row.missingTo !== null
  ) {
    return { from: row.missingFrom, to: row.missingTo };
  }
  return null;
}

/** Seal rule (§7.4): kinds rejected after an UNCLEAN_TERMINATION gap unless identical to a stored record. */
export function isSealable(row: { readonly kind: string; readonly gapReason: string | null }): boolean {
  return (
    row.kind === "SUMMARY" ||
    row.kind === "INSTANCE_CLOSED" ||
    (row.kind === "EVIDENCE_GAP" && row.gapReason === "SEQUENCE_DISCONTINUITY")
  );
}

/**
 * Complete-record comparison (§7.5): the stored row's recomputed hash, its
 * stored hash and the new record's hash (itself consistent with the new
 * record's fields) must all be equal. An unreadable stored row is never identical.
 */
export function isIdenticalRecord(stored: EvidenceRow, record: FrozenEvidenceRecord): boolean {
  try {
    const storedHash = recordHash(evidenceRowFields(stored));
    return (
      storedHash === stored.recordSha256 &&
      stored.recordSha256 === record.recordSha256 &&
      recordHash(record) === record.recordSha256
    );
  } catch {
    return false;
  }
}

/** First CHECK constraint the row violates, in PostgreSQL's (name) order; null if none. */
export function violatedCheck(row: {
  readonly kind: string;
  readonly gapReason: string | null;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly missingFrom: number | null;
  readonly missingTo: number | null;
}): string | null {
  const isGap = row.kind === "EVIDENCE_GAP";
  if (
    isGap &&
    !(row.gapReason === "SEQUENCE_DISCONTINUITY" || row.gapReason === "UNCLEAN_TERMINATION")
  ) {
    return "rle_gap_reason_ck";
  }
  if (
    isGap &&
    row.gapReason === "SEQUENCE_DISCONTINUITY" &&
    !(
      row.missingFrom !== null &&
      row.missingTo !== null &&
      row.missingFrom >= 1 &&
      row.missingTo >= row.missingFrom
    )
  ) {
    return "rle_gap_shape_ck";
  }
  if (!["INSTANCE_STARTED", "SUMMARY", "EVIDENCE_GAP", "INSTANCE_CLOSED"].includes(row.kind)) {
    return "rle_kind_ck";
  }
  if (
    row.kind === "SUMMARY" &&
    !(
      row.firstSequence !== null &&
      row.lastSequence !== null &&
      row.firstSequence >= 1 &&
      row.lastSequence >= row.firstSequence
    )
  ) {
    return "rle_summary_shape_ck";
  }
  return null;
}

/** P's durable state from its rows (§7.5); throws when P has no INSTANCE_STARTED or its last summary is unreadable. */
export function durableStateFromRows(
  limiterInstanceId: string,
  rows: readonly EvidenceRow[],
): DurableInstanceState {
  const own = rows.filter((row) => row.limiterInstanceId === limiterInstanceId);
  const started = own.find((row) => row.kind === "INSTANCE_STARTED");
  if (started === undefined) throw dataError("the instance has no INSTANCE_STARTED record");
  let last: EvidenceRow | undefined;
  for (const row of own) {
    if (row.kind !== "SUMMARY" || row.lastSequence === null) continue;
    if (last === undefined || row.lastSequence > (last.lastSequence as number)) last = row;
  }
  if (last === undefined) {
    return Object.freeze({
      limiterInstanceId,
      startedScope: started.scope,
      lastDurableSequence: 0,
      cumulativeAsOfLastDurable: null,
      auditCumulativeAsOfLastDurable: null,
    });
  }
  const cumulative = readSummaryCumulative(last.payload);
  if (cumulative === null) throw dataError("the last durable summary is unreadable");
  return Object.freeze({
    limiterInstanceId,
    startedScope: started.scope,
    lastDurableSequence: last.lastSequence as number,
    cumulativeAsOfLastDurable: freezeJson(cumulative.rateLimit) as unknown as Counters,
    auditCumulativeAsOfLastDurable: freezeJson(cumulative.audit) as unknown as AuditRecorderCounters,
  });
}

/** Canonical equality of two durable states. */
export function sameDurableState(a: DurableInstanceState, b: DurableInstanceState): boolean {
  const view = (state: DurableInstanceState) => ({
    limiterInstanceId: state.limiterInstanceId,
    startedScope: state.startedScope,
    lastDurableSequence: state.lastDurableSequence,
    cumulativeAsOfLastDurable: state.cumulativeAsOfLastDurable,
    auditCumulativeAsOfLastDurable: state.auditCumulativeAsOfLastDurable,
  });
  return canonicalJson(view(a)) === canonicalJson(view(b));
}

/** Every §8.1 Case B check, in the table's order, on one consistent view of P's rows. */
export function historicalGapVerdict(
  limiterInstanceId: string,
  scope: string,
  rows: readonly EvidenceRow[],
): HistoricalGapVerdict {
  const fail = (reason: Exclude<HistoricalGapVerdict, { valid: true }>["reason"]): HistoricalGapVerdict =>
    Object.freeze({ valid: false, reason });
  const own = rows.filter((row) => row.limiterInstanceId === limiterInstanceId);
  const gaps = own.filter((row) => row.kind === "EVIDENCE_GAP" && row.gapReason === "UNCLEAN_TERMINATION");
  if (gaps.length !== 1) return fail("NO_GAP");
  const gap = gaps[0] as EvidenceRow;
  if (typeof gap.payload !== "object" || gap.payload === null || Array.isArray(gap.payload)) {
    return fail("UNREADABLE");
  }
  if (!isIsoMillis(gap.recordedAt)) return fail("UNREADABLE");
  let storedHash: string;
  try {
    storedHash = recordHash(evidenceRowFields(gap));
  } catch {
    return fail("UNREADABLE");
  }
  if (storedHash !== gap.recordSha256) return fail("HASH_MISMATCH");
  if (
    gap.firstSequence !== null ||
    gap.lastSequence !== null ||
    gap.missingFrom !== null ||
    gap.missingTo !== null
  ) {
    return fail("IDENTITY_MISMATCH");
  }
  const started = own.find((row) => row.kind === "INSTANCE_STARTED");
  if (gap.scope !== scope || started === undefined || started.scope !== scope) return fail("SCOPE_MISMATCH");
  const payload = readUncleanGapPayload(gap.payload);
  const startedPayload = readInstanceStartedPayload(started.payload);
  if (
    payload === null ||
    startedPayload === null ||
    payload.detectedByInstanceId === limiterInstanceId ||
    Date.parse(payload.detectedAt) < Date.parse(startedPayload.instanceStartedAt)
  ) {
    return fail("UNSUPPORTED_PAYLOAD");
  }
  let state: DurableInstanceState;
  try {
    state = durableStateFromRows(limiterInstanceId, rows);
  } catch {
    return fail("DURABLE_FACTS_MISMATCH");
  }
  const durable =
    state.cumulativeAsOfLastDurable === null || state.auditCumulativeAsOfLastDurable === null
      ? null
      : { rateLimit: state.cumulativeAsOfLastDurable, audit: state.auditCumulativeAsOfLastDurable };
  if (
    payload.lastDurableSequence !== state.lastDurableSequence ||
    canonicalJson(payload.cumulativeAsOfLastDurable) !== canonicalJson(durable)
  ) {
    return fail("DURABLE_FACTS_MISMATCH");
  }
  return Object.freeze({ valid: true });
}

// ---------------------------------------------------------------------------
// In-memory store

/** Errors thrown by the in-memory store; `code` mirrors the PostgreSQL SQLSTATE where one applies. */
export class InMemoryStoreError extends Error {
  readonly outcome: StoreWriteOutcome;
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  constructor(
    message: string,
    outcome: StoreWriteOutcome,
    details: { readonly code?: string; readonly constraint?: string } = {},
  ) {
    super(message);
    this.name = "InMemoryStoreError";
    this.outcome = outcome;
    this.code = details.code;
    this.constraint = details.constraint;
  }
}

function dataError(message: string): InMemoryStoreError {
  return new InMemoryStoreError(message, "NOT_COMMITTED", { code: "XX001" });
}

function columnError(code: string, message: string, constraint?: string): InMemoryStoreError {
  return new InMemoryStoreError(
    message,
    "NOT_COMMITTED",
    constraint === undefined ? { code } : { code, constraint },
  );
}

export type EvidenceStoreMethod = keyof EvidenceStore;

const WRITE_METHODS: readonly EvidenceStoreMethod[] = [
  "writeUncleanGap",
  "writeEvidenceGroup",
  "writeRejections",
];

export interface StoreCall {
  readonly method: EvidenceStoreMethod;
  /** The store's clock when the call was made. */
  readonly at: number;
  /** Kinds of the records written, for the evidence writes. */
  readonly kinds: readonly string[];
}

/** A commit held under the lock until the test releases it (AN4 E3). */
export interface CommitGate {
  /** Resolves when the transaction has done its work and holds the lock. */
  readonly reached: Promise<void>;
  /** Commits; with thenThrow, the acknowledgement is then lost (UNKNOWN). */
  release(options?: { readonly thenThrow?: boolean }): void;
}

/** A call that does not proceed until released. */
export interface HangHandle {
  readonly reached: Promise<void>;
  release(): void;
}

export interface InMemoryFaults {
  /** The next `count` matching calls throw before doing anything. Default outcome NOT_COMMITTED. */
  failNext(
    count: number,
    options?: { readonly methods?: readonly EvidenceStoreMethod[]; readonly outcome?: StoreWriteOutcome },
  ): void;
  /** The next matching write does its work, then throws before commit: nothing is committed (NOT_COMMITTED). */
  throwBeforeCommit(options?: { readonly methods?: readonly EvidenceStoreMethod[] }): void;
  /** The next matching write commits, then throws: a lost acknowledgement (UNKNOWN). */
  commitThenThrow(options?: { readonly methods?: readonly EvidenceStoreMethod[] }): void;
  /** The next matching write holds its instance lock after its work, until released, then commits. */
  delayCommit(options?: { readonly methods?: readonly EvidenceStoreMethod[] }): CommitGate;
  /** The next matching call waits before doing anything (it holds no lock) until released. */
  hang(options?: { readonly methods?: readonly EvidenceStoreMethod[] }): HangHandle;
  /** Once: after the next successful call of `method`, before it returns, run `hook` (commit between calls). */
  afterCall(method: EvidenceStoreMethod, hook: () => void | Promise<void>): void;
}

export interface InMemoryRawAccess {
  /** Committed rows, deep-copied; optionally one instance's. */
  evidenceRows(limiterInstanceId?: string): readonly EvidenceRow[];
  rejectionRow(id: string): RejectionRow | null;
  rejectionRows(): readonly RejectionRow[];
  /** Out-of-protocol INSERT (no lock): column, CHECK and unique constraints apply, as for SQL. */
  seedEvidence(row: EvidenceRow): void;
  seedRejection(row: RejectionRow): void;
  /** Out-of-protocol UPDATE without the lock (§7.5 alterOutsideProtocol); constraints apply. */
  alterOutsideProtocol(id: string, changes: Partial<Omit<EvidenceRow, "id">>): void;
}

export interface InMemoryEvidenceStore extends EvidenceStore {
  readonly faults: InMemoryFaults;
  readonly raw: InMemoryRawAccess;
  /** Every call, in order. */
  readonly calls: readonly StoreCall[];
}

const UUID_ANY_CASE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
const REJECTIONS_LOCK = "\u0000rejections";

function uuidColumn(value: unknown, column: string): string {
  if (value === null || value === undefined) throw columnError("23502", `null value in column ${column}`);
  if (typeof value !== "string" || !UUID_ANY_CASE.test(value)) {
    throw columnError("22P02", `invalid input syntax for type uuid (column ${column})`);
  }
  return value.toLowerCase();
}

function textColumn(value: unknown, column: string, nullable: boolean): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw columnError("23502", `null value in column ${column}`);
  }
  if (typeof value !== "string") throw columnError("22P02", `invalid text (column ${column})`);
  return value;
}

function int4Column(value: unknown, column: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw columnError("22P02", `invalid input syntax for type integer (column ${column})`);
  }
  if (value < INT4_MIN || value > INT4_MAX) throw columnError("22003", `integer out of range (column ${column})`);
  return value;
}

function timestampColumn(value: unknown, column: string): string {
  if (value === null || value === undefined) throw columnError("23502", `null value in column ${column}`);
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) throw columnError("22007", `invalid timestamp (column ${column})`);
  return new Date(time).toISOString();
}

function jsonColumn(value: unknown, column: string, nullable: boolean): JsonValue {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw columnError("23502", `null value in column ${column}`);
  }
  try {
    return freezeJson(value);
  } catch {
    throw columnError("22P02", `invalid input syntax for type json (column ${column})`);
  }
}

/** Column types and NOT NULL, then CHECKs (as an INSERT or UPDATE would apply them). */
function normalizeEvidenceRow(row: EvidenceRow): EvidenceRow {
  const normalized: EvidenceRow = Object.freeze({
    id: uuidColumn(row.id, "id"),
    limiterInstanceId: uuidColumn(row.limiterInstanceId, "limiterInstanceId"),
    scope: textColumn(row.scope, "scope", false) as string,
    kind: textColumn(row.kind, "kind", false) as string,
    gapReason: textColumn(row.gapReason, "gapReason", true),
    firstSequence: int4Column(row.firstSequence, "firstSequence"),
    lastSequence: int4Column(row.lastSequence, "lastSequence"),
    missingFrom: int4Column(row.missingFrom, "missingFrom"),
    missingTo: int4Column(row.missingTo, "missingTo"),
    payload: jsonColumn(row.payload, "payload", false),
    recordSha256: textColumn(row.recordSha256, "recordSha256", false) as string,
    recordedAt: timestampColumn(row.recordedAt, "recordedAt"),
  });
  const check = violatedCheck(normalized);
  if (check !== null) {
    throw columnError("23514", `new row violates check constraint "${check}"`, check);
  }
  return normalized;
}

function normalizeRejectionRow(row: RejectionRow): RejectionRow {
  return Object.freeze({
    id: uuidColumn(row.id, "id"),
    actorType: textColumn(row.actorType, "actorType", false) as string,
    actorId: textColumn(row.actorId, "actorId", true),
    action: textColumn(row.action, "action", false) as string,
    entityType: textColumn(row.entityType, "entityType", false) as string,
    entityId: textColumn(row.entityId, "entityId", false) as string,
    metadata: jsonColumn(row.metadata, "metadata", true),
    createdAt: timestampColumn(row.createdAt, "createdAt"),
  });
}

/** Unique keys: the primary key, then the partial natural-key indexes. */
function uniqueViolation(row: EvidenceRow, rows: readonly EvidenceRow[], ignoreId?: string): string | null {
  const key = naturalKeyOf(row);
  for (const other of rows) {
    if (other.id === ignoreId) continue;
    if (other.id === row.id) return "RateLimitEvidence_pkey";
    if (key === null || other.limiterInstanceId !== row.limiterInstanceId) continue;
    const otherKey = naturalKeyOf(other);
    if (otherKey !== null && otherKey.index === key.index && otherKey.key === key.key) return key.index;
  }
  return null;
}

function assertUnique(row: EvidenceRow, rows: readonly EvidenceRow[], ignoreId?: string): void {
  const violation = uniqueViolation(row, rows, ignoreId);
  if (violation !== null) {
    throw columnError("23505", `duplicate key value violates unique constraint "${violation}"`, violation);
  }
}

function rowFromRecord(record: FrozenEvidenceRecord): EvidenceRow {
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
    payload: record.payload,
    recordSha256: record.recordSha256,
    recordedAt: record.recordedAt,
  };
}

/** The stored row for a record: by natural key within its instance, else by primary key. */
function existingFor(record: FrozenEvidenceRecord, rows: readonly EvidenceRow[]): EvidenceRow | undefined {
  const instance = record.limiterInstanceId.toLowerCase();
  const key = naturalKeyOf(record);
  if (key !== null) {
    const byKey = rows.find((row) => {
      if (row.limiterInstanceId !== instance) return false;
      const rowKey = naturalKeyOf(row);
      return rowKey !== null && rowKey.index === key.index && rowKey.key === key.key;
    });
    if (byKey !== undefined) return byKey;
  }
  const id = record.id.toLowerCase();
  return rows.find((row) => row.id === id);
}

/** §7.4 / §7.5 classification of one group record against a consistent view. */
function classifyGroupRecord(record: FrozenEvidenceRecord, rows: readonly EvidenceRow[]): WriteResult {
  const instance = record.limiterInstanceId.toLowerCase();
  const existing = existingFor(record, rows);
  const sealed = rows.some(
    (row) =>
      row.limiterInstanceId === instance &&
      row.kind === "EVIDENCE_GAP" &&
      row.gapReason === "UNCLEAN_TERMINATION",
  );
  if (sealed && isSealable(record)) {
    return existing !== undefined && isIdenticalRecord(existing, record) ? "IDENTICAL_EXISTS" : "SEALED";
  }
  if (existing !== undefined) return isIdenticalRecord(existing, record) ? "IDENTICAL_EXISTS" : "CONFLICT";
  const range = sequenceRangeOf(record);
  if (range !== null) {
    const overlaps = rows.some((row) => {
      if (row.limiterInstanceId !== instance) return false;
      const other = sequenceRangeOf(row);
      return other !== null && other.from <= range.to && other.to >= range.from;
    });
    if (overlaps) return "OVERLAP";
  }
  return "CREATED";
}

function copyRow<T>(row: T): T {
  return freezeJson(row) as unknown as T;
}

interface Waiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function waiter(): Waiter {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type PreFault =
  | {
      readonly kind: "FAIL";
      readonly methods: readonly EvidenceStoreMethod[] | null;
      readonly outcome: StoreWriteOutcome;
      remaining: number;
    }
  | {
      readonly kind: "HANG";
      readonly methods: readonly EvidenceStoreMethod[] | null;
      readonly reached: Waiter;
      readonly released: Waiter;
    };

type CommitFault =
  | { readonly kind: "THROW_BEFORE_COMMIT"; readonly methods: readonly EvidenceStoreMethod[] }
  | { readonly kind: "COMMIT_THEN_THROW"; readonly methods: readonly EvidenceStoreMethod[] }
  | {
      readonly kind: "DELAY_COMMIT";
      readonly methods: readonly EvidenceStoreMethod[];
      readonly reached: Waiter;
      readonly released: Waiter;
      thenThrow: boolean;
    };

interface Decision<T, I> {
  readonly result: T;
  /** Rows to insert at commit. */
  readonly inserts: readonly I[];
  /** True when the transaction is rolled back by a definitive result (no COMMIT). */
  readonly rollback: boolean;
}

/**
 * The in-memory store. `now` is the store's monotonic clock, used for the
 * verification deadline and the call log (default performance.now).
 *
 * Modelling choices (state-machine only): a lock request never waits on
 * time; verifyRegistration treats a lock that is held or queued as a lock
 * timeout (it throws), which the U3 classification reports STILL_UNKNOWN.
 */
export function createInMemoryEvidenceStore(
  options: { readonly now?: () => number } = {},
): InMemoryEvidenceStore {
  const now = options.now ?? (() => performance.now());
  let evidence: EvidenceRow[] = [];
  const rejections = new Map<string, RejectionRow>();
  const calls: StoreCall[] = [];
  const preFaults: PreFault[] = [];
  const commitFaults: CommitFault[] = [];
  const afterHooks: { readonly method: EvidenceStoreMethod; readonly hook: () => void | Promise<void> }[] = [];

  // Per-key FIFO mutex: a key has a tail while it is held or awaited.
  const tails = new Map<string, Promise<void>>();
  async function acquire(key: string): Promise<() => void> {
    const previous = tails.get(key) ?? Promise.resolve();
    const mine = waiter();
    const tail = previous.then(() => mine.promise);
    tails.set(key, tail);
    await previous;
    return () => {
      if (tails.get(key) === tail) tails.delete(key);
      mine.resolve();
    };
  }

  function matches(methods: readonly EvidenceStoreMethod[] | null, method: EvidenceStoreMethod): boolean {
    return methods === null || methods.includes(method);
  }

  async function beforeCall(method: EvidenceStoreMethod, kinds: readonly string[]): Promise<void> {
    calls.push(Object.freeze({ method, at: now(), kinds: Object.freeze([...kinds]) }));
    // Every call yields before acting, as a real store would.
    await Promise.resolve();
    const index = preFaults.findIndex((fault) => matches(fault.methods, method));
    if (index === -1) return;
    const fault = preFaults[index] as PreFault;
    if (fault.kind === "HANG") {
      preFaults.splice(index, 1);
      fault.reached.resolve();
      await fault.released.promise;
      return;
    }
    fault.remaining -= 1;
    if (fault.remaining <= 0) preFaults.splice(index, 1);
    throw new InMemoryStoreError("injected store failure", fault.outcome);
  }

  async function afterCall(method: EvidenceStoreMethod): Promise<void> {
    const index = afterHooks.findIndex((entry) => entry.method === method);
    if (index === -1) return;
    const [entry] = afterHooks.splice(index, 1);
    await entry?.hook();
  }

  function takeCommitFault(method: EvidenceStoreMethod): CommitFault | undefined {
    const index = commitFaults.findIndex((fault) => fault.methods.includes(method));
    if (index === -1) return undefined;
    return commitFaults.splice(index, 1)[0];
  }

  /** A locked evidence transaction: decide on a consistent view, then commit (with commit faults). */
  async function lockedWrite<T, I>(
    method: EvidenceStoreMethod,
    lockKey: string,
    decide: () => Decision<T, I>,
    apply: (inserts: readonly I[]) => void,
  ): Promise<T> {
    const release = await acquire(lockKey);
    try {
      const decision = decide();
      if (decision.rollback) return decision.result;
      const fault = takeCommitFault(method);
      if (fault?.kind === "THROW_BEFORE_COMMIT") {
        throw new InMemoryStoreError("injected failure before commit", "NOT_COMMITTED");
      }
      let thenThrow = fault?.kind === "COMMIT_THEN_THROW";
      if (fault?.kind === "DELAY_COMMIT") {
        fault.reached.resolve();
        await fault.released.promise;
        thenThrow = fault.thenThrow;
      }
      apply(decision.inserts);
      if (thenThrow) throw new InMemoryStoreError("injected lost acknowledgement", "UNKNOWN");
      return decision.result;
    } finally {
      release();
    }
  }

  function applyEvidence(inserts: readonly EvidenceRow[]): void {
    // Re-validated at commit: out-of-protocol changes take no lock.
    const next = [...evidence];
    for (const row of inserts) {
      assertUnique(row, next);
      next.push(row);
    }
    evidence = next;
  }

  const store: InMemoryEvidenceStore = {
    async findRecoveryCandidates(scope, excludeInstanceId) {
      await beforeCall("findRecoveryCandidates", []);
      const excluded = excludeInstanceId.toLowerCase();
      const closed = new Set(
        evidence.filter((row) => row.kind === "INSTANCE_CLOSED").map((row) => row.limiterInstanceId),
      );
      const unclean = new Set(
        evidence
          .filter((row) => row.kind === "EVIDENCE_GAP" && row.gapReason === "UNCLEAN_TERMINATION")
          .map((row) => row.limiterInstanceId),
      );
      const candidates = evidence
        .filter(
          (row) =>
            row.kind === "INSTANCE_STARTED" &&
            row.scope === scope &&
            row.limiterInstanceId !== excluded &&
            !closed.has(row.limiterInstanceId),
        )
        .map((row) => row.limiterInstanceId)
        .sort()
        .map((limiterInstanceId) =>
          Object.freeze({ limiterInstanceId, hasUncleanGap: unclean.has(limiterInstanceId) }),
        );
      await afterCall("findRecoveryCandidates");
      return Object.freeze(candidates);
    },

    async readDurableState(limiterInstanceId) {
      await beforeCall("readDurableState", []);
      const state = durableStateFromRows(limiterInstanceId.toLowerCase(), evidence);
      await afterCall("readDurableState");
      return state;
    },

    async writeUncleanGap(gap, derivedFrom) {
      await beforeCall("writeUncleanGap", [gap.kind]);
      if (
        gap.kind !== "EVIDENCE_GAP" ||
        gap.gapReason !== "UNCLEAN_TERMINATION" ||
        gap.limiterInstanceId.toLowerCase() !== derivedFrom.limiterInstanceId.toLowerCase()
      ) {
        throw new TypeError("writeUncleanGap: not an unclean-termination gap for the derived instance");
      }
      const instance = gap.limiterInstanceId.toLowerCase();
      const result = await lockedWrite<WriteResult, EvidenceRow>(
        "writeUncleanGap",
        instance,
        () => {
          const none = (value: WriteResult): Decision<WriteResult, EvidenceRow> => ({ result: value, inserts: [], rollback: false });
          // (1a) close check, (1) existing gap, (2) durable-state re-check, (3) insert.
          if (evidence.some((row) => row.limiterInstanceId === instance && row.kind === "INSTANCE_CLOSED")) {
            return none("CLOSED_EXISTS");
          }
          const existing = existingFor(gap, evidence);
          if (existing !== undefined) return none(isIdenticalRecord(existing, gap) ? "IDENTICAL_EXISTS" : "CONFLICT");
          if (!sameDurableState(durableStateFromRows(instance, evidence), derivedFrom)) return none("STALE_STATE");
          const row = normalizeEvidenceRow(rowFromRecord(gap));
          assertUnique(row, evidence);
          return { result: "CREATED", inserts: [row], rollback: false };
        },
        applyEvidence,
      );
      await afterCall("writeUncleanGap");
      return result;
    },

    async validateHistoricalGap(limiterInstanceId, scope) {
      await beforeCall("validateHistoricalGap", []);
      const instance = limiterInstanceId.toLowerCase();
      const release = await acquire(instance);
      let verdict: HistoricalGapVerdict;
      try {
        verdict = historicalGapVerdict(instance, scope, evidence);
      } finally {
        release();
      }
      await afterCall("validateHistoricalGap");
      return verdict;
    },

    async writeEvidenceGroup(records) {
      await beforeCall(
        "writeEvidenceGroup",
        records.map((record) => record.kind),
      );
      const first = records[0];
      if (first === undefined) throw new TypeError("writeEvidenceGroup: empty group");
      const instance = first.limiterInstanceId.toLowerCase();
      if (records.some((record) => record.limiterInstanceId.toLowerCase() !== instance)) {
        throw new TypeError("writeEvidenceGroup: a group belongs to one instance");
      }
      const results = await lockedWrite<readonly WriteResult[], EvidenceRow>(
        "writeEvidenceGroup",
        instance,
        () => {
          const staged: EvidenceRow[] = [];
          const outcome: WriteResult[] = [];
          for (const record of records) {
            const view = [...evidence, ...staged];
            const result = classifyGroupRecord(record, view);
            if (result === "CREATED") {
              const row = normalizeEvidenceRow(rowFromRecord(record));
              assertUnique(row, view);
              staged.push(row);
            }
            outcome.push(result);
          }
          const rollback = outcome.some(
            (result) => result === "CONFLICT" || result === "OVERLAP" || result === "SEALED",
          );
          return { result: Object.freeze(outcome), inserts: rollback ? [] : staged, rollback };
        },
        applyEvidence,
      );
      await afterCall("writeEvidenceGroup");
      return results;
    },

    async writeRejections(records) {
      await beforeCall(
        "writeRejections",
        records.map(() => "EVENT_REJECTED"),
      );
      const results = await lockedWrite<readonly WriteResult[], RejectionRow>(
        "writeRejections",
        REJECTIONS_LOCK,
        () => {
          const staged = new Map<string, RejectionRow>();
          const outcome: WriteResult[] = [];
          for (const record of records) {
            const incoming = normalizeRejectionRow(record as unknown as RejectionRow);
            const existing = staged.get(incoming.id) ?? rejections.get(incoming.id);
            if (existing !== undefined) {
              outcome.push(
                rejectionRowCanonical(existing) === rejectionRowCanonical(record) ? "IDENTICAL_EXISTS" : "CONFLICT",
              );
              continue;
            }
            staged.set(incoming.id, incoming);
            outcome.push("CREATED");
          }
          return {
            result: Object.freeze(outcome),
            inserts: [...staged.values()],
            rollback: false,
          };
        },
        (inserts) => {
          for (const row of inserts) {
            if (rejections.has(row.id)) {
              throw columnError("23505", 'duplicate key value violates unique constraint "AuditEntry_pkey"', "AuditEntry_pkey");
            }
          }
          for (const row of inserts) rejections.set(row.id, row);
        },
      );
      await afterCall("writeRejections");
      return results;
    },

    async verifyRegistration(limiterInstanceId, deadline) {
      await beforeCall("verifyRegistration", []);
      if (now() >= deadline) {
        throw new InMemoryStoreError("the verification deadline was reached", "NOT_COMMITTED");
      }
      const instance = limiterInstanceId.toLowerCase();
      if (tails.has(instance)) {
        throw new InMemoryStoreError("lock timeout (modelled: the instance lock is held)", "NOT_COMMITTED");
      }
      const release = await acquire(instance);
      let present: boolean;
      try {
        present = evidence.some((row) => row.limiterInstanceId === instance && row.kind === "INSTANCE_STARTED");
      } finally {
        release();
      }
      await afterCall("verifyRegistration");
      return Object.freeze({ present });
    },

    faults: {
      failNext(count, faultOptions = {}) {
        if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("failNext: count must be >= 1");
        preFaults.push({
          kind: "FAIL",
          methods: faultOptions.methods ?? null,
          outcome: faultOptions.outcome ?? "NOT_COMMITTED",
          remaining: count,
        });
      },
      throwBeforeCommit(faultOptions = {}) {
        commitFaults.push({ kind: "THROW_BEFORE_COMMIT", methods: faultOptions.methods ?? WRITE_METHODS });
      },
      commitThenThrow(faultOptions = {}) {
        commitFaults.push({ kind: "COMMIT_THEN_THROW", methods: faultOptions.methods ?? WRITE_METHODS });
      },
      delayCommit(faultOptions = {}) {
        const fault: CommitFault & { kind: "DELAY_COMMIT" } = {
          kind: "DELAY_COMMIT",
          methods: faultOptions.methods ?? WRITE_METHODS,
          reached: waiter(),
          released: waiter(),
          thenThrow: false,
        };
        commitFaults.push(fault);
        return {
          reached: fault.reached.promise,
          release(releaseOptions = {}) {
            fault.thenThrow = releaseOptions.thenThrow === true;
            fault.released.resolve();
          },
        };
      },
      hang(faultOptions = {}) {
        const fault: PreFault & { kind: "HANG" } = {
          kind: "HANG",
          methods: faultOptions.methods ?? null,
          reached: waiter(),
          released: waiter(),
        };
        preFaults.push(fault);
        return { reached: fault.reached.promise, release: () => fault.released.resolve() };
      },
      afterCall(method, hook) {
        afterHooks.push({ method, hook });
      },
    },

    raw: {
      evidenceRows(limiterInstanceId) {
        const instance = limiterInstanceId?.toLowerCase();
        return Object.freeze(
          evidence.filter((row) => instance === undefined || row.limiterInstanceId === instance).map(copyRow),
        );
      },
      rejectionRow(id) {
        const row = rejections.get(id.toLowerCase());
        return row === undefined ? null : copyRow(row);
      },
      rejectionRows() {
        return Object.freeze([...rejections.values()].map(copyRow));
      },
      seedEvidence(row) {
        const normalized = normalizeEvidenceRow(row);
        assertUnique(normalized, evidence);
        evidence = [...evidence, normalized];
      },
      seedRejection(row) {
        const normalized = normalizeRejectionRow(row);
        if (rejections.has(normalized.id)) {
          throw columnError("23505", 'duplicate key value violates unique constraint "AuditEntry_pkey"', "AuditEntry_pkey");
        }
        rejections.set(normalized.id, normalized);
      },
      alterOutsideProtocol(id, changes) {
        const target = id.toLowerCase();
        const index = evidence.findIndex((row) => row.id === target);
        if (index === -1) throw new RangeError("alterOutsideProtocol: no such row");
        const updated = normalizeEvidenceRow({ ...(evidence[index] as EvidenceRow), ...changes, id: target });
        assertUnique(updated, evidence, target);
        evidence = evidence.map((row, position) => (position === index ? updated : row));
      },
    },

    get calls() {
      return Object.freeze([...calls]);
    },
  };
  return store;
}
