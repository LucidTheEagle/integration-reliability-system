import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DISCONNECT_TIMEOUT_MS } from "@irs/db";
import {
  GATE_CEILINGS,
  MAX_CODES_PER_LINE,
  MAX_TRACKED_CODES,
  WORKER_CONSTANTS,
  WorkerConstantsError,
  withConstants,
} from "./worker-constants.js";

// Task 012B-3 (B2-9; PD-6 to PD-9; FD-21; S-5, S-11): the worker's
// provisional values, pinned. Pure; nothing connects.

describe("worker constants: the pinned values (provisional under O-013)", () => {
  it("every injectable value is pinned", () => {
    assert.deepEqual({ ...WORKER_CONSTANTS }, {
      cycleIntervalMs: 1000,
      redisDeadlineMs: 3000,
      recoveryPeriodMs: 30000,
      retireWindowMs: 5000,
      backoffBaseMs: 500,
      backoffCapMs: 5000,
      shutdownCycleMs: 5000,
      databaseDisconnectMs: 5000,
      retryAgeMs: 30000,
      auditAgeMs: 300000,
      auditRepairBound: 3,
      attemptWarningThreshold: 10,
      auditIntervalMs: 30000,
      claimBatch: 100,
    });
    assert.ok(Object.isFrozen(WORKER_CONSTANTS));
  });

  it("the FD-21 ceilings, PD-9's codes per line and S-5's tracked codes are pinned", () => {
    assert.deepEqual({ ...GATE_CEILINGS }, {
      queueGenerations: 2,
      probeConnections: 2,
      normalOperations: 15,
      probeOperations: 1,
      replacementsWithoutRecovery: 3,
    });
    assert.ok(Object.isFrozen(GATE_CEILINGS));
    assert.equal(MAX_CODES_PER_LINE, 8);
    assert.equal(MAX_TRACKED_CODES, 64);
  });

  it("the database bound equals @irs/db's DISCONNECT_TIMEOUT_MS", () => {
    assert.equal(WORKER_CONSTANTS.databaseDisconnectMs, DISCONNECT_TIMEOUT_MS);
  });

  it("O is 15 normal plus 1 reserved probe slot, 16 in all (B2-13)", () => {
    assert.equal(GATE_CEILINGS.normalOperations + GATE_CEILINGS.probeOperations, 16);
  });

  it("at most 4 Redis clients system-wide: Q plus P, each counted once", () => {
    assert.equal(GATE_CEILINGS.queueGenerations + GATE_CEILINGS.probeConnections, 4);
  });
});

describe("worker constants: withConstants (S-11)", () => {
  it("overrides a time value and returns a frozen merge, leaving the defaults unchanged", () => {
    const merged = withConstants({ cycleIntervalMs: 10, redisDeadlineMs: 30 });
    assert.equal(merged.cycleIntervalMs, 10);
    assert.equal(merged.redisDeadlineMs, 30);
    assert.equal(merged.recoveryPeriodMs, WORKER_CONSTANTS.recoveryPeriodMs);
    assert.ok(Object.isFrozen(merged));
    assert.equal(WORKER_CONSTANTS.cycleIntervalMs, 1000);
  });

  it("refuses an unknown key, and the ceilings cannot be overridden", () => {
    for (const key of ["unknownKey", "normalOperations", "queueGenerations", "replacementsWithoutRecovery"]) {
      assert.throws(() => withConstants({ [key]: 1 }), (error: unknown) => error instanceof WorkerConstantsError);
    }
  });

  it("refuses a value that is not a positive safe integer", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "10", null]) {
      assert.throws(() => withConstants({ cycleIntervalMs: value }), (error: unknown) => error instanceof WorkerConstantsError);
    }
  });
});
