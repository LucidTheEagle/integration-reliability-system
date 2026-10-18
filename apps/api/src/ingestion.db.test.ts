import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createDatabase, ingestEvent } from "@irs/db";
import type { Database, EventIngestionInput, EventIngestionResult, TransactionClient } from "@irs/db";
import type * as BaselineSupport from "../../../packages/db/dist/test-support/baseline.js";
import type * as DatabaseSupport from "../../../packages/db/dist/test-support/database.js";
import type * as GuardSupport from "../../../packages/db/dist/test-support/guard.js";
import type * as ServerLogSupport from "../../../packages/db/dist/test-support/server-log.js";
import type * as SyncRepSupport from "../../../packages/db/dist/test-support/syncrep-stall.js";
import { createDurableIngestionHandoff } from "./durable-ingestion.js";
import type { HandoffLogger } from "./durable-ingestion.js";
import { DEFAULT_RATE_LIMIT_POLICIES } from "./rate-limit.js";
import type { Counters, RateLimitPolicies } from "./rate-limit.js";
import {
  LogCapture,
  RecordingHandoff,
  SECRET_TEXT,
  envelopeJson,
  listen,
  makeApp,
  parseJson,
  rawExchange,
  spyLimiter,
  validRequest,
} from "./test-helpers.js";
import type { LimiterSpy, TestApp } from "./test-helpers.js";

// Task 011 HTTP tests against PostgreSQL (Rev 1.7 §16.3): HT-1 – HT-4,
// HT-8, HT-9, the database halves of HT-10 and HT-11, and SEC-1. Requests go
// through buildServer and the durable handoff to the production
// createDatabase path, connected as irs_test_api (api mode).
//
// FD-8 (2026-10-17): only apps/api *.db.test.ts files load @irs/db's test
// support (the guard, seeding, baseline, statement capture), and only from
// its build output by relative path. @irs/db exports only "." (FA-1). A
// missing build fails the test with a message naming the file; it never skips.
const TEST_SUPPORT = new URL("../../../packages/db/dist/test-support/", import.meta.url);

async function loadTestSupport<T>(file: string): Promise<T> {
  const url = new URL(file, TEST_SUPPORT);
  if (!existsSync(url)) {
    assert.fail(
      `@irs/db test support not built: ${fileURLToPath(url)} is missing; ` +
        "build it first (pnpm --filter @irs/db build)",
    );
  }
  return (await import(url.href)) as T;
}

const { assertServerBaseline } = await loadTestSupport<typeof BaselineSupport>("baseline.js");
const { STALL_ROLE, pinSession, revertCommitStall, stallCommits } =
  await loadTestSupport<typeof SyncRepSupport>("syncrep-stall.js");
const { countRows, guardedDatabase, latch, removeIntegrations, seedIntegration } =
  await loadTestSupport<typeof DatabaseSupport>("database.js");
const { connectGuarded, requireTestUrl, withUser } = await loadTestSupport<typeof GuardSupport>("guard.js");
const { readServerLog, settleLog, statementsOf } = await loadTestSupport<typeof ServerLogSupport>("server-log.js");

type ConfigStatus = DatabaseSupport.ConfigStatus;

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_MARKER = "irs-pg-body-marker-5e8b";
const STATUS_CHECK_SQL = `SELECT "public"."irs_integration_config_status_for_share"($1) AS "configStatus"`;

// Generous limits: these tests exercise ingestion, not the limiter (HT-3
// supplies its own small L3 policy). The manual clock never refills.
const ROOMY: Partial<RateLimitPolicies> = {
  L1: { ...DEFAULT_RATE_LIMIT_POLICIES.L1, bucket: { ...DEFAULT_RATE_LIMIT_POLICIES.L1.bucket, capacity: 10_000 } },
  L2: { ...DEFAULT_RATE_LIMIT_POLICIES.L2, bucket: { ...DEFAULT_RATE_LIMIT_POLICIES.L2.bucket, capacity: 10_000 } },
};

// Admin mode (connectGuarded "admin"): the server baseline check, seeding
// Integration rows, row observation and cleanup. irs_test_api has no
// privilege on "Integration" (FD-2) and cannot read whole rows. Every request
// under test runs as irs_test_api.
let admin: GuardSupport.GuardedConnection;
let db: Database;
const seeded: string[] = [];
const extraDatabases: Database[] = [];
const apps: FastifyInstance[] = [];

async function seed(status: ConfigStatus = "ACTIVE"): Promise<string> {
  const id = await seedIntegration(admin.client, status);
  seeded.push(id);
  return id;
}

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-api-ht-admin" });
  // FD-14 (HC-6): this session also sets up and observes DL-PG-2's stall, so
  // it pins synchronous_commit = local before anything commits.
  await pinSession(admin.client);
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
});

after(async () => {
  for (const app of apps) await app.close();
  for (const extra of extraDatabases) await extra.prisma.$disconnect();
  await db.prisma.$disconnect();
  await removeIntegrations(admin.client, seeded);
  await assertServerBaseline(admin.client);
  await admin.close();
});

type Ingest = (db: Database, input: EventIngestionInput) => Promise<EventIngestionResult>;

interface PgApp extends TestApp {
  readonly spy: LimiterSpy;
  readonly ingested: EventIngestionInput[];
  delta(): Counters;
}

/**
 * buildServer (through makeApp) with the durable handoff over `database`,
 * spied by a RecordingHandoff; the handoff logs through the server's logger,
 * as in production.ts. Every listed integration is given the test secret.
 */
function serve(options: {
  readonly integrations: readonly string[];
  readonly database?: Database;
  readonly ingest?: Ingest;
  readonly policies?: Partial<RateLimitPolicies>;
  readonly logs?: LogCapture;
  readonly server?: { requestTimeoutMs?: number; headersTimeoutMs?: number };
}): PgApp {
  const ingested: EventIngestionInput[] = [];
  const ingest: Ingest = options.ingest ?? ((database, input) => ingestEvent(database, input));
  let appRef: FastifyInstance | undefined;
  const logger: HandoffLogger = {
    info: (object, message) => appRef?.log.info(object, message),
    warn: (object, message) => appRef?.log.warn(object, message),
    error: (object, message) => appRef?.log.error(object, message),
  };
  const durable = createDurableIngestionHandoff({
    db: options.database ?? db,
    logger,
    ingest: async (database, input) => {
      ingested.push(input);
      return ingest(database, input);
    },
  });
  let spy: LimiterSpy | undefined;
  const t = makeApp({
    handoff: new RecordingHandoff((request) => durable.accept(request)),
    secrets: Object.fromEntries(options.integrations.map((id) => [id, SECRET_TEXT])),
    ...(options.logs === undefined ? {} : { logs: options.logs }),
    ...(options.server === undefined ? {} : { server: options.server }),
    rateLimit: {
      policies: options.policies ?? ROOMY,
      wrap: (inner) => {
        spy = spyLimiter(inner);
        return spy.limiter;
      },
    },
  });
  appRef = t.app;
  apps.push(t.app);
  assert.ok(spy !== undefined && t.evidence !== undefined);
  const evidence = t.evidence;
  return { ...t, spy, ingested, delta: () => evidence.drain().delta };
}

function delivery(externalEventId: string, payload: Record<string, unknown> = { note: BODY_MARKER }) {
  return validRequest(envelopeJson({ externalEventId, payload }));
}

function post(t: TestApp, integrationId: string, request: { body: Buffer; headers: Record<string, string> }) {
  return t.app.inject({ method: "POST", url: `/api/webhooks/${integrationId}`, headers: request.headers, payload: request.body });
}

function json(text: string): Record<string, unknown> {
  return parseJson(text) as Record<string, unknown>;
}

function assertGeneric(response: { statusCode: number; body: string }, status: number, code: string): string {
  assert.equal(response.statusCode, status);
  const body = json(response.body);
  assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
  assert.equal(body.error, code);
  assert.match(String(body.requestId), UUID);
  return String(body.requestId);
}

/** Admin mode: EVENT_RECEIVED rows whose id is one of the request IDs (observation). */
async function receivedRows(requestIds: readonly string[]) {
  return (
    await admin.client.query<{ id: string; entityId: string; metadata: Record<string, unknown> }>(
      `SELECT "id"::text AS "id", "entityId", "metadata" FROM "public"."AuditEntry"
        WHERE "action" = 'EVENT_RECEIVED' AND "id" = ANY($1::uuid[]) ORDER BY "createdAt", "id"`,
      [requestIds],
    )
  ).rows;
}

/** Admin mode: Event rows for one integration (observation). */
async function storedEvents(integrationId: string) {
  return (
    await admin.client.query<{ id: string; externalEventId: string; rawBody: Buffer; rawBodySha256: string }>(
      `SELECT "id"::text AS "id", "externalEventId", "rawBody", "rawBodySha256" FROM "public"."Event"
        WHERE "integrationId" = $1 ORDER BY "externalEventId"`,
      [integrationId],
    )
  ).rows;
}

/** SEC-1: none of the sentinels appears in any response body or captured log line. */
function assertNoSentinels(texts: readonly string[], sentinels: readonly string[]): void {
  for (const text of texts) {
    for (const sentinel of sentinels) {
      assert.equal(text.includes(sentinel), false, `sentinel leaked: ${sentinel}`);
    }
  }
}

function requestSentinels(requests: ReadonlyArray<{ headers: Record<string, string> }>): string[] {
  return [SECRET_TEXT, BODY_MARKER, ...requests.map((request) => request.headers["irs-signature"] ?? "unsigned")];
}

/** A pool limited to one connection, so its backend's statements can be read from the server log. */
async function capturePool(): Promise<{ database: Database; pid: number; since: Date }> {
  const database = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
  extraDatabases.push(database);
  const since = new Date(Date.now() - 2_000);
  const pid = (await database.prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid;
  assert.equal(typeof pid, "number");
  return { database, pid: pid ?? -1, since };
}

async function capturedTransactions(capture: { pid: number; since: Date }): Promise<string[][]> {
  await settleLog();
  const statements = statementsOf(await readServerLog(capture.since), capture.pid).filter(
    (sql) => sql !== "SELECT pg_backend_pid() AS pid",
  );
  const transactions: string[][] = [];
  for (const sql of statements) {
    if (sql === "BEGIN") transactions.push([]);
    else if (transactions.length === 0) transactions.push([`(outside a transaction) ${sql}`]);
    else transactions[transactions.length - 1]?.push(sql);
  }
  return transactions;
}

// ---------------------------------------------------------------------------

describe("HT-1 / HT-2: durable acceptance through buildServer", () => {
  it("HT-1: a signed delivery → 202 after commit; the Event row is stored byte-identical; AuditEntry.id = requestId", async () => {
    const integrationId = await seed();
    const t = serve({ integrations: [integrationId] });
    const request = delivery("ht1");
    const response = await post(t, integrationId, request);
    assert.equal(response.statusCode, 202);
    const body = json(response.body);
    assert.deepEqual(body, { status: "ACCEPTED", requestId: body.requestId });
    const requestId = String(body.requestId);
    const events = await storedEvents(integrationId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.externalEventId, "ht1");
    assert.deepEqual(Buffer.from(events[0]?.rawBody ?? Buffer.alloc(0)), request.body);
    assert.equal(events[0]?.rawBodySha256, createHash("sha256").update(request.body).digest("hex"));
    const received = await receivedRows([requestId]);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, requestId);
    assert.equal(received[0]?.entityId, events[0]?.id);
    assert.equal(received[0]?.metadata.disposition, "NEW");
    assert.equal(t.delta().layers.L2.individualRejections, 0);
    assertNoSentinels([response.body, t.logs.text()], requestSentinels([request]));
  });

  it("HT-2: the same delivery twice → 202 twice; one Event; a DUPLICATE EVENT_RECEIVED for the second request", async () => {
    const integrationId = await seed();
    const t = serve({ integrations: [integrationId] });
    const request = delivery("ht2");
    const first = await post(t, integrationId, request);
    const second = await post(t, integrationId, request);
    assert.deepEqual([first.statusCode, second.statusCode], [202, 202]);
    const ids = [String(json(first.body).requestId), String(json(second.body).requestId)];
    assert.notEqual(ids[0], ids[1]);
    const events = await storedEvents(integrationId);
    assert.equal(events.length, 1);
    const received = await receivedRows(ids);
    // Matched by request ID, not by row order: both rows carry the harness's
    // fixed receipt time (makeApp's now), so createdAt cannot order them.
    const sorted = [...received].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    assert.deepEqual(sorted.map((row) => [row.id, row.entityId, row.metadata.disposition, row.metadata.contentMatches]), [
      [ids[0], events[0]?.id, "NEW", null],
      [ids[1], events[0]?.id, "DUPLICATE", true],
    ]);
  });
});

describe("HT-3: L3 exhausted (C7)", () => {
  it("429 before the handoff; zero Event and EVENT_RECEIVED rows; L2 not consumed", async () => {
    const integrationId = await seed();
    const t = serve({
      integrations: [integrationId],
      policies: {
        ...ROOMY,
        L3: {
          bucket: { capacity: 1, refillPerSecond: 0.001 },
          overflow: { capacity: 1, refillPerSecond: 0.001 },
          maxKeys: 100,
        },
      },
    });
    assert.ok(t.limiter !== undefined);
    assert.equal(t.limiter.consumeVerified(integrationId, t.limiter.peerKey("127.0.0.1")).allowed, true, "L3 setup consume");
    t.delta();
    const request = delivery("ht3");
    const response = await post(t, integrationId, request);
    const requestId = assertGeneric(response, 429, "TOO_MANY_REQUESTS");
    assert.equal(response.headers.connection, "close");
    assert.match(String(response.headers["retry-after"]), /^[1-9][0-9]*$/);
    assert.equal(t.handoff.requests.length, 0, "the handoff is never called");
    assert.equal(t.ingested.length, 0);
    assert.equal(t.spy.calls.consumeRejectionAllowance, 0);
    assert.equal(t.delta().layers.L2.individualRejections, 0);
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
    assert.deepEqual(await receivedRows([requestId]), []);
  });
});

describe("HT-4 / SEC-1: the database is unreachable", () => {
  // FD-7: test-owned non-database sockets on 127.0.0.1 (a listener the test
  // closes, or one that accepts and stays silent); never a URL to a database.
  // The URL carries a password and a query string as SEC-1 sentinels only.
  const PASSWORD = "irs-pg-password-sentinel-91c4";
  const QUERY = "irs-pg-query-sentinel-3d7e";

  async function testOwnedSocket(kind: "closed" | "silent"): Promise<{ port: number; close(): Promise<void> }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const close = () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
    if (kind === "closed") await close();
    return { port: address.port, close };
  }

  for (const kind of ["closed", "silent"] as const) {
    it(`${kind === "closed" ? "a closed port" : "a silent listener (connect timeout)"} → 503 SERVICE_UNAVAILABLE with no detail; no sentinel in the body or logs`, { timeout: 15_000 }, async () => {
      const socket = await testOwnedSocket(kind);
      const unreachable = createDatabase({
        connectionString: `postgresql://irs_sentinel_user:${PASSWORD}@127.0.0.1:${socket.port}/irs_sentinel_db?application_name=${QUERY}`,
      });
      try {
        const integrationId = randomUUID();
        const t = serve({ integrations: [integrationId], database: unreachable });
        const request = delivery("ht4");
        const response = await post(t, integrationId, request);
        assertGeneric(response, 503, "SERVICE_UNAVAILABLE");
        const failed = t.logs.records().filter((record) => record.msg === "ingestion failed");
        assert.equal(failed.length, 1);
        assert.equal(failed[0]?.outcome, "TRANSIENT");
        assertNoSentinels(
          [response.body, t.logs.text()],
          [...requestSentinels([request]), PASSWORD, QUERY, "irs_sentinel_user", "irs_sentinel_db", `127.0.0.1:${socket.port}`, "ECONNREFUSED", "Connection terminated"],
        );
        assert.equal(t.delta().layers.L2.individualRejections, 0);
      } finally {
        await unreachable.prisma.$disconnect();
        await socket.close();
      }
    });
  }
});

describe("HT-10 / HT-11 (PostgreSQL): the ingestion rejections", () => {
  it("HT-10: P1 and P2 from an ACTIVE integration → 422; no ingestion-path statement; zero Event/EVENT_RECEIVED rows", async () => {
    const integrationId = await seed();
    const capture = await capturePool();
    const t = serve({ integrations: [integrationId], database: capture.database });
    t.delta();
    const requests = [delivery("ht10-p1", { text: `x\u0000${BODY_MARKER}` }), delivery("ht10-p2", { text: `x\uD800${BODY_MARKER}` })];
    const ids: string[] = [];
    for (const request of requests) ids.push(assertGeneric(await post(t, integrationId, request), 422, "UNPROCESSABLE_PAYLOAD"));
    assert.equal(t.ingested.length, 0, "ingestEvent never called");
    assert.equal(t.delta().layers.L2.individualRejections, 2, "one L2 allowance each");
    assert.deepEqual(await capturedTransactions(capture), [], "no statement on the ingestion pool");
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
    assert.deepEqual(await receivedRows(ids), []);
    assertNoSentinels([t.logs.text()], requestSentinels(requests));
  });

  it("HT-11 cases 2 and 3: ineligible integrations → 404 with only the status check; with P1/P2 → 422 and no statement", async () => {
    const integrations = [await seed("DRAFT"), await seed("DISABLED"), await seed("DECOMMISSIONED"), randomUUID()];
    const capture = await capturePool();
    const t = serve({ integrations, database: capture.database });
    t.delta();
    const ids: string[] = [];
    const requests: Array<{ headers: Record<string, string> }> = [];
    for (const integrationId of integrations) {
      const request = delivery(`ht11-${integrationId}`);
      requests.push(request);
      ids.push(assertGeneric(await post(t, integrationId, request), 404, "NOT_FOUND"));
    }
    // Case 3 (D2, retained order): pre-validation runs before the status check.
    for (const [integrationId, text] of [[integrations[1], "\u0000"], [integrations[3], "\uDC00"]] as const) {
      const request = delivery(`ht11-case3-${integrationId}`, { text: `x${text}${BODY_MARKER}` });
      requests.push(request);
      ids.push(assertGeneric(await post(t, integrationId ?? "", request), 422, "UNPROCESSABLE_PAYLOAD"));
    }
    assert.equal(t.ingested.length, 4, "only the four storable deliveries reached ingestEvent");
    assert.equal(t.delta().layers.L2.individualRejections, 6);
    const transactions = await capturedTransactions(capture);
    assert.deepEqual(
      transactions,
      integrations.map(() => ["SET TRANSACTION ISOLATION LEVEL READ COMMITTED", STATUS_CHECK_SQL, "COMMIT"]),
      "per 404: the status check is the only ingestion-path query; case 3 adds none",
    );
    for (const integrationId of integrations) {
      assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
    }
    assert.deepEqual(await receivedRows(ids), []);
    assertNoSentinels([t.logs.text()], requestSentinels(requests));
  });
});

describe("SEC-1 (PostgreSQL): a real database error", () => {
  it("a 42501 from PostgreSQL (status check without EXECUTE) → 500; body generic; logs carry name and code only", async () => {
    // Special mode: irs_test_api_no_execute (the registered role without
    // EXECUTE on the status function).
    const role = "irs_test_api_no_execute";
    const noExecute = await guardedDatabase({ url: withUser(apiUrl, role), mode: "special", special: role });
    extraDatabases.push(noExecute);
    const integrationId = await seed();
    const t = serve({ integrations: [integrationId], database: noExecute });
    const request = delivery("sec1-42501");
    const response = await post(t, integrationId, request);
    assertGeneric(response, 500, "INTERNAL_ERROR");
    const failed = t.logs.records().filter((record) => record.msg === "ingestion failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.outcome, "FAULT");
    assert.equal(typeof failed[0]?.errorName, "string");
    process.stdout.write(`[SEC-1] 42501 logged as ${JSON.stringify({ errorName: failed[0]?.errorName, code: failed[0]?.code })}\n`);
    assertNoSentinels(
      [response.body, t.logs.text()],
      [...requestSentinels([request]), "permission denied", "irs_integration_config_status_for_share", role, "127.0.0.1:55433", "irs_011_test"],
    );
    assert.deepEqual(await countRows(admin.client, integrationId), { events: 0, audits: 0 });
  });
});

describe("HT-8: invariant sweep over real TCP (mixed concurrent traffic, faults injected mid-run)", () => {
  it("every 202 has a committed EVENT_RECEIVED row; no non-202 request has one", { timeout: 30_000 }, async () => {
    const active = await seed();
    const disabled = await seed("DISABLED");
    // Database faults injected inside the real transaction through
    // ingestEvent's internal hook, by external event ID prefix:
    //   transient-*: SQLSTATE 57014 (statement timeout) → TRANSIENT → 503;
    //   fault-*:     SQLSTATE 22012 (division by zero) → FAULT → 500.
    // Each transaction rolls back; neither needs a privilege beyond irs_test_api's.
    const inject: Ingest = (database, input) => {
      if (input.externalEventId.startsWith("transient-")) {
        return ingestEvent(database, input, {
          afterStatusCheck: async (tx: TransactionClient) => {
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 1");
            await tx.$queryRawUnsafe("SELECT pg_sleep(0.2)");
          },
        });
      }
      if (input.externalEventId.startsWith("fault-")) {
        return ingestEvent(database, input, {
          afterStatusCheck: async (tx: TransactionClient) => {
            await tx.$queryRawUnsafe("SELECT 1 / 0");
          },
        });
      }
      return ingestEvent(database, input);
    };
    const t = serve({ integrations: [active, disabled], ingest: inject });
    const port = await listen(t.app);

    type Planned = { kind: string; integrationId: string; request: { body: Buffer; headers: Record<string, string> }; expected: number };
    const planned: Planned[] = [];
    for (let i = 0; i < 12; i += 1) planned.push({ kind: "new", integrationId: active, request: delivery(`new-${i}`), expected: 202 });
    for (let i = 0; i < 3; i += 1) {
      const request = delivery(`dup-${i}`);
      planned.push({ kind: "duplicate", integrationId: active, request, expected: 202 });
      planned.push({ kind: "duplicate", integrationId: active, request, expected: 202 });
    }
    for (let i = 0; i < 2; i += 1) {
      const request = delivery(`badsig-${i}`);
      planned.push({
        kind: "bad-signature",
        integrationId: active,
        request: { body: request.body, headers: { ...request.headers, "irs-signature": `t=1760000000,v1=${"0".repeat(64)}` } },
        expected: 401,
      });
    }
    planned.push({ kind: "p1", integrationId: active, request: delivery("p1-0", { text: `x\u0000${BODY_MARKER}` }), expected: 422 });
    planned.push({ kind: "ineligible", integrationId: disabled, request: delivery("inel-0"), expected: 404 });
    for (let i = 0; i < 3; i += 1) planned.push({ kind: "transient", integrationId: active, request: delivery(`transient-${i}`), expected: 503 });
    for (let i = 0; i < 2; i += 1) planned.push({ kind: "fault", integrationId: active, request: delivery(`fault-${i}`), expected: 500 });
    // Interleave so the faults land mid-run.
    const order = planned.map((entry, index) => ({ entry, key: (index * 7) % planned.length }));
    order.sort((a, b) => a.key - b.key);

    const results = await Promise.all(
      order.map(async ({ entry }) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/webhooks/${entry.integrationId}`, {
          method: "POST",
          headers: entry.request.headers,
          body: entry.request.body,
        });
        const body = json(await response.text());
        return { ...entry, status: response.status, requestId: String(body.requestId) };
      }),
    );
    // Rows created after a response would show up here.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const summary = results.map((r) => `${r.kind}:${r.status}`).sort();
    process.stdout.write(`[HT-8] ${results.length} requests: ${JSON.stringify(summary)}\n`);
    for (const result of results) assert.equal(result.status, result.expected, `${result.kind} (${result.requestId})`);
    assert.equal(new Set(results.map((r) => r.requestId)).size, results.length);

    const accepted = results.filter((r) => r.status === 202).map((r) => r.requestId);
    const refused = results.filter((r) => r.status !== 202).map((r) => r.requestId);
    const received = await receivedRows([...accepted, ...refused]);
    const receivedIds = new Set(received.map((row) => row.id));
    for (const id of accepted) assert.ok(receivedIds.has(id), `202 without a committed EVENT_RECEIVED row: ${id}`);
    const ambiguous = t.logs.records().filter((record) => record.code === "COMMIT_UNKNOWN");
    assert.equal(ambiguous.length, 0, "no ambiguous commit was logged");
    for (const id of refused) assert.equal(receivedIds.has(id), false, `non-202 request with an EVENT_RECEIVED row: ${id}`);

    const events = await storedEvents(active);
    assert.deepEqual(
      events.map((event) => event.externalEventId).sort(),
      [...Array.from({ length: 12 }, (_, i) => `new-${i}`), "dup-0", "dup-1", "dup-2"].sort(),
    );
    for (const row of received) assert.ok(events.some((event) => event.id === row.entityId), `EVENT_RECEIVED ${row.id} names a stored Event`);
    assert.deepEqual(await countRows(admin.client, disabled), { events: 0, audits: 0 });
    assertNoSentinels([t.logs.text()], requestSentinels(planned.map((p) => p.request)));
  });
});

describe("HT-9: handlerTimeout while ingestion is stalled, over real TCP", () => {
  it("exactly one response (503); the later commit never produces a second response", { timeout: 30_000 }, async () => {
    // handlerTimeout = requestTimeoutMs + 5 s (server.ts). The stall is held
    // before the transaction begins, through the handoff's ingest seam: a stall
    // inside the transaction ends at the 5 s transaction timeout or the 5 s
    // statement_timeout (VPF-5), before handlerTimeout. After the 503, the
    // stall is released and the real ingestEvent commits.
    const integrationId = await seed();
    const stall = latch();
    let committed: EventIngestionResult | undefined;
    const t = serve({
      integrations: [integrationId],
      server: { requestTimeoutMs: 400, headersTimeoutMs: 200 },
      ingest: async (database, input) => {
        await stall.wait;
        committed = await ingestEvent(database, input);
        return committed;
      },
    });
    const port = await listen(t.app);
    const request = delivery("ht9");
    const head = [
      `POST /api/webhooks/${integrationId} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Content-Type: application/json",
      `IRS-Signature: ${request.headers["irs-signature"]}`,
      `Content-Length: ${request.body.byteLength}`,
      "",
      "",
    ].join("\r\n");
    const started = Date.now();
    const releaseAt = 5_400 + 1_000;
    const releaser = setTimeout(() => stall.release(), releaseAt);
    const response = await rawExchange(port, [Buffer.concat([Buffer.from(head, "latin1"), request.body])], { waitMs: releaseAt + 3_000 });
    clearTimeout(releaser);
    stall.release();
    const elapsed = Date.now() - started;
    process.stdout.write(`[HT-9] exchange ended after ${elapsed} ms (closed=${response.closed}); committed=${committed?.disposition ?? "none"}\n`);

    const statusLines = response.raw.match(/HTTP\/1\.[01] \d{3}/g) ?? [];
    assert.deepEqual(statusLines, ["HTTP/1.1 503"], "exactly one response");
    const body = json(response.body);
    assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
    assert.equal(body.error, "SERVICE_UNAVAILABLE");
    const requestId = String(body.requestId);

    // The later commit happened (after the 503), and produced no second response.
    assert.equal(committed?.disposition, "NEW");
    assert.equal((await receivedRows([requestId])).length, 1, "the stalled ingestion committed after the 503 (ambiguous to the sender)");
    const attempts = t.logs.records().filter((record) => record.msg === "response attempt" && record.requestId === requestId);
    process.stdout.write(`[HT-9] response-attempt records: ${JSON.stringify(attempts.map((a) => ({ statusAttempted: a.statusAttempted, disposition: a.disposition, completion: a.completion })))}\n`);
    const warnings = t.logs.records().filter((record) => typeof record.msg === "string" && /already sent/i.test(String(record.msg)));
    process.stdout.write(`[HT-9] "already sent" log records: ${warnings.length}\n`);

    // Added under FD-12 (DEV-2): the 503 is the response deadline's, timed
    // against the same clock (reply.elapsedTime). [budget, budget + 250 ms]
    // is a target under a responsive event loop, not a hard real-time bound.
    assert.equal(attempts.length, 1, "one response attempt");
    assert.equal(attempts[0]?.statusAttempted, 503);
    const responseTimeMs = Number(attempts[0]?.responseTimeMs);
    process.stdout.write(`[HT-9] responseTimeMs ${responseTimeMs} (budget 5,400; target ≤ 5,650)\n`);
    assert.ok(responseTimeMs >= 5_400 && responseTimeMs <= 5_650, `responseTimeMs ${responseTimeMs} outside [5,400, 5,650]`);
    const late = t.logs.records().filter((record) => record.msg === "late ingestion outcome" && record.requestId === requestId);
    assert.equal(late.length, 1);
    assert.equal(late[0]?.late, "COMMITTED_AFTER_RESPONSE");
    assert.equal(warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Task 011 DEV-2 (FD-12): the response deadline against PostgreSQL.

/** One whole request over TCP with `Connection: close`; optionally the body after `gapMs`. */
function tcpDelivery(
  port: number,
  integrationId: string,
  request: { body: Buffer; headers: Record<string, string> },
  options: { gapMs?: number; waitMs: number },
) {
  const head = [
    `POST /api/webhooks/${integrationId} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Connection: close",
    "Content-Type: application/json",
    `IRS-Signature: ${request.headers["irs-signature"]}`,
    `Content-Length: ${request.body.byteLength}`,
    "",
    "",
  ].join("\r\n");
  const pieces = options.gapMs === undefined ? [Buffer.concat([Buffer.from(head, "latin1"), request.body])] : [head, request.body];
  return rawExchange(port, pieces, { gapMs: options.gapMs ?? 0, waitMs: options.waitMs });
}

function recordsFor(t: TestApp, msg: string, requestId: string) {
  return t.logs.records().filter((record) => record.msg === msg && record.requestId === requestId);
}

function responseTimeOf(t: TestApp, requestId: string): number {
  const attempts = recordsFor(t, "response attempt", requestId);
  assert.equal(attempts.length, 1, "one response attempt");
  return Number(attempts[0]?.responseTimeMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const started = performance.now();
  while (!(await condition())) {
    if (performance.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Admin mode (observation): backends of `role` waiting on a transaction lock (a unique-index wait). */
async function transactionLockWaiters(role: string): Promise<number> {
  return (
    (
      await admin.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
          WHERE usename = $1 AND wait_event_type = 'Lock' AND wait_event = 'transactionid'`,
        [role],
      )
    ).rows[0]?.n ?? 0
  );
}

describe("DL-PG-1: a retry while the original is unresolved waits on the unique index", () => {
  for (const ending of ["none", "commit", "rollback"] as const) {
    it(
      ending === "none"
        ? "(a) the original never ends → the retry fails at statement_timeout (57014, TRANSIENT) → 503"
        : ending === "commit"
          ? "(b) the original commits during the wait → the retry is DUPLICATE → 202"
          : "(c) the original rolls back during the wait → the retry inserts (NEW) → 202",
      { timeout: 20_000 },
      async () => {
        const integrationId = await seed();
        // requestTimeoutMs 2,000 → budget 7,000: the 5 s statement_timeout ends the wait first.
        const t = serve({ integrations: [integrationId], server: { requestTimeoutMs: 2_000 } });
        const request = delivery(`dlpg1-${ending}`);
        // Admin mode: a separate session holds the original's uncommitted row (same key, same bytes).
        const holder = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-dlpg1-holder" });
        try {
          await holder.client.query("BEGIN");
          await holder.client.query(
            `INSERT INTO "public"."Event" ("id", "integrationId", "externalEventId", "eventType", "resourceType", "resourceId",
               "payload", "occurredAt", "receivedAt", "status", "schemaVersion", "rawBody", "rawBodySha256")
             VALUES (gen_random_uuid(), $1, $2, 'payment.completed', 'payment', 'pay_456', '{}'::jsonb, now(), now(),
               'VALIDATED'::"public"."EventState", '1', $3, $4)`,
            [integrationId, `dlpg1-${ending}`, request.body, createHash("sha256").update(request.body).digest("hex")],
          );
          const responding = post(t, integrationId, request);
          await waitFor(async () => (await transactionLockWaiters("irs_test_api")) === 1, 4_000, "the retry's unique-index wait");
          process.stdout.write(`[DL-PG-1 ${ending}] the retry is waiting on a transaction lock (pg_stat_activity)\n`);
          if (ending === "commit") await holder.client.query("COMMIT");
          if (ending === "rollback") await holder.client.query("ROLLBACK");
          const response = await responding;
          const requestId = String(json(response.body).requestId);
          const time = responseTimeOf(t, requestId);
          process.stdout.write(`[DL-PG-1 ${ending}] ${response.statusCode} after ${time} ms\n`);
          if (ending === "none") {
            assertGeneric(response, 503, "SERVICE_UNAVAILABLE");
            const failed = recordsFor(t, "ingestion failed", requestId);
            assert.equal(failed.length, 1);
            assert.equal(failed[0]?.code, "57014");
            assert.equal(failed[0]?.outcome, "TRANSIENT");
            assert.ok(time >= 5_000 && time < 7_000, `answered at ${time} ms (statement_timeout, before the 7,000 ms deadline)`);
            assert.equal(recordsFor(t, "ingestion response deadline reached", requestId).length, 0);
            assert.deepEqual(await receivedRows([requestId]), []);
          } else {
            assert.equal(response.statusCode, 202);
            const received = await receivedRows([requestId]);
            assert.equal(received.length, 1);
            assert.equal(received[0]?.metadata.disposition, ending === "commit" ? "DUPLICATE" : "NEW");
            if (ending === "commit") assert.equal(received[0]?.metadata.contentMatches, true);
            assert.equal((await storedEvents(integrationId)).length, 1);
          }
        } finally {
          await holder.client.query("ROLLBACK").catch(() => undefined);
          await holder.close();
        }
      },
    );
  }
});

describe("DL-PG-2: the deadline during a COMMIT stall (FD-6 extended by FD-12; server-side wait, role-limited)", () => {
  // The DB-T20 mechanism, unchanged: synchronous_commit = local server-wide,
  // a non-existent synchronous standby, and synchronous_commit = on for
  // irs_test_api_role_setting only, so only its COMMITs wait. Every case sets
  // the stall up itself, and reverts and verifies it before ending (admin
  // mode). Setup and revert come from @irs/db's test-support/syncrep-stall
  // (shared with DB-T20): FD-14 order, pinned sessions, 10 s watchdog.
  const ROLE = STALL_ROLE;
  const stallUp = (label: string) => stallCommits(adminUrl, admin.client, label);
  const revertAndVerify = (label: string) => revertCommitStall(adminUrl, label);

  async function syncRepWaiters(): Promise<number> {
    return (
      (
        await admin.client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND wait_event = 'SyncRep'`,
          [ROLE],
        )
      ).rows[0]?.n ?? 0
    );
  }

  it("(a) one stalled request: the deadline answers it; the retry waits on the unique index and fails at about 5 s (57014)", { timeout: 60_000 }, async () => {
    const integrationId = await seed();
    let reverted = false;
    try {
      await stallUp("DL-PG-2 a");
      // Special mode: the registered role whose COMMITs wait (production pool settings, max 10).
      const stalledDb = await guardedDatabase({ url: withUser(apiUrl, ROLE), mode: "special", special: ROLE });
      extraDatabases.push(stalledDb);
      const t = serve({ integrations: [integrationId], database: stalledDb, server: { requestTimeoutMs: 2_000 } });
      const port = await listen(t.app);
      const request = delivery("dlpg2-a");
      const original = tcpDelivery(port, integrationId, request, { waitMs: 15_000 });
      await waitFor(async () => (await syncRepWaiters()) === 1, 5_000, "the original COMMIT waiting on SyncRep");
      const retry = tcpDelivery(port, integrationId, request, { waitMs: 15_000 });
      await waitFor(async () => (await transactionLockWaiters(ROLE)) === 1, 4_000, "the retry's unique-index wait");
      process.stdout.write("[DL-PG-2 a] original COMMIT on SyncRep; retry waiting on a transaction lock (pg_stat_activity)\n");
      const [originalResponse, retryResponse] = await Promise.all([original, retry]);

      assert.equal(originalResponse.status, 503);
      const originalId = String(json(originalResponse.body).requestId);
      const originalTime = responseTimeOf(t, originalId);
      process.stdout.write(`[DL-PG-2 a] original: 503 after ${originalTime} ms (budget 7,000)\n`);
      assert.ok(originalTime >= 7_000 && originalTime <= 7_250, `original answered at ${originalTime} ms`);
      const deadline = recordsFor(t, "ingestion response deadline reached", originalId);
      assert.equal(deadline.length, 1);
      assert.equal(deadline[0]?.outcome, "UNKNOWN");

      assert.equal(retryResponse.status, 503);
      const retryId = String(json(retryResponse.body).requestId);
      const retryTime = responseTimeOf(t, retryId);
      const retryFailed = recordsFor(t, "ingestion failed", retryId);
      process.stdout.write(
        `[DL-PG-2 a] retry: 503 after ${retryTime} ms; ${JSON.stringify(retryFailed.map((r) => ({ code: r.code, outcome: r.outcome })))}\n`,
      );
      assert.equal(retryFailed.length, 1);
      assert.equal(retryFailed[0]?.code, "57014");
      assert.equal(retryFailed[0]?.outcome, "TRANSIENT");
      assert.equal(recordsFor(t, "ingestion response deadline reached", retryId).length, 0);

      await revertAndVerify("DL-PG-2 a");
      reverted = true;
      await waitFor(async () => recordsFor(t, "late ingestion outcome", originalId).length > 0, 5_000, "the original's late outcome");
      const late = recordsFor(t, "late ingestion outcome", originalId);
      assert.equal(late.length, 1);
      assert.equal(late[0]?.late, "COMMITTED_AFTER_RESPONSE");
      const again = await post(t, integrationId, request);
      assert.equal(again.statusCode, 202);
      const received = await receivedRows([String(json(again.body).requestId)]);
      assert.equal(received[0]?.metadata.disposition, "DUPLICATE");
      assert.equal((await storedEvents(integrationId)).length, 1);
    } finally {
      if (!reverted) await revertAndVerify("DL-PG-2 a (finally)");
    }
  });

  it("(b) a fully stalled pool: ten requests answered by the deadline; the next fails at about 2 s (P2028)", { timeout: 60_000 }, async () => {
    const integrationId = await seed();
    let reverted = false;
    try {
      await stallUp("DL-PG-2 b");
      const stalledDb = await guardedDatabase({ url: withUser(apiUrl, ROLE), mode: "special", special: ROLE });
      extraDatabases.push(stalledDb);
      const t = serve({ integrations: [integrationId], database: stalledDb, server: { requestTimeoutMs: 2_000 } });
      const port = await listen(t.app);
      const originals = Array.from({ length: 10 }, (_, i) => tcpDelivery(port, integrationId, delivery(`dlpg2-b-${i}`), { waitMs: 15_000 }));
      await waitFor(async () => (await syncRepWaiters()) === 10, 10_000, "ten COMMITs waiting on SyncRep");
      process.stdout.write("[DL-PG-2 b] ten COMMITs waiting on SyncRep: the pool (max 10) is fully held\n");
      const next = await tcpDelivery(port, integrationId, delivery("dlpg2-b-next"), { waitMs: 15_000 });
      assert.equal(next.status, 503);
      const nextId = String(json(next.body).requestId);
      const nextTime = responseTimeOf(t, nextId);
      const nextFailed = recordsFor(t, "ingestion failed", nextId);
      process.stdout.write(
        `[DL-PG-2 b] next: 503 after ${nextTime} ms; ${JSON.stringify(nextFailed.map((r) => ({ code: r.code, outcome: r.outcome })))}\n`,
      );
      assert.equal(nextFailed.length, 1);
      assert.equal(nextFailed[0]?.code, "P2028");
      assert.equal(nextFailed[0]?.outcome, "TRANSIENT");
      assert.ok(nextTime >= 1_900 && nextTime < 2_600, `answered at ${nextTime} ms (maxWait 2,000)`);

      const responses = await Promise.all(originals);
      const ids = responses.map((response) => {
        assert.equal(response.status, 503);
        return String(json(response.body).requestId);
      });
      const times = ids.map((id) => responseTimeOf(t, id));
      process.stdout.write(`[DL-PG-2 b] originals: 503 after ${JSON.stringify(times)} ms (budget 7,000)\n`);
      for (const [index, id] of ids.entries()) {
        assert.equal(recordsFor(t, "ingestion response deadline reached", id).length, 1);
        const time = times[index] ?? 0;
        assert.ok(time >= 7_000 && time <= 7_250, `original ${index} answered at ${time} ms`);
      }

      await revertAndVerify("DL-PG-2 b");
      reverted = true;
      await waitFor(
        async () => ids.every((id) => recordsFor(t, "late ingestion outcome", id).length === 1),
        5_000,
        "ten late outcomes",
      );
      for (const id of ids) assert.equal(recordsFor(t, "late ingestion outcome", id)[0]?.late, "COMMITTED_AFTER_RESPONSE");
      assert.equal((await storedEvents(integrationId)).length, 10);
    } finally {
      if (!reverted) await revertAndVerify("DL-PG-2 b (finally)");
    }
  });
});

describe("DL-PG-3: a slow body plus normally bounded database work that ends after the deadline", () => {
  it("one 503 in [6,500, 6,750] ms, then COMMITTED_AFTER_RESPONSE; a retry is DUPLICATE", { timeout: 30_000 }, async () => {
    // requestTimeoutMs 1,500 → budget 6,500. Pool contention uses only the
    // existing createDatabase `pool` parameter (maxConnections 1; FD-12).
    // Timeline from t0: the body arrives at about 1,400 ms; a test-held
    // transaction keeps the only connection until 2,900 ms (a 1,500 ms pool
    // wait, under maxWait 2,000); the status check then waits on an admin row
    // lock until 7,400 ms (4,500 ms, under statement_timeout 5,000), and the
    // delivery commits at about 7,450 ms, inside its 5,000 ms transaction.
    const integrationId = await seed();
    const one = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    extraDatabases.push(one);
    const t = serve({ integrations: [integrationId], database: one, server: { requestTimeoutMs: 1_500 } });
    const port = await listen(t.app);
    // Admin mode: a row lock on the Integration that the status check (FOR SHARE) must wait for.
    const locker = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-dlpg3-locker" });
    try {
      await locker.client.query("BEGIN");
      await locker.client.query(`SELECT 1 FROM "public"."Integration" WHERE "id" = $1 FOR UPDATE`, [integrationId]);
      const t0 = performance.now();
      const acquired = latch();
      // Api mode: a test-held transaction occupying the only pool connection.
      const holding = one.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        acquired.release();
        await sleep(2_900 - (performance.now() - t0));
      });
      await acquired.wait;
      const releaseLock = setTimeout(() => void locker.client.query("COMMIT"), 7_400 - (performance.now() - t0));
      const request = delivery("dlpg3");
      const response = await tcpDelivery(port, integrationId, request, { gapMs: 1_400, waitMs: 12_000 });
      await holding;
      assert.equal(response.status, 503);
      assert.equal((response.raw.match(/HTTP\/1\.[01] \d{3}/g) ?? []).length, 1);
      const requestId = String(json(response.body).requestId);
      const time = responseTimeOf(t, requestId);
      process.stdout.write(`[DL-PG-3] 503 after ${time} ms (budget 6,500)\n`);
      assert.ok(time >= 6_500 && time <= 6_750, `answered at ${time} ms`);
      assert.equal(recordsFor(t, "ingestion response deadline reached", requestId).length, 1);
      await waitFor(async () => recordsFor(t, "late ingestion outcome", requestId).length > 0, 3_000, "the late outcome");
      clearTimeout(releaseLock);
      const late = recordsFor(t, "late ingestion outcome", requestId);
      process.stdout.write(`[DL-PG-3] late: ${JSON.stringify(late.map((r) => ({ late: r.late, lateByMs: r.lateByMs })))}\n`);
      assert.equal(late.length, 1);
      assert.equal(late[0]?.late, "COMMITTED_AFTER_RESPONSE");
      assert.equal((await receivedRows([requestId])).length, 1, "committed after the 503");
      const retry = await post(t, integrationId, request);
      assert.equal(retry.statusCode, 202);
      assert.equal((await receivedRows([String(json(retry.body).requestId)]))[0]?.metadata.disposition, "DUPLICATE");
    } finally {
      await locker.client.query("ROLLBACK").catch(() => undefined);
      await locker.close();
    }
  });
});
