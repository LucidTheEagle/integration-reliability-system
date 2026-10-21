import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ZERO_AUDIT_COUNTERS,
  buildEvidenceRecord,
  buildRejectionRecord,
  canonicalJson,
  deriveMissingRateLimitDelta,
  foldAudit,
  freezeDiscontinuityGap,
  freezeInstanceClosed,
  freezeInstanceStarted,
  freezeSummary,
  freezeUncleanGap,
  isIsoMillis,
  isLowerUuid,
  mergeEvidenceSummaries,
  readInstanceStartedPayload,
  readSummaryCumulative,
  readUncleanGapPayload,
  recordHash,
  rejectionRowCanonical,
} from "./evidence-records.js";
import type { AuditRecorderSnapshot, EvidenceRecordFields, EvidenceSummary } from "./evidence-records.js";
import { contractAuditCounters, contractCounters, contractSummary } from "./evidence-store-contract.js";

const T0 = "2026-10-21T10:00:00.000Z";
const T1 = "2026-10-21T10:01:00.000Z";

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe("canonicalJson (§7.2)", () => {
  it("sorts keys at every depth by UTF-16 code unit, with no whitespace", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [1, "x", null, true], c: 2 } }),
      '{"a":{"c":2,"d":[1,"x",null,true]},"b":1}',
    );
    // Code-unit order: uppercase before lowercase; a surrogate pair (U+D83D…) before U+FFFF.
    assert.equal(
      canonicalJson({ "￿": 4, "\u{1F600}": 3, a: 2, B: 1, "é": 5 }),
      '{"B":1,"a":2,"é":5,"\u{1F600}":3,"￿":4}',
    );
  });

  it("renders numbers and strings with JSON.stringify", () => {
    assert.equal(canonicalJson([60_000.25, 1 / 30, -0, 0, "a\"b\n"]), '[60000.25,0.03333333333333333,0,0,"a\\"b\\n"]');
  });

  it("rejects every value that is not plain JSON", () => {
    const sparse: unknown[] = [];
    sparse[1] = 1;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const rejected: readonly (readonly [string, unknown])[] = [
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["unsafe integer", 2 ** 53],
      ["undefined member", { a: undefined }],
      ["undefined", undefined],
      ["function", () => 1],
      ["bigint", 1n],
      ["symbol", Symbol("s")],
      ["Date", new Date(0)],
      ["Map", new Map()],
      ["sparse array", sparse],
      ["cycle", cycle],
    ];
    for (const [label, value] of rejected) assert.throws(() => canonicalJson(value), TypeError, label);
  });

  it("accepts a repeated (non-cyclic) reference", () => {
    const shared = { x: 1 };
    assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
  });
});

describe("recordHash: the complete-record hash (§7.2)", () => {
  // Pinned vector: the canonical text and its SHA-256, computed independently.
  // The @irs/db store must reproduce exactly this value (Stage 4).
  const fields: EvidenceRecordFields = {
    id: "00000000-0000-4000-8000-000000000001",
    limiterInstanceId: "00000000-0000-4000-8000-000000000002",
    scope: "irs.contract",
    kind: "INSTANCE_STARTED",
    gapReason: null,
    firstSequence: null,
    lastSequence: null,
    missingFrom: null,
    missingTo: null,
    recordedAt: T0,
    payload: { schemaVersion: 1, b: [1, 2.5, null, true], a: "x", "é": "☃" },
  };
  const CANONICAL =
    '{"firstSequence":null,"gapReason":null,"id":"00000000-0000-4000-8000-000000000001","kind":"INSTANCE_STARTED",' +
    '"lastSequence":null,"limiterInstanceId":"00000000-0000-4000-8000-000000000002","missingFrom":null,"missingTo":null,' +
    '"payload":{"a":"x","b":[1,2.5,null,true],"schemaVersion":1,"é":"☃"},"recordedAt":"2026-10-21T10:00:00.000Z",' +
    '"scope":"irs.contract"}';
  const HASH = "fb3cc9a2931751aa1f7844850bc81e1e27e2c6a8c317fa30e079059d50a515c7";

  it("hashes exactly the canonical text of the 11 fields", () => {
    const { payload, ...rest } = fields;
    assert.equal(canonicalJson({ ...rest, payload }), CANONICAL);
    assert.equal(recordHash(fields), HASH);
  });

  it("ignores recordSha256 and any extra property", () => {
    const extra = { ...fields, recordSha256: "x", note: "ignored" } as EvidenceRecordFields;
    assert.equal(recordHash(extra), HASH);
  });

  it("changes when any one field changes", () => {
    const changes: readonly Partial<EvidenceRecordFields>[] = [
      { id: randomUUID() },
      { scope: "other" },
      { recordedAt: T1 },
      { firstSequence: 1 },
      { missingTo: 1 },
      { payload: { schemaVersion: 1 } },
    ];
    for (const change of changes) assert.notEqual(recordHash({ ...fields, ...change }), HASH);
  });
});

describe("buildEvidenceRecord and the freeze helpers", () => {
  const instance = randomUUID();

  it("buildEvidenceRecord deep-copies, deep-freezes and hashes", () => {
    const payload = { schemaVersion: 1, nested: { value: 1 } };
    const record = buildEvidenceRecord({
      id: randomUUID(),
      limiterInstanceId: instance,
      scope: "s",
      kind: "INSTANCE_STARTED",
      gapReason: null,
      firstSequence: null,
      lastSequence: null,
      missingFrom: null,
      missingTo: null,
      recordedAt: T0,
      payload,
    });
    payload.nested.value = 2;
    assert.deepEqual(record.payload, { schemaVersion: 1, nested: { value: 1 } });
    assert.ok(isDeepFrozen(record));
    assert.equal(record.recordSha256, recordHash(record));
  });

  it("INSTANCE_STARTED payload (§7.3)", () => {
    const record = freezeInstanceStarted({
      id: randomUUID(),
      limiterInstanceId: instance,
      scope: "s",
      recordedAt: T1,
      instanceStartedAt: T0,
      rateLimitPolicies: { L2: { refillPerSecond: 1 / 30 } },
      auditPolicies: { queueCapacity: 1_000 },
    });
    assert.equal(record.kind, "INSTANCE_STARTED");
    assert.deepEqual(record.payload, {
      schemaVersion: 1,
      limiterInstanceId: instance,
      instanceStartedAt: T0,
      scope: "s",
      rateLimitPolicies: { L2: { refillPerSecond: 1 / 30 } },
      auditPolicies: { queueCapacity: 1_000 },
    });
    assert.ok(isDeepFrozen(record));
    assert.deepEqual(readInstanceStartedPayload(record.payload), {
      instanceStartedAt: T0,
      scope: "s",
      limiterInstanceId: instance,
    });
  });

  it("SUMMARY takes its instance and range from rateLimit; its payload is the summary", () => {
    const summary = contractSummary(instance, 3, 5);
    const record = freezeSummary({ id: randomUUID(), scope: "s", recordedAt: T1, summary });
    assert.deepEqual(
      [record.kind, record.limiterInstanceId, record.firstSequence, record.lastSequence, record.gapReason],
      ["SUMMARY", instance, 3, 5, null],
    );
    assert.deepEqual(record.payload, summary);
    assert.deepEqual(readSummaryCumulative(record.payload), {
      rateLimit: contractCounters(5),
      audit: contractAuditCounters(5),
    });
  });

  it("EVIDENCE_GAP (SEQUENCE_DISCONTINUITY): range columns, audit NOT_ATTRIBUTABLE, distinct keys UNKNOWN", () => {
    const record = freezeDiscontinuityGap({
      id: randomUUID(),
      limiterInstanceId: instance,
      scope: "s",
      recordedAt: T1,
      missingFrom: 2,
      missingTo: 4,
      initial: false,
      cause: "DRAIN_CONTRACT_VIOLATION",
      rateLimitDelta: "NOT_DERIVABLE",
      detectedAt: T1,
    });
    assert.deepEqual([record.gapReason, record.missingFrom, record.missingTo], ["SEQUENCE_DISCONTINUITY", 2, 4]);
    assert.deepEqual(record.payload, {
      schemaVersion: 1,
      missingFrom: 2,
      missingTo: 4,
      initial: false,
      cause: "DRAIN_CONTRACT_VIOLATION",
      derivedMissingDelta: { rateLimit: "NOT_DERIVABLE", audit: "NOT_ATTRIBUTABLE" },
      distinctKeys: "UNKNOWN",
      detectedAt: T1,
    });
  });

  it("EVIDENCE_GAP (UNCLEAN_TERMINATION) and INSTANCE_CLOSED payloads", () => {
    const detector = randomUUID();
    const families = { rateLimit: contractCounters(4), audit: contractAuditCounters(4) };
    const gap = freezeUncleanGap({
      id: randomUUID(),
      limiterInstanceId: instance,
      scope: "s",
      recordedAt: T1,
      lastDurableSequence: 4,
      cumulativeAsOfLastDurable: families,
      detectedAt: T1,
      detectedByInstanceId: detector,
    });
    assert.deepEqual([gap.gapReason, gap.missingFrom, gap.firstSequence], ["UNCLEAN_TERMINATION", null, null]);
    assert.deepEqual(readUncleanGapPayload(gap.payload), {
      schemaVersion: 1,
      lastDurableSequence: 4,
      cumulativeAsOfLastDurable: families,
      detectedAt: T1,
      detectedByInstanceId: detector,
    });
    const close = freezeInstanceClosed({
      id: randomUUID(),
      limiterInstanceId: instance,
      scope: "s",
      recordedAt: T1,
      finalSequence: 4,
      cumulative: families,
      forcedClose: true,
      closedAt: T1,
    });
    assert.deepEqual(close.payload, { schemaVersion: 1, finalSequence: 4, cumulative: families, forcedClose: true, closedAt: T1 });
  });

  it("the freeze helpers validate, naming only the field", () => {
    const base = { id: randomUUID(), limiterInstanceId: instance, scope: "s", recordedAt: T1 };
    const started = (changes: Record<string, unknown>) =>
      freezeInstanceStarted({ ...base, instanceStartedAt: T0, rateLimitPolicies: {}, auditPolicies: {}, ...changes });
    const message = (field: string) => ({ name: "TypeError", message: `invalid evidence record: ${field}` });
    assert.throws(() => started({ id: base.id.toUpperCase() }), message("id"));
    assert.throws(() => started({ recordedAt: "2026-10-21T10:01:00Z" }), message("recordedAt"));
    assert.throws(() => started({ scope: "" }), message("scope"));
    assert.throws(() => started({ auditPolicies: { bad: Number.NaN } }), TypeError);
    const summary = contractSummary(instance, 5, 5);
    assert.throws(
      () => freezeSummary({ id: base.id, scope: "s", recordedAt: T1, summary: { ...summary, rateLimit: { ...summary.rateLimit, lastSequence: 4 } } }),
      message("summary.lastSequence"),
    );
    const gap = (changes: Record<string, unknown>) =>
      freezeUncleanGap({
        ...base,
        lastDurableSequence: 0,
        cumulativeAsOfLastDurable: null,
        detectedAt: T1,
        detectedByInstanceId: randomUUID(),
        ...changes,
      });
    assert.throws(() => gap({ detectedByInstanceId: instance }), message("detectedByInstanceId"));
    assert.throws(
      () => gap({ cumulativeAsOfLastDurable: { rateLimit: contractCounters(1), audit: contractAuditCounters(1) } }),
      message("cumulativeAsOfLastDurable"),
    );
    assert.throws(() => gap({ lastDurableSequence: 2 }), message("cumulativeAsOfLastDurable"));
    assert.throws(
      () =>
        freezeDiscontinuityGap({
          ...base,
          missingFrom: 3,
          missingTo: 2,
          initial: false,
          cause: "SEQUENCE_DISCONTINUITY",
          rateLimitDelta: "NOT_DERIVABLE",
          detectedAt: T1,
        }),
      message("missingTo"),
    );
    assert.throws(
      () =>
        freezeInstanceClosed({
          ...base,
          finalSequence: 0,
          cumulative: { rateLimit: contractCounters(0), audit: contractAuditCounters(0) },
          forcedClose: false,
          closedAt: T1,
        }),
      message("finalSequence"),
    );
  });

  it("buildRejectionRecord deep-freezes all 8 columns and validates the key and createdAt", () => {
    const id = randomUUID();
    const fields = {
      id,
      actorType: "EXTERNAL_SENDER",
      actorId: null,
      action: "EVENT_REJECTED",
      entityType: "WEBHOOK_DELIVERY",
      entityId: id,
      metadata: {
        schemaVersion: 1,
        limiterInstanceId: instance,
        stage: "ROUTE_GUARD",
        httpStatus: 404,
        errorCode: "NOT_FOUND",
        claimedIntegrationId: null,
        verifierReason: null,
        responseCompletion: "CLOSE_BEFORE_FINISH",
        receivedAt: T0,
      },
      createdAt: T1,
    } as const;
    const record = buildRejectionRecord(fields);
    assert.deepEqual(record, fields);
    assert.ok(isDeepFrozen(record));
    assert.throws(() => buildRejectionRecord({ ...fields, createdAt: "not a time" }), TypeError);
    assert.throws(() => buildRejectionRecord({ ...fields, id: "x" }), TypeError);
    assert.equal(
      rejectionRowCanonical(record),
      canonicalJson({ ...fields }),
    );
  });
});

describe("A-T12: foldAudit and mergeEvidenceSummaries (§7.1, §7.2)", () => {
  const instance = randomUUID();
  const snapshot = (start: string, end: string, n: number, cumulative: number): AuditRecorderSnapshot => ({
    intervalStartedAt: start,
    intervalEndedAt: end,
    delta: contractAuditCounters(n),
    cumulative: contractAuditCounters(cumulative),
    gauges: { queueDepth: n, queueCapacity: 1_000 },
  });

  it("foldAudit: start from a, end from b, deltas summed, cumulative and gauges from b", () => {
    const folded = foldAudit(snapshot(T0, T1, 2, 2), snapshot(T1, "2026-10-21T10:02:00.000Z", 3, 5));
    assert.deepEqual(folded, {
      intervalStartedAt: T0,
      intervalEndedAt: "2026-10-21T10:02:00.000Z",
      delta: contractAuditCounters(5),
      cumulative: contractAuditCounters(5),
      gauges: { queueDepth: 3, queueCapacity: 1_000 },
    });
    assert.deepEqual(foldAudit(snapshot(T0, T1, 0, 0), snapshot(T1, T1, 0, 0)).delta, ZERO_AUDIT_COUNTERS);
  });

  it("merges contiguous summaries: Task 011B merge, audit folded, pairingFaults summed, alignment kept only if both ALIGNED", () => {
    const a: EvidenceSummary = { ...contractSummary(instance, 1, 2), pairingFaults: 1 };
    const b: EvidenceSummary = { ...contractSummary(instance, 3, 3), pairingFaults: 2 };
    const merged = mergeEvidenceSummaries(a, b);
    assert.ok(merged.ok);
    assert.deepEqual([merged.summary.rateLimit.firstSequence, merged.summary.rateLimit.lastSequence], [1, 3]);
    assert.equal(merged.summary.pairingFaults, 3);
    assert.equal(merged.summary.alignment, "ALIGNED");
    assert.deepEqual(merged.summary.audit.delta, contractAuditCounters(3));
    assert.deepEqual(merged.summary.audit.cumulative, b.audit.cumulative);
    const unverified = mergeEvidenceSummaries(a, { ...b, alignment: "UNVERIFIED" });
    assert.ok(unverified.ok);
    assert.equal(unverified.summary.alignment, "UNVERIFIED");
  });

  it("INSTANCE_MISMATCH and NOT_CONTIGUOUS propagate; nothing is merged", () => {
    const a = contractSummary(instance, 1, 2);
    assert.deepEqual(mergeEvidenceSummaries(a, contractSummary(randomUUID(), 3, 3)), {
      ok: false,
      reason: "INSTANCE_MISMATCH",
    });
    assert.deepEqual(mergeEvidenceSummaries(a, contractSummary(instance, 4, 4)), { ok: false, reason: "NOT_CONTIGUOUS" });
  });
});

describe("deriveMissingRateLimitDelta (§7.3)", () => {
  const instance = randomUUID();

  it("S-C: cumulative − delta of the first observed summary", () => {
    // Sequences 5..6 observed (delta = counters(2)), cumulative counters(10): 1..4 carried counters(8).
    assert.deepEqual(deriveMissingRateLimitDelta(contractSummary(instance, 5, 6, 10).rateLimit, null), contractCounters(8));
  });

  it("S-B: cumulative − delta − prior cumulative", () => {
    const prior = contractSummary(instance, 1, 2, 3).rateLimit;
    assert.deepEqual(deriveMissingRateLimitDelta(contractSummary(instance, 5, 6, 10).rateLimit, prior), contractCounters(5));
  });

  it("NOT_DERIVABLE when the contract is violated: a negative field, an overlapping or foreign prior", () => {
    const r = contractSummary(instance, 5, 6, 10).rateLimit;
    assert.equal(deriveMissingRateLimitDelta(r, contractSummary(instance, 1, 2, 9).rateLimit), "NOT_DERIVABLE");
    assert.equal(deriveMissingRateLimitDelta(r, contractSummary(instance, 1, 5, 3).rateLimit), "NOT_DERIVABLE");
    assert.equal(deriveMissingRateLimitDelta(r, contractSummary(randomUUID(), 1, 2, 3).rateLimit), "NOT_DERIVABLE");
    assert.equal(deriveMissingRateLimitDelta(contractSummary(instance, 5, 6, 1).rateLimit, null), "NOT_DERIVABLE");
  });
});

describe("payload readers and value checks", () => {
  const families = { rateLimit: contractCounters(1), audit: contractAuditCounters(1) };
  const gapPayload = {
    schemaVersion: 1,
    lastDurableSequence: 1,
    cumulativeAsOfLastDurable: families,
    detectedAt: T1,
    detectedByInstanceId: randomUUID(),
  };

  it("readUncleanGapPayload accepts exactly the declared shape", () => {
    assert.deepEqual(readUncleanGapPayload(gapPayload), gapPayload);
    assert.equal(readUncleanGapPayload({ ...gapPayload, schemaVersion: 2 }), null);
    assert.equal(readUncleanGapPayload({ ...gapPayload, extra: 1 }), null);
    assert.equal(readUncleanGapPayload({ ...gapPayload, lastDurableSequence: 1.5 }), null);
    assert.equal(
      readUncleanGapPayload({ ...gapPayload, cumulativeAsOfLastDurable: { ...families, audit: { submitted: 1 } } }),
      null,
    );
    assert.equal(readUncleanGapPayload("text"), null);
  });

  it("readSummaryCumulative and readInstanceStartedPayload reject unsupported versions and shapes", () => {
    assert.equal(readSummaryCumulative({ ...contractSummary(randomUUID(), 1, 1), schemaVersion: 2 }), null);
    assert.equal(readSummaryCumulative({ schemaVersion: 1 }), null);
    assert.equal(readInstanceStartedPayload({ schemaVersion: 1, instanceStartedAt: "x", scope: "s", limiterInstanceId: randomUUID() }), null);
  });

  it("isIsoMillis and isLowerUuid", () => {
    assert.ok(isIsoMillis(T0));
    for (const value of ["2026-10-21T10:00:00Z", "2026-02-30T00:00:00.000Z", "2026-10-21T10:00:00.000+00:00", 0]) {
      assert.equal(isIsoMillis(value), false, String(value));
    }
    const id = randomUUID();
    assert.ok(isLowerUuid(id));
    assert.equal(isLowerUuid(id.toUpperCase()), false);
  });
});
