import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
// The built package entry (dist/index.js): VPF-1(c).
import * as entry from "./index.js";
import { DEFAULT_POOL_SETTINGS, disconnectWithin, toPgPoolConfig } from "./client.js";
import type { Database } from "./client.js";

describe("built @irs/db entry (VPF-1(c))", () => {
  it("the package's exports map '.' to this built entry, with no subpaths", () => {
    const resolved = fileURLToPath(import.meta.resolve("@irs/db"));
    assert.equal(resolved, fileURLToPath(new URL("./index.js", import.meta.url)));
    assert.throws(() => import.meta.resolve("@irs/db/generated/prisma/client.js"));
    assert.throws(() => import.meta.resolve("@irs/db/test-support/guard.js"));
  });

  it("exports the documented runtime surface, and no internal seam", () => {
    assert.deepEqual(Object.keys(entry).sort(), [
      "AdvisoryLockNotInTransactionError",
      "AdvisoryLockTimeoutError",
      "DEFAULT_POOL_SETTINGS",
      "DEFAULT_TRANSACTION_OPTIONS",
      "DISCONNECT_TIMEOUT_MS",
      "EVIDENCE_MAX_WAIT_MS",
      "IngestionCommitUnknownError",
      "IngestionInvariantError",
      "LockedTransactionDeadlineError",
      "MAX_LOCKED_TRANSACTION_WINDOW_MS",
      "REQUIRED_MIGRATIONS",
      "TransactionTimeoutInvariantError",
      "advisoryLockKey",
      "classifyDatabaseError",
      "createDatabase",
      "disconnectWithin",
      "findEvidenceRecoveryCandidates",
      "ingestEvent",
      "insertDispatchAuditEntry",
      "readEvidenceDurableState",
      "readEvidenceRegistration",
      "sha256Hex",
      "validateEvidenceHistoricalGap",
      "verifySchemaReadiness",
      "withAdvisoryXactLock",
      "writeEvidenceGroup",
      "writeEvidenceUncleanGap",
      "writeRejectionAuditRows",
    ]);
    assert.equal(entry.MAX_LOCKED_TRANSACTION_WINDOW_MS, 30_000);
    assert.equal(entry.DISCONNECT_TIMEOUT_MS, 5_000);
  });

  it("createDatabase performs no I/O: a listener at the URL sees no connection", async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const db = entry.createDatabase({
        connectionString: `postgresql://irs_no_io@127.0.0.1:${port}/irs_no_io_test`,
      });
      assert.equal(typeof db.ping, "function");
      assert.equal(typeof db.prisma.$transaction, "function");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(sockets.length, 0);
      await db.prisma.$disconnect();
      assert.equal(sockets.length, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** Task 012B (PL-8): the startup parameters a pool sends, observed on a test-owned loopback socket (FD-7). */
async function startupParameters(options: Omit<Parameters<typeof entry.createDatabase>[0], "connectionString">): Promise<Record<string, string>> {
  let packet: Buffer | undefined;
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.once("data", (chunk: Buffer) => {
      packet = chunk;
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const db = entry.createDatabase({ connectionString: `postgresql://irs_no_database@127.0.0.1:${port}/irs_no_database_test`, ...options });
  try {
    await db.ping().catch(() => undefined);
    assert.ok(packet !== undefined, "a startup packet was received");
    const body = packet.subarray(8, packet.readInt32BE(0));
    const fields = body.toString("utf8").split("\0").filter((field) => field !== "");
    const parameters: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) parameters[fields[i] ?? ""] = fields[i + 1] ?? "";
    return parameters;
  } finally {
    await db.prisma.$disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("R1 (Task 012B, PL-8): the worker's session time zone is a startup parameter", () => {
  it("sessionTimeZone UTC sends options '-c transaction_timeout=0 -c TimeZone=UTC' on every connection start", async () => {
    const parameters = await startupParameters({ pool: { maxConnections: 3 }, sessionTimeZone: "UTC" });
    process.stdout.write(`[R1 client] worker startup parameters ${JSON.stringify(parameters)}\n`);
    assert.equal(parameters.options, "-c transaction_timeout=0 -c TimeZone=UTC");
    assert.equal(parameters.statement_timeout, "5000");
  });

  it("control: the default (the API's) still sends exactly '-c transaction_timeout=0'", async () => {
    const parameters = await startupParameters({});
    assert.equal(parameters.options, "-c transaction_timeout=0");
  });

  it("toPgPoolConfig maps the pin to the options string only", () => {
    const pinned = toPgPoolConfig("postgresql://u@127.0.0.1:1/d", DEFAULT_POOL_SETTINGS, "UTC");
    const plain = toPgPoolConfig("postgresql://u@127.0.0.1:1/d", DEFAULT_POOL_SETTINGS);
    assert.equal(pinned.options, "-c transaction_timeout=0 -c TimeZone=UTC");
    assert.deepEqual({ ...pinned, options: plain.options }, plain);
  });
});

describe("DB-T1 (client boundary): what the production client sends at connection start", () => {
  // The guard refuses URLs with query parameters, so `?schema=public` is observed here
  // against a test-owned socket (FD-7) that records the PostgreSQL startup packet.
  it("a ?schema=public URL is accepted; `schema` is not sent; the session settings are startup parameters", async () => {
    let packet: Buffer | undefined;
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      socket.once("data", (chunk: Buffer) => {
        packet = chunk;
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const db = entry.createDatabase({
      connectionString: `postgresql://irs_no_database@127.0.0.1:${port}/irs_no_database_test?schema=public`,
    });
    try {
      await db.ping().catch(() => undefined);
      assert.ok(packet !== undefined, "a startup packet was received");
      const body = packet.subarray(8, packet.readInt32BE(0));
      const fields = body.toString("utf8").split("\0").filter((field) => field !== "");
      const parameters: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) parameters[fields[i] ?? ""] = fields[i + 1] ?? "";
      process.stdout.write(`[DB-T1 client] protocol ${packet.readInt32BE(4)}; startup parameters ${JSON.stringify(parameters)}\n`);
      assert.equal(packet.readInt32BE(4), 196_608, "protocol 3.0 startup, no SSL request");
      assert.equal("schema" in parameters, false, "the schema parameter is not forwarded");
      assert.equal(parameters.user, "irs_no_database");
      assert.equal(parameters.database, "irs_no_database_test");
      assert.equal(parameters.statement_timeout, "5000");
      assert.equal(parameters.idle_in_transaction_session_timeout, "10000");
      assert.equal(parameters.options, "-c transaction_timeout=0");
    } finally {
      await db.prisma.$disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("disconnectWithin (unit; DB-T14 is the database half)", () => {
  function fakeDb(disconnect: () => Promise<void>): Database {
    return { prisma: { $disconnect: disconnect }, monotonicNow: () => 0, ping: async () => undefined } as unknown as Database;
  }

  it("reports completed when the disconnect resolves", async () => {
    assert.deepEqual(await disconnectWithin(fakeDb(async () => undefined), 1_000), { completed: true });
  });

  it("reports timedOut at the bound when the disconnect never settles, and never rejects", async () => {
    const started = performance.now();
    const outcome = await disconnectWithin(fakeDb(() => new Promise<void>(() => undefined)), 100);
    const elapsed = performance.now() - started;
    assert.deepEqual(outcome, { completed: false, timedOut: true });
    assert.ok(elapsed >= 95 && elapsed < 1_000, `elapsed ${elapsed} ms`);
  });

  it("reports not completed when the disconnect rejects, and never rejects itself", async () => {
    assert.deepEqual(await disconnectWithin(fakeDb(async () => Promise.reject(new Error("x"))), 1_000), {
      completed: false,
      timedOut: true,
    });
  });

  it("createDatabase injects the monotonic clock (default performance.now)", async () => {
    const clocked = entry.createDatabase({ connectionString: "postgresql://u@127.0.0.1:1/d", monotonicNow: () => 42 });
    assert.equal(clocked.monotonicNow(), 42);
    const defaulted = entry.createDatabase({ connectionString: "postgresql://u@127.0.0.1:1/d" });
    assert.ok(Math.abs(defaulted.monotonicNow() - performance.now()) < 1_000);
    await clocked.prisma.$disconnect();
    await defaulted.prisma.$disconnect();
  });
});

describe("pool settings (F-7 + VPF-5)", () => {
  it("defaults are the approved constants", () => {
    assert.deepEqual({ ...DEFAULT_POOL_SETTINGS }, {
      maxConnections: 10,
      connectTimeoutMs: 2_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMs: 10_000,
      sessionTransactionTimeoutZero: true,
    });
    assert.ok(Object.isFrozen(DEFAULT_POOL_SETTINGS));
  });

  it("maps to exactly these pg options, with no client-side query timeout", () => {
    const config = toPgPoolConfig("postgresql://u@127.0.0.1:1/d", DEFAULT_POOL_SETTINGS);
    assert.deepEqual(config, {
      connectionString: "postgresql://u@127.0.0.1:1/d",
      max: 10,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 5_000,
      idle_in_transaction_session_timeout: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      options: "-c transaction_timeout=0",
    });
    assert.equal("query_timeout" in config, false);
  });

  it("transaction defaults are READ COMMITTED, maxWait 2000, timeout 5000", () => {
    assert.deepEqual({ ...entry.DEFAULT_TRANSACTION_OPTIONS }, {
      isolationLevel: "ReadCommitted",
      maxWait: 2_000,
      timeout: 5_000,
    });
  });
});
