import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { disconnectWithin } from "@irs/db";
import type { Database, EvidenceStoreHooks, TransactionClient } from "@irs/db";
import type * as BaselineSupport from "../../../packages/db/dist/test-support/baseline.js";
import type * as DatabaseSupport from "../../../packages/db/dist/test-support/database.js";
import type * as GuardSupport from "../../../packages/db/dist/test-support/guard.js";
import type * as SyncRepSupport from "../../../packages/db/dist/test-support/syncrep-stall.js";
import { classifyCoverage } from "./coverage.js";
import { createDurableIngestionHandoff } from "./durable-ingestion.js";
import {
  buildEvidenceRecord,
  canonicalJson,
  freezeInstanceClosed,
  freezeInstanceStarted,
  freezeSummary,
  freezeUncleanGap,
} from "./evidence-records.js";
import type { FrozenEvidenceRecord, JsonValue } from "./evidence-records.js";
import type { EvidenceRow } from "./evidence-store.js";
import { contractAuditCounters, contractCounters, contractSummary } from "./evidence-store-contract.js";
import { createPostgresEvidenceStore } from "./evidence-store-postgres.js";
import type { PostgresEvidenceStore } from "./evidence-store-postgres.js";
import { composeEvidence } from "./production.js";
import type { ComposedEvidenceStore, EvidenceComposition } from "./production.js";
import { DEFAULT_RATE_LIMIT_POLICIES } from "./rate-limit.js";
import type { RateLimitPolicies } from "./rate-limit.js";
import { DEFAULT_AUDIT_POLICIES } from "./rejection-audit.js";
import {
  LogCapture,
  RecordingHandoff,
  SECRET_TEXT,
  assertNoUnmappedLog,
  envelopeJson,
  makeApp,
  parseJson,
  settleTurns,
  sign,
  validRequest,
} from "./test-helpers.js";

// Task 011A composed on PostgreSQL (Stage 7): the production composition
// (composeEvidence, the PostgreSQL store and its adapter) with Task 011's
// real durable handoff on the same guarded Database.
// - A-T23: an admitted 422 → an EVENT_REJECTED row, id = requestId, allowlisted metadata only.
// - A-T24: INGESTION_INTEGRATION 404 rows for DRAFT / DISABLED / DECOMMISSIONED /
//   unregistered; P1 from an inactive integration → a 422 row.
// - The composed connection cap: an RD-8-stalled recorder batch and a rejection flood;
//   highWaterMark ≤ 2 while ingestion 202s continue.
// - A-T21 composed (a): finalization with an RD-8-stalled close → F-D′, no claim; the
//   row is durable and byte-identical; the next startup writes no gap; coverage equals a
//   clean close. The pre-seeded pair on PostgreSQL → CONSISTENT_ANOMALY / DEFECT.
//
// Requests and store calls run as irs_test_api (api mode). Admin mode (synchronous_commit
// = local pinned, FD-14): the baseline, Integration seeding, the RD-8 stall and its verified
// revert, pg_stat_activity observation, backend termination, durability reads, the seeded
// pair, clean-up. P-011A-15: every terminated backend belongs to a dedicated pool that no
// later assertion reuses. Every evidence row has a scope starting with PREFIX; every
// EVENT_REJECTED row carries one of the compositions' limiter ids; all are deleted in after().
// Tolerance: each SyncRep wait must be observed within 10 s, otherwise the case is not
// established and fails; no latency is asserted.

const TEST_SUPPORT = new URL("../../../packages/db/dist/test-support/", import.meta.url);

async function loadTestSupport<T>(file: string): Promise<T> {
  const url = new URL(file, TEST_SUPPORT);
  if (!existsSync(url)) {
    assert.fail(`@irs/db test support not built: ${fileURLToPath(url)} is missing; build it first (pnpm --filter @irs/db build)`);
  }
  return (await import(url.href)) as T;
}

const { assertServerBaseline } = await loadTestSupport<typeof BaselineSupport>("baseline.js");
const { pinnedAdmin, revertCommitStall, stallCommits } = await loadTestSupport<typeof SyncRepSupport>("syncrep-stall.js");
const { guardedDatabase, removeIntegrations, seedIntegration } = await loadTestSupport<typeof DatabaseSupport>("database.js");
const { requireTestUrl } = await loadTestSupport<typeof GuardSupport>("guard.js");

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const PREFIX = `composed-${randomUUID()}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Roomy L1 / L2 (the harness's own configuration): these tests exercise auditing, not the limiter. */
const ROOMY: RateLimitPolicies = {
  ...DEFAULT_RATE_LIMIT_POLICIES,
  L1: { ...DEFAULT_RATE_LIMIT_POLICIES.L1, bucket: { capacity: 10_000, refillPerSecond: 100 }, overflow: { capacity: 1_000, refillPerSecond: 10 } },
  L2: { ...DEFAULT_RATE_LIMIT_POLICIES.L2, bucket: { capacity: 10_000, refillPerSecond: 100 }, overflow: { capacity: 1_000, refillPerSecond: 10 } },
};

let admin: GuardSupport.GuardedConnection;
let db: Database;
const limiterIds: string[] = [];
const integrations: string[] = [];
const apps: FastifyInstance[] = [];
const captures: LogCapture[] = [];
let scopes = 0;

before(async () => {
  admin = await pinnedAdmin(adminUrl, "irs-test-composed-admin");
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
});

afterEach(() => {
  for (const capture of captures.splice(0)) assertNoUnmappedLog(capture);
});

after(async () => {
  try {
    for (const app of apps) await app.close();
    await disconnectWithin(db, 5_000);
    await admin.client.query(`DELETE FROM "public"."RateLimitEvidence" WHERE left("scope", length($1)) = $1`, [PREFIX]);
    await admin.client.query(
      `DELETE FROM "public"."AuditEntry" WHERE "action" = 'EVENT_REJECTED' AND "metadata"->>'limiterInstanceId' = ANY($1::text[])`,
      [limiterIds],
    );
    await removeIntegrations(admin.client, integrations);
    await assertServerBaseline(admin.client);
  } finally {
    await admin.close();
  }
});

function newScope(): string {
  scopes += 1;
  return `${PREFIX}-${scopes}`;
}

async function seed(status: DatabaseSupport.ConfigStatus): Promise<string> {
  const id = await seedIntegration(admin.client, status);
  integrations.push(id);
  return id;
}

/** A spy over the PostgreSQL store: records every evidence group written (records and order). */
function spied(store: PostgresEvidenceStore): { store: ComposedEvidenceStore; groups: (readonly FrozenEvidenceRecord[])[] } {
  const groups: (readonly FrozenEvidenceRecord[])[] = [];
  return {
    groups,
    store: {
      findRecoveryCandidates: (...args) => store.findRecoveryCandidates(...args),
      readDurableState: (...args) => store.readDurableState(...args),
      validateHistoricalGap: (...args) => store.validateHistoricalGap(...args),
      writeUncleanGap: (...args) => store.writeUncleanGap(...args),
      writeRejections: (...args) => store.writeRejections(...args),
      verifyRegistration: (...args) => store.verifyRegistration(...args),
      writeEvidenceGroup: (records) => {
        groups.push(records);
        return store.writeEvidenceGroup(records);
      },
      cutoffAt: (deadline) => store.cutoffAt(deadline),
    },
  };
}

interface Composed {
  readonly ev: EvidenceComposition;
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly pg: PostgresEvidenceStore;
  readonly groups: (readonly FrozenEvidenceRecord[])[];
}

/** The production composition over `database`, with the durable handoff on the same Database, started (registered). */
async function composed(options: { database?: Database; scope?: string; hooks?: EvidenceStoreHooks; secrets?: Record<string, string> } = {}): Promise<Composed> {
  const database = options.database ?? db;
  const pg = createPostgresEvidenceStore({ db: database, ...(options.hooks === undefined ? {} : { hooks: options.hooks }) });
  const { store, groups } = spied(pg);
  const logs = new LogCapture();
  captures.push(logs);
  let appRef: FastifyInstance | undefined;
  const ev = composeEvidence({
    store,
    rateLimitPolicies: ROOMY,
    auditPolicies: DEFAULT_AUDIT_POLICIES,
    scope: options.scope ?? newScope(),
    logger: {
      warn: (object, message) => appRef?.log.warn(object, message),
      error: (object, message) => appRef?.log.error(object, message),
    },
  });
  limiterIds.push(ev.limiterInstanceId);
  const durable = createDurableIngestionHandoff({ db: database });
  const t = makeApp({
    rateLimiter: ev.limiter,
    rejectionAudit: ev.sink,
    handoff: new RecordingHandoff((request) => durable.accept(request)),
    secrets: options.secrets ?? {},
    logs,
  });
  appRef = t.app;
  apps.push(t.app);
  await ev.slots.startupSlot(new AbortController().signal);
  ev.consumer.stopTimer(); // the tests drive finalization themselves
  return { ev, app: t.app, logs, pg, groups };
}

function deliver(app: FastifyInstance, integrationId: string, payload: Record<string, unknown> = { note: "storable" }) {
  const request = validRequest(envelopeJson({ externalEventId: `ext-${randomUUID()}`, payload }));
  return app.inject({ method: "POST", url: `/api/webhooks/${integrationId}`, headers: request.headers, payload: request.body });
}

/** Admin mode, observation: one AuditEntry row by id. */
async function auditRow(id: string): Promise<{ action: string; actorType: string; actorId: string | null; entityType: string; entityId: string; metadata: Record<string, unknown> } | undefined> {
  const rows = (
    await admin.client.query(
      `SELECT "action", "actorType", "actorId", "entityType", "entityId", "metadata" FROM "public"."AuditEntry" WHERE "id" = $1::uuid`,
      [id],
    )
  ).rows as { action: string; actorType: string; actorId: string | null; entityType: string; entityId: string; metadata: Record<string, unknown> }[];
  return rows[0];
}

async function waitForRow(id: string) {
  const until = performance.now() + 10_000;
  for (;;) {
    const row = await auditRow(id);
    if (row !== undefined) return row;
    if (performance.now() > until) assert.fail("no EVENT_REJECTED row within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const METADATA_KEYS = [
  "claimedIntegrationId",
  "errorCode",
  "httpStatus",
  "limiterInstanceId",
  "receivedAt",
  "responseCompletion",
  "schemaVersion",
  "stage",
  "verifierReason",
];

/** Admin mode, observation: one instance's evidence rows, in the stores' text form. */
async function evidenceRows(limiterInstanceId: string): Promise<EvidenceRow[]> {
  const rows = (
    await admin.client.query<EvidenceRow & { payload: string }>(
      `SELECT "id"::text AS "id", "limiterInstanceId"::text AS "limiterInstanceId", "scope", "kind", "gapReason",
              "firstSequence", "lastSequence", "missingFrom", "missingTo", "payload"::text AS "payload", "recordSha256",
              to_char("recordedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
         FROM "public"."RateLimitEvidence" WHERE "limiterInstanceId" = $1::uuid ORDER BY "id"`,
      [limiterInstanceId],
    )
  ).rows;
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as JsonValue }));
}

function asRecords(rows: readonly EvidenceRow[]): FrozenEvidenceRecord[] {
  return rows.map((row) => buildEvidenceRecord({ ...row, kind: row.kind as never, gapReason: row.gapReason as never }));
}

async function finalize(c: Composed, forced = false) {
  return c.ev.slots.finalizeBeforeDisconnect("SIGNAL", { forced });
}

// ---------------------------------------------------------------------------

describe("A-T23 / A-T24: EVENT_REJECTED rows for the ingestion stages, through the real durable handoff", () => {
  it("A-T23: an admitted 422 (P1) → an EVENT_REJECTED row with id = requestId and allowlisted metadata only; no EVENT_RECEIVED with that id", async () => {
    const integrationId = await seed("ACTIVE");
    const c = await composed({ secrets: { [integrationId]: SECRET_TEXT } });
    const response = await deliver(c.app, integrationId, { note: "S-PAYLOAD-7f3e\u0000" });
    assert.equal(response.statusCode, 422);
    const requestId = (parseJson(response.body) as { requestId: string }).requestId;
    const row = await waitForRow(requestId);
    assert.deepEqual([row.action, row.actorType, row.actorId, row.entityType, row.entityId], ["EVENT_REJECTED", "EXTERNAL_SENDER", null, "WEBHOOK_DELIVERY", requestId]);
    assert.deepEqual(Object.keys(row.metadata).sort(), METADATA_KEYS);
    assert.deepEqual(
      [row.metadata.stage, row.metadata.httpStatus, row.metadata.errorCode, row.metadata.claimedIntegrationId, row.metadata.limiterInstanceId, row.metadata.schemaVersion],
      ["INGESTION_PAYLOAD", 422, "UNPROCESSABLE_PAYLOAD", integrationId, c.ev.limiterInstanceId, 1],
    );
    assert.ok(!JSON.stringify(row).includes("S-PAYLOAD-7f3e"), "no payload content");
    const received = await admin.client.query(`SELECT count(*)::int AS n FROM "public"."AuditEntry" WHERE "action" = 'EVENT_RECEIVED' AND "id" = $1::uuid`, [requestId]);
    assert.equal((received.rows[0] as { n: number }).n, 0);
    assert.equal((await finalize(c)).successAllowed, true);
  });

  it("A-T24: DRAFT, DISABLED, DECOMMISSIONED and unregistered → an INGESTION_INTEGRATION row; the body equals the route 404 but for requestId; P1 from an inactive integration → a 422 row", async () => {
    const draft = await seed("DRAFT");
    const disabled = await seed("DISABLED");
    const decommissioned = await seed("DECOMMISSIONED");
    const unregistered = randomUUID();
    const secrets = Object.fromEntries([draft, disabled, decommissioned, unregistered].map((id) => [id, SECRET_TEXT]));
    const c = await composed({ secrets });
    const route404 = await deliver(c.app, randomUUID());
    assert.equal(route404.statusCode, 404, "the route-guard 404 (no secret)");
    const shape = (text: string) => {
      const { requestId, ...rest } = parseJson(text) as { requestId: string } & Record<string, unknown>;
      assert.match(requestId, UUID);
      return rest;
    };
    for (const integrationId of [draft, disabled, decommissioned, unregistered]) {
      const response = await deliver(c.app, integrationId);
      assert.equal(response.statusCode, 404);
      assert.deepEqual(shape(response.body), shape(route404.body), "the same body as the route 404, apart from requestId");
      const requestId = (parseJson(response.body) as { requestId: string }).requestId;
      const row = await waitForRow(requestId);
      assert.deepEqual([row.metadata.stage, row.metadata.httpStatus, row.metadata.claimedIntegrationId], ["INGESTION_INTEGRATION", 404, integrationId]);
      const received = await admin.client.query(`SELECT count(*)::int AS n FROM "public"."AuditEntry" WHERE "action" = 'EVENT_RECEIVED' AND "id" = $1::uuid`, [requestId]);
      assert.equal((received.rows[0] as { n: number }).n, 0);
    }
    const p1 = await deliver(c.app, draft, { note: "nul\u0000here" });
    assert.equal(p1.statusCode, 422);
    const p1Row = await waitForRow((parseJson(p1.body) as { requestId: string }).requestId);
    assert.equal(p1Row.metadata.stage, "INGESTION_PAYLOAD");
    assert.equal((await finalize(c)).successAllowed, true);
  });
});

describe("The composed connection cap (RD-3) on PostgreSQL", () => {
  it("an RD-8-stalled recorder batch and a rejection flood: highWaterMark ≤ 2 throughout, while ingestion 202s continue", async () => {
    const integrationId = await seed("ACTIVE");
    const stalledDb = await guardedDatabase({ url: apiUrl, mode: "api" });
    let stallNext = true;
    const stalledPids: number[] = [];
    const hooks: EvidenceStoreHooks = {
      beforeWork: async (tx: TransactionClient, primitive) => {
        if (primitive !== "writeRejectionAuditRows" || !stallNext) return;
        stallNext = false;
        const pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS "pid"`)[0]?.pid;
        if (pid !== undefined) stalledPids.push(pid);
        await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
      },
    };
    let stallStarted = false;
    let c: Composed | undefined;
    try {
      await stallCommits(adminUrl, admin.client, "composed cap");
      stallStarted = true;
      c = await composed({ database: stalledDb, hooks, secrets: { [integrationId]: SECRET_TEXT } });
      const flood = Array.from({ length: 20 }, () => {
        const request = validRequest(envelopeJson({ externalEventId: `flood-${randomUUID()}` }));
        return c?.app.inject({ method: "POST", url: `/api/webhooks/${integrationId}`, headers: { ...request.headers, "irs-signature": sign(Buffer.from("forged")) }, payload: request.body });
      });
      const responses = await Promise.all(flood);
      assert.ok(responses.every((response) => response?.statusCode === 401));
      const until = performance.now() + 10_000;
      while (stalledPids.length === 0) {
        if (performance.now() > until) assert.fail("not established: the recorder batch did not start within 10 s");
        await settleTurns(1);
      }
      // The batch's COMMIT must be observed waiting on SyncRep (the RD-8 premise), within 10 s.
      let syncRep = 0;
      while (syncRep === 0) {
        const waiting = await admin.client.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND wait_event = 'SyncRep'`, [stalledPids[0]]);
        syncRep = (waiting.rows[0] as { n: number }).n;
        if (syncRep === 0) {
          if (performance.now() > until) assert.fail("not established: the recorder batch's COMMIT was not seen waiting on SyncRep within 10 s");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.equal(c.pg.inFlight, 1, "the stalled batch holds its slot");
      for (let n = 0; n < 5; n += 1) {
        const accepted = await deliver(c.app, integrationId);
        assert.equal(accepted.statusCode, 202, "ingestion continues during the stall");
        assert.ok(c.pg.highWaterMark <= 2);
      }
      process.stdout.write(`[composed cap] SyncRep waits observed for the batch: ${syncRep}; highWaterMark ${c.pg.highWaterMark}; inFlight ${c.pg.inFlight}\n`);
      assert.ok(c.pg.highWaterMark <= 2);
      for (const pid of stalledPids) await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
    } finally {
      if (c !== undefined) {
        await c.ev.recorder.finalize(2_000);
        c.pg.cutoffAt(stalledDb.monotonicNow());
      }
      await disconnectWithin(stalledDb, 5_000);
      if (stallStarted) await revertCommitStall(adminUrl, "composed cap");
    }
  });
});

describe("A-T21 composed on PostgreSQL (F-20 Option C)", () => {
  it("(a) the close commits durably but its acknowledgement is lost: F-D′ and no claim; the row is byte-identical; the next startup writes no gap; coverage equals a clean close", async () => {
    const scope = newScope();
    const stalledDb = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    let groupWrites = 0;
    const stalledPid: number[] = [];
    const hooks: EvidenceStoreHooks = {
      beforeWork: async (tx: TransactionClient, primitive) => {
        if (primitive !== "writeEvidenceGroup") return;
        groupWrites += 1;
        // 1: INSTANCE_STARTED, 2: the final summary, 3: INSTANCE_CLOSED (stalled).
        if (groupWrites !== 3) return;
        const pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS "pid"`)[0]?.pid;
        if (pid !== undefined) stalledPid.push(pid);
        await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
      },
    };
    let stallStarted = false;
    let c: Composed | undefined;
    try {
      c = await composed({ database: stalledDb, scope, hooks });
      await stallCommits(adminUrl, admin.client, "A-T21 composed (a)");
      stallStarted = true;
      const result = await finalize(c);
      assert.deepEqual(result, { successAllowed: false });
      const outcomes = c.logs.records().filter((record) => record.event === "EVIDENCE_FINALIZED").map((record) => record.outcome);
      assert.deepEqual(outcomes, ["F-D′"], "the consumer claims nothing beyond F-D′");
      assert.equal(stalledPid.length, 1, "the close write began");
      const waiting = await admin.client.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND wait_event = 'SyncRep'`, [stalledPid[0]]);
      assert.equal((waiting.rows[0] as { n: number }).n, 1, "its COMMIT is waiting on SyncRep");
      // As in P-4: terminate first (a SyncRep waiter is not yet visible to other sessions),
      // then the durability read, still inside the stall.
      await admin.client.query("SELECT pg_terminate_backend($1)", [stalledPid[0]]);
      let close: EvidenceRow[] = [];
      const until = performance.now() + 10_000;
      while (close.length === 0 && performance.now() < until) {
        close = (await evidenceRows(c.ev.limiterInstanceId)).filter((row) => row.kind === "INSTANCE_CLOSED");
        if (close.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const frozenClose = c.groups.flat().find((record) => record.kind === "INSTANCE_CLOSED") as FrozenEvidenceRecord;
      assert.equal(close.length, 1, "the close committed durably");
      assert.equal(canonicalJson(asRecords(close)[0]), canonicalJson(frozenClose), "byte-identical to its freeze");
    } finally {
      await disconnectWithin(stalledDb, 5_000);
      if (stallStarted) await revertCommitStall(adminUrl, "A-T21 composed (a)");
    }
    assert.ok(c !== undefined);
    const previous = c.ev.limiterInstanceId;
    // The next startup, on the shared pool: P is closed, so no gap is written for it.
    const next = await composed({ scope });
    assert.equal((await evidenceRows(previous)).filter((row) => row.kind === "EVIDENCE_GAP").length, 0);
    const coverage = classifyCoverage(asRecords(await evidenceRows(previous)), previous);
    assert.equal(coverage.complete, true, "the same classification as a clean close");
    assert.equal((await finalize(next)).successAllowed, true);
  });

  it("a pre-seeded close and UNCLEAN_TERMINATION gap on PostgreSQL → CONSISTENT_ANOMALY; an altered finalSequence → DEFECT", async () => {
    for (const consistent of [true, false]) {
      const scope = newScope();
      const instance = randomUUID();
      limiterIds.push(instance);
      const T = "2026-10-21T10:00:00.000Z";
      const records: FrozenEvidenceRecord[] = [
        freezeInstanceStarted({ id: randomUUID(), limiterInstanceId: instance, scope, recordedAt: T, instanceStartedAt: T, rateLimitPolicies: {}, auditPolicies: {} }),
        freezeSummary({ id: randomUUID(), scope, recordedAt: T, summary: contractSummary(instance, 1, 2) }),
        freezeInstanceClosed({
          id: randomUUID(),
          limiterInstanceId: instance,
          scope,
          recordedAt: T,
          finalSequence: consistent ? 2 : 3,
          cumulative: { rateLimit: contractCounters(2), audit: contractAuditCounters(2) },
          forcedClose: false,
          closedAt: T,
        }),
        freezeUncleanGap({
          id: randomUUID(),
          limiterInstanceId: instance,
          scope,
          recordedAt: T,
          lastDurableSequence: 2,
          cumulativeAsOfLastDurable: { rateLimit: contractCounters(2), audit: contractAuditCounters(2) },
          detectedAt: T,
          detectedByInstanceId: randomUUID(),
        }),
      ];
      // Admin mode: the pair committed directly, as data written before the amendment would be.
      for (const record of records) {
        await admin.client.query(
          `INSERT INTO "public"."RateLimitEvidence" ("id", "limiterInstanceId", "scope", "kind", "gapReason", "firstSequence",
             "lastSequence", "missingFrom", "missingTo", "payload", "recordSha256", "recordedAt")
           VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::int, $7::int, $8::int, $9::int, $10::jsonb, $11::text, $12::timestamptz)`,
          [record.id, record.limiterInstanceId, record.scope, record.kind, record.gapReason, record.firstSequence, record.lastSequence,
           record.missingFrom, record.missingTo, JSON.stringify(record.payload), record.recordSha256, record.recordedAt],
        );
      }
      const coverage = classifyCoverage(asRecords(await evidenceRows(instance)), instance);
      assert.equal(coverage.closeGapPair, consistent ? "CONSISTENT_ANOMALY" : "DEFECT");
      assert.equal(coverage.complete, false);
      assert.deepEqual(coverage.segments.at(-1), { kind: "UNKNOWN_AFTER", reason: "UNCLEAN_TERMINATION", lastDurableSequence: 2 });
    }
  });
});
