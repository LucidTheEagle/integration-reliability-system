import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  AdvisoryLockNotInTransactionError,
  AdvisoryLockTimeoutError,
  IngestionCommitUnknownError,
  IngestionInvariantError,
  LockedTransactionDeadlineError,
  PINNED_DRIVER_VERSIONS,
  TRANSIENT_DRIVER_MESSAGES,
  TransactionTimeoutInvariantError,
  classifyDatabaseError,
  markCommitUnknown,
} from "./errors.js";
import { Prisma } from "./generated/prisma/client.js";

// VPF-4 classifier: fixtures copy the shapes recorded by VP-011 (Decision
// Package VPF-4 §1). Real-error reproductions are in errors.db.test.ts.

function known(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("fixture", { code, clientVersion: "7.10.0", meta });
}

function withAdapterCause(code: string, cause: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return known(code, { driverAdapterError: { cause } });
}

function driverAdapterError(cause: Record<string, unknown>): Error {
  return Object.assign(new Error("fixture"), { name: "DriverAdapterError", cause });
}

function transient(error: unknown): void {
  assert.equal(classifyDatabaseError(error).failureClass, "TRANSIENT");
}

function fault(error: unknown): void {
  assert.equal(classifyDatabaseError(error).failureClass, "FAULT");
}

describe("VPF-4: recorded shapes", () => {
  it("pool acquisition timeout, plain query (pg-pool, unwrapped) → TRANSIENT", () => {
    transient(new Error("timeout exceeded when trying to connect"));
  });
  it("pool acquisition timeout, $transaction (P2028) → TRANSIENT", () => {
    assert.deepEqual(classifyDatabaseError(known("P2028")), { failureClass: "TRANSIENT", code: "P2028" });
  });
  it("connect timeout against a silent peer (plain) → TRANSIENT", () => {
    transient(new Error("Connection terminated due to connection timeout"));
  });
  it("closed port (P2010, kind DatabaseNotReachable) → TRANSIENT", () => {
    assert.deepEqual(classifyDatabaseError(withAdapterCause("P2010", { kind: "DatabaseNotReachable" })), {
      failureClass: "TRANSIENT",
      code: "DatabaseNotReachable",
    });
  });
  it("terminated between statements (plain) → TRANSIENT", () => {
    transient(new Error("Client has encountered a connection error and is not queryable"));
  });
  it("terminated during a statement (P2010, 57P01) → TRANSIENT", () => {
    assert.deepEqual(classifyDatabaseError(withAdapterCause("P2010", { originalCode: "57P01", kind: "postgres" })), {
      failureClass: "TRANSIENT",
      code: "57P01",
    });
  });
  it("statement_timeout (57014) and transaction_timeout (25P04) → TRANSIENT", () => {
    transient(withAdapterCause("P2010", { originalCode: "57014", kind: "postgres" }));
    transient(withAdapterCause("P2010", { originalCode: "25P04", kind: "postgres" }));
  });
  it("FK violation (P2003; P2010 + 23503) → FAULT", () => {
    assert.deepEqual(classifyDatabaseError(known("P2003")), { failureClass: "FAULT", code: "P2003" });
    assert.deepEqual(
      classifyDatabaseError(withAdapterCause("P2010", { originalCode: "23503", kind: "ForeignKeyConstraintViolation" })),
      { failureClass: "FAULT", code: "23503" },
    );
  });
  it("Prisma expiry (P2028) → TRANSIENT", () => {
    transient(known("P2028"));
  });
  it("lost acknowledgement, socket reset (bare DriverAdapterError ConnectionClosed) → TRANSIENT", () => {
    assert.deepEqual(classifyDatabaseError(driverAdapterError({ kind: "ConnectionClosed" })), {
      failureClass: "TRANSIENT",
      code: "ConnectionClosed",
    });
  });
  it("lost acknowledgement, silent then teardown (plain) → TRANSIENT", () => {
    transient(new Error("Connection terminated unexpectedly"));
  });
});

describe("VPF-4: layers and SQLSTATE table", () => {
  it("SQLSTATE classes 08 and 53, 57P02/57P03, 40001, 40P01, 55P03, 25P03 → TRANSIENT", () => {
    for (const code of ["08006", "08001", "53300", "57P02", "57P03", "40001", "40P01", "55P03", "25P03"]) {
      transient(withAdapterCause("P2010", { originalCode: code, kind: "postgres" }));
    }
  });
  it("unexpected 23505, class 22, class 42 and unknown SQLSTATEs → FAULT", () => {
    for (const code of ["23505", "22P05", "22021", "42P01", "42501", "XX000"]) {
      fault(withAdapterCause("P2010", { originalCode: code, kind: "postgres" }));
    }
  });
  it("SQLSTATE from a bare DriverAdapterError's cause.code", () => {
    transient(driverAdapterError({ code: "57014", kind: "postgres" }));
  });
  it("other P1001/P1017/P2024 codes → TRANSIENT; other adapter kinds → FAULT", () => {
    transient(known("P1001"));
    transient(known("P1017"));
    transient(known("P2024"));
    fault(withAdapterCause("P2010", { kind: "UniqueConstraintViolation" }));
  });
  it("runner and ingestion classes", () => {
    transient(new AdvisoryLockTimeoutError("x", "LOCK", "NOT_COMMITTED"));
    transient(new LockedTransactionDeadlineError("x", "WORK", "NOT_COMMITTED"));
    fault(new AdvisoryLockNotInTransactionError("x", "SETUP", "NOT_COMMITTED"));
    fault(new TransactionTimeoutInvariantError("x", "SETUP", "NOT_COMMITTED"));
    fault(new IngestionInvariantError("x"));
  });
  it("runner classes take precedence over a SQLSTATE in their cause", () => {
    fault(new TransactionTimeoutInvariantError("x", "SETUP", "NOT_COMMITTED", withAdapterCause("P2010", { originalCode: "57014" })));
  });
});

describe("VPF-4: phase first (commit boundary)", () => {
  it("any error after the ingestion callback completed → COMMIT_UNKNOWN, whatever its shape", () => {
    for (const cause of [
      new Error("anything"),
      known("P2003"),
      withAdapterCause("P2010", { originalCode: "23505" }),
      "not an error",
      undefined,
    ]) {
      assert.deepEqual(classifyDatabaseError(new IngestionCommitUnknownError(cause)), {
        failureClass: "TRANSIENT",
        code: "COMMIT_UNKNOWN",
      });
    }
  });
  it("a runner-marked commit-phase error → COMMIT_UNKNOWN, even a FAULT-looking one", () => {
    const error = markCommitUnknown(Object.assign(known("P2003"), { phase: "COMMIT", outcome: "UNKNOWN" }));
    assert.equal(classifyDatabaseError(error).code, "COMMIT_UNKNOWN");
  });
  it("an unmarked object that merely carries outcome UNKNOWN gets no special treatment", () => {
    fault(Object.assign(new Error("forged"), { phase: "COMMIT", outcome: "UNKNOWN" }));
  });
});

describe("VPF-4: allowlist negatives", () => {
  it("the same message with a suffix, a prefix or a different case → FAULT", () => {
    for (const message of TRANSIENT_DRIVER_MESSAGES) {
      fault(new Error(`${message}.`));
      fault(new Error(` ${message}`));
      fault(new Error(message.toUpperCase()));
    }
  });
  it("an Error subclass with an allowlisted message → FAULT", () => {
    class SubError extends Error {}
    fault(new SubError("Connection terminated unexpectedly"));
    fault(new TypeError("Connection terminated unexpectedly"));
  });
  it("an allowlisted message on an object with a code → not the allowlist path", () => {
    fault(Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" }));
  });
  it("unknown connection-flavoured text → FAULT", () => {
    fault(new Error("Connection reset by peer"));
    fault(new Error("socket hang up"));
    fault(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }));
  });
  it("undefined, a string, null, a number and a plain object → FAULT", () => {
    for (const value of [undefined, "timeout exceeded when trying to connect", null, 42, { message: "x" }]) {
      fault(value);
    }
  });
  it("the allowlist is exactly the four pinned messages", () => {
    assert.deepEqual([...TRANSIENT_DRIVER_MESSAGES], [
      "timeout exceeded when trying to connect",
      "Connection terminated due to connection timeout",
      "Client has encountered a connection error and is not queryable",
      "Connection terminated unexpectedly",
    ]);
    assert.ok(Object.isFrozen(TRANSIENT_DRIVER_MESSAGES));
  });
});

describe("VPF-4: driver version guard", () => {
  it("the resolved pg and pg-pool equal the pinned versions (an upgrade forces review)", () => {
    const requireHere = createRequire(import.meta.url);
    const requireFromAdapter = createRequire(requireHere.resolve("@prisma/adapter-pg"));
    const pgEntry = requireFromAdapter.resolve("pg");
    const requireFromPg = createRequire(pgEntry);
    const pgVersion = (requireFromAdapter("pg/package.json") as { version: string }).version;
    // pg-pool restricts its exports, so read its manifest next to its resolved entry.
    const poolEntry = requireFromPg.resolve("pg-pool");
    const poolVersion = (JSON.parse(readFileSync(join(dirname(poolEntry), "package.json"), "utf8")) as { version: string })
      .version;
    assert.deepEqual({ pg: pgVersion, "pg-pool": poolVersion }, { ...PINNED_DRIVER_VERSIONS });
  });
});
