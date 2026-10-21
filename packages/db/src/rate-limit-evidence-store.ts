import { createHash } from "node:crypto";
import { advisoryLockKey, withAdvisoryXactLock } from "./advisory-lock.js";
import type { Database, TransactionClient } from "./client.js";
import { LockedTransactionDeadlineError } from "./errors.js";
import type { LockedTransactionPhase } from "./errors.js";
import { Prisma } from "./generated/prisma/client.js";

// Task 011A evidence-store primitives (addendum RD-2; design Revision 1.4
// §7.4, §7.5, §8.1; AN4 E2 Option A, E5a). Plain input and output types:
// apps/api adapts them to its EvidenceStore port. Every primitive opens
// exactly one transaction. The locked ones take the per-instance advisory
// lock through withAdvisoryXactLock; every read that a decision depends on
// is a separate statement issued after the lock statement has returned, so
// it sees every commit made by the previous holder (R18 §9.5). All SQL is
// schema-qualified with explicit casts.
//
// The rules (lookup, seal, overlap, complete-record comparison, Case B) are
// those of apps/api's in-memory store; one contract suite runs against both.

/** J1 (R6): `maxWait` of every 011A transaction except U3 verification. */
export const EVIDENCE_MAX_WAIT_MS = 500;

/** @internal — the per-instance lock namespace (R18 §9.5). */
export const EVIDENCE_LOCK_NAMESPACE = "irs.rate-limit-evidence.instance";

/** @internal — locked evidence transactions: a fixed 5 s window from the call. */
export const EVIDENCE_LOCKED_TRANSACTION = Object.freeze({
  windowMs: 5_000,
  lockTimeoutMs: 1_000,
  postLockReserveMs: 2_000,
  commitReserveMs: 250,
  maxWaitMs: EVIDENCE_MAX_WAIT_MS,
});

/** @internal — U3 registration verification (AN4 E5a), within the lifecycle's 1,000 ms deadline. */
export const REGISTRATION_VERIFICATION_TRANSACTION = Object.freeze({
  maxWaitMs: 200,
  lockTimeoutMs: 500,
  postLockReserveMs: 250,
  commitReserveMs: 50,
});

/** @internal — unlocked evidence reads and EVENT_REJECTED batches. */
export const EVIDENCE_UNLOCKED_TRANSACTION = Object.freeze({
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: EVIDENCE_MAX_WAIT_MS,
  timeout: 4_500,
});

export type EvidenceJson =
  | null
  | boolean
  | number
  | string
  | readonly EvidenceJson[]
  | { readonly [key: string]: EvidenceJson };

/** One RateLimitEvidence row: the 12 columns as plain values. */
export interface EvidenceRecordRow {
  readonly id: string;
  readonly limiterInstanceId: string;
  readonly scope: string;
  readonly kind: string;
  readonly gapReason: string | null;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly missingFrom: number | null;
  readonly missingTo: number | null;
  readonly payload: EvidenceJson;
  readonly recordSha256: string;
  /** ISO 8601 UTC, millisecond precision. */
  readonly recordedAt: string;
}

export type EvidenceWriteResult =
  | "CREATED"
  | "IDENTICAL_EXISTS"
  | "CONFLICT"
  | "OVERLAP"
  | "SEALED"
  | "STALE_STATE"
  | "CLOSED_EXISTS";

export interface EvidenceDurableState {
  readonly limiterInstanceId: string;
  readonly startedScope: string;
  readonly lastDurableSequence: number;
  /** The last durable summary's rateLimit.cumulative; null if none. */
  readonly cumulativeAsOfLastDurable: EvidenceJson | null;
  /** The last durable summary's audit.cumulative; null if none. */
  readonly auditCumulativeAsOfLastDurable: EvidenceJson | null;
}

export interface EvidenceRecoveryCandidate {
  readonly limiterInstanceId: string;
  readonly hasUncleanGap: boolean;
}

export type EvidenceGapVerdict =
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

export interface EvidenceRegistrationRead {
  readonly present: boolean;
}

export type EvidencePrimitive =
  | "findEvidenceRecoveryCandidates"
  | "readEvidenceDurableState"
  | "writeEvidenceUncleanGap"
  | "validateEvidenceHistoricalGap"
  | "writeEvidenceGroup"
  | "writeRejectionAuditRows"
  | "readEvidenceRegistration";

/**
 * @internal — test seams, called inside the transaction's work: beforeWork
 * as its first statement(s), afterWork after the work and before COMMIT
 * (the IngestionHooks pattern). Not part of the package API.
 */
export interface EvidenceStoreHooks {
  readonly beforeWork?: (tx: TransactionClient, primitive: EvidencePrimitive) => Promise<void>;
  readonly afterWork?: (tx: TransactionClient, primitive: EvidencePrimitive) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Canonical JSON and the complete-record hash (design §7.2). The same
// algorithm as apps/api's evidence-records.ts, which @irs/db cannot import;
// a pinned vector in both packages' tests holds them equal.

/** @internal */
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

/** @internal — SHA-256 of canonicalJson over the 11 fields other than recordSha256. */
export function evidenceRecordHash(row: Omit<EvidenceRecordRow, "recordSha256">): string {
  const text = canonicalJson({
    id: row.id,
    limiterInstanceId: row.limiterInstanceId,
    scope: row.scope,
    kind: row.kind,
    gapReason: row.gapReason,
    firstSequence: row.firstSequence,
    lastSequence: row.lastSequence,
    missingFrom: row.missingFrom,
    missingTo: row.missingTo,
    recordedAt: row.recordedAt,
    payload: row.payload,
  });
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stored hash recomputed = stored recordSha256 = incoming recordSha256, and the incoming row is self-consistent. */
function isIdentical(stored: EvidenceRecordRow, incoming: EvidenceRecordRow): boolean {
  try {
    return (
      evidenceRecordHash(stored) === stored.recordSha256 &&
      stored.recordSha256 === incoming.recordSha256 &&
      evidenceRecordHash(incoming) === incoming.recordSha256
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Payload readers (design §7.3): exact shapes; null when not readable.

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAYERS = ["L1", "L2", "L3"] as const;
const LAYER_FIELDS = [
  "limited",
  "limitedPrecheck",
  "limitedConverted",
  "limitedViaOverflow",
  "overflowAdmissions",
  "individualRejections",
] as const;
const AUDIT_FIELDS = [
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
] as const;

function isIsoMillis(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_MILLIS.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRateLimitCounters(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!hasExactKeys(value, ["layers", "abortedBeforeResponse", "limiterFaults", "logLinesSuppressed"])) return false;
  const layers = value.layers;
  if (!isObject(layers) || !hasExactKeys(layers, LAYERS)) return false;
  for (const layer of LAYERS) {
    const counters = layers[layer];
    if (!isObject(counters) || !hasExactKeys(counters, LAYER_FIELDS)) return false;
    if (!LAYER_FIELDS.every((field) => isCount(counters[field]))) return false;
  }
  return isCount(value.abortedBeforeResponse) && isCount(value.limiterFaults) && isCount(value.logLinesSuppressed);
}

function isAuditCounters(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, AUDIT_FIELDS) && AUDIT_FIELDS.every((field) => isCount(value[field]));
}

function isCumulativeFamilies(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ["rateLimit", "audit"]) &&
    isRateLimitCounters(value.rateLimit) &&
    isAuditCounters(value.audit)
  );
}

function summaryCumulative(payload: unknown): { rateLimit: EvidenceJson; audit: EvidenceJson } | null {
  if (!isObject(payload) || payload.schemaVersion !== 1) return null;
  const { rateLimit, audit } = payload;
  if (!isObject(rateLimit) || !isObject(audit)) return null;
  if (!isRateLimitCounters(rateLimit.cumulative) || !isAuditCounters(audit.cumulative)) return null;
  return { rateLimit: rateLimit.cumulative as EvidenceJson, audit: audit.cumulative as EvidenceJson };
}

function uncleanGapPayload(payload: unknown): {
  lastDurableSequence: number;
  cumulativeAsOfLastDurable: EvidenceJson;
  detectedAt: string;
  detectedByInstanceId: string;
} | null {
  if (!isObject(payload)) return null;
  const keys = ["schemaVersion", "lastDurableSequence", "cumulativeAsOfLastDurable", "detectedAt", "detectedByInstanceId"];
  if (!hasExactKeys(payload, keys)) return null;
  const { schemaVersion, lastDurableSequence, cumulativeAsOfLastDurable, detectedAt, detectedByInstanceId } = payload;
  if (schemaVersion !== 1 || !isCount(lastDurableSequence)) return null;
  if (cumulativeAsOfLastDurable !== null && !isCumulativeFamilies(cumulativeAsOfLastDurable)) return null;
  if (!isIsoMillis(detectedAt) || typeof detectedByInstanceId !== "string" || !UUID_LOWER.test(detectedByInstanceId)) {
    return null;
  }
  return {
    lastDurableSequence,
    cumulativeAsOfLastDurable: cumulativeAsOfLastDurable as EvidenceJson,
    detectedAt,
    detectedByInstanceId,
  };
}

function instanceStartedAt(payload: unknown): string | null {
  if (!isObject(payload) || payload.schemaVersion !== 1) return null;
  const { instanceStartedAt: startedAt, scope, limiterInstanceId } = payload;
  if (!isIsoMillis(startedAt) || typeof scope !== "string") return null;
  if (typeof limiterInstanceId !== "string" || !UUID_LOWER.test(limiterInstanceId)) return null;
  return startedAt;
}

// ---------------------------------------------------------------------------
// SQL fragments

const TABLE = Prisma.sql`"public"."RateLimitEvidence"`;

// payload and recordedAt are read as text: the comparison never depends on
// driver JSON or date parsing, or on the session TimeZone.
const ROW_COLUMNS = Prisma.sql`"id"::text AS "id", "limiterInstanceId"::text AS "limiterInstanceId", "scope", "kind",
  "gapReason", "firstSequence", "lastSequence", "missingFrom", "missingTo", "payload"::text AS "payload",
  "recordSha256", to_char("recordedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"`;

interface RawEvidenceRow extends Omit<EvidenceRecordRow, "payload"> {
  readonly payload: string;
}

function parseRow(raw: RawEvidenceRow): EvidenceRecordRow {
  return { ...raw, payload: JSON.parse(raw.payload) as EvidenceJson };
}

async function selectRows(tx: TransactionClient, where: Prisma.Sql): Promise<EvidenceRecordRow[]> {
  const rows = await tx.$queryRaw<RawEvidenceRow[]>`SELECT ${ROW_COLUMNS} FROM ${TABLE} WHERE ${where}`;
  return rows.map(parseRow);
}

/** The natural-key predicate (a partial unique index) and its ON CONFLICT arbiter; null for a keyless row. */
function naturalKey(row: EvidenceRecordRow): { readonly predicate: Prisma.Sql; readonly arbiter: string } | null {
  if (row.kind === "INSTANCE_STARTED" || row.kind === "INSTANCE_CLOSED") {
    return {
      predicate: Prisma.sql`"kind" = ${row.kind}::text`,
      arbiter: `("limiterInstanceId", "kind") WHERE "kind" IN ('INSTANCE_STARTED', 'INSTANCE_CLOSED')`,
    };
  }
  if (row.kind === "SUMMARY" && row.firstSequence !== null && row.lastSequence !== null) {
    return {
      predicate: Prisma.sql`"kind" = 'SUMMARY' AND "firstSequence" = ${row.firstSequence}::int AND "lastSequence" = ${row.lastSequence}::int`,
      arbiter: `("limiterInstanceId", "firstSequence", "lastSequence") WHERE "kind" = 'SUMMARY'`,
    };
  }
  if (row.kind === "EVIDENCE_GAP" && row.gapReason === "SEQUENCE_DISCONTINUITY") {
    if (row.missingFrom === null || row.missingTo === null) return null;
    return {
      predicate: Prisma.sql`"kind" = 'EVIDENCE_GAP' AND "gapReason" = 'SEQUENCE_DISCONTINUITY' AND "missingFrom" = ${row.missingFrom}::int AND "missingTo" = ${row.missingTo}::int`,
      arbiter: `("limiterInstanceId", "missingFrom", "missingTo") WHERE "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'SEQUENCE_DISCONTINUITY'`,
    };
  }
  if (row.kind === "EVIDENCE_GAP" && row.gapReason === "UNCLEAN_TERMINATION") {
    return {
      predicate: Prisma.sql`"kind" = 'EVIDENCE_GAP' AND "gapReason" = 'UNCLEAN_TERMINATION'`,
      arbiter: `("limiterInstanceId") WHERE "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'UNCLEAN_TERMINATION'`,
    };
  }
  return null;
}

/** The stored row for an incoming one: by natural key within its instance, else by primary key. */
async function existingFor(tx: TransactionClient, row: EvidenceRecordRow): Promise<EvidenceRecordRow | undefined> {
  const key = naturalKey(row);
  if (key !== null) {
    const [byKey] = await selectRows(
      tx,
      Prisma.sql`"limiterInstanceId" = ${row.limiterInstanceId}::uuid AND ${key.predicate} LIMIT 1`,
    );
    if (byKey !== undefined) return byKey;
  }
  const [byId] = await selectRows(tx, Prisma.sql`"id" = ${row.id}::uuid LIMIT 1`);
  return byId;
}

function sequenceRange(row: EvidenceRecordRow): { readonly from: number; readonly to: number } | null {
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

function isSealable(row: EvidenceRecordRow): boolean {
  return (
    row.kind === "SUMMARY" ||
    row.kind === "INSTANCE_CLOSED" ||
    (row.kind === "EVIDENCE_GAP" && row.gapReason === "SEQUENCE_DISCONTINUITY")
  );
}

async function exists(tx: TransactionClient, where: Prisma.Sql): Promise<boolean> {
  const rows = await tx.$queryRaw<{ found: boolean }[]>`SELECT EXISTS (SELECT 1 FROM ${TABLE} WHERE ${where}) AS "found"`;
  return rows[0]?.found === true;
}

/** INSERT … ON CONFLICT <arbiter> DO NOTHING RETURNING "id"; true when the row was inserted. */
async function insertRow(tx: TransactionClient, row: EvidenceRecordRow): Promise<boolean> {
  const arbiter = naturalKey(row)?.arbiter ?? `("id")`;
  const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO ${TABLE}
      ("id", "limiterInstanceId", "scope", "kind", "gapReason", "firstSequence", "lastSequence",
       "missingFrom", "missingTo", "payload", "recordSha256", "recordedAt")
    VALUES (${row.id}::uuid, ${row.limiterInstanceId}::uuid, ${row.scope}::text, ${row.kind}::text,
      ${row.gapReason}::text, ${row.firstSequence}::int, ${row.lastSequence}::int, ${row.missingFrom}::int,
      ${row.missingTo}::int, ${JSON.stringify(row.payload)}::jsonb, ${row.recordSha256}::text,
      ${row.recordedAt}::timestamptz)
    ON CONFLICT ${Prisma.raw(arbiter)} DO NOTHING
    RETURNING "id"::text AS "id"`;
  return inserted.length === 1;
}

/** Inserts, or, if a row appeared under the key after the lookup, compares with it. */
async function insertOrCompare(tx: TransactionClient, row: EvidenceRecordRow): Promise<EvidenceWriteResult> {
  if (await insertRow(tx, row)) return "CREATED";
  const existing = await existingFor(tx, row);
  return existing !== undefined && isIdentical(existing, row) ? "IDENTICAL_EXISTS" : "CONFLICT";
}

class EvidenceDataError extends Error {
  override readonly name = "EvidenceDataError";
}

async function durableState(tx: TransactionClient, limiterInstanceId: string): Promise<EvidenceDurableState> {
  const started = await tx.$queryRaw<{ scope: string }[]>`SELECT "scope" FROM ${TABLE}
    WHERE "limiterInstanceId" = ${limiterInstanceId}::uuid AND "kind" = 'INSTANCE_STARTED' LIMIT 1`;
  const startedScope = started[0]?.scope;
  if (startedScope === undefined) throw new EvidenceDataError("the instance has no INSTANCE_STARTED record");
  const [last] = await selectRows(
    tx,
    Prisma.sql`"limiterInstanceId" = ${limiterInstanceId}::uuid AND "kind" = 'SUMMARY' AND "lastSequence" IS NOT NULL
      ORDER BY "lastSequence" DESC LIMIT 1`,
  );
  if (last === undefined) {
    return {
      limiterInstanceId,
      startedScope,
      lastDurableSequence: 0,
      cumulativeAsOfLastDurable: null,
      auditCumulativeAsOfLastDurable: null,
    };
  }
  const cumulative = summaryCumulative(last.payload);
  if (cumulative === null) throw new EvidenceDataError("the last durable summary is unreadable");
  return {
    limiterInstanceId,
    startedScope,
    lastDurableSequence: last.lastSequence as number,
    cumulativeAsOfLastDurable: cumulative.rateLimit,
    auditCumulativeAsOfLastDurable: cumulative.audit,
  };
}

function sameState(a: EvidenceDurableState, b: EvidenceDurableState): boolean {
  const view = (state: EvidenceDurableState) => ({
    limiterInstanceId: state.limiterInstanceId.toLowerCase(),
    startedScope: state.startedScope,
    lastDurableSequence: state.lastDurableSequence,
    cumulativeAsOfLastDurable: state.cumulativeAsOfLastDurable,
    auditCumulativeAsOfLastDurable: state.auditCumulativeAsOfLastDurable,
  });
  return canonicalJson(view(a)) === canonicalJson(view(b));
}

// ---------------------------------------------------------------------------
// Transaction wrappers

/** One locked evidence transaction on the instance's key, with the fixed 5 s window. */
async function lockedEvidence<T>(
  db: Database,
  limiterInstanceId: string,
  primitive: EvidencePrimitive,
  hooks: EvidenceStoreHooks,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  const { windowMs, ...runner } = EVIDENCE_LOCKED_TRANSACTION;
  return withAdvisoryXactLock(
    db,
    advisoryLockKey(EVIDENCE_LOCK_NAMESPACE, limiterInstanceId.toLowerCase()),
    { ...runner, deadline: db.monotonicNow() + windowMs },
    async (tx) => {
      await hooks.beforeWork?.(tx, primitive);
      const result = await work(tx);
      await hooks.afterWork?.(tx, primitive);
      return result;
    },
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("non-error value thrown", { cause: error });
}

/**
 * @internal — one unlocked READ COMMITTED transaction (maxWait
 * EVIDENCE_MAX_WAIT_MS). Every thrown error carries `phase` and `outcome`:
 * after the callback completed, COMMIT/UNKNOWN (B-1); before, NOT_COMMITTED.
 */
export async function unlockedEvidenceTransaction<T>(
  db: Database,
  primitive: EvidencePrimitive,
  hooks: EvidenceStoreHooks,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  let phase: LockedTransactionPhase = "NOT_STARTED";
  let callbackCompleted = false;
  try {
    return await db.prisma.$transaction(async (tx) => {
      phase = "WORK";
      await hooks.beforeWork?.(tx, primitive);
      const result = await work(tx);
      await hooks.afterWork?.(tx, primitive);
      phase = "COMMIT";
      callbackCompleted = true;
      return result;
    }, EVIDENCE_UNLOCKED_TRANSACTION);
  } catch (error) {
    throw Object.assign(asError(error), {
      phase: callbackCompleted ? ("COMMIT" as const) : phase,
      outcome: callbackCompleted ? ("UNKNOWN" as const) : ("NOT_COMMITTED" as const),
    });
  }
}

// ---------------------------------------------------------------------------
// Primitives

/** Unlocked discovery: instances started in `scope`, not closed, not `excludeInstanceId`. Sorted by id. */
export async function findEvidenceRecoveryCandidates(
  db: Database,
  scope: string,
  excludeInstanceId: string,
  hooks: EvidenceStoreHooks = {},
): Promise<readonly EvidenceRecoveryCandidate[]> {
  return unlockedEvidenceTransaction(db, "findEvidenceRecoveryCandidates", hooks, async (tx) => {
    const rows = await tx.$queryRaw<EvidenceRecoveryCandidate[]>`SELECT s."limiterInstanceId"::text AS "limiterInstanceId",
        EXISTS (SELECT 1 FROM ${TABLE} g WHERE g."limiterInstanceId" = s."limiterInstanceId"
          AND g."kind" = 'EVIDENCE_GAP' AND g."gapReason" = 'UNCLEAN_TERMINATION') AS "hasUncleanGap"
      FROM ${TABLE} s
      WHERE s."kind" = 'INSTANCE_STARTED' AND s."scope" = ${scope}::text
        AND s."limiterInstanceId" <> ${excludeInstanceId}::uuid
        AND NOT EXISTS (SELECT 1 FROM ${TABLE} c WHERE c."limiterInstanceId" = s."limiterInstanceId"
          AND c."kind" = 'INSTANCE_CLOSED')`;
    // Sorted here, by code unit: no dependence on the database collation.
    return rows
      .map((row) => ({ limiterInstanceId: row.limiterInstanceId, hasUncleanGap: row.hasUncleanGap }))
      .sort((a, b) => (a.limiterInstanceId < b.limiterInstanceId ? -1 : a.limiterInstanceId > b.limiterInstanceId ? 1 : 0));
  });
}

/** Unlocked read used only to freeze a Case A gap. Throws when unreadable. */
export async function readEvidenceDurableState(
  db: Database,
  limiterInstanceId: string,
  hooks: EvidenceStoreHooks = {},
): Promise<EvidenceDurableState> {
  return unlockedEvidenceTransaction(db, "readEvidenceDurableState", hooks, (tx) =>
    durableState(tx, limiterInstanceId.toLowerCase()),
  );
}

/**
 * Case A, one locked transaction: (1a) INSTANCE_CLOSED exists → CLOSED_EXISTS;
 * (1) a gap exists → IDENTICAL_EXISTS or CONFLICT; (2) durable state differs
 * from `derivedFrom` → STALE_STATE; (3) insert → CREATED. The first three
 * write nothing.
 */
export async function writeEvidenceUncleanGap(
  db: Database,
  gap: EvidenceRecordRow,
  derivedFrom: EvidenceDurableState,
  hooks: EvidenceStoreHooks = {},
): Promise<EvidenceWriteResult> {
  const instance = gap.limiterInstanceId.toLowerCase();
  if (
    gap.kind !== "EVIDENCE_GAP" ||
    gap.gapReason !== "UNCLEAN_TERMINATION" ||
    instance !== derivedFrom.limiterInstanceId.toLowerCase()
  ) {
    throw new TypeError("writeEvidenceUncleanGap: not an unclean-termination gap for the derived instance");
  }
  return lockedEvidence(db, instance, "writeEvidenceUncleanGap", hooks, async (tx) => {
    // Each check is its own statement after the lock statement (AN4 E2 conditions (a)–(d)).
    if (await exists(tx, Prisma.sql`"limiterInstanceId" = ${instance}::uuid AND "kind" = 'INSTANCE_CLOSED'`)) {
      return "CLOSED_EXISTS";
    }
    const existing = await existingFor(tx, gap);
    if (existing !== undefined) return isIdentical(existing, gap) ? "IDENTICAL_EXISTS" : "CONFLICT";
    if (!sameState(await durableState(tx, instance), derivedFrom)) return "STALE_STATE";
    return insertOrCompare(tx, gap);
  });
}

/** Case B: one locked, read-only transaction applying every §8.1 check to a fresh view. */
export async function validateEvidenceHistoricalGap(
  db: Database,
  limiterInstanceId: string,
  scope: string,
  hooks: EvidenceStoreHooks = {},
): Promise<EvidenceGapVerdict> {
  const instance = limiterInstanceId.toLowerCase();
  return lockedEvidence(db, instance, "validateEvidenceHistoricalGap", hooks, async (tx) => {
    const fail = (reason: Exclude<EvidenceGapVerdict, { valid: true }>["reason"]): EvidenceGapVerdict => ({
      valid: false,
      reason,
    });
    const gaps = await selectRows(
      tx,
      Prisma.sql`"limiterInstanceId" = ${instance}::uuid AND "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'UNCLEAN_TERMINATION'`,
    );
    if (gaps.length !== 1) return fail("NO_GAP");
    const gap = gaps[0] as EvidenceRecordRow;
    if (!isObject(gap.payload) || !isIsoMillis(gap.recordedAt)) return fail("UNREADABLE");
    let storedHash: string;
    try {
      storedHash = evidenceRecordHash(gap);
    } catch {
      return fail("UNREADABLE");
    }
    if (storedHash !== gap.recordSha256) return fail("HASH_MISMATCH");
    if (gap.firstSequence !== null || gap.lastSequence !== null || gap.missingFrom !== null || gap.missingTo !== null) {
      return fail("IDENTITY_MISMATCH");
    }
    const [started] = await selectRows(
      tx,
      Prisma.sql`"limiterInstanceId" = ${instance}::uuid AND "kind" = 'INSTANCE_STARTED' LIMIT 1`,
    );
    if (gap.scope !== scope || started === undefined || started.scope !== scope) return fail("SCOPE_MISMATCH");
    const payload = uncleanGapPayload(gap.payload);
    const startedAt = instanceStartedAt(started.payload);
    if (
      payload === null ||
      startedAt === null ||
      payload.detectedByInstanceId === instance ||
      Date.parse(payload.detectedAt) < Date.parse(startedAt)
    ) {
      return fail("UNSUPPORTED_PAYLOAD");
    }
    let state: EvidenceDurableState;
    try {
      state = await durableState(tx, instance);
    } catch (error) {
      if (error instanceof EvidenceDataError) return fail("DURABLE_FACTS_MISMATCH");
      throw error;
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
    return { valid: true };
  });
}

/** Thrown inside the work to roll a group back; carries the definitive results. */
class GroupRollback extends Error {
  override readonly name = "GroupRollback";
  constructor(readonly results: readonly EvidenceWriteResult[]) {
    super("evidence group rolled back by a definitive result");
  }
}

function rollbackResults(error: unknown): readonly EvidenceWriteResult[] | undefined {
  if (error instanceof GroupRollback) return error.results;
  if (error instanceof LockedTransactionDeadlineError && error.cause instanceof GroupRollback) {
    return error.cause.results;
  }
  return undefined;
}

/**
 * One locked, atomic transaction for one instance's group. Each record, in
 * order: seal check; natural-key (else primary-key) lookup with
 * complete-record comparison; overlap; insert. If any result is CONFLICT,
 * OVERLAP or SEALED the transaction is rolled back and the results are
 * returned; a shape-constraint violation throws.
 */
export async function writeEvidenceGroup(
  db: Database,
  rows: readonly EvidenceRecordRow[],
  hooks: EvidenceStoreHooks = {},
): Promise<readonly EvidenceWriteResult[]> {
  const first = rows[0];
  if (first === undefined) throw new TypeError("writeEvidenceGroup: empty group");
  const instance = first.limiterInstanceId.toLowerCase();
  if (rows.some((row) => row.limiterInstanceId.toLowerCase() !== instance)) {
    throw new TypeError("writeEvidenceGroup: a group belongs to one instance");
  }
  try {
    return await lockedEvidence(db, instance, "writeEvidenceGroup", hooks, async (tx) => {
      const results: EvidenceWriteResult[] = [];
      for (const row of rows) results.push(await classifyAndInsert(tx, instance, row));
      if (results.some((result) => result === "CONFLICT" || result === "OVERLAP" || result === "SEALED")) {
        throw new GroupRollback(results);
      }
      return results;
    });
  } catch (error) {
    const results = rollbackResults(error);
    if (results !== undefined) return results;
    throw error;
  }
}

async function classifyAndInsert(
  tx: TransactionClient,
  instance: string,
  row: EvidenceRecordRow,
): Promise<EvidenceWriteResult> {
  const existing = await existingFor(tx, row);
  if (isSealable(row)) {
    const sealed = await exists(
      tx,
      Prisma.sql`"limiterInstanceId" = ${instance}::uuid AND "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'UNCLEAN_TERMINATION'`,
    );
    if (sealed) return existing !== undefined && isIdentical(existing, row) ? "IDENTICAL_EXISTS" : "SEALED";
  }
  if (existing !== undefined) return isIdentical(existing, row) ? "IDENTICAL_EXISTS" : "CONFLICT";
  const range = sequenceRange(row);
  if (range !== null) {
    const overlaps = await exists(
      tx,
      Prisma.sql`"limiterInstanceId" = ${instance}::uuid AND (
        ("kind" = 'SUMMARY' AND "firstSequence" <= ${range.to}::int AND "lastSequence" >= ${range.from}::int)
        OR ("kind" = 'EVIDENCE_GAP' AND "gapReason" = 'SEQUENCE_DISCONTINUITY'
            AND "missingFrom" <= ${range.to}::int AND "missingTo" >= ${range.from}::int))`,
    );
    if (overlaps) return "OVERLAP";
  }
  return insertOrCompare(tx, row);
}

/**
 * U3 (AN4 E5a): one locked, read-only transaction on the instance's key with
 * the lifecycle's absolute `deadline` (on db.monotonicNow) and the U3 runner
 * values. The INSTANCE_STARTED read is a separate statement after the lock.
 */
export async function readEvidenceRegistration(
  db: Database,
  limiterInstanceId: string,
  deadline: number,
  hooks: EvidenceStoreHooks = {},
): Promise<EvidenceRegistrationRead> {
  const instance = limiterInstanceId.toLowerCase();
  return withAdvisoryXactLock(
    db,
    advisoryLockKey(EVIDENCE_LOCK_NAMESPACE, instance),
    { ...REGISTRATION_VERIFICATION_TRANSACTION, deadline },
    async (tx) => {
      await hooks.beforeWork?.(tx, "readEvidenceRegistration");
      const present = await exists(tx, Prisma.sql`"limiterInstanceId" = ${instance}::uuid AND "kind" = 'INSTANCE_STARTED'`);
      await hooks.afterWork?.(tx, "readEvidenceRegistration");
      return { present };
    },
  );
}
