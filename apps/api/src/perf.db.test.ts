import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { DEFAULT_RATE_LIMIT_POLICIES } from "./rate-limit.js";
import type { RateLimitPolicies } from "./rate-limit.js";
import { RecordingHandoff, SECRET_TEXT, envelopeJson, listen, makeApp, validRequest } from "./test-helpers.js";

// PERF-1 (Rev 1.7 §16.5; Prompt B Stage 8). SYNTHETIC: a bounded benchmark
// on the local Docker test PostgreSQL, never production-capacity evidence.
// Deliveries go over real TCP (loopback, test-owned listener) through
// buildServer and the durable handoff to the production createDatabase pool
// (default PoolSettings), as irs_test_api (api mode). The harness's own
// limiter policies are raised so that the limiter is not what is measured;
// no production limit or default is changed. Correctness invariants are
// asserted; the metrics are printed as one JSON line per cell ("[PERF-1]").
//
// FD-8: test support is loaded from @irs/db's build output by relative path.
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
const HARNESS_POLICIES: Partial<RateLimitPolicies> = {
  L1: { ...DEFAULT_RATE_LIMIT_POLICIES.L1, bucket: { ...DEFAULT_RATE_LIMIT_POLICIES.L1.bucket, capacity: 1_000_000 } },
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
const seeded: string[] = [];

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-perf1-admin" });
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
  // One integration per measured run (16 cells × RUNS) plus the warm-up.
  for (let i = 0; i < 16 * RUNS + 1; i += 1) seeded.push(await seedIntegration(admin.client, "ACTIVE"));
  // Cause attribution for non-202 responses (founder-authorized PERF-1 re-run,
  // 2026-10-18). Server logging stays off; instead the handoff's own error
  // records (errorName, code, outcome) and its returned outcome are kept in
  // memory per request ID, with the time the handoff settled. No load change.
  const logger: HandoffLogger = {
    info: () => undefined,
    warn: (object) => captureHandoffLog(object),
    error: (object) => captureHandoffLog(object),
  };
  const durable = createDurableIngestionHandoff({ db, logger });
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
    rateLimit: { policies: HARNESS_POLICIES },
    server: { logger: false },
  });
  app = t.app;
  port = await listen(app);
  const version = (await admin.client.query<{ v: string }>("SELECT version() AS v")).rows[0]?.v;
  process.stdout.write(
    `[PERF-1 env] ${JSON.stringify({
      node: process.version,
      postgres: version,
      pool: DEFAULT_POOL_SETTINGS,
      transaction: DEFAULT_TRANSACTION_OPTIONS,
      runs: RUNS,
      harnessLimiter: "L1/L3 bucket capacity raised in the harness only; production defaults unchanged",
    })}\n`,
  );
});

after(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
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

async function uniqueCell(size: PayloadSize, concurrency: number, perRun: number): Promise<void> {
  const runs: Array<{ results: Result[]; wallMs: number }> = [];
  for (let run = 0; run < RUNS; run += 1) {
    const integrationId = nextIntegration();
    const requests = Array.from({ length: perRun }, (_, i) =>
      validRequest(envelopeJson({ externalEventId: `perf-u-${size}-${concurrency}-${run}-${i}`, payload: PAYLOADS[size]() })),
    );
    const measured = await drive(integrationId, requests, concurrency);
    runs.push(measured);
    // Invariants: one Event per key; each 202 has its committed EVENT_RECEIVED row naming that Event.
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
  process.stdout.write(`[PERF-1] ${JSON.stringify(summarize({ path: "unique", size, concurrency, perRun }, runs))}\n`);
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
    const measured = await drive(integrationId, Array.from({ length: perRun }, () => original), concurrency);
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
  process.stdout.write(`[PERF-1] ${JSON.stringify(summarize({ path: "duplicate", size, concurrency, perRun }, runs))}\n`);
}

describe("PERF-1 (synthetic; §16.5)", () => {
  it("warm-up (discarded), then 3 measured runs per cell; correctness invariants hold under concurrency", { timeout: 900_000 }, async () => {
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
    process.stdout.write(
      `[PERF-1 payload bytes] ${JSON.stringify(
        Object.fromEntries(
          (Object.keys(PAYLOADS) as PayloadSize[]).map((size) => [size, Buffer.byteLength(envelopeJson({ externalEventId: "perf-size", payload: PAYLOADS[size]() }))]),
        ),
      )}\n`,
    );
  });
});
