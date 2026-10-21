/**
 * Task 011A evidence records (design Revision 1.4 §6.2, §7.2, §7.3; AN4).
 *
 * Pure: types, canonical JSON, the complete-record hash, freeze helpers,
 * payload readers, audit folding and evidence-summary merging. No I/O, no
 * clock and no randomness: every id and timestamp is supplied by the
 * caller, so a frozen record can be rebuilt byte for byte in a test.
 *
 * Error messages name the offending field or value kind only, never a
 * value: these records carry evidence, and messages may reach logs.
 */
import { createHash } from "node:crypto";
import { mergeSummaries } from "./rate-limit.js";
import type { Counters, Layer, LayerCounters, RateLimitSummary } from "./rate-limit.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Recorder counters (§6.2). Defined here, beside the snapshot that carries
// them; the recorder module re-exports them.

export interface AuditRecorderCounters {
  /** Candidates received by submit() before FINALIZED. */
  readonly submitted: number;
  /** Subset of submitted with responseCompletion FINISH_OBSERVED. */
  readonly finishObserved: number;
  /** Subset of submitted with responseCompletion CLOSE_BEFORE_FINISH. */
  readonly closeBeforeFinish: number;
  /** ROUTER / NOT_FOUND candidates (AD-3). */
  readonly ineligibleNonWebhook: number;
  /** Refused by the global write bucket. */
  readonly suppressedByCeiling: number;
  /** Refused because the queue was full. */
  readonly droppedQueueFull: number;
  /** Frozen and enqueued. */
  readonly admitted: number;
  /** Store confirmed CREATED or IDENTICAL_EXISTS. */
  readonly persisted: number;
  /** Store reported the same id with different content; never overwritten. */
  readonly conflicts: number;
  /** Removed from the queue at finalize; never sent to the store. */
  readonly notAttemptedAtShutdown: number;
  /** Removed from the queue at finalize; sent at least once, never confirmed. */
  readonly outcomeUnknownAtShutdown: number;
  /** Internal exceptions caught inside submit() or the writer. */
  readonly sinkFaults: number;
}

export interface AuditRecorderGauges {
  readonly queueDepth: number;
  readonly queueCapacity: number;
}

export const AUDIT_COUNTER_FIELDS: readonly (keyof AuditRecorderCounters)[] = Object.freeze([
  "submitted",
  "finishObserved",
  "closeBeforeFinish",
  "ineligibleNonWebhook",
  "suppressedByCeiling",
  "droppedQueueFull",
  "admitted",
  "persisted",
  "conflicts",
  "notAttemptedAtShutdown",
  "outcomeUnknownAtShutdown",
  "sinkFaults",
]);

export const ZERO_AUDIT_COUNTERS: AuditRecorderCounters = Object.freeze({
  submitted: 0,
  finishObserved: 0,
  closeBeforeFinish: 0,
  ineligibleNonWebhook: 0,
  suppressedByCeiling: 0,
  droppedQueueFull: 0,
  admitted: 0,
  persisted: 0,
  conflicts: 0,
  notAttemptedAtShutdown: 0,
  outcomeUnknownAtShutdown: 0,
  sinkFaults: 0,
});

export function sumAuditCounters(
  a: AuditRecorderCounters,
  b: AuditRecorderCounters,
): AuditRecorderCounters {
  const sum: Record<string, number> = {};
  for (const field of AUDIT_COUNTER_FIELDS) sum[field] = a[field] + b[field];
  return Object.freeze(sum as unknown as AuditRecorderCounters);
}

// ---------------------------------------------------------------------------
// Snapshots and summaries (§7.1, §7.2)

/** The single return type of recorder control.drainCounters(). */
export interface AuditRecorderSnapshot {
  /** ISO, wall clock at the previous snapshot (or recorder creation). */
  readonly intervalStartedAt: string;
  /** ISO, wall clock at this snapshot. */
  readonly intervalEndedAt: string;
  /** Since the previous snapshot; summed on fold and merge. */
  readonly delta: AuditRecorderCounters;
  /** Since recorder creation; carried forward from the later snapshot. */
  readonly cumulative: AuditRecorderCounters;
  /** At this snapshot; carried forward from the later snapshot. */
  readonly gauges: AuditRecorderGauges;
}

export type EvidenceAlignment = "ALIGNED" | "UNVERIFIED";

export interface EvidenceSummary {
  readonly schemaVersion: 1;
  /** Exactly as defined by Task 011B §9.2. */
  readonly rateLimit: RateLimitSummary;
  readonly audit: AuditRecorderSnapshot;
  /** Delta; summed on merge. */
  readonly pairingFaults: number;
  /** ALIGNED only for a contiguous (S-A) summary; merge yields UNVERIFIED if either input is. */
  readonly alignment: EvidenceAlignment;
}

/** Distinct from Task 011B's MergeResult, which is unchanged. */
export type EvidenceMergeResult =
  | { readonly ok: true; readonly summary: EvidenceSummary }
  | { readonly ok: false; readonly reason: "INSTANCE_MISMATCH" | "NOT_CONTIGUOUS" };

/** intervalStartedAt from a; intervalEndedAt from b; delta summed; cumulative and gauges from b. */
export function foldAudit(
  a: AuditRecorderSnapshot,
  b: AuditRecorderSnapshot,
): AuditRecorderSnapshot {
  return Object.freeze({
    intervalStartedAt: a.intervalStartedAt,
    intervalEndedAt: b.intervalEndedAt,
    delta: sumAuditCounters(a.delta, b.delta),
    cumulative: Object.freeze({ ...b.cumulative }),
    gauges: Object.freeze({ ...b.gauges }),
  });
}

/** Never merges across instances or gaps (Task 011B mergeSummaries decides). */
export function mergeEvidenceSummaries(
  a: EvidenceSummary,
  b: EvidenceSummary,
): EvidenceMergeResult {
  const merged = mergeSummaries(a.rateLimit, b.rateLimit);
  if (!merged.ok) return Object.freeze({ ok: false, reason: merged.reason });
  const summary: EvidenceSummary = Object.freeze({
    schemaVersion: 1,
    rateLimit: merged.summary,
    audit: foldAudit(a.audit, b.audit),
    pairingFaults: a.pairingFaults + b.pairingFaults,
    alignment:
      a.alignment === "ALIGNED" && b.alignment === "ALIGNED" ? "ALIGNED" : "UNVERIFIED",
  });
  return Object.freeze({ ok: true, summary });
}

// ---------------------------------------------------------------------------
// Record types (§7.2) and payloads (§7.3)

export type EvidenceKind = "INSTANCE_STARTED" | "SUMMARY" | "EVIDENCE_GAP" | "INSTANCE_CLOSED";
export type GapReason = "SEQUENCE_DISCONTINUITY" | "UNCLEAN_TERMINATION";
export type GapCause = "SEQUENCE_DISCONTINUITY" | "DRAIN_CONTRACT_VIOLATION";

/** Complete content fixed before the first write attempt; never rebuilt. */
export interface FrozenEvidenceRecord {
  /** App-assigned UUID (lowercase) at freeze time. */
  readonly id: string;
  readonly limiterInstanceId: string;
  /** AD-8. */
  readonly scope: string;
  readonly kind: EvidenceKind;
  readonly gapReason: GapReason | null;
  /** SUMMARY. */
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  /** EVIDENCE_GAP (discontinuity). */
  readonly missingFrom: number | null;
  readonly missingTo: number | null;
  /** ISO 8601 UTC with exactly millisecond precision, fixed at freeze. */
  readonly recordedAt: string;
  readonly payload: JsonValue;
  /** Lowercase hex SHA-256 of canonicalJson(every other field). */
  readonly recordSha256: string;
}

export type EvidenceRecordFields = Omit<FrozenEvidenceRecord, "recordSha256">;

export interface InstanceStartedPayload {
  readonly schemaVersion: 1;
  readonly limiterInstanceId: string;
  readonly instanceStartedAt: string;
  readonly scope: string;
  readonly rateLimitPolicies: JsonValue;
  readonly auditPolicies: JsonValue;
}

export interface DerivedMissingDelta {
  readonly rateLimit: Counters | "NOT_DERIVABLE";
  readonly audit: "NOT_ATTRIBUTABLE";
}

export interface DiscontinuityGapPayload {
  readonly schemaVersion: 1;
  readonly missingFrom: number;
  readonly missingTo: number;
  readonly initial: boolean;
  readonly cause: GapCause;
  readonly derivedMissingDelta: DerivedMissingDelta;
  readonly distinctKeys: "UNKNOWN";
  readonly detectedAt: string;
}

/** Both counter families as of one summary (an unclean gap's durable facts, a close record). */
export interface CumulativeFamilies {
  readonly rateLimit: Counters;
  readonly audit: AuditRecorderCounters;
}

export interface UncleanGapPayload {
  readonly schemaVersion: 1;
  readonly lastDurableSequence: number;
  readonly cumulativeAsOfLastDurable: CumulativeFamilies | null;
  readonly detectedAt: string;
  readonly detectedByInstanceId: string;
}

export interface InstanceClosedPayload {
  readonly schemaVersion: 1;
  readonly finalSequence: number;
  readonly cumulative: CumulativeFamilies;
  readonly forcedClose: boolean;
  readonly closedAt: string;
}

/** AuditEntry metadata of an EVENT_REJECTED row (§5.4). */
export interface RejectionMetadata {
  readonly schemaVersion: 1;
  readonly limiterInstanceId: string;
  readonly stage: string;
  readonly httpStatus: number;
  readonly errorCode: string;
  readonly claimedIntegrationId: string | null;
  readonly verifierReason: string | null;
  readonly responseCompletion: string;
  readonly receivedAt: string;
}

/** One EVENT_REJECTED AuditEntry row (§5.4): all 8 columns, frozen at admission. */
export interface FrozenRejectionRecord {
  /** requestId. */
  readonly id: string;
  readonly actorType: "EXTERNAL_SENDER";
  readonly actorId: null;
  readonly action: "EVENT_REJECTED";
  readonly entityType: "WEBHOOK_DELIVERY";
  /** requestId. */
  readonly entityId: string;
  readonly metadata: RejectionMetadata;
  /** Frozen admission time; never the column default. */
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON and the complete-record hash (§7.2)

/**
 * Object keys sorted by UTF-16 code unit at every depth; no insignificant
 * whitespace; strings and numbers rendered by JSON.stringify. Accepts only
 * JSON values built from plain objects and arrays: undefined, functions,
 * symbols, bigints, non-finite numbers, unsafe integers, sparse arrays,
 * cycles and non-plain objects (Date included) throw a TypeError.
 */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value, new Set<object>());
}

function writeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new TypeError("canonicalJson: unsafe integer");
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) throw new TypeError("canonicalJson: cycle");
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) throw new TypeError("canonicalJson: sparse array");
            parts.push(writeCanonical(value[index], ancestors));
          }
          return `[${parts.join(",")}]`;
        }
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("canonicalJson: non-plain object");
        }
        const record = value as Record<string, unknown>;
        // Default sort compares UTF-16 code units.
        const keys = Object.keys(record).sort();
        const parts = keys.map((key) => {
          const member = record[key];
          if (member === undefined) throw new TypeError("canonicalJson: undefined member");
          return `${JSON.stringify(key)}:${writeCanonical(member, ancestors)}`;
        });
        return `{${parts.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The complete-record hash: SHA-256 of canonicalJson over exactly the 11
 * persisted fields other than recordSha256. Extra properties are ignored.
 */
export function recordHash(record: EvidenceRecordFields): string {
  return sha256Hex(
    canonicalJson({
      id: record.id,
      limiterInstanceId: record.limiterInstanceId,
      scope: record.scope,
      kind: record.kind,
      gapReason: record.gapReason,
      firstSequence: record.firstSequence,
      lastSequence: record.lastSequence,
      missingFrom: record.missingFrom,
      missingTo: record.missingTo,
      recordedAt: record.recordedAt,
      payload: record.payload,
    }),
  );
}

/** Canonical text of all 8 AuditEntry columns: the rejection comparison unit (§9.3). */
export function rejectionRowCanonical(record: {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly metadata: JsonValue | RejectionMetadata | null;
  readonly createdAt: string;
}): string {
  return canonicalJson({
    id: record.id,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    metadata: record.metadata,
    createdAt: record.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Value checks shared by the freeze helpers, the readers and the stores

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Lowercase canonical UUID text, as PostgreSQL returns it. */
export function isLowerUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_LOWER.test(value);
}

/** YYYY-MM-DDTHH:mm:ss.sssZ that round-trips through Date unchanged. */
export function isIsoMillis(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_MILLIS.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const LAYERS: readonly Layer[] = ["L1", "L2", "L3"];
const LAYER_FIELDS: readonly (keyof LayerCounters)[] = [
  "limited",
  "limitedPrecheck",
  "limitedConverted",
  "limitedViaOverflow",
  "overflowAdmissions",
  "individualRejections",
];

/** Exactly the Task 011B Counters shape, every value a non-negative safe integer. */
export function isRateLimitCounters(value: unknown): value is Counters {
  if (!isObject(value)) return false;
  if (!hasExactKeys(value, ["layers", "abortedBeforeResponse", "limiterFaults", "logLinesSuppressed"])) {
    return false;
  }
  const layers = value.layers;
  if (!isObject(layers) || !hasExactKeys(layers, LAYERS)) return false;
  for (const layer of LAYERS) {
    const counters = layers[layer];
    if (!isObject(counters) || !hasExactKeys(counters, LAYER_FIELDS)) return false;
    if (!LAYER_FIELDS.every((field) => isCount(counters[field]))) return false;
  }
  return (
    isCount(value.abortedBeforeResponse) &&
    isCount(value.limiterFaults) &&
    isCount(value.logLinesSuppressed)
  );
}

/** Exactly the AuditRecorderCounters shape, every value a non-negative safe integer. */
export function isAuditCounters(value: unknown): value is AuditRecorderCounters {
  return (
    isObject(value) &&
    hasExactKeys(value, AUDIT_COUNTER_FIELDS) &&
    AUDIT_COUNTER_FIELDS.every((field) => isCount(value[field]))
  );
}

function isCumulativeFamilies(value: unknown): value is CumulativeFamilies {
  return (
    isObject(value) &&
    hasExactKeys(value, ["rateLimit", "audit"]) &&
    isRateLimitCounters(value.rateLimit) &&
    isAuditCounters(value.audit)
  );
}

// ---------------------------------------------------------------------------
// Freezing

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

/** A deep, frozen, JSON-only copy; throws a TypeError for anything canonicalJson rejects. */
export function freezeJson(value: unknown): JsonValue {
  return deepFreeze(JSON.parse(canonicalJson(value)) as JsonValue);
}

/**
 * Low-level: copies exactly the 11 fields, deep-copies the payload, computes
 * recordSha256 and deep-freezes. Performs no semantic validation, so a test
 * can build a malformed record for the shape constraints (A-T20); the
 * kind-specific freeze helpers below validate first.
 */
export function buildEvidenceRecord(fields: EvidenceRecordFields): FrozenEvidenceRecord {
  const subject: EvidenceRecordFields = {
    id: fields.id,
    limiterInstanceId: fields.limiterInstanceId,
    scope: fields.scope,
    kind: fields.kind,
    gapReason: fields.gapReason,
    firstSequence: fields.firstSequence,
    lastSequence: fields.lastSequence,
    missingFrom: fields.missingFrom,
    missingTo: fields.missingTo,
    recordedAt: fields.recordedAt,
    payload: freezeJson(fields.payload),
  };
  return Object.freeze({ ...subject, recordSha256: recordHash(subject) });
}

function invalid(field: string): never {
  throw new TypeError(`invalid evidence record: ${field}`);
}

interface RecordIdentity {
  readonly id: string;
  readonly limiterInstanceId: string;
  readonly scope: string;
  readonly recordedAt: string;
}

function checkIdentity(input: RecordIdentity): void {
  if (!isLowerUuid(input.id)) invalid("id");
  if (!isLowerUuid(input.limiterInstanceId)) invalid("limiterInstanceId");
  if (typeof input.scope !== "string" || input.scope.length === 0) invalid("scope");
  if (!isIsoMillis(input.recordedAt)) invalid("recordedAt");
}

export function freezeInstanceStarted(
  input: RecordIdentity & {
    readonly instanceStartedAt: string;
    readonly rateLimitPolicies: unknown;
    readonly auditPolicies: unknown;
  },
): FrozenEvidenceRecord {
  checkIdentity(input);
  if (!isIsoMillis(input.instanceStartedAt)) invalid("instanceStartedAt");
  const payload: InstanceStartedPayload = {
    schemaVersion: 1,
    limiterInstanceId: input.limiterInstanceId,
    instanceStartedAt: input.instanceStartedAt,
    scope: input.scope,
    rateLimitPolicies: freezeJson(input.rateLimitPolicies),
    auditPolicies: freezeJson(input.auditPolicies),
  };
  return buildEvidenceRecord({
    id: input.id,
    limiterInstanceId: input.limiterInstanceId,
    scope: input.scope,
    kind: "INSTANCE_STARTED",
    gapReason: null,
    firstSequence: null,
    lastSequence: null,
    missingFrom: null,
    missingTo: null,
    recordedAt: input.recordedAt,
    payload: payload as unknown as JsonValue,
  });
}

/** The SUMMARY payload is the EvidenceSummary itself; its range and instance come from rateLimit. */
export function freezeSummary(input: {
  readonly id: string;
  readonly scope: string;
  readonly recordedAt: string;
  readonly summary: EvidenceSummary;
}): FrozenEvidenceRecord {
  const { summary } = input;
  const rateLimit = summary.rateLimit;
  checkIdentity({ ...input, limiterInstanceId: rateLimit.limiterInstanceId });
  if (summary.schemaVersion !== 1) invalid("summary.schemaVersion");
  if (!isPositiveSequence(rateLimit.firstSequence)) invalid("summary.firstSequence");
  if (!isPositiveSequence(rateLimit.lastSequence) || rateLimit.lastSequence < rateLimit.firstSequence) {
    invalid("summary.lastSequence");
  }
  if (summary.alignment !== "ALIGNED" && summary.alignment !== "UNVERIFIED") invalid("summary.alignment");
  if (!isCount(summary.pairingFaults)) invalid("summary.pairingFaults");
  return buildEvidenceRecord({
    id: input.id,
    limiterInstanceId: rateLimit.limiterInstanceId,
    scope: input.scope,
    kind: "SUMMARY",
    gapReason: null,
    firstSequence: rateLimit.firstSequence,
    lastSequence: rateLimit.lastSequence,
    missingFrom: null,
    missingTo: null,
    recordedAt: input.recordedAt,
    payload: summary as unknown as JsonValue,
  });
}

export function freezeDiscontinuityGap(
  input: RecordIdentity & {
    readonly missingFrom: number;
    readonly missingTo: number;
    readonly initial: boolean;
    readonly cause: GapCause;
    readonly rateLimitDelta: Counters | "NOT_DERIVABLE";
    readonly detectedAt: string;
  },
): FrozenEvidenceRecord {
  checkIdentity(input);
  if (!isPositiveSequence(input.missingFrom)) invalid("missingFrom");
  if (!isPositiveSequence(input.missingTo) || input.missingTo < input.missingFrom) invalid("missingTo");
  if (typeof input.initial !== "boolean") invalid("initial");
  if (input.cause !== "SEQUENCE_DISCONTINUITY" && input.cause !== "DRAIN_CONTRACT_VIOLATION") invalid("cause");
  if (input.rateLimitDelta !== "NOT_DERIVABLE" && !isRateLimitCounters(input.rateLimitDelta)) {
    invalid("rateLimitDelta");
  }
  if (!isIsoMillis(input.detectedAt)) invalid("detectedAt");
  const payload: DiscontinuityGapPayload = {
    schemaVersion: 1,
    missingFrom: input.missingFrom,
    missingTo: input.missingTo,
    initial: input.initial,
    cause: input.cause,
    derivedMissingDelta: { rateLimit: input.rateLimitDelta, audit: "NOT_ATTRIBUTABLE" },
    distinctKeys: "UNKNOWN",
    detectedAt: input.detectedAt,
  };
  return buildEvidenceRecord({
    id: input.id,
    limiterInstanceId: input.limiterInstanceId,
    scope: input.scope,
    kind: "EVIDENCE_GAP",
    gapReason: "SEQUENCE_DISCONTINUITY",
    firstSequence: null,
    lastSequence: null,
    missingFrom: input.missingFrom,
    missingTo: input.missingTo,
    recordedAt: input.recordedAt,
    payload: payload as unknown as JsonValue,
  });
}

export function freezeUncleanGap(
  input: RecordIdentity & {
    readonly lastDurableSequence: number;
    readonly cumulativeAsOfLastDurable: CumulativeFamilies | null;
    readonly detectedAt: string;
    readonly detectedByInstanceId: string;
  },
): FrozenEvidenceRecord {
  checkIdentity(input);
  if (!isCount(input.lastDurableSequence)) invalid("lastDurableSequence");
  if (input.cumulativeAsOfLastDurable !== null && !isCumulativeFamilies(input.cumulativeAsOfLastDurable)) {
    invalid("cumulativeAsOfLastDurable");
  }
  if ((input.lastDurableSequence === 0) !== (input.cumulativeAsOfLastDurable === null)) {
    invalid("cumulativeAsOfLastDurable");
  }
  if (!isIsoMillis(input.detectedAt)) invalid("detectedAt");
  if (!isLowerUuid(input.detectedByInstanceId) || input.detectedByInstanceId === input.limiterInstanceId) {
    invalid("detectedByInstanceId");
  }
  const payload: UncleanGapPayload = {
    schemaVersion: 1,
    lastDurableSequence: input.lastDurableSequence,
    cumulativeAsOfLastDurable: input.cumulativeAsOfLastDurable,
    detectedAt: input.detectedAt,
    detectedByInstanceId: input.detectedByInstanceId,
  };
  return buildEvidenceRecord({
    id: input.id,
    limiterInstanceId: input.limiterInstanceId,
    scope: input.scope,
    kind: "EVIDENCE_GAP",
    gapReason: "UNCLEAN_TERMINATION",
    firstSequence: null,
    lastSequence: null,
    missingFrom: null,
    missingTo: null,
    recordedAt: input.recordedAt,
    payload: payload as unknown as JsonValue,
  });
}

export function freezeInstanceClosed(
  input: RecordIdentity & {
    readonly finalSequence: number;
    readonly cumulative: CumulativeFamilies;
    readonly forcedClose: boolean;
    readonly closedAt: string;
  },
): FrozenEvidenceRecord {
  checkIdentity(input);
  if (!isPositiveSequence(input.finalSequence)) invalid("finalSequence");
  if (!isCumulativeFamilies(input.cumulative)) invalid("cumulative");
  if (typeof input.forcedClose !== "boolean") invalid("forcedClose");
  if (!isIsoMillis(input.closedAt)) invalid("closedAt");
  const payload: InstanceClosedPayload = {
    schemaVersion: 1,
    finalSequence: input.finalSequence,
    cumulative: input.cumulative,
    forcedClose: input.forcedClose,
    closedAt: input.closedAt,
  };
  return buildEvidenceRecord({
    id: input.id,
    limiterInstanceId: input.limiterInstanceId,
    scope: input.scope,
    kind: "INSTANCE_CLOSED",
    gapReason: null,
    firstSequence: null,
    lastSequence: null,
    missingFrom: null,
    missingTo: null,
    recordedAt: input.recordedAt,
    payload: payload as unknown as JsonValue,
  });
}

/** Deep-frozen copy of an EVENT_REJECTED row; validates the key and the frozen time. */
export function buildRejectionRecord(fields: FrozenRejectionRecord): FrozenRejectionRecord {
  if (!isLowerUuid(fields.id)) invalid("id");
  if (!isIsoMillis(fields.createdAt)) invalid("createdAt");
  return Object.freeze({
    id: fields.id,
    actorType: fields.actorType,
    actorId: fields.actorId,
    action: fields.action,
    entityType: fields.entityType,
    entityId: fields.entityId,
    metadata: freezeJson(fields.metadata) as unknown as RejectionMetadata,
    createdAt: fields.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Missing-range rate-limit delta (§7.3)

function subtractCounters(a: Counters, b: Counters): Counters {
  const layer = (x: LayerCounters, y: LayerCounters): LayerCounters => ({
    limited: x.limited - y.limited,
    limitedPrecheck: x.limitedPrecheck - y.limitedPrecheck,
    limitedConverted: x.limitedConverted - y.limitedConverted,
    limitedViaOverflow: x.limitedViaOverflow - y.limitedViaOverflow,
    overflowAdmissions: x.overflowAdmissions - y.overflowAdmissions,
    individualRejections: x.individualRejections - y.individualRejections,
  });
  return {
    layers: {
      L1: layer(a.layers.L1, b.layers.L1),
      L2: layer(a.layers.L2, b.layers.L2),
      L3: layer(a.layers.L3, b.layers.L3),
    },
    abortedBeforeResponse: a.abortedBeforeResponse - b.abortedBeforeResponse,
    limiterFaults: a.limiterFaults - b.limiterFaults,
    logLinesSuppressed: a.logLinesSuppressed - b.logLinesSuppressed,
  };
}

/**
 * Exact rate-limit activity of the range missing before `r`:
 * S-B (prior given) `r.cumulative − r.delta − prior.cumulative`;
 * S-C (prior null) `r.cumulative − r.delta`. "NOT_DERIVABLE" when an input
 * violates the Task 011B cumulative contract or any field would be negative.
 */
export function deriveMissingRateLimitDelta(
  r: RateLimitSummary,
  prior: RateLimitSummary | null,
): Counters | "NOT_DERIVABLE" {
  if (!isRateLimitCounters(r.cumulative) || !isRateLimitCounters(r.delta)) return "NOT_DERIVABLE";
  let missing = subtractCounters(r.cumulative, r.delta);
  if (prior !== null) {
    if (
      prior.limiterInstanceId !== r.limiterInstanceId ||
      prior.lastSequence >= r.firstSequence ||
      !isRateLimitCounters(prior.cumulative)
    ) {
      return "NOT_DERIVABLE";
    }
    missing = subtractCounters(missing, prior.cumulative);
  }
  return isRateLimitCounters(missing) ? (freezeJson(missing) as unknown as Counters) : "NOT_DERIVABLE";
}

// ---------------------------------------------------------------------------
// Payload readers (§7.3: readers reject a missing, non-integer or
// unsupported schemaVersion). Each returns null when the value does not
// have exactly the declared shape.

export function readInstanceStartedPayload(
  payload: unknown,
): { readonly instanceStartedAt: string; readonly scope: string; readonly limiterInstanceId: string } | null {
  if (!isObject(payload) || payload.schemaVersion !== 1) return null;
  const { instanceStartedAt, scope, limiterInstanceId } = payload;
  if (!isIsoMillis(instanceStartedAt) || typeof scope !== "string" || !isLowerUuid(limiterInstanceId)) {
    return null;
  }
  return { instanceStartedAt, scope, limiterInstanceId };
}

/** The two cumulative families of a SUMMARY payload. */
export function readSummaryCumulative(payload: unknown): CumulativeFamilies | null {
  if (!isObject(payload) || payload.schemaVersion !== 1) return null;
  const { rateLimit, audit } = payload;
  if (!isObject(rateLimit) || !isObject(audit)) return null;
  if (!isRateLimitCounters(rateLimit.cumulative) || !isAuditCounters(audit.cumulative)) return null;
  return { rateLimit: rateLimit.cumulative, audit: audit.cumulative };
}

export function readUncleanGapPayload(payload: unknown): UncleanGapPayload | null {
  if (!isObject(payload)) return null;
  if (
    !hasExactKeys(payload, [
      "schemaVersion",
      "lastDurableSequence",
      "cumulativeAsOfLastDurable",
      "detectedAt",
      "detectedByInstanceId",
    ])
  ) {
    return null;
  }
  const { schemaVersion, lastDurableSequence, cumulativeAsOfLastDurable, detectedAt, detectedByInstanceId } =
    payload;
  if (schemaVersion !== 1 || !isCount(lastDurableSequence)) return null;
  if (cumulativeAsOfLastDurable !== null && !isCumulativeFamilies(cumulativeAsOfLastDurable)) return null;
  if (!isIsoMillis(detectedAt) || !isLowerUuid(detectedByInstanceId)) return null;
  return {
    schemaVersion: 1,
    lastDurableSequence,
    cumulativeAsOfLastDurable,
    detectedAt,
    detectedByInstanceId,
  };
}
