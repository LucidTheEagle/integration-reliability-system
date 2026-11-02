import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigValidationError } from "@irs/config";
import { classifyDatabaseError } from "@irs/db";
import { IllegalEventStateTransitionError } from "@irs/domain";
import { AuditIdGeneratorUnavailable } from "./audit-id.js";
import { DispatchQueueError, DispatchRedisError } from "./dispatch-queue/index.js";
import { RedisPasswordFileError } from "./redis-password.js";
import {
  GATE_START_DEFERRED,
  READINESS_REASONS,
  classifyReadinessResult,
  classifyStartupFailure,
} from "./startup-outcomes.js";
import type { DatabaseClassifier } from "./startup-outcomes.js";

// Task 012B-3 (B2-1; FD-18; PD-10; S-1, S-2): every row of the startup
// classification, by instanceof and fixed fields, never by message. The
// database classifier is the third, required parameter (founder decision
// PD-B): the real classifyDatabaseError for one row, fakes for the rest.

const transient: DatabaseClassifier = () => ({ failureClass: "TRANSIENT", code: "08006" });
const fault: DatabaseClassifier = () => ({ failureClass: "FAULT", code: "28P01" });
const unused: DatabaseClassifier = () => {
  throw new Error("the database classifier is used only in the readiness phase");
};

describe("startup outcomes: every row (S-1)", () => {
  it("config: ConfigValidationError exits CONFIG_INVALID", () => {
    assert.deepEqual(classifyStartupFailure("config", new ConfigValidationError(["X: is required"]), unused), {
      outcome: "exit",
      code: "CONFIG_INVALID",
    });
  });

  it("password: RedisPasswordFileError exits by its check", () => {
    const rows = [
      ["repository-root", "REDIS_PASSWORD_REPOSITORY_ROOT"],
      ["missing-variable", "REDIS_PASSWORD_MISSING_VARIABLE"],
      ["unreadable-file", "REDIS_PASSWORD_UNREADABLE_FILE"],
      ["bad-format", "REDIS_PASSWORD_BAD_FORMAT"],
    ] as const;
    for (const [check, code] of rows) {
      assert.deepEqual(classifyStartupFailure("password", new RedisPasswordFileError(check, "detail"), unused), { outcome: "exit", code });
    }
  });

  it("uuidv7: AuditIdGeneratorUnavailable exits AUDIT_ID_V7_UNAVAILABLE", () => {
    assert.deepEqual(classifyStartupFailure("uuidv7", new AuditIdGeneratorUnavailable(), unused), {
      outcome: "exit",
      code: "AUDIT_ID_V7_UNAVAILABLE",
    });
  });

  it("transition: IllegalEventStateTransitionError exits ILLEGAL_EVENT_STATE_TRANSITION", () => {
    assert.deepEqual(classifyStartupFailure("transition", new IllegalEventStateTransitionError("VALIDATED", "QUEUED"), unused), {
      outcome: "exit",
      code: "ILLEGAL_EVENT_STATE_TRANSITION",
    });
  });

  it("readiness: a ready:false result exits with its reason, for each of the six", () => {
    assert.equal(READINESS_REASONS.length, 6);
    for (const reason of READINESS_REASONS) {
      assert.deepEqual(classifyReadinessResult({ ready: false, reason }), { outcome: "exit", code: reason });
    }
    assert.deepEqual(classifyReadinessResult({ ready: false, reason: "SOMETHING_ELSE" }), { outcome: "exit", code: "UNCLASSIFIED" });
  });

  it("readiness: a TRANSIENT throw is degraded with its database code; a FAULT throw exits with it (fakes)", () => {
    assert.deepEqual(classifyStartupFailure("readiness", new Error("x"), transient), { outcome: "degraded", code: "08006" });
    assert.deepEqual(classifyStartupFailure("readiness", new Error("x"), fault), { outcome: "exit", code: "28P01" });
  });

  it("readiness: the real classifyDatabaseError, on a driver-adapter error carrying SQLSTATE 08006 (TRANSIENT), and on an unknown error (FAULT)", () => {
    // The shape packages/db/src/errors.ts:121-132 reads: a DriverAdapterError whose cause carries the SQLSTATE.
    const connectionFailure = Object.assign(new Error("connection failure"), { name: "DriverAdapterError", cause: { originalCode: "08006" } });
    assert.deepEqual(classifyStartupFailure("readiness", connectionFailure, classifyDatabaseError), { outcome: "degraded", code: "08006" });
    const unknown = classifyStartupFailure("readiness", new TypeError("unknown"), classifyDatabaseError);
    assert.deepEqual(unknown, { outcome: "exit", code: "TypeError" });
  });

  it("readiness: a database code failing S-2's shape check becomes UNCLASSIFIED; a missing code too", () => {
    const shaped: DatabaseClassifier = () => ({ failureClass: "TRANSIENT", code: "planted marker 7f3a" });
    assert.deepEqual(classifyStartupFailure("readiness", new Error("x"), shaped), { outcome: "degraded", code: "UNCLASSIFIED" });
    const none: DatabaseClassifier = () => ({ failureClass: "FAULT", code: undefined });
    assert.deepEqual(classifyStartupFailure("readiness", new Error("x"), none), { outcome: "exit", code: "UNCLASSIFIED" });
    const throwing: DatabaseClassifier = () => {
      throw new Error("classifier failure");
    };
    assert.deepEqual(classifyStartupFailure("readiness", new Error("x"), throwing), { outcome: "exit", code: "UNCLASSIFIED" });
  });

  it("queue: a DispatchRedisError is degraded with its code, UNCLASSIFIED included, never an exit (DR5 §6; FD-18)", () => {
    assert.deepEqual(classifyStartupFailure("queue", new DispatchRedisError("ECONNREFUSED"), unused), { outcome: "degraded", code: "ECONNREFUSED" });
    assert.deepEqual(classifyStartupFailure("queue", new DispatchRedisError("UNCLASSIFIED"), unused), { outcome: "degraded", code: "UNCLASSIFIED" });
    assert.deepEqual(classifyStartupFailure("queue", new DispatchRedisError("lower-case"), unused), { outcome: "degraded", code: "UNCLASSIFIED" });
  });

  it("queue: gate.start() returning false is GATE_START_DEFERRED", () => {
    assert.equal(GATE_START_DEFERRED, "GATE_START_DEFERRED");
  });

  it("queue: a DispatchQueueError is unclassifiable: exit UNCLASSIFIED", () => {
    assert.deepEqual(classifyStartupFailure("queue", new DispatchQueueError("settings", "host is malformed"), unused), {
      outcome: "exit",
      code: "UNCLASSIFIED",
    });
  });

  it("any phase: anything else exits UNCLASSIFIED, fail closed (PD-10)", () => {
    for (const phase of ["config", "password", "uuidv7", "transition", "database", "queue", "ready"] as const) {
      assert.deepEqual(classifyStartupFailure(phase, new Error("x"), unused), { outcome: "exit", code: "UNCLASSIFIED" });
      assert.deepEqual(classifyStartupFailure(phase, "not an error", unused), { outcome: "exit", code: "UNCLASSIFIED" });
    }
    // A known class in another phase is unclassifiable there.
    assert.deepEqual(classifyStartupFailure("password", new ConfigValidationError(["X: is required"]), unused), {
      outcome: "exit",
      code: "UNCLASSIFIED",
    });
  });

  it("never by message: a plain Error whose message imitates each known class exits UNCLASSIFIED", () => {
    const imitations: [Parameters<typeof classifyStartupFailure>[0], Error][] = [
      ["config", Object.assign(new Error("Invalid configuration: X"), { name: "ConfigValidationError" })],
      ["password", Object.assign(new Error("Redis password file refused (bad-format): x"), { name: "RedisPasswordFileError", check: "bad-format" })],
      ["uuidv7", Object.assign(new Error("audit id generator unavailable (AUDIT_ID_V7_UNAVAILABLE)"), { code: "AUDIT_ID_V7_UNAVAILABLE" })],
      ["transition", Object.assign(new Error("Illegal EventState transition: VALIDATED -> QUEUED"), { name: "IllegalEventStateTransitionError" })],
      ["queue", Object.assign(new Error("dispatch queue Redis operation failed (ECONNREFUSED)"), { name: "DispatchRedisError", code: "ECONNREFUSED" })],
    ];
    for (const [phase, error] of imitations) {
      assert.deepEqual(classifyStartupFailure(phase, error, unused), { outcome: "exit", code: "UNCLASSIFIED" });
    }
  });
});
