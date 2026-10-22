import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCoverage } from "./coverage.js";
import {
  ZERO_AUDIT_COUNTERS,
  buildEvidenceRecord,
  freezeDiscontinuityGap,
  freezeInstanceClosed,
  freezeInstanceStarted,
  freezeSummary,
  freezeUncleanGap,
} from "./evidence-records.js";
import type { AuditRecorderCounters, EvidenceSummary, FrozenEvidenceRecord, JsonValue } from "./evidence-records.js";
import { contractAuditCounters, contractCounters, contractSummary } from "./evidence-store-contract.js";
import type { Counters } from "./rate-limit.js";

// Coverage classification (design §9.4): A-T14 (a) – (g), A-T14b, the
// coverage parts of A-T19 (h) and (i), and the A-T21 interpretation of a
// coexisting close and UNCLEAN_TERMINATION gap (AN4 E2 Option B).

const SCOPE = "coverage-tests";
const T = "2026-10-21T10:00:00.000Z";
const ZERO_COUNTERS = contractCounters(0);

function summaryRecord(
  instance: string,
  first: number,
  last: number,
  options: {
    rlDelta?: Counters;
    auditDelta?: AuditRecorderCounters;
    cumulative?: number;
    auditCumulative?: AuditRecorderCounters;
    alignment?: "ALIGNED" | "UNVERIFIED";
    pairingFaults?: number;
    lowerBound?: boolean;
  } = {},
): FrozenEvidenceRecord {
  const base = contractSummary(instance, first, last, options.cumulative ?? last);
  const distinct = { count: 0, saturated: options.lowerBound === true, lowerBound: options.lowerBound === true };
  const summary: EvidenceSummary = {
    ...base,
    rateLimit: {
      ...base.rateLimit,
      delta: options.rlDelta ?? ZERO_COUNTERS,
      distinctKeys: { L1: distinct, L2: base.rateLimit.distinctKeys.L2, L3: base.rateLimit.distinctKeys.L3 },
    },
    audit: {
      ...base.audit,
      delta: options.auditDelta ?? ZERO_AUDIT_COUNTERS,
      cumulative: options.auditCumulative ?? base.audit.cumulative,
    },
    pairingFaults: options.pairingFaults ?? 0,
    alignment: options.alignment ?? "ALIGNED",
  };
  return freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: T, summary });
}

function gap(instance: string, from: number, to: number, initial = false, cause: "SEQUENCE_DISCONTINUITY" | "DRAIN_CONTRACT_VIOLATION" = "SEQUENCE_DISCONTINUITY", rateLimitDelta: Counters | "NOT_DERIVABLE" = contractCounters(to - from + 1)): FrozenEvidenceRecord {
  return freezeDiscontinuityGap({
    id: randomUUID(),
    limiterInstanceId: instance,
    scope: SCOPE,
    recordedAt: T,
    missingFrom: from,
    missingTo: to,
    initial,
    cause,
    rateLimitDelta,
    detectedAt: T,
  });
}

function closed(instance: string, finalSequence: number, forcedClose = false, cumulative = finalSequence): FrozenEvidenceRecord {
  return freezeInstanceClosed({
    id: randomUUID(),
    limiterInstanceId: instance,
    scope: SCOPE,
    recordedAt: T,
    finalSequence,
    cumulative: { rateLimit: contractCounters(cumulative), audit: contractAuditCounters(cumulative) },
    forcedClose,
    closedAt: T,
  });
}

function started(instance: string): FrozenEvidenceRecord {
  return freezeInstanceStarted({
    id: randomUUID(),
    limiterInstanceId: instance,
    scope: SCOPE,
    recordedAt: T,
    instanceStartedAt: T,
    rateLimitPolicies: {},
    auditPolicies: {},
  });
}

function unclean(instance: string, lastDurableSequence: number, cumulative = lastDurableSequence): FrozenEvidenceRecord {
  return freezeUncleanGap({
    id: randomUUID(),
    limiterInstanceId: instance,
    scope: SCOPE,
    recordedAt: T,
    lastDurableSequence,
    cumulativeAsOfLastDurable:
      lastDurableSequence === 0 ? null : { rateLimit: contractCounters(cumulative), audit: contractAuditCounters(cumulative) },
    detectedAt: T,
    detectedByInstanceId: randomUUID(),
  });
}

const kinds = (result: ReturnType<typeof classifyCoverage>) => result.segments.map((segment) => segment.kind);

describe("A-T14: coverage classification", () => {
  const instance = randomUUID();

  it("(a) all deltas zero, pairingFaults 0, ALIGNED → COVERED_ZERO; a clean close → complete", () => {
    const result = classifyCoverage([started(instance), summaryRecord(instance, 1, 2), closed(instance, 2)], instance);
    assert.deepEqual(result.segments, [{ kind: "COVERED_ZERO", firstSequence: 1, lastSequence: 2 }]);
    assert.equal(result.complete, true);
  });

  it("(b) rate-limit deltas zero but an audit delta non-zero → COVERED, not COVERED_ZERO", () => {
    const result = classifyCoverage(
      [summaryRecord(instance, 1, 1, { auditDelta: { ...ZERO_AUDIT_COUNTERS, suppressedByCeiling: 1 } }), closed(instance, 1)],
      instance,
    );
    assert.deepEqual(kinds(result), ["COVERED"]);
    assert.equal(result.complete, true);
  });

  it("(c) rate-limit activity present → COVERED, SAME_INTERVAL; pairingFaults alone also → COVERED", () => {
    const active = classifyCoverage([summaryRecord(instance, 1, 1, { rlDelta: contractCounters(1) }), closed(instance, 1)], instance);
    assert.equal(active.segments[0]?.kind, "COVERED");
    assert.equal((active.segments[0] as { auditAttribution?: string }).auditAttribution, "SAME_INTERVAL");
    const faults = classifyCoverage([summaryRecord(instance, 1, 1, { pairingFaults: 1 }), closed(instance, 1)], instance);
    assert.equal(faults.segments[0]?.kind, "COVERED");
  });

  it("(d) all-zero deltas but UNVERIFIED → COVERED, alignmentUnverified, complete false", () => {
    const result = classifyCoverage([summaryRecord(instance, 1, 1, { alignment: "UNVERIFIED" }), closed(instance, 1)], instance);
    assert.deepEqual(kinds(result), ["COVERED"]);
    assert.equal(result.alignmentUnverified, true);
    assert.equal(result.complete, false);
  });

  it("(e) KNOWN_GAP (both causes, initial and not), UNKNOWN_AFTER (UNCLEAN_TERMINATION, OPEN) and UNACCOUNTED are never COVERED_ZERO; complete false", () => {
    const withGaps = classifyCoverage(
      [
        gap(instance, 1, 1, true, "SEQUENCE_DISCONTINUITY"),
        summaryRecord(instance, 2, 2, { alignment: "UNVERIFIED" }),
        gap(instance, 3, 4, false, "DRAIN_CONTRACT_VIOLATION", "NOT_DERIVABLE"),
        summaryRecord(instance, 5, 5, { alignment: "UNVERIFIED" }),
        closed(instance, 5),
      ],
      instance,
    );
    assert.deepEqual(kinds(withGaps), ["KNOWN_GAP", "COVERED", "KNOWN_GAP", "COVERED"]);
    assert.equal(withGaps.complete, false);
    const hole = classifyCoverage([summaryRecord(instance, 1, 1), summaryRecord(instance, 3, 3), closed(instance, 3)], instance);
    assert.deepEqual(kinds(hole), ["COVERED_ZERO", "UNACCOUNTED", "COVERED_ZERO"]);
    assert.deepEqual(hole.segments[1], { kind: "UNACCOUNTED", missingFrom: 2, missingTo: 2 });
    assert.equal(hole.complete, false);
    const open = classifyCoverage([summaryRecord(instance, 1, 2)], instance);
    assert.deepEqual(open.segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "OPEN", lastDurableSequence: 2 });
    assert.equal(open.complete, false);
    const terminated = classifyCoverage([summaryRecord(instance, 1, 2), unclean(instance, 2)], instance);
    assert.deepEqual(terminated.segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "UNCLEAN_TERMINATION", lastDurableSequence: 2 });
    assert.equal(terminated.complete, false);
    const closedShort = classifyCoverage([summaryRecord(instance, 1, 1), closed(instance, 3)], instance);
    assert.deepEqual(closedShort.segments.at(-1), { kind: "UNACCOUNTED", missingFrom: 2, missingTo: 3 });
    assert.equal(closedShort.complete, false);
  });

  it("(f) auditOutcomeUnknown sums deltas (5), never cumulative (13); records outside covered segments contribute nothing", () => {
    const delta = (n: number): AuditRecorderCounters => ({ ...ZERO_AUDIT_COUNTERS, outcomeUnknownAtShutdown: n });
    const result = classifyCoverage(
      [
        summaryRecord(instance, 1, 1, { auditDelta: delta(0), auditCumulative: delta(0) }),
        summaryRecord(instance, 2, 2, { auditDelta: delta(3), auditCumulative: delta(3) }),
        summaryRecord(instance, 3, 3, { auditDelta: delta(2), auditCumulative: delta(5) }),
        summaryRecord(instance, 4, 4, { auditDelta: delta(0), auditCumulative: delta(5) }),
        closed(instance, 4),
        // Another instance's summary is ignored.
        summaryRecord(randomUUID(), 1, 1, { auditDelta: delta(7) }),
      ],
      instance,
    );
    assert.equal(result.auditOutcomeUnknown, 5);
  });

  it("(g) exact versus unattributable: the gap's stored derivedMissingDelta; the next summary SPANS_PRECEDING_GAP with its audit delta unsplit; lower-bound flags kept", () => {
    const after = summaryRecord(instance, 4, 5, { alignment: "UNVERIFIED", auditDelta: contractAuditCounters(3), lowerBound: true });
    const result = classifyCoverage(
      [summaryRecord(instance, 1, 2, { rlDelta: contractCounters(1) }), gap(instance, 3, 3), after, summaryRecord(instance, 6, 6, { rlDelta: contractCounters(1) }), closed(instance, 6)],
      instance,
    );
    assert.deepEqual(kinds(result), ["COVERED", "KNOWN_GAP", "COVERED", "COVERED"]);
    const known = result.segments[1] as { derivedMissingDelta: unknown; distinctKeys: unknown };
    assert.deepEqual(known.derivedMissingDelta, { rateLimit: contractCounters(1), audit: "NOT_ATTRIBUTABLE" });
    assert.equal(known.distinctKeys, "UNKNOWN");
    const spans = result.segments[2] as { auditAttribution: string; summary: EvidenceSummary };
    assert.equal(spans.auditAttribution, "SPANS_PRECEDING_GAP");
    assert.deepEqual(spans.summary.audit.delta, contractAuditCounters(3));
    assert.equal((result.segments[0] as { auditAttribution: string }).auditAttribution, "SAME_INTERVAL");
    assert.equal((result.segments[3] as { auditAttribution: string }).auditAttribution, "SAME_INTERVAL");
    assert.equal(result.distinctKeysLowerBound, true);
    assert.equal(result.complete, false);
  });
});

describe("A-T14b: forced close", () => {
  it("forcedClose true → UNKNOWN_AFTER FORCED_CLOSE and never complete; the same records with forcedClose false → complete", () => {
    const instance = randomUUID();
    const covered = [summaryRecord(instance, 1, 3)];
    const forced = classifyCoverage([...covered, closed(instance, 3, true)], instance);
    assert.deepEqual(forced.segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "FORCED_CLOSE", lastDurableSequence: 3 });
    assert.equal(forced.complete, false);
    assert.equal(classifyCoverage([...covered, closed(instance, 3, false)], instance).complete, true);
  });
});

describe("A-T21 interpretation: a coexisting INSTANCE_CLOSED and UNCLEAN_TERMINATION gap (AN4 E2 Option B)", () => {
  it("equal finalSequence and both cumulative families → CONSISTENT_ANOMALY, tail UNCLEAN_TERMINATION, complete false", () => {
    const instance = randomUUID();
    const result = classifyCoverage([summaryRecord(instance, 1, 2), closed(instance, 2), unclean(instance, 2)], instance);
    assert.equal(result.closeGapPair, "CONSISTENT_ANOMALY");
    assert.deepEqual(result.segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "UNCLEAN_TERMINATION", lastDurableSequence: 2 });
    assert.equal(result.complete, false);
  });

  it("an altered finalSequence, or one cumulative family different → DEFECT, never a valid state", () => {
    const instance = randomUUID();
    const sequenceDiffers = classifyCoverage([summaryRecord(instance, 1, 2), closed(instance, 3), unclean(instance, 2)], instance);
    assert.equal(sequenceDiffers.closeGapPair, "DEFECT");
    assert.equal(sequenceDiffers.complete, false);
    const close = closed(instance, 2);
    const payload = close.payload as Record<string, JsonValue>;
    const auditAltered = buildEvidenceRecord({
      ...close,
      payload: {
        ...payload,
        cumulative: { ...(payload.cumulative as Record<string, JsonValue>), audit: contractAuditCounters(99) as unknown as JsonValue },
      },
    });
    const familyDiffers = classifyCoverage([summaryRecord(instance, 1, 2), auditAltered, unclean(instance, 2)], instance);
    assert.equal(familyDiffers.closeGapPair, "DEFECT");
    assert.deepEqual(familyDiffers.segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "UNCLEAN_TERMINATION", lastDurableSequence: 2 });
    assert.equal(familyDiffers.complete, false);
  });

  it("no pair → no closeGapPair field", () => {
    const instance = randomUUID();
    assert.equal("closeGapPair" in classifyCoverage([summaryRecord(instance, 1, 1), closed(instance, 1)], instance), false);
  });
});

describe("defensive classification", () => {
  it("an unreadable summary payload is UNACCOUNTED, never covered; an overlap is a defect (complete false)", () => {
    const instance = randomUUID();
    const unreadable = buildEvidenceRecord({ ...summaryRecord(instance, 1, 1), payload: { schemaVersion: 1 } });
    const result = classifyCoverage([unreadable, closed(instance, 1)], instance);
    assert.deepEqual(result.segments, [{ kind: "UNACCOUNTED", missingFrom: 1, missingTo: 1 }]);
    assert.equal(result.complete, false);
    const overlap = classifyCoverage([summaryRecord(instance, 1, 3), summaryRecord(instance, 2, 4), closed(instance, 3)], instance);
    assert.equal(overlap.complete, false);
  });
});
