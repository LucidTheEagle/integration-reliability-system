import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database, TransactionClient } from "./client.js";
import { disconnectWithin } from "./client.js";
import { classifyDatabaseError } from "./errors.js";
import {
  canonicalJson,
  evidenceRecordHash,
  findEvidenceRecoveryCandidates,
  readEvidenceDurableState,
  writeEvidenceGroup,
  writeEvidenceUncleanGap,
} from "./rate-limit-evidence-store.js";
import type { EvidenceDurableState, EvidenceJson, EvidenceRecordRow, EvidenceStoreHooks } from "./rate-limit-evidence-store.js";
import { assertServerBaseline } from "./test-support/baseline.js";
import { guardedDatabase, latch } from "./test-support/database.js";
import { connectGuarded, requireTestUrl } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { pinnedAdmin, revertCommitStall, stallCommits } from "./test-support/syncrep-stall.js";

// Task 011A: the PostgreSQL evidence-store primitives, store level.
// - A-T20 (PostgreSQL half, direct SQL): malformed rows rejected by the CHECKs.
// - The per-instance lock serializes evidence transactions (two sessions).
// - A-T21 store level on PostgreSQL (AN4 E3, Option C): (b) a close committed
//   under the lock while writeEvidenceUncleanGap waits → CLOSED_EXISTS;
//   (b′) a close committed between discovery and the gap call → CLOSED_EXISTS;
//   (c) the gap first, then the close → SEALED; (d) a late segment →
//   STALE_STATE, then re-derived; (a) by RD-8: a lost acknowledgement for the
//   close write (the P-4 method: stallCommits / revertCommitStall unchanged,
//   SET LOCAL synchronous_commit = on as the first statement in the work,
//   pg_terminate_backend from the pinned admin session, the durability read
//   inside the stall).
//
// Every evidence write runs as irs_test_api (api mode). Admin mode
// (synchronous_commit = local pinned, FD-14): the baseline check, the stall
// and its verified revert, pg_stat_activity observation, backend
// termination, durability reads and clean-up. Every row this file creates
// has a scope starting with SCOPE and is deleted in after().
// Tolerance (stated before running): each awaited wait (an advisory-lock
// wait, a SyncRep wait) must be observed within 10 s, otherwise the case is
// not established and fails; no other timing is asserted.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const SCOPE = `rle-db-${randomUUID()}`;
const T0 = "2026-10-21T10:00:00.000Z";
const T1 = "2026-10-21T10:01:00.000Z";

let admin: GuardedConnection;
let db: Database;
let scopes = 0;

function newScope(): string {
  scopes += 1;
  return `${SCOPE}-${scopes}`;
}

before(async () => {
  admin = await pinnedAdmin(adminUrl, "irs-test-rle-admin");
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
});

after(async () => {
  try {
    await disconnectWithin(db, 5_000);
    await admin.client.query(`DELETE FROM "public"."RateLimitEvidence" WHERE left("scope", length($1)) = $1`, [SCOPE]);
    await assertServerBaseline(admin.client);
  } finally {
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// Rows

function counters(n: number): EvidenceJson {
  const layer = (individualRejections: number) => ({
    limited: 0,
    limitedPrecheck: 0,
    limitedConverted: 0,
    limitedViaOverflow: 0,
    overflowAdmissions: 0,
    individualRejections,
  });
  return { layers: { L1: layer(0), L2: layer(n), L3: layer(0) }, abortedBeforeResponse: 0, limiterFaults: 0, logLinesSuppressed: 0 };
}

function auditCounters(n: number): EvidenceJson {
  const fields = [
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
  ];
  return Object.fromEntries(fields.map((field) => [field, field === "submitted" ? n : 0]));
}

function sealRow(fields: Omit<EvidenceRecordRow, "recordSha256">): EvidenceRecordRow {
  return { ...fields, recordSha256: evidenceRecordHash(fields) };
}

function base(scope: string, instance: string) {
  return {
    id: randomUUID(),
    limiterInstanceId: instance,
    scope,
    gapReason: null,
    firstSequence: null,
    lastSequence: null,
    missingFrom: null,
    missingTo: null,
    recordedAt: T1,
  };
}

function started(scope: string, instance: string): EvidenceRecordRow {
  return sealRow({
    ...base(scope, instance),
    kind: "INSTANCE_STARTED",
    recordedAt: T0,
    payload: { schemaVersion: 1, limiterInstanceId: instance, instanceStartedAt: T0, scope, rateLimitPolicies: {}, auditPolicies: {} },
  });
}

function summary(scope: string, instance: string, first: number, last: number): EvidenceRecordRow {
  return sealRow({
    ...base(scope, instance),
    kind: "SUMMARY",
    firstSequence: first,
    lastSequence: last,
    payload: {
      schemaVersion: 1,
      rateLimit: { limiterInstanceId: instance, firstSequence: first, lastSequence: last, cumulative: counters(last) },
      audit: { cumulative: auditCounters(last) },
      pairingFaults: 0,
      alignment: "ALIGNED",
    },
  });
}

function closed(scope: string, instance: string, finalSequence: number): EvidenceRecordRow {
  return sealRow({
    ...base(scope, instance),
    kind: "INSTANCE_CLOSED",
    payload: {
      schemaVersion: 1,
      finalSequence,
      cumulative: { rateLimit: counters(finalSequence), audit: auditCounters(finalSequence) },
      forcedClose: false,
      closedAt: T1,
    },
  });
}

function gapFrom(scope: string, state: EvidenceDurableState): EvidenceRecordRow {
  return sealRow({
    ...base(scope, state.limiterInstanceId),
    kind: "EVIDENCE_GAP",
    gapReason: "UNCLEAN_TERMINATION",
    payload: {
      schemaVersion: 1,
      lastDurableSequence: state.lastDurableSequence,
      cumulativeAsOfLastDurable:
        state.cumulativeAsOfLastDurable === null
          ? null
          : { rateLimit: state.cumulativeAsOfLastDurable, audit: state.auditCumulativeAsOfLastDurable },
      detectedAt: T1,
      detectedByInstanceId: randomUUID(),
    },
  });
}

/** An instance with INSTANCE_STARTED and SUMMARY 1..2, committed. */
async function registered(scope: string): Promise<string> {
  const instance = randomUUID();
  assert.deepEqual(await writeEvidenceGroup(db, [started(scope, instance), summary(scope, instance, 1, 2)]), [
    "CREATED",
    "CREATED",
  ]);
  return instance;
}

// ---------------------------------------------------------------------------
// Admin observation

/** Admin mode, observation: one instance's committed rows, in the stores' text form. */
async function storedRows(instance: string): Promise<EvidenceRecordRow[]> {
  const rows = (
    await admin.client.query<EvidenceRecordRow & { payload: string }>(
      `SELECT "id"::text AS "id", "limiterInstanceId"::text AS "limiterInstanceId", "scope", "kind", "gapReason",
              "firstSequence", "lastSequence", "missingFrom", "missingTo", "payload"::text AS "payload", "recordSha256",
              to_char("recordedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
         FROM "public"."RateLimitEvidence" WHERE "limiterInstanceId" = $1::uuid ORDER BY "id"`,
      [instance],
    )
  ).rows;
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as EvidenceJson }));
}

async function waitFor<T>(observe: () => Promise<T | undefined>, what: string): Promise<T> {
  const until = performance.now() + 10_000;
  for (;;) {
    const seen = await observe();
    if (seen !== undefined) return seen;
    if (performance.now() > until) assert.fail(`not established: ${what} not observed within 10 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Admin mode, observation: an irs_test_api backend waiting on an advisory lock. */
function lockWaiter(): Promise<number> {
  return waitFor(async () => {
    const rows = (
      await admin.client.query<{ pid: number }>(
        `SELECT pid FROM pg_catalog.pg_stat_activity
          WHERE usename = 'irs_test_api' AND datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      )
    ).rows;
    return rows[0]?.pid;
  }, "an advisory-lock wait");
}

/** Hooks holding one primitive's transaction open after its work, until released. */
function holdAfterWork(primitive: string): { readonly hooks: EvidenceStoreHooks; readonly reached: Promise<void>; release(): void } {
  const reached = latch();
  const gate = latch();
  return {
    hooks: {
      afterWork: async (_tx: TransactionClient, name) => {
        if (name !== primitive) return;
        reached.release();
        await gate.wait;
      },
    },
    reached: reached.wait,
    release: gate.release,
  };
}

// ---------------------------------------------------------------------------

describe("A-T20 (PostgreSQL half): direct SQL inserts of malformed rows (api mode)", () => {
  it("each malformed row fails with 23514 and its constraint name; nothing is persisted", async () => {
    const scope = newScope();
    const api = await connectGuarded({ url: apiUrl, mode: "api", applicationName: "irs-test-rle-a-t20" });
    try {
      const cases: readonly (readonly [string, string, Partial<EvidenceRecordRow>])[] = [
        ["SUMMARY with a null firstSequence", "rle_summary_shape_ck", { kind: "SUMMARY", lastSequence: 3 }],
        ["SUMMARY with a null lastSequence", "rle_summary_shape_ck", { kind: "SUMMARY", firstSequence: 3 }],
        ["SUMMARY with firstSequence 0", "rle_summary_shape_ck", { kind: "SUMMARY", firstSequence: 0, lastSequence: 0 }],
        ["SUMMARY with an inverted range", "rle_summary_shape_ck", { kind: "SUMMARY", firstSequence: 5, lastSequence: 4 }],
        ["discontinuity gap, null missingTo", "rle_gap_shape_ck", { kind: "EVIDENCE_GAP", gapReason: "SEQUENCE_DISCONTINUITY", missingFrom: 3 }],
        ["discontinuity gap, missingFrom 0", "rle_gap_shape_ck", { kind: "EVIDENCE_GAP", gapReason: "SEQUENCE_DISCONTINUITY", missingFrom: 0, missingTo: 2 }],
        ["discontinuity gap, inverted range", "rle_gap_shape_ck", { kind: "EVIDENCE_GAP", gapReason: "SEQUENCE_DISCONTINUITY", missingFrom: 5, missingTo: 3 }],
        ["gap without a reason", "rle_gap_reason_ck", { kind: "EVIDENCE_GAP", missingFrom: 3, missingTo: 4 }],
        ["gap with an unknown reason", "rle_gap_reason_ck", { kind: "EVIDENCE_GAP", gapReason: "OTHER" }],
        ["an unknown kind", "rle_kind_ck", { kind: "BOGUS" }],
      ];
      for (const [label, constraint, changes] of cases) {
        const row = { ...base(scope, randomUUID()), kind: "SUMMARY", payload: { schemaVersion: 1 }, recordSha256: "0".repeat(64), ...changes };
        const error = await api.client
          .query(
            `INSERT INTO "public"."RateLimitEvidence" ("id", "limiterInstanceId", "scope", "kind", "gapReason", "firstSequence",
               "lastSequence", "missingFrom", "missingTo", "payload", "recordSha256", "recordedAt")
             VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::int, $7::int, $8::int, $9::int, $10::jsonb, $11::text, $12::timestamptz)`,
            [row.id, row.limiterInstanceId, row.scope, row.kind, row.gapReason, row.firstSequence, row.lastSequence,
             row.missingFrom, row.missingTo, JSON.stringify(row.payload), row.recordSha256, row.recordedAt],
          )
          .then(
            () => assert.fail(`${label}: accepted`),
            (caught: unknown) => caught as { code?: string; constraint?: string },
          );
        assert.deepEqual([error.code, error.constraint], ["23514", constraint], label);
      }
      const persisted = await admin.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "public"."RateLimitEvidence" WHERE "scope" = $1`,
        [scope],
      );
      assert.equal(persisted.rows[0]?.n, 0);
    } finally {
      await api.close();
    }
  });
});

describe("PA-4: exponent-form numbers through jsonb, on the real write and re-read path", () => {
  it("a payload with exponent-form numbers is IDENTICAL_EXISTS on an identical retry (no duplicate); a different value is CONFLICT", async () => {
    const scope = newScope();
    const instance = randomUUID();
    // Canonical JSON renders these in exponent form; jsonb (numeric) stores and returns them in positional form.
    const numbers = { tiny: 1e-7, smaller: 1.5e-10, negative: -3.2e-8, extreme: 1e-300, fractionalLarge: 123456789012345.67 };
    assert.equal(canonicalJson(numbers.tiny), "1e-7");
    // A value >= 1e21 cannot appear in a payload: every double >= 2^53 is an integer, and canonical JSON refuses unsafe integers.
    assert.throws(() => canonicalJson({ big: 1e21 }), TypeError);
    const record = sealRow({
      ...base(scope, instance),
      kind: "INSTANCE_STARTED",
      recordedAt: T0,
      payload: { schemaVersion: 1, limiterInstanceId: instance, instanceStartedAt: T0, scope, rateLimitPolicies: {}, auditPolicies: numbers },
    });
    assert.deepEqual(await writeEvidenceGroup(db, [record]), ["CREATED"]);
    // Admin mode, observation: the stored jsonb really is in positional form.
    const stored = (
      await admin.client.query<{ tiny: string }>(
        `SELECT "payload"->'auditPolicies'->>'tiny' AS "tiny" FROM "public"."RateLimitEvidence" WHERE "id" = $1::uuid`,
        [record.id],
      )
    ).rows[0];
    assert.equal(stored?.tiny, "0.0000001");
    assert.deepEqual(await writeEvidenceGroup(db, [record]), ["IDENTICAL_EXISTS"]);
    assert.deepEqual(await storedRows(instance), [record]);
    const different = sealRow({
      ...record,
      id: randomUUID(),
      payload: { ...(record.payload as Record<string, EvidenceJson>), auditPolicies: { ...numbers, tiny: 2e-7 } },
    });
    assert.deepEqual(await writeEvidenceGroup(db, [different]), ["CONFLICT"]);
    assert.deepEqual(await storedRows(instance), [record]);
  });
});

describe("the per-instance advisory lock serializes evidence transactions (two sessions)", () => {
  it("a second write on the same instance waits for the first; another instance does not", async () => {
    const scope = newScope();
    const instance = randomUUID();
    const hold = holdAfterWork("writeEvidenceGroup");
    const first = writeEvidenceGroup(db, [started(scope, instance)], hold.hooks);
    await hold.reached;
    // While the first holds the lock, another instance's evidence is not blocked.
    assert.deepEqual(await writeEvidenceGroup(db, [started(scope, randomUUID())]), ["CREATED"]);
    assert.deepEqual(await storedRows(instance), [], "the held write has not committed");
    const second = writeEvidenceGroup(db, [summary(scope, instance, 1, 1)]);
    await lockWaiter();
    // Released as soon as the wait is seen: the waiter's lockTimeoutMs is 1,000.
    hold.release();
    assert.deepEqual(await first, ["CREATED"]);
    assert.deepEqual(await second, ["CREATED"]);
    assert.equal((await storedRows(instance)).length, 2);
  });

  it("concurrent overlapping groups: exactly one is CREATED, the other OVERLAP; identical groups: CREATED and IDENTICAL_EXISTS", async () => {
    const scope = newScope();
    const instance = randomUUID();
    const results = await Promise.all([
      writeEvidenceGroup(db, [summary(scope, instance, 1, 3)]),
      writeEvidenceGroup(db, [summary(scope, instance, 2, 4)]),
    ]);
    assert.deepEqual(results.map((r) => r[0]).sort(), ["CREATED", "OVERLAP"]);
    const same = summary(scope, instance, 10, 10);
    const twice = await Promise.all([writeEvidenceGroup(db, [same]), writeEvidenceGroup(db, [same])]);
    assert.deepEqual(twice.map((r) => r[0]).sort(), ["CREATED", "IDENTICAL_EXISTS"]);
    assert.equal((await storedRows(instance)).length, 2);
  });
});

describe("A-T21 store level on PostgreSQL (AN4 E3; F-20 Option C)", () => {
  it("(b) a close committed under the lock while writeEvidenceUncleanGap waits → CLOSED_EXISTS; no gap", async () => {
    const scope = newScope();
    const instance = await registered(scope);
    const candidates = await findEvidenceRecoveryCandidates(db, scope, randomUUID());
    assert.deepEqual(candidates, [{ limiterInstanceId: instance, hasUncleanGap: false }]);
    const state = await readEvidenceDurableState(db, instance);
    const hold = holdAfterWork("writeEvidenceGroup");
    const close = writeEvidenceGroup(db, [closed(scope, instance, 2)], hold.hooks);
    await hold.reached;
    const gap = writeEvidenceUncleanGap(db, gapFrom(scope, state), state);
    await lockWaiter();
    hold.release();
    assert.deepEqual(await close, ["CREATED"]);
    assert.equal(await gap, "CLOSED_EXISTS");
    assert.equal((await storedRows(instance)).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
  });

  it("(b′) a close committed fully between discovery and writeEvidenceUncleanGap (no lock wait) → CLOSED_EXISTS", async () => {
    const scope = newScope();
    const instance = await registered(scope);
    assert.deepEqual(await findEvidenceRecoveryCandidates(db, scope, randomUUID()), [
      { limiterInstanceId: instance, hasUncleanGap: false },
    ]);
    const state = await readEvidenceDurableState(db, instance);
    assert.deepEqual(await writeEvidenceGroup(db, [closed(scope, instance, 2)]), ["CREATED"]);
    assert.equal(await writeEvidenceUncleanGap(db, gapFrom(scope, state), state), "CLOSED_EXISTS");
    assert.equal((await storedRows(instance)).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
  });

  it("(c) the gap commits first; a late close is SEALED and rolled back before COMMIT", async () => {
    const scope = newScope();
    const instance = await registered(scope);
    const state = await readEvidenceDurableState(db, instance);
    assert.equal(await writeEvidenceUncleanGap(db, gapFrom(scope, state), state), "CREATED");
    assert.deepEqual(await writeEvidenceGroup(db, [closed(scope, instance, 2)]), ["SEALED"]);
    assert.equal((await storedRows(instance)).filter((row) => row.kind === "INSTANCE_CLOSED").length, 0);
  });

  it("(d) a late segment committed under the lock while the gap write waits → STALE_STATE, then re-derived", async () => {
    const scope = newScope();
    const instance = await registered(scope);
    const state = await readEvidenceDurableState(db, instance);
    const hold = holdAfterWork("writeEvidenceGroup");
    const late = writeEvidenceGroup(db, [summary(scope, instance, 3, 4)], hold.hooks);
    await hold.reached;
    const gap = writeEvidenceUncleanGap(db, gapFrom(scope, state), state);
    await lockWaiter();
    hold.release();
    assert.deepEqual(await late, ["CREATED"]);
    assert.equal(await gap, "STALE_STATE");
    const fresh = await readEvidenceDurableState(db, instance);
    assert.equal(fresh.lastDurableSequence, 4);
    const rederived = gapFrom(scope, fresh);
    assert.equal(await writeEvidenceUncleanGap(db, rederived, fresh), "CREATED");
    const stored = (await storedRows(instance)).filter((row) => row.kind === "EVIDENCE_GAP");
    assert.deepEqual(stored, [rederived]);
  });

  it("(a) RD-8: the close commits durably, its acknowledgement is lost (COMMIT/UNKNOWN); the row is byte-identical; discovery excludes P; the retry is IDENTICAL_EXISTS", async () => {
    const scope = newScope();
    const instance = await registered(scope);
    const close = closed(scope, instance, 2);
    const stalledDb = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    let stallStarted = false;
    try {
      await stallCommits(adminUrl, admin.client, "A-T21(a)");
      stallStarted = true;
      const hooks: EvidenceStoreHooks = {
        // The first statement of the work: only this transaction waits for the standby.
        beforeWork: async (tx) => {
          await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
        },
      };
      const pending = writeEvidenceGroup(stalledDb, [close], hooks).then(
        (value) => ({ settled: "resolved" as const, value }),
        (error: unknown) => ({ settled: "rejected" as const, error }),
      );
      const pid = await waitFor(async () => {
        const rows = (
          await admin.client.query<{ pid: number }>(
            `SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename = 'irs_test_api' AND datname = current_database() AND wait_event = 'SyncRep'`,
          )
        ).rows;
        return rows[0]?.pid;
      }, "the close COMMIT waiting on SyncRep");
      await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
      const outcome = await pending;
      assert.equal(outcome.settled, "rejected");
      const error = (outcome as { error: { phase?: unknown; outcome?: unknown } }).error;
      assert.deepEqual([error.phase, error.outcome], ["COMMIT", "UNKNOWN"]);
      assert.deepEqual(classifyDatabaseError(error), { failureClass: "TRANSIENT", code: "COMMIT_UNKNOWN" });
      // The durability read, inside the stall (admin, pinned session).
      const durable = (await storedRows(instance)).filter((row) => row.kind === "INSTANCE_CLOSED");
      assert.deepEqual(durable, [close]);
    } finally {
      await disconnectWithin(stalledDb, 5_000);
      if (stallStarted) await revertCommitStall(adminUrl, "A-T21(a)");
    }
    assert.deepEqual(await findEvidenceRecoveryCandidates(db, scope, randomUUID()), []);
    assert.deepEqual(await writeEvidenceGroup(db, [close]), ["IDENTICAL_EXISTS"]);
  });
});
