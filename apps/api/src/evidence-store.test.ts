import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  freezeInstanceClosed,
  freezeInstanceStarted,
  freezeSummary,
  freezeUncleanGap,
} from "./evidence-records.js";
import type { FrozenEvidenceRecord } from "./evidence-records.js";
import {
  InMemoryStoreError,
  classifyRegistrationVerification,
  createInMemoryEvidenceStore,
  storeErrorOutcome,
} from "./evidence-store.js";
import type { DurableInstanceState, EvidenceRow, EvidenceStore, InMemoryEvidenceStore } from "./evidence-store.js";
import { EVIDENCE_MAX_WAIT_MS } from "@irs/db";
import type { Database, PrismaClient } from "@irs/db";
import { createPostgresEvidenceStore } from "./evidence-store-postgres.js";
import {
  CONTRACT_T0,
  contractAuditCounters,
  contractCounters,
  contractSummary,
  runEvidenceStoreContract,
} from "./evidence-store-contract.js";

runEvidenceStoreContract("in-memory store", async () => {
  const store = createInMemoryEvidenceStore();
  return {
    store,
    scope: `contract-${randomUUID()}`,
    otherScope: `contract-other-${randomUUID()}`,
    rejectionTag: randomUUID(),
    now: () => performance.now(),
    seedRaw: async (row) => store.raw.seedEvidence(row),
    alterRaw: async (id, changes) => store.raw.alterOutsideProtocol(id, changes),
    readRaw: async (limiterInstanceId) => store.raw.evidenceRows(limiterInstanceId),
    readRejection: async (id) => store.raw.rejectionRow(id),
    constraintOf: (error) => (error instanceof InMemoryStoreError ? error.constraint : undefined),
    cleanup: async () => undefined,
  };
});

// ---------------------------------------------------------------------------
// In-memory-only behaviour: fault modes (A14 §7.5, AN4 E3). These are
// state-machine tests: they script store events and are never evidence of
// PostgreSQL locking, snapshot visibility or durability.

const SCOPE = "in-memory-tests";
const T1 = "2026-10-21T10:01:00.000Z";

function started(instance: string): FrozenEvidenceRecord {
  return freezeInstanceStarted({
    id: randomUUID(),
    limiterInstanceId: instance,
    scope: SCOPE,
    recordedAt: CONTRACT_T0,
    instanceStartedAt: CONTRACT_T0,
    rateLimitPolicies: {},
    auditPolicies: {},
  });
}

function summary(instance: string, first: number, last: number): FrozenEvidenceRecord {
  return freezeSummary({ id: randomUUID(), scope: SCOPE, recordedAt: T1, summary: contractSummary(instance, first, last) });
}

function closed(instance: string, finalSequence: number): FrozenEvidenceRecord {
  return freezeInstanceClosed({
    id: randomUUID(),
    limiterInstanceId: instance,
    scope: SCOPE,
    recordedAt: T1,
    finalSequence,
    cumulative: { rateLimit: contractCounters(finalSequence), audit: contractAuditCounters(finalSequence) },
    forcedClose: false,
    closedAt: T1,
  });
}

function gapFrom(state: DurableInstanceState): FrozenEvidenceRecord {
  return freezeUncleanGap({
    id: randomUUID(),
    limiterInstanceId: state.limiterInstanceId,
    scope: SCOPE,
    recordedAt: T1,
    lastDurableSequence: state.lastDurableSequence,
    cumulativeAsOfLastDurable:
      state.cumulativeAsOfLastDurable === null || state.auditCumulativeAsOfLastDurable === null
        ? null
        : { rateLimit: state.cumulativeAsOfLastDurable, audit: state.auditCumulativeAsOfLastDurable },
    detectedAt: T1,
    detectedByInstanceId: randomUUID(),
  });
}

/** Settles within a few macrotask turns, or reports that it is still pending. */
async function settledSoon<T>(promise: Promise<T>): Promise<{ settled: boolean }> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return { settled };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail("expected the call to throw"),
    (error: unknown) => error,
  );
}

async function registered(store: InMemoryEvidenceStore, lastSequence = 0): Promise<string> {
  const instance = randomUUID();
  const records = [started(instance)];
  if (lastSequence > 0) records.push(summary(instance, 1, lastSequence));
  await store.writeEvidenceGroup(records);
  return instance;
}

describe("in-memory store: fault modes", () => {
  it("failNext: the next N matching calls throw NOT_COMMITTED before doing anything", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    store.faults.failNext(2, { methods: ["writeEvidenceGroup"] });
    const first = await caught(store.writeEvidenceGroup([started(instance)]));
    assert.equal(storeErrorOutcome(first), "NOT_COMMITTED");
    await caught(store.writeEvidenceGroup([started(instance)]));
    assert.deepEqual(store.raw.evidenceRows(instance), []);
    // Other methods are unaffected; after N failures the method works again.
    assert.deepEqual(await store.findRecoveryCandidates(SCOPE, randomUUID()), []);
    assert.deepEqual(await store.writeEvidenceGroup([started(instance)]), ["CREATED"]);
  });

  it("failNext with outcome UNKNOWN reports UNKNOWN", async () => {
    const store = createInMemoryEvidenceStore();
    store.faults.failNext(1, { outcome: "UNKNOWN" });
    assert.equal(storeErrorOutcome(await caught(store.readDurableState(randomUUID()))), "UNKNOWN");
  });

  it("throwBeforeCommit: the group is rolled back (NOT_COMMITTED); the identical retry is CREATED", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    const group = [started(instance), summary(instance, 1, 1)];
    store.faults.throwBeforeCommit();
    assert.equal(storeErrorOutcome(await caught(store.writeEvidenceGroup(group))), "NOT_COMMITTED");
    assert.deepEqual(store.raw.evidenceRows(instance), []);
    assert.deepEqual(await store.writeEvidenceGroup(group), ["CREATED", "CREATED"]);
  });

  it("commitThenThrow (lost acknowledgement): committed, UNKNOWN; the identical retry is IDENTICAL_EXISTS", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    const group = [started(instance), summary(instance, 1, 1)];
    store.faults.commitThenThrow();
    assert.equal(storeErrorOutcome(await caught(store.writeEvidenceGroup(group))), "UNKNOWN");
    assert.equal(store.raw.evidenceRows(instance).length, 2);
    assert.deepEqual(await store.writeEvidenceGroup(group), ["IDENTICAL_EXISTS", "IDENTICAL_EXISTS"]);
  });

  it("commitThenThrow on a rejection batch: the identical retry is IDENTICAL_EXISTS", async () => {
    const store = createInMemoryEvidenceStore();
    const id = randomUUID();
    const record = {
      id,
      actorType: "EXTERNAL_SENDER",
      actorId: null,
      action: "EVENT_REJECTED",
      entityType: "WEBHOOK_DELIVERY",
      entityId: id,
      metadata: {
        schemaVersion: 1,
        limiterInstanceId: randomUUID(),
        stage: "VERIFIER",
        httpStatus: 401,
        errorCode: "UNAUTHORIZED",
        claimedIntegrationId: null,
        verifierReason: null,
        responseCompletion: "FINISH_OBSERVED",
        receivedAt: CONTRACT_T0,
      },
      createdAt: T1,
    } as const;
    store.faults.commitThenThrow({ methods: ["writeRejections"] });
    assert.equal(storeErrorOutcome(await caught(store.writeRejections([record]))), "UNKNOWN");
    assert.notEqual(store.raw.rejectionRow(id), null);
    assert.deepEqual(await store.writeRejections([record]), ["IDENTICAL_EXISTS"]);
  });

  it("delayCommit holds the instance lock: same-instance calls wait, other instances do not", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    const other = randomUUID();
    const gate = store.faults.delayCommit();
    const delayed = store.writeEvidenceGroup([started(instance)]);
    await gate.reached;
    const waiting = store.writeEvidenceGroup([summary(instance, 1, 1)]);
    assert.equal((await settledSoon(waiting)).settled, false);
    assert.deepEqual(await store.writeEvidenceGroup([started(other)]), ["CREATED"]);
    assert.deepEqual(store.raw.evidenceRows(instance), []);
    gate.release();
    assert.deepEqual(await delayed, ["CREATED"]);
    assert.deepEqual(await waiting, ["CREATED"]);
    assert.equal(store.raw.evidenceRows(instance).length, 2);
  });

  it("delayCommit released with thenThrow: committed, then UNKNOWN", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    const gate = store.faults.delayCommit();
    const delayed = store.writeEvidenceGroup([started(instance)]);
    await gate.reached;
    gate.release({ thenThrow: true });
    assert.equal(storeErrorOutcome(await caught(delayed)), "UNKNOWN");
    assert.equal(store.raw.evidenceRows(instance).length, 1);
  });

  it("hang: the call does not proceed until released, and holds no lock meanwhile", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    const hang = store.faults.hang({ methods: ["writeEvidenceGroup"] });
    const hung = store.writeEvidenceGroup([started(instance)]);
    await hang.reached;
    assert.equal((await settledSoon(hung)).settled, false);
    assert.deepEqual(await store.writeEvidenceGroup([summary(instance, 1, 1)]), ["CREATED"]);
    hang.release();
    assert.deepEqual(await hung, ["CREATED"]);
  });

  it("alterOutsideProtocol takes no lock: it applies while a delayed commit holds the instance lock", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = await registered(store);
    const [row] = store.raw.evidenceRows(instance) as [EvidenceRow];
    const gate = store.faults.delayCommit();
    const delayed = store.writeEvidenceGroup([summary(instance, 1, 1)]);
    await gate.reached;
    store.raw.alterOutsideProtocol(row.id, { recordSha256: "f".repeat(64) });
    assert.equal(store.raw.evidenceRows(instance)[0]?.recordSha256, "f".repeat(64));
    gate.release();
    assert.deepEqual(await delayed, ["CREATED"]);
  });

  it("the call log records every call in order, with the kinds of the records written", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    await store.writeEvidenceGroup([started(instance), summary(instance, 1, 1)]);
    await store.findRecoveryCandidates(SCOPE, instance);
    assert.deepEqual(
      store.calls.map((call) => [call.method, call.kinds]),
      [
        ["writeEvidenceGroup", ["INSTANCE_STARTED", "SUMMARY"]],
        ["findRecoveryCandidates", []],
      ],
    );
  });
});

describe("in-memory store: AN4 E3 orderings (state-machine tests, not PostgreSQL evidence)", () => {
  it("(b) a close committed under the lock while writeUncleanGap waits → CLOSED_EXISTS; nothing written", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = await registered(store, 2);
    const candidates = await store.findRecoveryCandidates(SCOPE, randomUUID());
    assert.deepEqual(candidates, [{ limiterInstanceId: instance, hasUncleanGap: false }]);
    const state = await store.readDurableState(instance);
    const gate = store.faults.delayCommit({ methods: ["writeEvidenceGroup"] });
    const close = store.writeEvidenceGroup([closed(instance, 2)]);
    await gate.reached;
    const gapWrite = store.writeUncleanGap(gapFrom(state), state);
    assert.equal((await settledSoon(gapWrite)).settled, false);
    gate.release();
    assert.deepEqual(await close, ["CREATED"]);
    assert.equal(await gapWrite, "CLOSED_EXISTS");
    assert.equal(store.raw.evidenceRows(instance).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
  });

  it("(b′) a close committed between readDurableState and writeUncleanGap (no lock wait) → CLOSED_EXISTS", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = await registered(store, 2);
    const close = closed(instance, 2);
    store.faults.afterCall("readDurableState", () => {
      store.raw.seedEvidence({
        id: close.id,
        limiterInstanceId: close.limiterInstanceId,
        scope: close.scope,
        kind: close.kind,
        gapReason: close.gapReason,
        firstSequence: close.firstSequence,
        lastSequence: close.lastSequence,
        missingFrom: close.missingFrom,
        missingTo: close.missingTo,
        payload: close.payload,
        recordSha256: close.recordSha256,
        recordedAt: close.recordedAt,
      });
    });
    const state = await store.readDurableState(instance);
    assert.equal(await store.writeUncleanGap(gapFrom(state), state), "CLOSED_EXISTS");
  });

  it("(c) the gap commits first; a late close is SEALED and rolled back", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = await registered(store, 2);
    const state = await store.readDurableState(instance);
    assert.equal(await store.writeUncleanGap(gapFrom(state), state), "CREATED");
    assert.deepEqual(await store.writeEvidenceGroup([closed(instance, 2)]), ["SEALED"]);
    assert.equal(store.raw.evidenceRows(instance).filter((row) => row.kind === "INSTANCE_CLOSED").length, 0);
  });

  it("(d) a late segment committed under the lock while writeUncleanGap waits → STALE_STATE, then re-derived", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = await registered(store, 2);
    const state = await store.readDurableState(instance);
    const gate = store.faults.delayCommit({ methods: ["writeEvidenceGroup"] });
    const late = store.writeEvidenceGroup([summary(instance, 3, 4)]);
    await gate.reached;
    const gapWrite = store.writeUncleanGap(gapFrom(state), state);
    gate.release();
    assert.deepEqual(await late, ["CREATED"]);
    assert.equal(await gapWrite, "STALE_STATE");
    const fresh = await store.readDurableState(instance);
    assert.equal(fresh.lastDurableSequence, 4);
    assert.equal(await store.writeUncleanGap(gapFrom(fresh), fresh), "CREATED");
  });
});

describe("in-memory store: constraints and preconditions", () => {
  function row(instance: string, changes: Partial<EvidenceRow>): EvidenceRow {
    return {
      id: randomUUID(),
      limiterInstanceId: instance,
      scope: SCOPE,
      kind: "SUMMARY",
      gapReason: null,
      firstSequence: 1,
      lastSequence: 1,
      missingFrom: null,
      missingTo: null,
      payload: { schemaVersion: 1 },
      recordSha256: "0".repeat(64),
      recordedAt: CONTRACT_T0,
      ...changes,
    };
  }

  function codeOf(action: () => void): readonly [string | undefined, string | undefined] {
    try {
      action();
    } catch (error) {
      assert.ok(error instanceof InMemoryStoreError);
      return [error.code, error.constraint];
    }
    return assert.fail("expected a constraint error");
  }

  it("out-of-protocol seeding applies column types, CHECKs and unique keys, as SQL would", () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    store.raw.seedEvidence(row(instance, {}));
    assert.deepEqual(codeOf(() => store.raw.seedEvidence(row(instance, {}))), ["23505", "rle_summary_range_uq"]);
    assert.deepEqual(codeOf(() => store.raw.seedEvidence(row(instance, { firstSequence: 2, lastSequence: 1 }))), [
      "23514",
      "rle_summary_shape_ck",
    ]);
    assert.deepEqual(codeOf(() => store.raw.seedEvidence(row(instance, { id: "not-a-uuid" }))), ["22P02", undefined]);
    assert.deepEqual(
      codeOf(() => store.raw.seedEvidence(row(instance, { firstSequence: 2_147_483_648, lastSequence: 2_147_483_648 }))),
      ["22003", undefined],
    );
    assert.deepEqual(codeOf(() => store.raw.seedEvidence(row(instance, { scope: null as never }))), ["23502", undefined]);
    const [stored] = store.raw.evidenceRows(instance) as [EvidenceRow];
    assert.deepEqual(codeOf(() => store.raw.seedEvidence(row(randomUUID(), { id: stored.id }))), [
      "23505",
      "RateLimitEvidence_pkey",
    ]);
    assert.deepEqual(codeOf(() => store.raw.alterOutsideProtocol(stored.id, { kind: "BOGUS" })), [
      "23514",
      "rle_kind_ck",
    ]);
  });

  it("uuid text is stored in lowercase, as PostgreSQL stores it", () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    store.raw.seedEvidence(row(instance.toUpperCase(), {}));
    assert.equal(store.raw.evidenceRows(instance)[0]?.limiterInstanceId, instance);
  });

  it("preconditions: an empty or mixed-instance group, and a non-unclean gap, throw before any write", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = await registered(store, 1);
    await assert.rejects(store.writeEvidenceGroup([]), TypeError);
    await assert.rejects(store.writeEvidenceGroup([summary(instance, 2, 2), summary(randomUUID(), 1, 1)]), TypeError);
    const state = await store.readDurableState(instance);
    await assert.rejects(store.writeUncleanGap(summary(instance, 2, 2), state), TypeError);
    assert.equal(store.raw.evidenceRows(instance).length, 2);
  });

  it("readDurableState rejects when the last durable summary is unreadable", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = await registered(store, 2);
    const last = store.raw.evidenceRows(instance).find((r) => r.kind === "SUMMARY") as EvidenceRow;
    store.raw.alterOutsideProtocol(last.id, { payload: { schemaVersion: 1 } });
    await assert.rejects(store.readDurableState(instance));
  });
});

describe("U3 registration verification (AN4 E5a)", () => {
  it("verifyRegistration while the instance lock is held throws (modelled lock timeout) → STILL_UNKNOWN", async () => {
    const store = createInMemoryEvidenceStore();
    const instance = randomUUID();
    const gate = store.faults.delayCommit();
    const registration = store.writeEvidenceGroup([started(instance)]);
    await gate.reached;
    const error = await caught(store.verifyRegistration(instance, performance.now() + 1_000));
    assert.equal(storeErrorOutcome(error), "NOT_COMMITTED");
    assert.deepEqual(
      classifyRegistrationVerification({ attempts: [{ outcome: "UNKNOWN" }], recorderAndConsumerStarted: false }, { ok: false }),
      { kind: "STILL_UNKNOWN" },
    );
    gate.release();
    await registration;
    assert.deepEqual(await store.verifyRegistration(instance, performance.now() + 1_000), { present: true });
  });

  it("classification table: absence needs every attempt NOT_COMMITTED; anything uncertain is STILL_UNKNOWN", () => {
    const record = (outcomes: readonly ("CONFIRMED" | "NOT_COMMITTED" | "UNKNOWN")[], started = true) => ({
      attempts: outcomes.map((outcome) => ({ outcome })),
      recorderAndConsumerStarted: started,
    });
    const cases: readonly (readonly [string, ReturnType<typeof classifyRegistrationVerification>, ReturnType<typeof classifyRegistrationVerification>])[] = [
      ["present, started", classifyRegistrationVerification(record(["CONFIRMED"]), { ok: true, present: true }), { kind: "CONFIRMED_PRESENT", recorderAndConsumerStarted: true }],
      ["present, not started", classifyRegistrationVerification(record(["UNKNOWN"], false), { ok: true, present: true }), { kind: "CONFIRMED_PRESENT", recorderAndConsumerStarted: false }],
      ["present, record missing", classifyRegistrationVerification(null, { ok: true, present: true }), { kind: "CONFIRMED_PRESENT", recorderAndConsumerStarted: false }],
      ["absent, all NOT_COMMITTED", classifyRegistrationVerification(record(["NOT_COMMITTED", "NOT_COMMITTED"]), { ok: true, present: false }), { kind: "CONFIRMED_ABSENT" }],
      ["absent, no attempt made", classifyRegistrationVerification(record([]), { ok: true, present: false }), { kind: "CONFIRMED_ABSENT" }],
      ["absent, one UNKNOWN (A-T22b (iv))", classifyRegistrationVerification(record(["NOT_COMMITTED", "UNKNOWN"]), { ok: true, present: false }), { kind: "STILL_UNKNOWN" }],
      ["absent, one CONFIRMED", classifyRegistrationVerification(record(["CONFIRMED"]), { ok: true, present: false }), { kind: "STILL_UNKNOWN" }],
      ["absent, record missing", classifyRegistrationVerification(null, { ok: true, present: false }), { kind: "STILL_UNKNOWN" }],
      ["read failed", classifyRegistrationVerification(record(["NOT_COMMITTED"]), { ok: false }), { kind: "STILL_UNKNOWN" }],
    ];
    for (const [label, actual, expected] of cases) assert.deepEqual(actual, expected, label);
  });
});

// ---------------------------------------------------------------------------
// The PostgreSQL adapter, database-free: RD-3 limiter semantics and the
// port → primitive mapping, against a fake Database whose transactions the
// test settles. No connection is ever made.

interface FakeTransaction {
  readonly options: unknown;
  settle(ok: boolean): void;
}

function controlledDatabase(): { readonly db: Database; readonly transactions: FakeTransaction[] } {
  const transactions: FakeTransaction[] = [];
  const prisma = {
    $transaction: (_work: unknown, options: unknown) =>
      new Promise((resolve, reject) => {
        transactions.push({ options, settle: (ok) => (ok ? resolve([]) : reject(new Error("fake transaction failed"))) });
      }),
  };
  return { db: { prisma: prisma as unknown as PrismaClient, monotonicNow: () => 1_000, ping: async () => undefined }, transactions };
}

async function turns(count = 5): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("PostgreSQL adapter: RD-3 connection cap (database-free)", () => {
  it("a slot is taken before the primitive runs: the third operation waits at the limiter, not in the pool", async () => {
    const { db, transactions } = controlledDatabase();
    const store = createPostgresEvidenceStore({ db });
    const calls = [1, 2, 3].map(() => store.findRecoveryCandidates(SCOPE, randomUUID()));
    await turns();
    assert.equal(transactions.length, 2, "only two primitives requested a transaction");
    assert.deepEqual([store.inFlight, store.waiting, store.highWaterMark], [2, 1, 2]);
    transactions[0]?.settle(true);
    await turns();
    assert.equal(transactions.length, 3, "the waiter started when a slot was released");
    assert.deepEqual([store.inFlight, store.waiting, store.highWaterMark], [2, 0, 2]);
    transactions[1]?.settle(false);
    transactions[2]?.settle(true);
    const settled = await Promise.allSettled(calls);
    assert.deepEqual(settled.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.deepEqual([store.inFlight, store.waiting, store.highWaterMark], [0, 0, 2]);
  });

  it("a caller that stops waiting releases nothing: the slot is held until the operation settles", async () => {
    const { db, transactions } = controlledDatabase();
    const store = createPostgresEvidenceStore({ db });
    const operation = store.writeRejections([]);
    const raced = await Promise.race([operation.then(() => "settled"), turns(2).then(() => "abandoned")]);
    assert.equal(raced, "abandoned");
    await turns();
    assert.equal(store.inFlight, 1);
    transactions[0]?.settle(false);
    await operation.catch(() => undefined);
    assert.equal(store.inFlight, 0);
  });

  it("waiters are served in arrival order", async () => {
    const { db, transactions } = controlledDatabase();
    const store = createPostgresEvidenceStore({ db, limit: 1 });
    const order: string[] = [];
    const calls = ["a", "b", "c"].map((name) =>
      store.findRecoveryCandidates(name, randomUUID()).then(() => order.push(name)),
    );
    for (let index = 0; index < 3; index += 1) {
      await turns();
      assert.equal(transactions.length, index + 1);
      assert.equal(store.highWaterMark, 1);
      transactions[index]?.settle(true);
    }
    await Promise.all(calls);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("the limit must be an integer >= 1", () => {
    const { db } = controlledDatabase();
    assert.throws(() => createPostgresEvidenceStore({ db, limit: 0 }), RangeError);
  });

  it("every port method maps to its primitive with maxWait EVIDENCE_MAX_WAIT_MS (U3: 200)", async () => {
    const instance = randomUUID();
    const state: DurableInstanceState = {
      limiterInstanceId: instance,
      startedScope: SCOPE,
      lastDurableSequence: 0,
      cumulativeAsOfLastDurable: null,
      auditCumulativeAsOfLastDurable: null,
    };
    const calls: readonly (readonly [string, (store: EvidenceStore) => Promise<unknown>, number])[] = [
      ["findRecoveryCandidates", (s) => s.findRecoveryCandidates(SCOPE, instance), 500],
      ["readDurableState", (s) => s.readDurableState(instance), 500],
      ["writeUncleanGap", (s) => s.writeUncleanGap(gapFrom(state), state), 500],
      ["validateHistoricalGap", (s) => s.validateHistoricalGap(instance, SCOPE), 500],
      ["writeEvidenceGroup", (s) => s.writeEvidenceGroup([started(instance)]), 500],
      ["writeRejections", (s) => s.writeRejections([]), 500],
      ["verifyRegistration", (s) => s.verifyRegistration(instance, 1_000 + 1_000), 200],
    ];
    for (const [method, call, maxWait] of calls) {
      const { db, transactions } = controlledDatabase();
      const store = createPostgresEvidenceStore({ db });
      const pending = call(store);
      await turns();
      assert.equal(transactions.length, 1, method);
      assert.equal((transactions[0]?.options as { maxWait?: unknown }).maxWait, maxWait, method);
      assert.equal(EVIDENCE_MAX_WAIT_MS, 500);
      transactions[0]?.settle(false);
      await assert.rejects(pending);
      assert.equal(store.inFlight, 0, method);
    }
  });
});

describe("B-1: storeErrorOutcome decides by outcome only", () => {
  it("only an explicit NOT_COMMITTED is NOT_COMMITTED; everything else is UNKNOWN", () => {
    assert.equal(storeErrorOutcome({ outcome: "NOT_COMMITTED" }), "NOT_COMMITTED");
    assert.equal(storeErrorOutcome(new InMemoryStoreError("x", "NOT_COMMITTED")), "NOT_COMMITTED");
    assert.equal(storeErrorOutcome({ outcome: "UNKNOWN", phase: "COMMIT" }), "UNKNOWN");
    assert.equal(storeErrorOutcome({ outcome: "COMMITTED" }), "UNKNOWN");
    assert.equal(storeErrorOutcome(Object.assign(new Error("x"), { name: "LockedTransactionDeadlineError" })), "UNKNOWN");
    assert.equal(storeErrorOutcome(null), "UNKNOWN");
    assert.equal(storeErrorOutcome("NOT_COMMITTED"), "UNKNOWN");
  });
});
