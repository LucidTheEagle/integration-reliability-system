/**
 * The shared EvidenceStore contract suite (addendum RD-2): the same tests
 * run against the in-memory store (evidence-store.test.ts) and against the
 * PostgreSQL store through its adapter (evidence-store-postgres.db.test.ts).
 *
 * Test-only code: not exported from index.ts and not itself a test file.
 * It uses only the port and the fixture, so a result here is a statement
 * about whichever store the fixture provides.
 */
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ZERO_AUDIT_COUNTERS,
  buildEvidenceRecord,
  buildRejectionRecord,
  freezeDiscontinuityGap,
  freezeInstanceClosed,
  freezeInstanceStarted,
  freezeSummary,
  freezeUncleanGap,
  recordHash,
} from "./evidence-records.js";
import type {
  AuditRecorderCounters,
  EvidenceRecordFields,
  EvidenceSummary,
  FrozenEvidenceRecord,
  FrozenRejectionRecord,
  JsonValue,
} from "./evidence-records.js";
import { evidenceRowFields } from "./evidence-store.js";
import type {
  DurableInstanceState,
  EvidenceRow,
  EvidenceStore,
  RejectionRow,
  WriteResult,
} from "./evidence-store.js";
import type { Counters, RateLimitSummary } from "./rate-limit.js";

export interface EvidenceStoreFixture {
  readonly store: EvidenceStore;
  /** Unique to this fixture; every evidence row the suite creates uses `scope` or `otherScope`. */
  readonly scope: string;
  readonly otherScope: string;
  /** Unique to this fixture; the metadata.limiterInstanceId of every rejection row the suite creates. */
  readonly rejectionTag: string;
  /** The store's monotonic clock (the verifyRegistration deadline clock). */
  now(): number;
  /** Out-of-protocol INSERT; the table's constraints apply. */
  seedRaw(row: EvidenceRow): Promise<void>;
  /** Out-of-protocol UPDATE; the table's constraints apply. */
  alterRaw(id: string, changes: Partial<Omit<EvidenceRow, "id">>): Promise<void>;
  /** One instance's committed rows. */
  readRaw(limiterInstanceId: string): Promise<readonly EvidenceRow[]>;
  readRejection(id: string): Promise<RejectionRow | null>;
  /** The violated constraint's name carried by a store error, if any. */
  constraintOf(error: unknown): string | undefined;
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Builders (deterministic content; fresh random ids)

export const CONTRACT_T0 = "2026-10-21T10:00:00.000Z";
const T1 = "2026-10-21T10:01:00.000Z";
const T2 = "2026-10-21T10:02:00.000Z";

/** Task 011B counters with every field 0 except L2 individualRejections = n and L1 limited = 2n. */
export function contractCounters(n: number): Counters {
  const layer = (individualRejections: number, limited: number) => ({
    limited,
    limitedPrecheck: 0,
    limitedConverted: 0,
    limitedViaOverflow: 0,
    overflowAdmissions: 0,
    individualRejections,
  });
  return {
    layers: { L1: layer(0, 2 * n), L2: layer(n, 0), L3: layer(0, 0) },
    abortedBeforeResponse: 0,
    limiterFaults: 0,
    logLinesSuppressed: 0,
  };
}

export function contractAuditCounters(n: number): AuditRecorderCounters {
  return { ...ZERO_AUDIT_COUNTERS, submitted: n, finishObserved: n, admitted: n, persisted: n };
}

/** A summary of sequences first..last whose cumulative values are `cumulative` (delta = per-sequence share). */
export function contractSummary(
  limiterInstanceId: string,
  first: number,
  last: number,
  cumulative = last,
): EvidenceSummary {
  const span = last - first + 1;
  const distinct = { count: 0, saturated: false, lowerBound: false };
  const gauge = { tableSize: 1, tableCapacity: 10_000 };
  const rateLimit: RateLimitSummary = {
    schemaVersion: 1,
    limiterInstanceId,
    instanceStartedAt: CONTRACT_T0,
    firstSequence: first,
    lastSequence: last,
    intervalStartedAt: CONTRACT_T0,
    intervalEndedAt: T1,
    intervalMs: 60_000.25,
    delta: contractCounters(span),
    distinctKeys: { L1: distinct, L2: distinct, L3: distinct },
    cumulative: contractCounters(cumulative),
    gauges: { L1: gauge, L2: gauge, L3: gauge },
  };
  return {
    schemaVersion: 1,
    rateLimit,
    audit: {
      intervalStartedAt: CONTRACT_T0,
      intervalEndedAt: T1,
      delta: contractAuditCounters(span),
      cumulative: contractAuditCounters(cumulative),
      gauges: { queueDepth: 0, queueCapacity: 1_000 },
    },
    pairingFaults: 0,
    alignment: "ALIGNED",
  };
}

function started(scope: string, limiterInstanceId: string): FrozenEvidenceRecord {
  return freezeInstanceStarted({
    id: randomUUID(),
    limiterInstanceId,
    scope,
    recordedAt: CONTRACT_T0,
    instanceStartedAt: CONTRACT_T0,
    rateLimitPolicies: { L2: { bucket: { capacity: 20, refillPerSecond: 1 / 30 } } },
    auditPolicies: { queueCapacity: 1_000 },
  });
}

function summary(scope: string, limiterInstanceId: string, first: number, last: number): FrozenEvidenceRecord {
  return freezeSummary({
    id: randomUUID(),
    scope,
    recordedAt: T1,
    summary: contractSummary(limiterInstanceId, first, last),
  });
}

function seqGap(scope: string, limiterInstanceId: string, from: number, to: number): FrozenEvidenceRecord {
  return freezeDiscontinuityGap({
    id: randomUUID(),
    limiterInstanceId,
    scope,
    recordedAt: T1,
    missingFrom: from,
    missingTo: to,
    initial: false,
    cause: "SEQUENCE_DISCONTINUITY",
    rateLimitDelta: contractCounters(to - from + 1),
    detectedAt: T1,
  });
}

function closed(scope: string, limiterInstanceId: string, finalSequence: number): FrozenEvidenceRecord {
  return freezeInstanceClosed({
    id: randomUUID(),
    limiterInstanceId,
    scope,
    recordedAt: T2,
    finalSequence,
    cumulative: { rateLimit: contractCounters(finalSequence), audit: contractAuditCounters(finalSequence) },
    forcedClose: false,
    closedAt: T2,
  });
}

function uncleanGapFrom(scope: string, state: DurableInstanceState): FrozenEvidenceRecord {
  return freezeUncleanGap({
    id: randomUUID(),
    limiterInstanceId: state.limiterInstanceId,
    scope,
    recordedAt: T2,
    lastDurableSequence: state.lastDurableSequence,
    cumulativeAsOfLastDurable:
      state.cumulativeAsOfLastDurable === null || state.auditCumulativeAsOfLastDurable === null
        ? null
        : { rateLimit: state.cumulativeAsOfLastDurable, audit: state.auditCumulativeAsOfLastDurable },
    detectedAt: T2,
    detectedByInstanceId: randomUUID(),
  });
}

/** The same record with some fields changed and its hash recomputed. */
function variant(record: FrozenEvidenceRecord, changes: Partial<EvidenceRecordFields>): FrozenEvidenceRecord {
  return buildEvidenceRecord({ ...evidenceRowFields(asRow(record)), ...changes });
}

function withPayload(record: FrozenEvidenceRecord, changes: Record<string, JsonValue>): FrozenEvidenceRecord {
  return variant(record, { payload: { ...(record.payload as Record<string, JsonValue>), ...changes } });
}

function asRow(record: FrozenEvidenceRecord): EvidenceRow {
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

function byId(rows: readonly EvidenceRow[]): EvidenceRow[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function rejection(tag: string, changes: Partial<FrozenRejectionRecord> = {}): FrozenRejectionRecord {
  const id = changes.id ?? randomUUID();
  return buildRejectionRecord({
    id,
    actorType: "EXTERNAL_SENDER",
    actorId: null,
    action: "EVENT_REJECTED",
    entityType: "WEBHOOK_DELIVERY",
    entityId: id,
    metadata: {
      schemaVersion: 1,
      limiterInstanceId: tag,
      stage: "VERIFIER",
      httpStatus: 401,
      errorCode: "UNAUTHORIZED",
      claimedIntegrationId: "0f6a8b2c-1d3e-4f50-8a6b-7c8d9e0f1a2b",
      verifierReason: "SIGNATURE_MISMATCH",
      responseCompletion: "FINISH_OBSERVED",
      receivedAt: CONTRACT_T0,
    },
    createdAt: T1,
    ...changes,
  });
}

function rejectionAsRow(record: FrozenRejectionRecord): RejectionRow {
  return {
    id: record.id,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    metadata: record.metadata as unknown as JsonValue,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// The suite

export function runEvidenceStoreContract(
  name: string,
  createFixture: () => Promise<EvidenceStoreFixture>,
): void {
  async function withFixture(body: (f: EvidenceStoreFixture) => Promise<void>): Promise<void> {
    const f = await createFixture();
    try {
      await body(f);
    } finally {
      await f.cleanup();
    }
  }

  async function write(f: EvidenceStoreFixture, ...records: FrozenEvidenceRecord[]): Promise<readonly WriteResult[]> {
    return f.store.writeEvidenceGroup(records);
  }

  /** An instance with INSTANCE_STARTED and SUMMARY 1..2, and its UNCLEAN_TERMINATION gap written through the protocol. */
  async function uncleanInstance(f: EvidenceStoreFixture): Promise<{ instance: string; gap: FrozenEvidenceRecord }> {
    const instance = randomUUID();
    assert.deepEqual(await write(f, started(f.scope, instance), summary(f.scope, instance, 1, 2)), [
      "CREATED",
      "CREATED",
    ]);
    const gap = uncleanGapFrom(f.scope, await f.store.readDurableState(instance));
    assert.equal(await f.store.writeUncleanGap(gap, await f.store.readDurableState(instance)), "CREATED");
    return { instance, gap };
  }

  /** Out-of-protocol change of a stored row, with its stored hash recomputed so only the change is wrong. */
  async function alterRehashed(
    f: EvidenceStoreFixture,
    record: FrozenEvidenceRecord,
    changes: Partial<Omit<EvidenceRow, "id">>,
  ): Promise<void> {
    const row = { ...asRow(record), ...changes };
    await f.alterRaw(record.id, { ...changes, recordSha256: recordHash(evidenceRowFields(row)) });
  }

  describe(`${name}: EvidenceStore contract`, () => {
    describe("idempotent writes and complete-record comparison (B7b, A-T5(e))", () => {
      it("INSTANCE_STARTED: CREATED, then IDENTICAL_EXISTS; the stored row equals the frozen record", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          const record = started(f.scope, instance);
          assert.deepEqual(await write(f, record), ["CREATED"]);
          assert.deepEqual(await write(f, record), ["IDENTICAL_EXISTS"]);
          assert.deepEqual(await f.readRaw(instance), [asRow(record)]);
        });
      });

      const cases: readonly {
        readonly kind: string;
        readonly make: (f: EvidenceStoreFixture, instance: string) => Promise<FrozenEvidenceRecord>;
        readonly variants: readonly (readonly [string, (r: FrozenEvidenceRecord, f: EvidenceStoreFixture) => FrozenEvidenceRecord])[];
      }[] = [
        {
          kind: "INSTANCE_STARTED",
          make: async (f, instance) => {
            const record = started(f.scope, instance);
            assert.deepEqual(await write(f, record), ["CREATED"]);
            return record;
          },
          variants: [
            ["recordedAt", (r) => variant(r, { recordedAt: T2 })],
            ["scope", (r, f) => variant(r, { scope: f.otherScope })],
            ["id", (r) => variant(r, { id: randomUUID() })],
            ["firstSequence", (r) => variant(r, { firstSequence: 1 })],
            ["missingFrom", (r) => variant(r, { missingFrom: 1 })],
            ["one payload field", (r) => withPayload(r, { instanceStartedAt: T1 })],
          ],
        },
        {
          kind: "SUMMARY",
          make: async (f, instance) => {
            const record = summary(f.scope, instance, 1, 3);
            assert.deepEqual(await write(f, record), ["CREATED"]);
            return record;
          },
          variants: [
            ["recordedAt", (r) => variant(r, { recordedAt: T2 })],
            ["scope", (r, f) => variant(r, { scope: f.otherScope })],
            ["id", (r) => variant(r, { id: randomUUID() })],
            ["missingFrom", (r) => variant(r, { missingFrom: 1 })],
            ["one payload field", (r) => withPayload(r, { pairingFaults: 1 })],
          ],
        },
        {
          kind: "EVIDENCE_GAP (SEQUENCE_DISCONTINUITY)",
          make: async (f, instance) => {
            const record = seqGap(f.scope, instance, 4, 6);
            assert.deepEqual(await write(f, record), ["CREATED"]);
            return record;
          },
          variants: [
            ["recordedAt", (r) => variant(r, { recordedAt: T2 })],
            ["scope", (r, f) => variant(r, { scope: f.otherScope })],
            ["id", (r) => variant(r, { id: randomUUID() })],
            ["firstSequence", (r) => variant(r, { firstSequence: 1 })],
            ["one payload field", (r) => withPayload(r, { initial: true })],
          ],
        },
        {
          kind: "INSTANCE_CLOSED",
          make: async (f, instance) => {
            const record = closed(f.scope, instance, 3);
            assert.deepEqual(await write(f, record), ["CREATED"]);
            return record;
          },
          variants: [
            ["recordedAt", (r) => variant(r, { recordedAt: T1 })],
            ["scope", (r, f) => variant(r, { scope: f.otherScope })],
            ["id", (r) => variant(r, { id: randomUUID() })],
            ["lastSequence", (r) => variant(r, { lastSequence: 3 })],
            ["one payload field", (r) => withPayload(r, { forcedClose: true })],
          ],
        },
      ];

      for (const { kind, make, variants } of cases) {
        it(`${kind}: same natural key with any differing field → CONFLICT; the stored row is unchanged`, async () => {
          await withFixture(async (f) => {
            const instance = randomUUID();
            const record = await make(f, instance);
            for (const [label, change] of variants) {
              assert.deepEqual(await write(f, change(record, f)), ["CONFLICT"], label);
            }
            assert.deepEqual(await write(f, record), ["IDENTICAL_EXISTS"]);
            assert.deepEqual(await f.readRaw(instance), [asRow(record)]);
          });
        });
      }

      it("EVIDENCE_GAP (UNCLEAN_TERMINATION) through writeUncleanGap: any differing field → CONFLICT; unchanged", async () => {
        await withFixture(async (f) => {
          const { instance, gap } = await uncleanInstance(f);
          const state = await f.store.readDurableState(instance);
          const variants: readonly (readonly [string, FrozenEvidenceRecord])[] = [
            ["recordedAt", variant(gap, { recordedAt: T1 })],
            ["scope", variant(gap, { scope: f.otherScope })],
            ["id", variant(gap, { id: randomUUID() })],
            ["missingFrom", variant(gap, { missingFrom: 1 })],
            ["one payload field", withPayload(gap, { detectedByInstanceId: randomUUID() })],
          ];
          for (const [label, other] of variants) {
            assert.equal(await f.store.writeUncleanGap(other, state), "CONFLICT", label);
          }
          assert.equal(await f.store.writeUncleanGap(gap, state), "IDENTICAL_EXISTS");
          const gaps = (await f.readRaw(instance)).filter((row) => row.kind === "EVIDENCE_GAP");
          assert.deepEqual(gaps, [asRow(gap)]);
        });
      });

      it("a stored row whose own hash does not match its fields is CONFLICT, even for the identical record", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          const record = started(f.scope, instance);
          assert.deepEqual(await write(f, record), ["CREATED"]);
          await f.alterRaw(record.id, { recordSha256: "0".repeat(64) });
          assert.deepEqual(await write(f, record), ["CONFLICT"]);
        });
      });
    });

    describe("groups: atomicity, overlap and seal rules (§7.4)", () => {
      it("a CONFLICT anywhere in a group rolls back the whole group", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          const start = started(f.scope, instance);
          assert.deepEqual(await write(f, start), ["CREATED"]);
          const results = await write(f, summary(f.scope, instance, 1, 1), variant(start, { recordedAt: T2 }));
          assert.deepEqual(results, ["CREATED", "CONFLICT"]);
          assert.deepEqual(await f.readRaw(instance), [asRow(start)]);
        });
      });

      it("records see the group's earlier records; an identical retry of a group is IDENTICAL_EXISTS per record", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          const a = summary(f.scope, instance, 1, 1);
          const b = summary(f.scope, instance, 2, 3);
          assert.deepEqual(await write(f, a, b), ["CREATED", "CREATED"]);
          assert.deepEqual(await write(f, a, b), ["IDENTICAL_EXISTS", "IDENTICAL_EXISTS"]);
          const c = summary(f.scope, instance, 4, 4);
          assert.deepEqual(await write(f, b, c), ["IDENTICAL_EXISTS", "CREATED"]);
          assert.deepEqual(byId(await f.readRaw(instance)), byId([a, b, c].map(asRow)));
          // Inside one group, a later overlapping record sees the earlier one.
          const d = summary(f.scope, instance, 5, 6);
          assert.deepEqual(await write(f, d, summary(f.scope, instance, 6, 7)), ["CREATED", "OVERLAP"]);
          assert.equal((await f.readRaw(instance)).length, 3);
        });
      });

      it("OVERLAP: a range intersecting a stored SUMMARY or discontinuity gap of the same instance", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          const s13 = summary(f.scope, instance, 1, 3);
          assert.deepEqual(await write(f, s13), ["CREATED"]);
          assert.deepEqual(await write(f, summary(f.scope, instance, 2, 4)), ["OVERLAP"]);
          assert.deepEqual(await write(f, summary(f.scope, instance, 3, 3)), ["OVERLAP"]);
          assert.deepEqual(await write(f, seqGap(f.scope, instance, 3, 5)), ["OVERLAP"]);
          assert.deepEqual(await write(f, s13), ["IDENTICAL_EXISTS"]);
          const g45 = seqGap(f.scope, instance, 4, 5);
          assert.deepEqual(await write(f, g45), ["CREATED"]);
          assert.deepEqual(await write(f, summary(f.scope, instance, 5, 6)), ["OVERLAP"]);
          const s66 = summary(f.scope, instance, 6, 6);
          assert.deepEqual(await write(f, s66), ["CREATED"]);
          // Ranges of another instance never overlap.
          const other = randomUUID();
          assert.deepEqual(await write(f, summary(f.scope, other, 1, 3)), ["CREATED"]);
          assert.deepEqual(byId(await f.readRaw(instance)), byId([s13, g45, s66].map(asRow)));
        });
      });

      it("SEALED: after an UNCLEAN_TERMINATION gap, a new SUMMARY, discontinuity gap or close is rejected", async () => {
        await withFixture(async (f) => {
          const { instance } = await uncleanInstance(f);
          const before = byId(await f.readRaw(instance));
          assert.deepEqual(await write(f, summary(f.scope, instance, 3, 3)), ["SEALED"]);
          assert.deepEqual(await write(f, seqGap(f.scope, instance, 3, 4)), ["SEALED"]);
          assert.deepEqual(await write(f, closed(f.scope, instance, 2)), ["SEALED"]);
          // A record identical to a stored one is still IDENTICAL_EXISTS.
          const stored = before.find((row) => row.kind === "SUMMARY") as EvidenceRow;
          const storedStart = before.find((row) => row.kind === "INSTANCE_STARTED") as EvidenceRow;
          const summaryRecord = buildEvidenceRecord(evidenceRowFields(stored));
          assert.deepEqual(await write(f, summaryRecord), ["IDENTICAL_EXISTS"]);
          assert.deepEqual(await write(f, buildEvidenceRecord(evidenceRowFields(storedStart))), ["IDENTICAL_EXISTS"]);
          // A sealed result rolls back the group's other records.
          assert.deepEqual(await write(f, summaryRecord, summary(f.scope, instance, 3, 3)), [
            "IDENTICAL_EXISTS",
            "SEALED",
          ]);
          assert.deepEqual(byId(await f.readRaw(instance)), before);
        });
      });
    });

    describe("Case A: writeUncleanGap (§8.1, AN4 E2 Option A)", () => {
      it("CREATED; an identical retry is IDENTICAL_EXISTS; a different gap is CONFLICT", async () => {
        await withFixture(async (f) => {
          const { instance, gap } = await uncleanInstance(f);
          const state = await f.store.readDurableState(instance);
          assert.equal(await f.store.writeUncleanGap(gap, state), "IDENTICAL_EXISTS");
          assert.equal(await f.store.writeUncleanGap(uncleanGapFrom(f.scope, state), state), "CONFLICT");
          const gaps = (await f.readRaw(instance)).filter((row) => row.kind === "EVIDENCE_GAP");
          assert.deepEqual(gaps, [asRow(gap)]);
        });
      });

      it("STALE_STATE when durable state changed after the unlocked read; nothing written; re-derivation succeeds", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          await write(f, started(f.scope, instance), summary(f.scope, instance, 1, 2));
          const stale = await f.store.readDurableState(instance);
          assert.deepEqual(await write(f, summary(f.scope, instance, 3, 3)), ["CREATED"]);
          assert.equal(await f.store.writeUncleanGap(uncleanGapFrom(f.scope, stale), stale), "STALE_STATE");
          assert.equal((await f.readRaw(instance)).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
          const fresh = await f.store.readDurableState(instance);
          assert.equal(fresh.lastDurableSequence, 3);
          const gap = uncleanGapFrom(f.scope, fresh);
          assert.equal(await f.store.writeUncleanGap(gap, fresh), "CREATED");
          assert.equal((gap.payload as { lastDurableSequence: number }).lastDurableSequence, 3);
        });
      });

      it("CLOSED_EXISTS when a close became visible after the read; nothing written", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          await write(f, started(f.scope, instance), summary(f.scope, instance, 1, 2));
          const state = await f.store.readDurableState(instance);
          assert.deepEqual(await write(f, closed(f.scope, instance, 2)), ["CREATED"]);
          assert.equal(await f.store.writeUncleanGap(uncleanGapFrom(f.scope, state), state), "CLOSED_EXISTS");
          assert.equal((await f.readRaw(instance)).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
        });
      });

      it("the close check precedes the existing-gap check (a pre-existing pair resolves CLOSED_EXISTS)", async () => {
        await withFixture(async (f) => {
          const { instance } = await uncleanInstance(f);
          await f.seedRaw(asRow(closed(f.scope, instance, 2)));
          const state = await f.store.readDurableState(instance);
          assert.equal(await f.store.writeUncleanGap(uncleanGapFrom(f.scope, state), state), "CLOSED_EXISTS");
        });
      });
    });

    describe("reads", () => {
      it("readDurableState: zero and nulls without a summary; the maximum summary's cumulative values otherwise", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          await write(f, started(f.scope, instance));
          assert.deepEqual(await f.store.readDurableState(instance), {
            limiterInstanceId: instance,
            startedScope: f.scope,
            lastDurableSequence: 0,
            cumulativeAsOfLastDurable: null,
            auditCumulativeAsOfLastDurable: null,
          });
          await write(f, summary(f.scope, instance, 3, 5), summary(f.scope, instance, 1, 2));
          assert.deepEqual(await f.store.readDurableState(instance), {
            limiterInstanceId: instance,
            startedScope: f.scope,
            lastDurableSequence: 5,
            cumulativeAsOfLastDurable: contractCounters(5),
            auditCumulativeAsOfLastDurable: contractAuditCounters(5),
          });
        });
      });

      it("readDurableState rejects for an instance without INSTANCE_STARTED", async () => {
        await withFixture(async (f) => {
          await assert.rejects(f.store.readDurableState(randomUUID()));
        });
      });

      it("findRecoveryCandidates (A-T16): this scope only, unclosed, the current instance excluded, with the gap flag", async () => {
        await withFixture(async (f) => {
          const [open, closedOne, otherScope, unclean, self] = [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
          ];
          await write(f, started(f.scope, open));
          await write(f, started(f.scope, closedOne), summary(f.scope, closedOne, 1, 1), closed(f.scope, closedOne, 1));
          await write(f, started(f.otherScope, otherScope));
          await write(f, started(f.scope, unclean));
          const state = await f.store.readDurableState(unclean);
          assert.equal(await f.store.writeUncleanGap(uncleanGapFrom(f.scope, state), state), "CREATED");
          await write(f, started(f.scope, self));
          const expected = [
            { limiterInstanceId: open, hasUncleanGap: false },
            { limiterInstanceId: unclean, hasUncleanGap: true },
          ].sort((a, b) => (a.limiterInstanceId < b.limiterInstanceId ? -1 : 1));
          assert.deepEqual(await f.store.findRecoveryCandidates(f.scope, self), expected);
        });
      });

      it("verifyRegistration: present after INSTANCE_STARTED, absent otherwise; it writes nothing", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          assert.deepEqual(await f.store.verifyRegistration(instance, f.now() + 1_000), { present: false });
          await write(f, started(f.scope, instance));
          const before = await f.readRaw(instance);
          assert.deepEqual(await f.store.verifyRegistration(instance, f.now() + 1_000), { present: true });
          assert.deepEqual(await f.readRaw(instance), before);
        });
      });

      it("verifyRegistration rejects when the deadline has passed", async () => {
        await withFixture(async (f) => {
          await assert.rejects(f.store.verifyRegistration(randomUUID(), f.now() - 1));
        });
      });
    });

    describe("Case B: validateHistoricalGap (§8.1)", () => {
      it("valid for a gap written through the protocol; nothing is written", async () => {
        await withFixture(async (f) => {
          const { instance } = await uncleanInstance(f);
          const before = byId(await f.readRaw(instance));
          assert.deepEqual(await f.store.validateHistoricalGap(instance, f.scope), { valid: true });
          assert.deepEqual(byId(await f.readRaw(instance)), before);
        });
      });

      it("NO_GAP without an UNCLEAN_TERMINATION gap", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          await write(f, started(f.scope, instance));
          assert.deepEqual(await f.store.validateHistoricalGap(instance, f.scope), { valid: false, reason: "NO_GAP" });
        });
      });

      const invalid: readonly (readonly [
        string,
        string,
        (f: EvidenceStoreFixture, instance: string, gap: FrozenEvidenceRecord) => Promise<string | undefined>,
      ])[] = [
        ["a field changed without its hash", "HASH_MISMATCH", async (f, _i, gap) => {
          await f.alterRaw(gap.id, { payload: { ...(gap.payload as Record<string, JsonValue>), detectedAt: T1 } });
          return undefined;
        }],
        ["a payload that is not an object", "UNREADABLE", async (f, _i, gap) => {
          await alterRehashed(f, gap, { payload: "not an object" });
          return undefined;
        }],
        ["a sequence field set", "IDENTITY_MISMATCH", async (f, _i, gap) => {
          await alterRehashed(f, gap, { missingFrom: 1 });
          return undefined;
        }],
        ["another scope requested", "SCOPE_MISMATCH", async (f) => f.otherScope],
        ["the gap's scope differs from INSTANCE_STARTED's", "SCOPE_MISMATCH", async (f, _i, gap) => {
          await alterRehashed(f, gap, { scope: f.otherScope });
          return f.otherScope;
        }],
        ["an unsupported schemaVersion", "UNSUPPORTED_PAYLOAD", async (f, _i, gap) => {
          await alterRehashed(f, gap, { payload: { ...(gap.payload as Record<string, JsonValue>), schemaVersion: 2 } });
          return undefined;
        }],
        ["detected by the instance itself", "UNSUPPORTED_PAYLOAD", async (f, instance, gap) => {
          await alterRehashed(f, gap, {
            payload: { ...(gap.payload as Record<string, JsonValue>), detectedByInstanceId: instance },
          });
          return undefined;
        }],
        ["detected before the instance started", "UNSUPPORTED_PAYLOAD", async (f, _i, gap) => {
          await alterRehashed(f, gap, {
            payload: { ...(gap.payload as Record<string, JsonValue>), detectedAt: "2026-10-21T09:59:59.999Z" },
          });
          return undefined;
        }],
        ["a lastDurableSequence that is not the durable one", "DURABLE_FACTS_MISMATCH", async (f, _i, gap) => {
          await alterRehashed(f, gap, {
            payload: { ...(gap.payload as Record<string, JsonValue>), lastDurableSequence: 1 },
          });
          return undefined;
        }],
        ["a summary added after the gap, out of protocol", "DURABLE_FACTS_MISMATCH", async (f, instance) => {
          await f.seedRaw(asRow(summary(f.scope, instance, 3, 3)));
          return undefined;
        }],
      ];

      for (const [label, reason, corrupt] of invalid) {
        it(`${reason}: ${label}`, async () => {
          await withFixture(async (f) => {
            const { instance, gap } = await uncleanInstance(f);
            const scope = (await corrupt(f, instance, gap)) ?? f.scope;
            assert.deepEqual(await f.store.validateHistoricalGap(instance, scope), { valid: false, reason });
          });
        });
      }
    });

    describe("EVENT_REJECTED batches: writeRejections (§5.4, A-T11 store half)", () => {
      it("CREATED, then IDENTICAL_EXISTS; the stored row equals the frozen record, createdAt included", async () => {
        await withFixture(async (f) => {
          const a = rejection(f.rejectionTag);
          const b = rejection(f.rejectionTag);
          assert.deepEqual(await f.store.writeRejections([a, b]), ["CREATED", "CREATED"]);
          assert.deepEqual(await f.store.writeRejections([a, b]), ["IDENTICAL_EXISTS", "IDENTICAL_EXISTS"]);
          assert.deepEqual(await f.readRejection(a.id), rejectionAsRow(a));
          assert.deepEqual(await f.readRejection(b.id), rejectionAsRow(b));
        });
      });

      it("any differing column → CONFLICT, never overwritten; a CONFLICT does not roll back the batch", async () => {
        await withFixture(async (f) => {
          const a = rejection(f.rejectionTag);
          assert.deepEqual(await f.store.writeRejections([a]), ["CREATED"]);
          const variants: readonly (readonly [string, FrozenRejectionRecord])[] = [
            ["createdAt only", rejection(f.rejectionTag, { id: a.id, createdAt: T2 })],
            ["one metadata field", rejection(f.rejectionTag, { id: a.id, metadata: { ...a.metadata, verifierReason: "TIMESTAMP_SKEW" } })],
            ["entityId", rejection(f.rejectionTag, { id: a.id, entityId: randomUUID() })],
          ];
          for (const [label, other] of variants) {
            assert.deepEqual(await f.store.writeRejections([other]), ["CONFLICT"], label);
          }
          const c = rejection(f.rejectionTag);
          assert.deepEqual(await f.store.writeRejections([c, (variants[0] as readonly [string, FrozenRejectionRecord])[1]]), [
            "CREATED",
            "CONFLICT",
          ]);
          assert.deepEqual(await f.readRejection(a.id), rejectionAsRow(a));
          assert.deepEqual(await f.readRejection(c.id), rejectionAsRow(c));
        });
      });
    });

    describe("A-T20: shape constraints reject malformed records; the whole group rolls back", () => {
      const malformed: readonly (readonly [string, string, (instance: string, scope: string) => EvidenceRecordFields])[] = [
        ["SUMMARY with a null firstSequence", "rle_summary_shape_ck", (i, s) => fields(i, s, "SUMMARY", { firstSequence: null, lastSequence: 3 })],
        ["SUMMARY with a null lastSequence", "rle_summary_shape_ck", (i, s) => fields(i, s, "SUMMARY", { firstSequence: 3, lastSequence: null })],
        ["SUMMARY with firstSequence 0", "rle_summary_shape_ck", (i, s) => fields(i, s, "SUMMARY", { firstSequence: 0, lastSequence: 0 })],
        ["SUMMARY with an inverted range", "rle_summary_shape_ck", (i, s) => fields(i, s, "SUMMARY", { firstSequence: 5, lastSequence: 4 })],
        ["discontinuity gap with a null missingTo", "rle_gap_shape_ck", (i, s) => fields(i, s, "EVIDENCE_GAP", { gapReason: "SEQUENCE_DISCONTINUITY", missingFrom: 3, missingTo: null })],
        ["discontinuity gap with missingFrom 0", "rle_gap_shape_ck", (i, s) => fields(i, s, "EVIDENCE_GAP", { gapReason: "SEQUENCE_DISCONTINUITY", missingFrom: 0, missingTo: 2 })],
        ["discontinuity gap with an inverted range", "rle_gap_shape_ck", (i, s) => fields(i, s, "EVIDENCE_GAP", { gapReason: "SEQUENCE_DISCONTINUITY", missingFrom: 5, missingTo: 3 })],
        ["gap without a reason", "rle_gap_reason_ck", (i, s) => fields(i, s, "EVIDENCE_GAP", { gapReason: null, missingFrom: 3, missingTo: 4 })],
        ["gap with an unknown reason", "rle_gap_reason_ck", (i, s) => fields(i, s, "EVIDENCE_GAP", { gapReason: "OTHER" as never })],
        ["an unknown kind", "rle_kind_ck", (i, s) => fields(i, s, "BOGUS" as never, {})],
      ];

      for (const [label, constraint, make] of malformed) {
        it(`${label} → ${constraint}`, async () => {
          await withFixture(async (f) => {
            const instance = randomUUID();
            // Sequence 10 intersects no malformed range, so each case reaches its CHECK.
            const valid = summary(f.scope, instance, 10, 10);
            const bad = buildEvidenceRecord(make(instance, f.scope));
            const error = await f.store.writeEvidenceGroup([valid, bad]).then(
              () => assert.fail("a malformed record was accepted"),
              (caught: unknown) => caught,
            );
            assert.equal(f.constraintOf(error), constraint);
            assert.deepEqual(await f.readRaw(instance), []);
          });
        });
      }

      it("well-formed SUMMARY and gaps are accepted", async () => {
        await withFixture(async (f) => {
          const instance = randomUUID();
          assert.deepEqual(
            await write(f, summary(f.scope, instance, 1, 1), seqGap(f.scope, instance, 2, 2), summary(f.scope, instance, 3, 4)),
            ["CREATED", "CREATED", "CREATED"],
          );
        });
      });
    });
  });
}

function fields(
  limiterInstanceId: string,
  scope: string,
  kind: EvidenceRecordFields["kind"],
  changes: Partial<EvidenceRecordFields>,
): EvidenceRecordFields {
  return {
    id: randomUUID(),
    limiterInstanceId,
    scope,
    kind,
    gapReason: null,
    firstSequence: null,
    lastSequence: null,
    missingFrom: null,
    missingTo: null,
    recordedAt: T1,
    payload: { schemaVersion: 1 },
    ...changes,
  };
}
