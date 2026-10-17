import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
// The built package entry (dist/index.js): VPF-1(c).
import * as entry from "./index.js";
import { DEFAULT_POOL_SETTINGS, toPgPoolConfig } from "./client.js";

describe("built @irs/db entry (VPF-1(c))", () => {
  it("the package's exports map '.' to this built entry, with no subpaths", () => {
    const resolved = fileURLToPath(import.meta.resolve("@irs/db"));
    assert.equal(resolved, fileURLToPath(new URL("./index.js", import.meta.url)));
    assert.throws(() => import.meta.resolve("@irs/db/generated/prisma/client.js"));
    assert.throws(() => import.meta.resolve("@irs/db/test-support/guard.js"));
  });

  it("exports the documented runtime surface", () => {
    assert.deepEqual(Object.keys(entry).sort(), [
      "DEFAULT_POOL_SETTINGS",
      "DEFAULT_TRANSACTION_OPTIONS",
      "createDatabase",
    ]);
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
