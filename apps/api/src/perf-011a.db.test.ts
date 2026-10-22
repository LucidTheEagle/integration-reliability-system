import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { DEFAULT_POOL_SETTINGS, DEFAULT_TRANSACTION_OPTIONS } from "@irs/db";
import type { Database } from "@irs/db";
import type * as BaselineSupport from "../../../packages/db/dist/test-support/baseline.js";
import type * as DatabaseSupport from "../../../packages/db/dist/test-support/database.js";
import type * as GuardSupport from "../../../packages/db/dist/test-support/guard.js";
import { createDurableIngestionHandoff } from "./durable-ingestion.js";
import type { HandoffLogger } from "./durable-ingestion.js";
import type { AuditRecorderCounters } from "./evidence-records.js";
import { createPostgresEvidenceStore } from "./evidence-store-postgres.js";
import type { PostgresEvidenceStore } from "./evidence-store-postgres.js";
import { composeEvidence } from "./production.js";
import type { EvidenceComposition } from "./production.js";
import { DEFAULT_RATE_LIMIT_POLICIES } from "./rate-limit.js";
import type { RateLimitPolicies } from "./rate-limit.js";
import { DEFAULT_AUDIT_POLICIES } from "./rejection-audit.js";
import { LogCapture, RecordingHandoff, SECRET_TEXT, envelopeJson, listen, makeApp, sign, validRequest } from "./test-helpers.js";

// Task 011A Stage 8 (RD-3; J3 = authorize). SYNTHETIC: PERF-1's fixed
// workload (perf.db.test.ts, unchanged) with Task 011A active through the
// production modules: composeEvidence over the PostgreSQL store and its
// RD-3 adapter, on the same guarded Database as the durable handoff.
// Alongside each measured run, a separate stream of invalid-signature
// deliveries (VERIFIER 401, eligible) is sent at the J2 rate. The harness's
// own limiter configuration raises L1, L2 and L3 so that neither stream is
// converted to 429; no production limit or default is changed. The result
// is recorded, never declared a pass. Admin mode: baseline, seeding,
// observation and clean-up.
//
// Differences from PERF-1, all in this file: the 011A composition; L2
// raised; the rejection stream; the 011A invariants; per-run recorder
// counters; and the server logger at "warn" into a capture (PERF-1 disables
// it) so that REJECTION_STAGE_UNMAPPED can be counted. The attribution
// functions (handoffRecord, captureHandoffLog, noteHandoff, reasonFor) and
// drive, percentile, round, observe and summarize are copied from
// perf.db.test.ts unchanged.

const TEST_SUPPORT = new URL("../../../packages/db/dist/test-support/", import.meta.url);

async function loadTestSupport<T>(file: string): Promise<T> {
  const url = new URL(file, TEST_SUPPORT);
  if (!existsSync(url)) {
    assert.fail(`@irs/db test support not built: ${fileURLToPath(url)} is missing; build it first (pnpm --filter @irs/db build)`);
  }
  return (await import(url.href)) as T;
}

const { assertServerBaseline } = await loadTestSupport<typeof BaselineSupport>("baseline.js");
const { guardedDatabase, removeIntegrations, seedIntegration } = await loadTestSupport<typeof DatabaseSupport>("database.js");
const { connectGuarded, requireTestUrl } = await loadTestSupport<typeof GuardSupport>("guard.js");

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");

const RUNS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
/** J2 (R6): the rejection stream's rate; a test input, not a target. */
const REJECTION_STREAM_PER_SECOND = 20;
const SCOPE = `perf-011a-${randomUUID()}`;
const HARNESS_POLICIES: RateLimitPolicies = {
  ...DEFAULT_RATE_LIMIT_POLICIES,
  L1: { ...DEFAULT_RATE_LIMIT_POLICIES.L1, bucket: { ...DEFAULT_RATE_LIMIT_POLICIES.L1.bucket, capacity: 1_000_000 } },
  L2: { ...DEFAULT_RATE_LIMIT_POLICIES.L2, bucket: { ...DEFAULT_RATE_LIMIT_POLICIES.L2.bucket, capacity: 1_000_000 } },
  L3: { ...DEFAULT_RATE_LIMIT_POLICIES.L3, bucket: { ...DEFAULT_RATE_LIMIT_POLICIES.L3.bucket, capacity: 1_000_000 } },
};

// Payload sizes: small (the default envelope), typical (about 4 KiB) and a
// larger-payload check (about 512 KiB, within the 1 MiB input bound).
const PAYLOADS = {
  small: (): Record<string, unknown> => ({ amount: 100 }),
  typical: (): Record<string, unknown> => ({
    items: Array.from({ length: 40 }, (_, i) => ({ sku: `sku-${i}`, name: `item ${i} ${"n".repeat(60)}`, qty: i % 5, price: 1_000 + i })),
  }),
  large: (): Record<string, unknown> => ({ blob: "x".repeat(512 * 1024) }),
} as const;
type PayloadSize = keyof typeof PAYLOADS;

// Admin mode: baseline, seeding, invariant observation and cleanup.
let admin: GuardSupport.GuardedConnection;
let db: Database;
let app: FastifyInstance;
let port = 0;
let ev: EvidenceComposition;
let store: PostgresEvidenceStore;
const logs = new LogCapture();
const seeded: string[] = [];

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-perf011a-admin" });
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
  for (let i = 0; i < 16 * RUNS + 1; i += 1) seeded.push(await seedIntegration(admin.client, "ACTIVE"));
  const logger: HandoffLogger = {
    info: () => undefined,
    warn: (object) => captureHandoffLog(object),
    error: (object) => captureHandoffLog(object),
  };
  const durable = createDurableIngestionHandoff({ db, logger });
  store = createPostgresEvidenceStore({ db });
  let appRef: FastifyInstance | undefined;
  ev = composeEvidence({
    store,
    rateLimitPolicies: HARNESS_POLICIES,
    auditPolicies: DEFAULT_AUDIT_POLICIES,
    scope: SCOPE,
    logger: {
      warn: (object, message) => appRef?.log.warn(object, message),
      error: (object, message) => appRef?.log.error(object, message),
    },
  });
  const t = makeApp({
    handoff: new RecordingHandoff(async (request) => {
      try {
        const outcome = await durable.accept(request);
        noteHandoff(request.requestId, {
          outcome: outcome.status,
          ...(outcome.status === "UNAVAILABLE" && outcome.classification !== undefined ? { classification: outcome.classification } : {}),
        });
        return outcome;
      } catch (error) {
        noteHandoff(request.requestId, { outcome: "THREW" });
        throw error;
      }
    }),
    secrets: Object.fromEntries(seeded.map((id) => [id, SECRET_TEXT])),
    rateLimiter: ev.limiter,
    rejectionAudit: ev.sink,
    logs,
    server: { logger: { level: "warn", stream: logs } },
  });
  app = t.app;
  appRef = app;
  await ev.slots.startupSlot(new AbortController().signal);
  port = await listen(app);
  const version = (await admin.client.query<{ v: string }>("SELECT version() AS v")).rows[0]?.v;
  process.stdout.write(
    `[PERF-011A env] ${JSON.stringify({
      node: process.version,
      postgres: version,
      pool: DEFAULT_POOL_SETTINGS,
      transaction: DEFAULT_TRANSACTION_OPTIONS,
      runs: RUNS,
      rejectionStreamPerSecond: REJECTION_STREAM_PER_SECOND,
      auditPolicies: DEFAULT_AUDIT_POLICIES,
      limiterInstanceId: ev.limiterInstanceId,
      harnessLimiter: "L1/L2/L3 bucket capacity raised in the harness only; production defaults unchanged",
    })}\n`,
  );
});

after(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  await admin.client.query(`DELETE FROM "public"."RateLimitEvidence" WHERE "scope" = $1`, [SCOPE]);
  await admin.client.query(
    `DELETE FROM "public"."AuditEntry" WHERE "action" = 'EVENT_REJECTED' AND "metadata"->>'limiterInstanceId' = $1`,
    [ev.limiterInstanceId],
  );
  await removeIntegrations(admin.client, seeded);
  await assertServerBaseline(admin.client);
  await admin.close();
});

let integrationCursor = 0;
function nextIntegration(): string {
  const id = seeded[integrationCursor];
  integrationCursor += 1;
  assert.ok(id !== undefined, "seeded integrations exhausted");
  return id;
}

// ---- Copied from perf.db.test.ts unchanged (attribution and measurement) ----

interface HandoffRecord {
  outcome?: string;
  classification?: string;
  code?: string;
  errorName?: string;
  logOutcome?: string;
  settledAt?: number;
}
const handoffRecords = new Map<string, HandoffRecord>();

function handoffRecord(requestId: string): HandoffRecord {
  let record = handoffRecords.get(requestId);
  if (record === undefined) {
    record = {};
    handoffRecords.set(requestId, record);
  }
  return record;
}

function captureHandoffLog(object: Record<string, unknown>): void {
  if (typeof object.requestId !== "string") return;
  const record = handoffRecord(object.requestId);
  if (typeof object.code === "string") record.code = object.code;
  if (typeof object.errorName === "string") record.errorName = object.errorName;
  if (typeof object.outcome === "string") record.logOutcome = object.outcome;
}

function noteHandoff(requestId: string, settled: { outcome: string; classification?: string }): void {
  const record = handoffRecord(requestId);
  record.outcome = settled.outcome;
  if (settled.classification !== undefined) record.classification = settled.classification;
  record.settledAt = performance.now();
}

interface Result {
  readonly status: number | "TIMEOUT" | "FAILED";
  readonly ms: number;
  readonly requestId?: string;
  /** performance.now() when the client had the whole response. */
  readonly receivedAt?: number;
}

/**
 * The reason for a non-202 result: the handoff's outcome and classification
 * with the code from its own error record, or the response deadline when the
 * 503 was sent before the handoff settled.
 */
function reasonFor(result: Result): string {
  if (result.status === "TIMEOUT" || result.status === "FAILED") return `CLIENT_${result.status}`;
  if (result.requestId === undefined) return `HTTP_${result.status} (no requestId)`;
  const record = handoffRecords.get(result.requestId);
  if (record === undefined) return `HTTP_${result.status} handoff not called`;
  if (record.settledAt === undefined || record.settledAt > (result.receivedAt ?? Number.POSITIVE_INFINITY)) {
    return `HTTP_${result.status} RESPONSE_DEADLINE (handoff ${record.settledAt === undefined ? "unsettled" : `settled later: ${String(record.outcome)}`})`;
  }
  return [
    `HTTP_${result.status} ${String(record.outcome)}`,
    record.classification === undefined ? "" : `/${record.classification}`,
    record.code === undefined ? "" : ` code=${record.code}`,
    record.errorName === undefined ? "" : ` errorName=${record.errorName}`,
  ].join("");
}

async function drive(
  integrationId: string,
  requests: ReadonlyArray<{ body: Buffer; headers: Record<string, string> }>,
  concurrency: number,
): Promise<{ results: Result[]; wallMs: number }> {
  const url = `http://127.0.0.1:${port}/api/webhooks/${integrationId}`;
  const results: Result[] = [];
  let next = 0;
  const started = performance.now();
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const request = requests[index];
      if (request === undefined) return;
      const sent = performance.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        const receivedAt = performance.now();
        const ms = receivedAt - sent;
        let requestId: string | undefined;
        try {
          const parsed = (JSON.parse(text) as { requestId?: unknown }).requestId;
          if (typeof parsed === "string") requestId = parsed;
        } catch {
          // Not JSON: no request ID to attribute.
        }
        results.push({ status: response.status, ms, receivedAt, ...(requestId === undefined ? {} : { requestId }) });
      } catch (error) {
        results.push({ status: error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "FAILED", ms: performance.now() - sent });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { results, wallMs: performance.now() - started };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? Number.NaN;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Admin mode (observation): the invariant state for one integration. */
async function observe(integrationId: string, requestIds: readonly string[]) {
  const events = (
    await admin.client.query<{ id: string; externalEventId: string; rawBodySha256: string }>(
      `SELECT "id"::text AS "id", "externalEventId", "rawBodySha256" FROM "public"."Event" WHERE "integrationId" = $1`,
      [integrationId],
    )
  ).rows;
  const audits = (
    await admin.client.query<{ id: string; entityId: string; metadata: Record<string, unknown> }>(
      `SELECT "id"::text AS "id", "entityId", "metadata" FROM "public"."AuditEntry"
        WHERE "action" = 'EVENT_RECEIVED' AND "id" = ANY($1::uuid[])`,
      [requestIds],
    )
  ).rows;
  return { events, audits };
}

function summarize(cell: Record<string, unknown>, runs: Array<{ results: Result[]; wallMs: number }>): Record<string, unknown> {
  const all = runs.flatMap((run) => run.results);
  const successMs = all.filter((r) => r.status === 202).map((r) => r.ms).sort((a, b) => a - b);
  const statusCounts: Record<string, number> = {};
  for (const r of all) statusCounts[String(r.status)] = (statusCounts[String(r.status)] ?? 0) + 1;
  const nonAcceptedReasons: Record<string, number> = {};
  for (const r of all) {
    if (r.status === 202) continue;
    const reason = reasonFor(r);
    nonAcceptedReasons[reason] = (nonAcceptedReasons[reason] ?? 0) + 1;
  }
  const perRun = runs.map((run) => ({
    successful: run.results.filter((r) => r.status === 202).length,
    wallMs: round(run.wallMs),
    successfulPerSecond: round((run.results.filter((r) => r.status === 202).length * 1_000) / run.wallMs),
  }));
  return {
    ...cell,
    measuredRuns: runs.length,
    requests: all.length,
    statusCounts,
    nonAcceptedReasons,
    failures: all.filter((r) => r.status === "FAILED").length,
    timeouts: all.filter((r) => r.status === "TIMEOUT").length,
    p50Ms: round(percentile(successMs, 50)),
    p95Ms: round(percentile(successMs, 95)),
    successfulPerSecond: perRun.map((r) => r.successfulPerSecond),
    perRun,
  };
}

// ---- Task 011A additions ----

/** One invalid-signature delivery every 1000 / J2 ms to the run's integration, until stopped. */
function rejectionStream(integrationId: string): { stop(): Promise<{ results: Result[]; wallMs: number; sent: number }> } {
  const url = `http://127.0.0.1:${port}/api/webhooks/${integrationId}`;
  const results: Result[] = [];
  const pending: Promise<void>[] = [];
  const started = performance.now();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let sent = 0;
  const intervalMs = 1_000 / REJECTION_STREAM_PER_SECOND;
  const fire = (): void => {
    if (stopped) return;
    sent += 1;
    const request = validRequest(envelopeJson({ externalEventId: `perf-r-${randomUUID()}` }));
    const headers = { ...request.headers, "irs-signature": sign(Buffer.from("forged")) };
    const at = performance.now();
    pending.push(
      fetch(url, { method: "POST", headers, body: request.body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then(
        async (response) => {
          const text = await response.text();
          const receivedAt = performance.now();
          let requestId: string | undefined;
          try {
            const parsed = (JSON.parse(text) as { requestId?: unknown }).requestId;
            if (typeof parsed === "string") requestId = parsed;
          } catch {
            // Not JSON.
          }
          results.push({ status: response.status, ms: receivedAt - at, receivedAt, ...(requestId === undefined ? {} : { requestId }) });
        },
        (error: unknown) => {
          results.push({ status: error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "FAILED", ms: performance.now() - at });
        },
      ),
    );
    timer = setTimeout(fire, intervalMs);
  };
  fire();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      const wallMs = performance.now() - started;
      await Promise.all(pending);
      return { results, wallMs, sent };
    },
  };
}

function counterDelta(before: AuditRecorderCounters, after: AuditRecorderCounters): Record<string, number> {
  const fields: (keyof AuditRecorderCounters)[] = [
    "submitted",
    "ineligibleNonWebhook",
    "suppressedByCeiling",
    "droppedQueueFull",
    "admitted",
    "persisted",
    "conflicts",
    "notAttemptedAtShutdown",
    "outcomeUnknownAtShutdown",
  ];
  return Object.fromEntries(fields.map((field) => [field, after[field] - before[field]]));
}

const runRecords: Record<string, unknown>[] = [];
let maxHighWaterMark = 0;

/** One measured run with the rejection stream alongside it, and the 011A invariants. */
async function measure(
  label: string,
  integrationId: string,
  requests: ReadonlyArray<{ body: Buffer; headers: Record<string, string> }>,
  concurrency: number,
): Promise<{ results: Result[]; wallMs: number }> {
  const countersBefore = ev.recorder.cumulative();
  const stream = rejectionStream(integrationId);
  const measured = await drive(integrationId, requests, concurrency);
  const rejections = await stream.stop();
  const countersAfter = ev.recorder.cumulative();
  maxHighWaterMark = Math.max(maxHighWaterMark, store.highWaterMark);
  assert.ok(store.highWaterMark <= 2, "RD-3: highWaterMark ≤ 2");
  // No EVENT_REJECTED row for a 202 request.
  const accepted = measured.results.filter((r) => r.status === 202).map((r) => String(r.requestId));
  const crossed = await admin.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "public"."AuditEntry" WHERE "action" = 'EVENT_REJECTED' AND "id" = ANY($1::uuid[])`,
    [accepted],
  );
  assert.equal(crossed.rows[0]?.n, 0, "no EVENT_REJECTED row for a 202 request");
  const rejectionStatus: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};
  for (const r of rejections.results) {
    rejectionStatus[String(r.status)] = (rejectionStatus[String(r.status)] ?? 0) + 1;
    if (r.status !== 401) {
      const reason = reasonFor(r);
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
  }
  runRecords.push({
    run: label,
    deliveryStatus: Object.fromEntries(Object.entries(measured.results.reduce<Record<string, number>>((acc, r) => {
      acc[String(r.status)] = (acc[String(r.status)] ?? 0) + 1;
      return acc;
    }, {}))),
    rejectionSent: rejections.sent,
    rejectionStatus,
    rejectionNon401Reasons: rejectionReasons,
    achievedRejectionsPerSecond: round((rejections.sent * 1_000) / rejections.wallMs),
    counters: counterDelta(countersBefore, countersAfter),
    highWaterMark: store.highWaterMark,
    inFlight: store.inFlight,
  });
  return measured;
}

async function uniqueCell(size: PayloadSize, concurrency: number, perRun: number): Promise<void> {
  const runs: Array<{ results: Result[]; wallMs: number }> = [];
  for (let run = 0; run < RUNS; run += 1) {
    const integrationId = nextIntegration();
    const requests = Array.from({ length: perRun }, (_, i) =>
      validRequest(envelopeJson({ externalEventId: `perf-u-${size}-${concurrency}-${run}-${i}`, payload: PAYLOADS[size]() })),
    );
    const measured = await measure(`unique/${size}/${concurrency}/${run}`, integrationId, requests, concurrency);
    runs.push(measured);
    // PERF-1 invariants: one Event per key; each 202 has its committed EVENT_RECEIVED row naming that Event.
    const accepted = measured.results.filter((r) => r.status === 202).map((r) => String(r.requestId));
    const { events, audits } = await observe(integrationId, accepted);
    assert.equal(new Set(events.map((e) => e.externalEventId)).size, events.length, "one Event per idempotency key");
    assert.equal(events.length, accepted.length, "every accepted unique delivery stored exactly one Event");
    assert.equal(audits.length, accepted.length, "every 202 has a committed EVENT_RECEIVED row");
    const eventIds = new Set(events.map((e) => e.id));
    for (const audit of audits) {
      assert.ok(eventIds.has(audit.entityId), "EVENT_RECEIVED names a stored Event");
      assert.equal(audit.metadata.disposition, "NEW");
    }
  }
  process.stdout.write(`[PERF-011A] ${JSON.stringify(summarize({ path: "unique", size, concurrency, perRun }, runs))}\n`);
}

async function duplicateCell(size: PayloadSize, concurrency: number, perRun: number): Promise<void> {
  const runs: Array<{ results: Result[]; wallMs: number }> = [];
  for (let run = 0; run < RUNS; run += 1) {
    const integrationId = nextIntegration();
    const key = `perf-d-${size}-${concurrency}-${run}`;
    const original = validRequest(envelopeJson({ externalEventId: key, payload: PAYLOADS[size]() }));
    const first = await drive(integrationId, [original], 1);
    assert.equal(first.results[0]?.status, 202, "the original delivery is accepted (not measured)");
    const originalSha = createHash("sha256").update(original.body).digest("hex");
    const measured = await measure(`duplicate/${size}/${concurrency}/${run}`, integrationId, Array.from({ length: perRun }, () => original), concurrency);
    runs.push(measured);
    const accepted = measured.results.filter((r) => r.status === 202).map((r) => String(r.requestId));
    const { events, audits } = await observe(integrationId, accepted);
    assert.equal(events.length, 1, "one Event for the key");
    assert.equal(events[0]?.rawBodySha256, originalSha, "duplicates never overwrite the original event");
    assert.equal(audits.length, accepted.length, "every 202 has a committed EVENT_RECEIVED row");
    for (const audit of audits) {
      assert.equal(audit.metadata.disposition, "DUPLICATE");
      assert.equal(audit.metadata.contentMatches, true);
      assert.equal(audit.entityId, events[0]?.id);
    }
    if (run === 0) {
      // A payload mismatch stays visible and leaves the stored event unchanged (not measured).
      const mismatch = validRequest(envelopeJson({ externalEventId: key, payload: { mismatch: true } }));
      const result = await drive(integrationId, [mismatch], 1);
      assert.equal(result.results[0]?.status, 202);
      const after = await observe(integrationId, [String(result.results[0]?.requestId)]);
      assert.equal(after.audits[0]?.metadata.contentMatches, false, "contentMatches: false is visible");
      assert.equal(after.events.length, 1);
      assert.equal(after.events[0]?.rawBodySha256, originalSha, "the stored event is unchanged");
    }
  }
  process.stdout.write(`[PERF-011A] ${JSON.stringify(summarize({ path: "duplicate", size, concurrency, perRun }, runs))}\n`);
}

describe("PERF-011A (synthetic; Task 011A active; RD-3)", () => {
  it("PERF-1's workload with 011A composed and a 20/s rejection stream; correctness and 011A invariants hold", { timeout: 900_000 }, async () => {
    const warmup = nextIntegration();
    await drive(
      warmup,
      Array.from({ length: 50 }, (_, i) => validRequest(envelopeJson({ externalEventId: `perf-warmup-${i}` }))),
      5,
    );
    for (const size of ["small", "typical"] as const) {
      for (const [concurrency, perRun] of [
        [1, 100],
        [10, 300],
        [50, 500],
      ] as const) {
        await uniqueCell(size, concurrency, perRun);
        await duplicateCell(size, concurrency, perRun);
      }
    }
    for (const [concurrency, perRun] of [
      [1, 10],
      [10, 30],
    ] as const) {
      await uniqueCell("large", concurrency, perRun);
      await duplicateCell("large", concurrency, perRun);
    }
    // Finalization through the production slot; then the durable count equals persisted.
    const finalization = await ev.slots.finalizeBeforeDisconnect("SIGNAL", { forced: false });
    const totals = ev.recorder.cumulative();
    const rows = await admin.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "public"."AuditEntry" WHERE "action" = 'EVENT_REJECTED' AND "metadata"->>'limiterInstanceId' = $1`,
      [ev.limiterInstanceId],
    );
    process.stdout.write(`[PERF-011A runs] ${JSON.stringify(runRecords)}\n`);
    process.stdout.write(
      `[PERF-011A totals] ${JSON.stringify({
        finalization,
        recorder: totals,
        afterFinalize: ev.recorder.afterFinalize,
        eventRejectedRows: rows.rows[0]?.n,
        maxHighWaterMark,
        refusedByCutoff: store.refusedByCutoff,
        unmappedLogs: logs.count("REJECTION_STAGE_UNMAPPED"),
      })}\n`,
    );
    assert.equal(rows.rows[0]?.n, totals.persisted, "EVENT_REJECTED rows = persisted");
    assert.equal(totals.notAttemptedAtShutdown, 0);
    assert.equal(totals.outcomeUnknownAtShutdown, 0);
    assert.ok(maxHighWaterMark <= 2);
    assert.equal(logs.count("REJECTION_STAGE_UNMAPPED"), 0);
    process.stdout.write(
      `[PERF-011A payload bytes] ${JSON.stringify(
        Object.fromEntries(
          (Object.keys(PAYLOADS) as PayloadSize[]).map((size) => [size, Buffer.byteLength(envelopeJson({ externalEventId: "perf-size", payload: PAYLOADS[size]() }))]),
        ),
      )}\n`,
    );
  });
});
