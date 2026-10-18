import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Socket, createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { createDatabase, disconnectWithin } from "./client.js";
import type { Database } from "./client.js";
import { classifyDatabaseError, prismaCodeOf, sqlStateOf } from "./errors.js";
import { ingestEvent } from "./event-ingestion.js";
import { assertServerBaseline } from "./test-support/baseline.js";
import { guardedDatabase, ingestionInput, latch, removeIntegrations, seedIntegration } from "./test-support/database.js";
import { connectGuarded, requireTestUrl } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";

// The production client against PostgreSQL: DB-T10 (real error shapes),
// DB-T13 and V8 (pool limits and every PoolSettings value applied), DB-T14
// (bounded disconnect). Database connections are api mode; the closed port
// and the silent listener are sockets this test owns, never a database (FD-7).

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");

// Admin mode: baseline observation, seeding, pg_stat_activity observation and backend termination.
let admin: GuardedConnection;
const seeded: string[] = [];

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-client-admin" });
  await assertServerBaseline(admin.client);
});

after(async () => {
  await removeIntegrations(admin.client, seeded);
  await assertServerBaseline(admin.client);
  await admin.close();
});

function shape(error: unknown): Record<string, unknown> {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } }).meta;
  return {
    class: error instanceof Error ? error.constructor.name : typeof error,
    prismaCode: prismaCodeOf(error),
    sqlState: sqlStateOf(error),
    kind: meta?.driverAdapterError?.cause?.kind ?? (error as { cause?: { kind?: unknown } }).cause?.kind,
    message: error instanceof Error ? error.message.split("\n")[0] : String(error),
    classification: classifyDatabaseError(error),
  };
}

async function failureOf(action: () => Promise<unknown>): Promise<unknown> {
  return action().then(
    () => assert.fail("expected a failure"),
    (error: unknown) => error,
  );
}

/** Admin mode: terminates one backend (observation and control). */
async function terminate(pid: number): Promise<void> {
  await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
}

async function backendPid(db: Database): Promise<number> {
  return (await db.prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? -1;
}

/** A test-owned listener: it accepts and never answers (FD-7). */
async function silentListener(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, sockets };
}

describe("DB-T10: real errors from PostgreSQL, classified per §8.4 / VPF-4", () => {
  it("a closed port (test-owned, FD-7) → TRANSIENT", async () => {
    const { server, port } = await silentListener();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const db = createDatabase({ connectionString: `postgresql://irs_no_database@127.0.0.1:${port}/irs_no_database_test` });
    try {
      const error = await failureOf(() => db.ping());
      process.stdout.write(`[DB-T10] closed port: ${JSON.stringify(shape(error))}\n`);
      assert.equal(classifyDatabaseError(error).failureClass, "TRANSIENT");
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("pg_terminate_backend during a statement (57P01) and between statements (plain Error) → TRANSIENT; the pool recovers", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    try {
      const during = db.prisma
        .$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_sleep(3)`;
        })
        .then(() => assert.fail("expected termination"), (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const sleeping = (
        await admin.client.query<{ pid: number }>(
          `SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename = 'irs_test_api' AND query LIKE 'SELECT pg_sleep(3)%'`,
        )
      ).rows[0]?.pid;
      assert.equal(typeof sleeping, "number");
      await terminate(sleeping ?? -1);
      const duringError = await during;
      process.stdout.write(`[DB-T10] terminated during a statement: ${JSON.stringify(shape(duringError))}\n`);
      assert.equal(classifyDatabaseError(duringError).failureClass, "TRANSIENT");

      const between = await failureOf(() =>
        db.prisma.$transaction(async (tx) => {
          const pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? -1;
          await terminate(pid);
          await new Promise((resolve) => setTimeout(resolve, 300));
          await tx.$queryRaw`SELECT 1`;
        }),
      );
      process.stdout.write(`[DB-T10] terminated between statements: ${JSON.stringify(shape(between))}\n`);
      assert.equal(classifyDatabaseError(between).failureClass, "TRANSIENT");

      await db.ping();
      process.stdout.write(`[DB-T10] pool recovered on pid ${await backendPid(db)}\n`);
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("statement_timeout (57014) → TRANSIENT at about 5 s", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    try {
      const started = performance.now();
      const error = await failureOf(() => db.prisma.$executeRaw`SELECT pg_sleep(6)`);
      const elapsed = performance.now() - started;
      process.stdout.write(`[DB-T10] statement_timeout after ${Math.round(elapsed)} ms: ${JSON.stringify(shape(error))}\n`);
      assert.equal(sqlStateOf(error), "57014");
      assert.equal(classifyDatabaseError(error).failureClass, "TRANSIENT");
      assert.ok(elapsed >= 4_900 && elapsed < 6_500, `elapsed ${elapsed} ms (tolerance 4.9–6.5 s)`);
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("a foreign-key violation (raw P2010 + 23503, and through the model API) → FAULT", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    try {
      const raw = await failureOf(
        () => db.prisma.$executeRaw`INSERT INTO "public"."Event" ("id", "integrationId", "externalEventId", "eventType", "resourceType", "resourceId", "payload", "occurredAt", "receivedAt", "status", "schemaVersion", "rawBody", "rawBodySha256")
          VALUES (gen_random_uuid(), gen_random_uuid(), 'fk', 'x', 'x', 'x', '{}'::jsonb, now(), now(), 'VALIDATED', '1', '\\x61'::bytea, ${"a".repeat(64)})`,
      );
      process.stdout.write(`[DB-T10] FK violation (raw): ${JSON.stringify(shape(raw))}\n`);
      assert.equal(sqlStateOf(raw), "23503");
      assert.equal(classifyDatabaseError(raw).failureClass, "FAULT");
      const model = await failureOf(() =>
        db.prisma.event.createMany({
          data: [
            {
              integrationId: "00000000-0000-4000-8000-000000000000",
              externalEventId: "fk-model",
              eventType: "x",
              resourceType: "x",
              resourceId: "x",
              payload: {},
              occurredAt: new Date(),
              receivedAt: new Date(),
              status: "VALIDATED",
              schemaVersion: "1",
              rawBody: new Uint8Array([97]),
              rawBodySha256: "a".repeat(64),
            },
          ],
        }),
      );
      process.stdout.write(`[DB-T10] FK violation (model API): ${JSON.stringify(shape(model))}\n`);
      assert.equal(classifyDatabaseError(model).failureClass, "FAULT");
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("a missing table (42P01) → FAULT", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    try {
      const error = await failureOf(() => db.prisma.$queryRaw`SELECT 1 FROM "public"."NoSuchTable"`);
      process.stdout.write(`[DB-T10] missing table: ${JSON.stringify(shape(error))}\n`);
      assert.equal(sqlStateOf(error), "42P01");
      assert.equal(classifyDatabaseError(error).failureClass, "FAULT");
    } finally {
      await db.prisma.$disconnect();
    }
  });
});

describe("DB-T13 / V8: every PoolSettings value is applied", () => {
  it("V8(d): each new physical session has statement_timeout 5s, idle_in_transaction_session_timeout 10s and transaction_timeout 0, from the client", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    try {
      const holders = Array.from({ length: 5 }, () => latch());
      const arrived: Record<string, unknown>[] = [];
      const runs = holders.map((holder) =>
        db.prisma.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Record<string, unknown>[]>`
              SELECT pg_backend_pid() AS pid,
                     (SELECT setting || '|' || source FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') AS statement_timeout,
                     (SELECT setting || '|' || source FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS idle_in_transaction,
                     (SELECT setting || '|' || source FROM pg_catalog.pg_settings WHERE name = 'transaction_timeout') AS transaction_timeout`;
            arrived.push(rows[0] ?? {});
            await holder.wait;
          },
          { timeout: 20_000 },
        ),
      );
      while (arrived.length < holders.length) await new Promise((resolve) => setTimeout(resolve, 50));
      for (const holder of holders) holder.release();
      await Promise.all(runs);
      process.stdout.write(`[V8 d] ${JSON.stringify(arrived)}\n`);
      assert.equal(new Set(arrived.map((row) => row.pid)).size, 5, "five distinct physical sessions");
      for (const row of arrived) {
        assert.equal(row.statement_timeout, "5000|client");
        assert.equal(row.idle_in_transaction, "10000|client");
        assert.equal(row.transaction_timeout, "0|client");
      }
    } finally {
      await db.prisma.$disconnect();
    }
  });

  it("keepAlive: every pooled socket gets setKeepAlive(true, 10000)", async () => {
    const calls: unknown[][] = [];
    const original = Socket.prototype.setKeepAlive;
    Socket.prototype.setKeepAlive = function (this: Socket, ...args: unknown[]) {
      calls.push(args);
      return original.apply(this, args as Parameters<typeof original>);
    };
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    try {
      const holders = Array.from({ length: 3 }, () => latch());
      let started = 0;
      const runs = holders.map((holder) =>
        db.prisma.$transaction(
          async () => {
            started += 1;
            await holder.wait;
          },
          { timeout: 20_000 },
        ),
      );
      while (started < holders.length) await new Promise((resolve) => setTimeout(resolve, 50));
      for (const holder of holders) holder.release();
      await Promise.all(runs);
    } finally {
      await db.prisma.$disconnect();
      Socket.prototype.setKeepAlive = original;
    }
    process.stdout.write(`[V8 keepAlive] setKeepAlive calls: ${JSON.stringify(calls)}\n`);
    assert.ok(calls.length >= 3, "one call per pooled connection");
    for (const call of calls) assert.deepEqual(call, [true, 10_000]);
  });

  it("DB-T13 / V8(a): with max 10 connections held, the 11th plain query and the 11th transaction fail TRANSIENT at about 2 s; the server sees exactly 10", async () => {
    const integrationId = await seedIntegration(admin.client, "ACTIVE");
    seeded.push(integrationId);
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    const holders = Array.from({ length: 10 }, () => latch());
    let held = 0;
    const runs = holders.map((holder) =>
      db.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          held += 1;
          await holder.wait;
        },
        { timeout: 30_000, maxWait: 10_000 },
      ),
    );
    try {
      while (held < 10) await new Promise((resolve) => setTimeout(resolve, 50));
      const backends = (
        await admin.client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename = 'irs_test_api' AND datname = 'irs_011_test'`,
        )
      ).rows[0]?.n;
      assert.equal(backends, 10, "the server shows exactly 10 application backends");

      let started = performance.now();
      const plain = await failureOf(() => db.ping());
      const plainMs = performance.now() - started;
      started = performance.now();
      const transaction = await failureOf(() => ingestEvent(db, ingestionInput(integrationId, "db-t13")));
      const transactionMs = performance.now() - started;
      process.stdout.write(
        `[DB-T13] 11th plain query after ${Math.round(plainMs)} ms: ${JSON.stringify(shape(plain))}\n` +
          `[DB-T13] 11th transaction after ${Math.round(transactionMs)} ms: ${JSON.stringify(shape(transaction))}\n`,
      );
      assert.equal(classifyDatabaseError(plain).failureClass, "TRANSIENT");
      assert.equal(classifyDatabaseError(transaction).failureClass, "TRANSIENT");
      for (const elapsed of [plainMs, transactionMs]) {
        assert.ok(elapsed >= 1_900 && elapsed < 2_600, `elapsed ${elapsed} ms (V8 tolerance 1.9–2.6 s)`);
      }
    } finally {
      for (const holder of holders) holder.release();
      await Promise.all(runs);
    }

    // V8(c): released connections close after idleTimeoutMs (30 s).
    const released = performance.now();
    let remaining = 10;
    while (remaining > 0 && performance.now() - released < 35_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      remaining =
        (
          await admin.client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename = 'irs_test_api' AND datname = 'irs_011_test'`,
          )
        ).rows[0]?.n ?? 0;
    }
    const idleMs = performance.now() - released;
    process.stdout.write(`[V8 c] all idle backends gone after ${Math.round(idleMs)} ms\n`);
    await db.prisma.$disconnect();
    assert.equal(remaining, 0);
    assert.ok(idleMs >= 29_500 && idleMs < 32_500, `idle close after ${idleMs} ms (V8 tolerance 29.5–32.5 s)`);
  });

  it("V8(b): connect timeout against a silent listener (test-owned, FD-7) → TRANSIENT at about 2 s", async () => {
    const { server, port, sockets } = await silentListener();
    const db = createDatabase({ connectionString: `postgresql://irs_no_database@127.0.0.1:${port}/irs_no_database_test` });
    try {
      const started = performance.now();
      const error = await failureOf(() => db.ping());
      const elapsed = performance.now() - started;
      process.stdout.write(`[V8 b] connect timeout after ${Math.round(elapsed)} ms: ${JSON.stringify(shape(error))}\n`);
      assert.equal(classifyDatabaseError(error).failureClass, "TRANSIENT");
      assert.ok(elapsed >= 1_900 && elapsed < 2_600, `elapsed ${elapsed} ms (V8 tolerance 1.9–2.6 s)`);
    } finally {
      await db.prisma.$disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("DB-T14: disconnectWithin", () => {
  it("idle → completed quickly", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    await db.ping();
    const started = performance.now();
    assert.deepEqual(await disconnectWithin(db, 5_000), { completed: true });
    assert.ok(performance.now() - started < 1_000);
  });

  it("with a connection held by pg_sleep(30) → timedOut at 5 s (tolerance 4.9–6 s); never rejects", async () => {
    const db = await guardedDatabase({ url: apiUrl, mode: "api" });
    const sleeper = db.prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = 0`;
          await tx.$executeRaw`SELECT pg_sleep(30)`;
        },
        { timeout: 40_000 },
      )
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = performance.now();
    const outcome = await disconnectWithin(db, 5_000);
    const elapsed = performance.now() - started;
    process.stdout.write(`[DB-T14] held connection: ${JSON.stringify(outcome)} after ${Math.round(elapsed)} ms\n`);
    assert.deepEqual(outcome, { completed: false, timedOut: true });
    assert.ok(elapsed >= 4_900 && elapsed < 6_000, `elapsed ${elapsed} ms`);
    const pid = (
      await admin.client.query<{ pid: number }>(
        `SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename = 'irs_test_api' AND query LIKE 'SELECT pg_sleep(30)%'`,
      )
    ).rows[0]?.pid;
    if (pid !== undefined) await terminate(pid);
    await sleeper;
  });
});
