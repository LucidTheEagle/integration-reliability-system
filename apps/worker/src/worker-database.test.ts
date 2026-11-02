import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CreateDatabaseOptions } from "@irs/db";
import { WORKER_POOL, openWorkerDatabase } from "./worker-database.js";

// Task 012B-3 (B2-2; F-TOPG; F-ADAPTER; R1): the options the worker hands to
// createDatabase, pinned with a fake. R1's UTC pin keeps every worker session
// at TimeZone=UTC, because the pinned adapter reads timestamptz shifted under
// a non-UTC session (F-ADAPTER). @irs/db's public surface is unchanged
// (F-TOPG). Nothing connects.

describe("worker database: the composition (B2-2, R1)", () => {
  it("passes exactly the connection string, the 3-connection pool and the UTC pin", () => {
    const received: CreateDatabaseOptions[] = [];
    const marker = { fake: "database" };
    const url = "postgresql://irs_test_worker@127.0.0.1:55433/irs_011_test";
    const db = openWorkerDatabase((options) => {
      received.push(options);
      return marker;
    }, url);
    assert.equal(db, marker);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { connectionString: url, pool: { maxConnections: 3 }, sessionTimeZone: "UTC" });
    assert.deepEqual(Object.keys(received[0] ?? {}).sort(), ["connectionString", "pool", "sessionTimeZone"]);
  });

  it("WORKER_POOL is frozen at max 3 connections, and each call gets its own copy", () => {
    assert.deepEqual({ ...WORKER_POOL }, { maxConnections: 3 });
    assert.ok(Object.isFrozen(WORKER_POOL));
    const pools: unknown[] = [];
    openWorkerDatabase((options) => pools.push(options.pool), "postgresql://irs_test_worker@127.0.0.1:55433/irs_011_test");
    assert.notEqual(pools[0], WORKER_POOL);
  });
});
