import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigValidationError } from "@irs/config";
import type { CreateDatabaseOptions, Database } from "@irs/db";
import { createProductionServer } from "./production.js";
import {
  INTEGRATION_ID,
  WEBHOOK_PATH,
  envelopeJson,
  parseJson,
  sign,
} from "./test-helpers.js";
// Task 011A additions (Stage 7): the imports below serve only the added tests.
import type { PrismaClient } from "@irs/db";
import { createInMemoryEvidenceStore } from "./evidence-store.js";
import { createPostgresEvidenceStore } from "./evidence-store-postgres.js";
import { composeEvidence } from "./production.js";
import { DEFAULT_RATE_LIMIT_POLICIES } from "./rate-limit.js";
import { DEFAULT_AUDIT_POLICIES } from "./rejection-audit.js";
import { LogCapture, ManualClock, ManualScheduler, settleTurns } from "./test-helpers.js";

/** Synthetic test secret: 32 bytes as 64 lowercase hex characters. */
const SECRET_HEX = "5a".repeat(32);
const SECRET_BYTES = new Uint8Array(Buffer.from(SECRET_HEX, "hex"));

/** Production wiring uses the real clock, so sign with the current time. */
function currentRequest(): { body: Buffer; headers: Record<string, string> } {
  const body = Buffer.from(envelopeJson());
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "irs-signature": sign(body, timestamp, SECRET_BYTES),
    },
  };
}

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/irs",
  REDIS_HOST: "localhost",
  REDIS_PORT: "6379",
  API_PORT: "3001",
  WEB_PORT: "3000",
};

const VALID_ENV = {
  ...BASE_ENV,
  IRS_WEBHOOK_SECRETS: `${INTEGRATION_ID}=${SECRET_HEX}`,
};

/**
 * Database doubles for the injected factory (PROD-1): no test here creates
 * a real client, so nothing can reach a database.
 */
function unavailableDatabase(): Database {
  return {
    prisma: {
      $transaction: () => Promise.reject(new Error("timeout exceeded when trying to connect")),
    },
    monotonicNow: () => 0,
    ping: () => Promise.reject(new Error("timeout exceeded when trying to connect")),
  } as unknown as Database;
}

/** A fake interactive transaction that walks ingestEvent's NEW path. */
function acceptingDatabase(): { db: Database; statements: string[] } {
  const statements: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      statements.push(strings.join("$"));
      return [{ configStatus: "ACTIVE" }];
    },
    event: {
      createManyAndReturn: async () => {
        statements.push("event.createManyAndReturn");
        return [{ id: "0190f3a2-0000-7000-8000-0000000000e1" }];
      },
    },
    auditEntry: {
      createMany: async () => {
        statements.push("auditEntry.createMany");
        return { count: 1 };
      },
    },
  };
  const db = {
    prisma: { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) },
    monotonicNow: () => 0,
    ping: async () => undefined,
  } as unknown as Database;
  return { db, statements };
}

function factory(db: Database) {
  const created: CreateDatabaseOptions[] = [];
  return {
    created,
    createDatabase: (options: CreateDatabaseOptions) => {
      created.push(options);
      return db;
    },
  };
}

describe("production wiring (PROD-1)", () => {
  it("returns { app, port, db }, creating the database from DATABASE_URL through the injected factory", async () => {
    const db = unavailableDatabase();
    const injected = factory(db);
    const server = createProductionServer(VALID_ENV, { logger: false }, injected);
    try {
      assert.equal(server.port, 3001);
      assert.equal(server.db, db);
      assert.deepEqual(injected.created, [{ connectionString: VALID_ENV.DATABASE_URL }]);
    } finally {
      await server.app.close();
    }
  });

  it("wires the durable handoff: a signed, valid delivery runs ingestEvent and is answered 202", async () => {
    const accepting = acceptingDatabase();
    const { app } = createProductionServer(VALID_ENV, { logger: false }, factory(accepting.db));
    try {
      const request = currentRequest();
      const response = await app.inject({ method: "POST", url: WEBHOOK_PATH, headers: request.headers, payload: request.body });
      assert.equal(response.statusCode, 202);
      const body = parseJson(response.body) as { status: string; requestId: string };
      assert.equal(body.status, "ACCEPTED");
      assert.equal(accepting.statements[0], 'SELECT "public"."irs_integration_config_status_for_share"($) AS "configStatus"');
      assert.deepEqual(accepting.statements.slice(1), ["event.createManyAndReturn", "auditEntry.createMany"]);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the database is unavailable, and never a 2xx", async () => {
    const { app } = createProductionServer(VALID_ENV, { logger: false }, factory(unavailableDatabase()));
    try {
      for (let i = 0; i < 3; i += 1) {
        const request = currentRequest();
        const response = await app.inject({ method: "POST", url: WEBHOOK_PATH, headers: request.headers, payload: request.body });
        assert.equal(response.statusCode, 503);
        const body = parseJson(response.body) as { error: string; requestId: string };
        assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
        assert.equal(body.error, "SERVICE_UNAVAILABLE");
        assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    } finally {
      await app.close();
    }
  });

  it("starts with an absent or empty IRS_WEBHOOK_SECRETS and fails closed with 404", async () => {
    for (const env of [BASE_ENV, { ...BASE_ENV, IRS_WEBHOOK_SECRETS: "" }]) {
      const { app } = createProductionServer(env, { logger: false }, factory(unavailableDatabase()));
      try {
        const request = currentRequest();
        const response = await app.inject({
          method: "POST",
          url: WEBHOOK_PATH,
          headers: request.headers,
          payload: request.body,
        });
        assert.equal(response.statusCode, 404);
      } finally {
        await app.close();
      }
    }
  });

  it("fails to start with invalid secrets without echoing them, and creates no database", () => {
    const leaky = "ab".repeat(20); // 40 hex chars: too short, must not be echoed
    const injected = factory(unavailableDatabase());
    assert.throws(
      () =>
        createProductionServer(
          { ...BASE_ENV, IRS_WEBHOOK_SECRETS: `${INTEGRATION_ID}=${leaky}` },
          { logger: false },
          injected,
        ),
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.message.includes("IRS_WEBHOOK_SECRETS") &&
        !error.message.includes(leaky),
    );
    assert.equal(injected.created.length, 0);
  });

  it("fails to start with an invalid base configuration, and creates no database", () => {
    const injected = factory(unavailableDatabase());
    assert.throws(
      () =>
        createProductionServer(
          { IRS_WEBHOOK_SECRETS: VALID_ENV.IRS_WEBHOOK_SECRETS },
          { logger: false },
          injected,
        ),
      ConfigValidationError,
    );
    assert.equal(injected.created.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Task 011A additions (Stage 7): the runtime proof of the plan's §11 (k)
// claims, A-T4 through the RD-13 seam, and A-T13 part 2 (PA-3).

/** Active resources by type, after letting pending callbacks run. */
async function activeResources(): Promise<Map<string, number>> {
  await new Promise((resolve) => setImmediate(resolve));
  const counts = new Map<string, number>();
  for (const type of process.getActiveResourcesInfo()) counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}

function assertNoNewResources(before: Map<string, number>, after: Map<string, number>): void {
  for (const [type, count] of after) assert.ok(count <= (before.get(type) ?? 0), `a ${type} outlived app.close()`);
}

function deepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

/** A delivery whose signature does not match its body (an eligible VERIFIER 401). */
function forgedRequest(): { body: Buffer; headers: Record<string, string> } {
  const request = currentRequest();
  return {
    body: request.body,
    headers: { ...request.headers, "irs-signature": sign(Buffer.from("x"), Math.floor(Date.now() / 1000), SECRET_BYTES) },
  };
}

const STATUS_CHECK = "SELECT \"public\".\"irs_integration_config_status_for_share\"($) AS \"configStatus\"";

describe("Task 011A production composition (PROD-011A)", () => {
  it("PROD-011A-1: no 011A timer or handle outlives app.close(), no unhandled rejection, one createDatabase call, the case-2 statements exactly", async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const before = await activeResources();
      const accepting = acceptingDatabase();
      const injected = factory(accepting.db);
      const server = createProductionServer(VALID_ENV, { logger: false }, injected);
      const accepted = currentRequest();
      assert.equal((await server.app.inject({ method: "POST", url: WEBHOOK_PATH, headers: accepted.headers, payload: accepted.body })).statusCode, 202);
      const forged = forgedRequest();
      const rejected = await server.app.inject({ method: "POST", url: WEBHOOK_PATH, headers: forged.headers, payload: forged.body });
      assert.equal(rejected.statusCode, 401, "an eligible candidate, admitted and queued");
      const unknown = await server.app.inject({ method: "POST", url: "/api/webhooks/11111111-2222-4333-8444-555555555555", headers: accepted.headers, payload: accepted.body });
      assert.equal(unknown.statusCode, 404);
      await server.app.close();
      assertNoNewResources(before, await activeResources());
      assert.equal(unhandled, 0);
      assert.equal(injected.created.length, 1);
      assert.equal(accepting.statements[0], STATUS_CHECK);
      assert.deepEqual(accepting.statements.slice(1), ["event.createManyAndReturn", "auditEntry.createMany"], "no 011A statement reached the database");
      assert.equal(server.evidence.recorder.state, "CREATED", "the writer never started");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("PROD-011A-2 (A-T4): a request through the production-composed app appears in that composition's paired summary; F-A; no leak", async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const before = await activeResources();
      const inMemory = createInMemoryEvidenceStore();
      const injected = factory(unavailableDatabase());
      const logs = new LogCapture();
      let received: Database | undefined;
      const server = createProductionServer(VALID_ENV, { logger: { level: "info", stream: logs } }, {
        createDatabase: injected.createDatabase,
        createEvidenceStore: (db) => {
          received = db;
          return inMemory;
        },
      });
      await server.evidence.slots.startupSlot(new AbortController().signal);
      const forged = forgedRequest();
      const rejected = await server.app.inject({ method: "POST", url: WEBHOOK_PATH, headers: forged.headers, payload: forged.body });
      assert.equal(rejected.statusCode, 401);
      for (let turn = 0; turn < 50 && inMemory.raw.rejectionRows().length === 0; turn += 1) await settleTurns(1);
      const result = await server.evidence.slots.finalizeBeforeDisconnect("SIGNAL", { forced: false });
      assert.deepEqual(result, { successAllowed: true });
      assert.ok(logs.records().some((record) => record.event === "EVIDENCE_FINALIZED" && record.outcome === "F-A"));
      const id = server.evidence.limiterInstanceId;
      const rows = inMemory.raw.evidenceRows(id);
      type SummaryPayload = {
        rateLimit: { limiterInstanceId: string; delta: { layers: { L2: { individualRejections: number } } } };
        audit: { delta: { submitted: number; persisted: number } };
      };
      const summaries = rows.filter((row) => row.kind === "SUMMARY").map((row) => row.payload as unknown as SummaryPayload);
      assert.ok(summaries.length >= 1);
      assert.ok(summaries.every((summary) => summary.rateLimit.limiterInstanceId === id));
      const sum = (pick: (summary: SummaryPayload) => number) => summaries.reduce((total, summary) => total + pick(summary), 0);
      assert.equal(sum((summary) => summary.rateLimit.delta.layers.L2.individualRejections), 1);
      assert.equal(sum((summary) => summary.audit.delta.submitted), 1);
      assert.equal(sum((summary) => summary.audit.delta.persisted), 1);
      const rejection = inMemory.raw.rejectionRows()[0];
      assert.equal((rejection?.metadata as { limiterInstanceId?: string } | null)?.limiterInstanceId, id);
      assert.equal(rejection?.id, (parseJson(rejected.body) as { requestId: string }).requestId);
      assert.equal(rows.filter((row) => row.kind === "INSTANCE_CLOSED").length, 1, "INSTANCE_CLOSED confirmed");
      await server.app.close();
      assertNoNewResources(before, await activeResources());
      assert.equal(unhandled, 0);
      assert.equal(injected.created.length, 1);
      assert.equal(received, server.db, "the store received the composition's one Database");
      assert.equal(logs.count("REJECTION_STAGE_UNMAPPED"), 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("PROD-011A-3: the composition's policies are deep-frozen copies; the store receives the same Database; nothing is logged unmapped", async () => {
    const logs = new LogCapture();
    const injected = factory(unavailableDatabase());
    let received: Database | undefined;
    const server = createProductionServer(VALID_ENV, { logger: { level: "info", stream: logs } }, {
      createDatabase: injected.createDatabase,
      createEvidenceStore: (db) => {
        received = db;
        return createPostgresEvidenceStore({ db });
      },
    });
    try {
      assert.ok(deepFrozen(server.evidence.policies));
      assert.notEqual(server.evidence.policies.rateLimit, DEFAULT_RATE_LIMIT_POLICIES, "a copy, not the module default");
      assert.notEqual(server.evidence.policies.audit, DEFAULT_AUDIT_POLICIES);
      assert.deepEqual(JSON.parse(JSON.stringify(server.evidence.policies.audit)), JSON.parse(JSON.stringify(DEFAULT_AUDIT_POLICIES)));
      assert.equal(received, server.db);
      assert.equal(logs.count("REJECTION_STAGE_UNMAPPED"), 0);
    } finally {
      await server.app.close();
    }
  });
});

describe("A-T13 part 2 (PA-3): composed through the adapter, no store operation starts after D3", () => {
  it("both slots held by hung transactions, the final write queued; after D3 no primitive starts, even when a slot frees", async () => {
    const clock = new ManualClock();
    const scheduler = new ManualScheduler(clock);
    const transactions: { settle(ok: boolean): void }[] = [];
    const prisma = {
      $transaction: () =>
        new Promise((resolve, reject) => {
          transactions.push({ settle: (ok) => (ok ? resolve([]) : reject(new Error("fake transaction failed"))) });
        }),
    };
    const db = { prisma: prisma as unknown as PrismaClient, monotonicNow: clock.now, ping: async () => undefined } as Database;
    const store = createPostgresEvidenceStore({ db, timers: { set: scheduler.setTimeout, clear: scheduler.clearTimeout } });
    const ev = composeEvidence({
      store,
      rateLimitPolicies: DEFAULT_RATE_LIMIT_POLICIES,
      auditPolicies: DEFAULT_AUDIT_POLICIES,
      clock: { monotonicNow: clock.now, wallNow: clock.wall },
      scheduler,
      random: () => 0.5,
    });
    // Two operations hold the RD-3 slots and never settle on their own.
    const held = [store.writeRejections([]), store.findRecoveryCandidates("s", ev.limiterInstanceId)];
    await settleTurns();
    assert.equal(transactions.length, 2);
    let result: unknown;
    const finalizing = ev.slots.finalizeBeforeDisconnect("SIGNAL", { forced: false }).then((value) => {
      result = value;
    });
    await scheduler.advance(0);
    assert.equal(store.waiting, 1, "the final summary write is queued at the limiter");
    assert.equal(transactions.length, 2);
    await scheduler.advance(5_000);
    await finalizing;
    assert.deepEqual(result, { successAllowed: false }, "F-D: the final write was never confirmed");
    assert.deepEqual([store.waiting, store.inFlight, transactions.length], [0, 2, 2]);
    assert.ok(store.refusedByCutoff >= 1);
    // A slot freed after the deadline: still nothing starts.
    transactions[0]?.settle(true);
    await settleTurns();
    assert.equal(transactions.length, 2, "no primitive started after D3");
    await assert.rejects(store.writeEvidenceGroup([]), { name: "EvidenceCutoffError" });
    assert.equal(transactions.length, 2);
    transactions[1]?.settle(true);
    await Promise.allSettled(held);
    assert.equal(store.inFlight, 0);
    assert.equal(scheduler.pending, 0, "no timer remains");
  });
});
