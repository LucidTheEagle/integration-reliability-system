/**
 * Coverage classification of one limiter instance's durable evidence
 * (design Revision 1.4 §9.4, B10; AN4 E2 Option B as selected under
 * F-20 Option C). Pure. It reports what the stored records establish and
 * never more: missing intervals and unknown tails are their own segment
 * kinds and are never reported as covered or zero.
 */
import { canonicalJson } from "./evidence-records.js";
import type { DerivedMissingDelta, EvidenceSummary, FrozenEvidenceRecord, GapCause } from "./evidence-records.js";
import type { Counters, Layer } from "./rate-limit.js";

export type CoverageSegment =
  | {
      readonly kind: "COVERED";
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly summary: EvidenceSummary;
      readonly auditAttribution: "SAME_INTERVAL" | "SPANS_PRECEDING_GAP";
    }
  | { readonly kind: "COVERED_ZERO"; readonly firstSequence: number; readonly lastSequence: number }
  | {
      readonly kind: "KNOWN_GAP";
      readonly missingFrom: number;
      readonly missingTo: number;
      readonly initial: boolean;
      readonly cause: GapCause;
      readonly derivedMissingDelta: DerivedMissingDelta;
      readonly distinctKeys: "UNKNOWN";
    }
  | {
      readonly kind: "UNKNOWN_AFTER";
      readonly lastDurableSequence: number;
      readonly reason: "UNCLEAN_TERMINATION" | "FORCED_CLOSE" | "OPEN";
    }
  /** A hole with no gap record, or a range whose record cannot be read: a defect. */
  | { readonly kind: "UNACCOUNTED"; readonly missingFrom: number; readonly missingTo: number };

export interface CoverageResult {
  readonly segments: readonly CoverageSegment[];
  readonly complete: boolean;
  readonly distinctKeysLowerBound: boolean;
  /** Any covered summary with alignment "UNVERIFIED". */
  readonly alignmentUnverified: boolean;
  /** Σ audit.delta.outcomeUnknownAtShutdown over covered summaries: a count of unresolved outcomes, never a resolution. */
  readonly auditOutcomeUnknown: number;
  /**
   * AN4 E2 Option B: present only when the instance has both an
   * INSTANCE_CLOSED and an UNCLEAN_TERMINATION gap.
   */
  readonly closeGapPair?: "CONSISTENT_ANOMALY" | "DEFECT";
}

const LAYERS: readonly Layer[] = ["L1", "L2", "L3"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rateLimitDeltaIsZero(counters: Counters): boolean {
  return (
    LAYERS.every((layer) => Object.values(counters.layers[layer]).every((value) => value === 0)) &&
    counters.abortedBeforeResponse === 0 &&
    counters.limiterFaults === 0 &&
    counters.logLinesSuppressed === 0
  );
}

/** The summary payload, if it has the shape coverage reads; null otherwise. */
function readSummary(record: FrozenEvidenceRecord): EvidenceSummary | null {
  const payload = record.payload;
  if (!isRecord(payload) || payload.schemaVersion !== 1) return null;
  const { rateLimit, audit } = payload;
  if (!isRecord(rateLimit) || !isRecord(audit)) return null;
  if (!isRecord(rateLimit.delta) || !isRecord(rateLimit.distinctKeys) || !isRecord(audit.delta)) return null;
  if (payload.alignment !== "ALIGNED" && payload.alignment !== "UNVERIFIED") return null;
  if (typeof payload.pairingFaults !== "number") return null;
  return payload as unknown as EvidenceSummary;
}

function isZeroSummary(summary: EvidenceSummary): boolean {
  return (
    summary.alignment === "ALIGNED" &&
    summary.pairingFaults === 0 &&
    rateLimitDeltaIsZero(summary.rateLimit.delta) &&
    Object.values(summary.audit.delta).every((value) => value === 0)
  );
}

type Item =
  | { readonly type: "SUMMARY"; readonly from: number; readonly to: number; readonly record: FrozenEvidenceRecord }
  | { readonly type: "GAP"; readonly from: number; readonly to: number; readonly record: FrozenEvidenceRecord };

/** Classifies one instance's records (other instances' records are ignored). */
export function classifyCoverage(records: readonly FrozenEvidenceRecord[], limiterInstanceId: string): CoverageResult {
  const own = records.filter((record) => record.limiterInstanceId === limiterInstanceId);
  const items: Item[] = [];
  for (const record of own) {
    if (record.kind === "SUMMARY" && record.firstSequence !== null && record.lastSequence !== null) {
      items.push({ type: "SUMMARY", from: record.firstSequence, to: record.lastSequence, record });
    } else if (
      record.kind === "EVIDENCE_GAP" &&
      record.gapReason === "SEQUENCE_DISCONTINUITY" &&
      record.missingFrom !== null &&
      record.missingTo !== null
    ) {
      items.push({ type: "GAP", from: record.missingFrom, to: record.missingTo, record });
    }
  }
  items.sort((a, b) => a.from - b.from || a.to - b.to);

  const segments: CoverageSegment[] = [];
  let cursor = 1;
  let defect = false;
  let alignmentUnverified = false;
  let distinctKeysLowerBound = false;
  let auditOutcomeUnknown = 0;
  let previousWasGap = false;

  for (const item of items) {
    if (item.from < cursor) {
      // An overlap the store's rules forbid: report it, never resolve it.
      defect = true;
      continue;
    }
    if (item.from > cursor) {
      segments.push({ kind: "UNACCOUNTED", missingFrom: cursor, missingTo: item.from - 1 });
    }
    if (item.type === "GAP") {
      const payload = item.record.payload;
      if (
        isRecord(payload) &&
        payload.schemaVersion === 1 &&
        typeof payload.initial === "boolean" &&
        (payload.cause === "SEQUENCE_DISCONTINUITY" || payload.cause === "DRAIN_CONTRACT_VIOLATION") &&
        isRecord(payload.derivedMissingDelta)
      ) {
        segments.push({
          kind: "KNOWN_GAP",
          missingFrom: item.from,
          missingTo: item.to,
          initial: payload.initial,
          cause: payload.cause,
          derivedMissingDelta: payload.derivedMissingDelta as unknown as DerivedMissingDelta,
          distinctKeys: "UNKNOWN",
        });
      } else {
        segments.push({ kind: "UNACCOUNTED", missingFrom: item.from, missingTo: item.to });
      }
      previousWasGap = true;
    } else {
      const summary = readSummary(item.record);
      if (summary === null) {
        segments.push({ kind: "UNACCOUNTED", missingFrom: item.from, missingTo: item.to });
      } else {
        auditOutcomeUnknown += summary.audit.delta.outcomeUnknownAtShutdown ?? 0;
        if (summary.alignment === "UNVERIFIED") alignmentUnverified = true;
        if (LAYERS.some((layer) => summary.rateLimit.distinctKeys[layer]?.lowerBound === true)) {
          distinctKeysLowerBound = true;
        }
        if (isZeroSummary(summary)) {
          segments.push({ kind: "COVERED_ZERO", firstSequence: item.from, lastSequence: item.to });
        } else {
          segments.push({
            kind: "COVERED",
            firstSequence: item.from,
            lastSequence: item.to,
            summary,
            auditAttribution: previousWasGap ? "SPANS_PRECEDING_GAP" : "SAME_INTERVAL",
          });
        }
      }
      previousWasGap = false;
    }
    cursor = item.to + 1;
  }
  const lastDurableSequence = cursor - 1;

  // Tail rules (§9.4), with the close/gap pair (AN4 E2 Option B).
  const closed = own.find((record) => record.kind === "INSTANCE_CLOSED");
  const unclean = own.find((record) => record.kind === "EVIDENCE_GAP" && record.gapReason === "UNCLEAN_TERMINATION");
  const closePayload = closed !== undefined && isRecord(closed.payload) ? closed.payload : undefined;
  const gapPayload = unclean !== undefined && isRecord(unclean.payload) ? unclean.payload : undefined;
  let closeGapPair: CoverageResult["closeGapPair"];
  let closedCleanly = false;

  if (unclean !== undefined) {
    const gapLast = typeof gapPayload?.lastDurableSequence === "number" ? gapPayload.lastDurableSequence : lastDurableSequence;
    segments.push({ kind: "UNKNOWN_AFTER", reason: "UNCLEAN_TERMINATION", lastDurableSequence: gapLast });
    if (closed !== undefined) {
      const consistent =
        closePayload !== undefined &&
        gapPayload !== undefined &&
        closePayload.finalSequence === gapPayload.lastDurableSequence &&
        safeCanonical(closePayload.cumulative) !== undefined &&
        safeCanonical(closePayload.cumulative) === safeCanonical(gapPayload.cumulativeAsOfLastDurable);
      closeGapPair = consistent ? "CONSISTENT_ANOMALY" : "DEFECT";
    }
  } else if (closed !== undefined) {
    const finalSequence = typeof closePayload?.finalSequence === "number" ? closePayload.finalSequence : undefined;
    if (finalSequence === undefined || typeof closePayload?.forcedClose !== "boolean") {
      defect = true;
      segments.push({ kind: "UNKNOWN_AFTER", reason: "OPEN", lastDurableSequence });
    } else {
      if (finalSequence > lastDurableSequence) {
        segments.push({ kind: "UNACCOUNTED", missingFrom: lastDurableSequence + 1, missingTo: finalSequence });
      } else if (finalSequence < lastDurableSequence) {
        defect = true;
      }
      if (closePayload.forcedClose) {
        segments.push({ kind: "UNKNOWN_AFTER", reason: "FORCED_CLOSE", lastDurableSequence: finalSequence });
      } else {
        closedCleanly = true;
      }
    }
  } else {
    segments.push({ kind: "UNKNOWN_AFTER", reason: "OPEN", lastDurableSequence });
  }

  const complete =
    closedCleanly &&
    !defect &&
    !alignmentUnverified &&
    segments.every((segment) => segment.kind === "COVERED" || segment.kind === "COVERED_ZERO");

  return Object.freeze({
    segments: Object.freeze(segments),
    complete,
    distinctKeysLowerBound,
    alignmentUnverified,
    auditOutcomeUnknown,
    ...(closeGapPair === undefined ? {} : { closeGapPair }),
  });
}

function safeCanonical(value: unknown): string | undefined {
  try {
    return value === undefined ? undefined : canonicalJson(value);
  } catch {
    return undefined;
  }
}
