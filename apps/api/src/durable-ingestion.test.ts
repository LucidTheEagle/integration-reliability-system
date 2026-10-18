import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IngestionCommitUnknownError, IngestionInvariantError } from "@irs/db";
import type { Database, EventIngestionInput, EventIngestionResult } from "@irs/db";
import type { VerifiedWebhookEnvelope } from "@irs/integrations";
import { createDurableIngestionHandoff, findUnstorableCondition, toIngestionInput } from "./durable-ingestion.js";
import type { HandoffLogger } from "./durable-ingestion.js";
import type { IngestionRequest } from "./handoff.js";

// The durable handoff with a fake repository (HO-1 – HO-7) and the pure
// P1/P2 pre-validation (DB-T16 (a), (b)). No database.

const FAKE_DB = {} as Database;
const SECRET_MARKER = "irs-test-secret-sentinel";

function envelope(overrides: Partial<VerifiedWebhookEnvelope> = {}): VerifiedWebhookEnvelope {
  return {
    externalEventId: "evt_1",
    eventType: "payment.completed",
    resourceType: "payment",
    resourceId: "pay_1",
    occurredAt: new Date("2026-10-12T10:00:00.000Z"),
    schemaVersion: "1",
    payload: { amount: 100, nested: { note: "ok" } },
    ...overrides,
  };
}

function request(overrides: Partial<VerifiedWebhookEnvelope> = {}): IngestionRequest {
  const rawBody = new TextEncoder().encode('{"externalEventId":"evt_1"}');
  return {
    requestId: "0190f3a2-0000-7000-8000-00000000000a",
    integrationId: "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61",
    envelope: envelope(overrides),
    rawBody,
    receivedAt: new Date("2026-10-17T10:00:00.000Z"),
    metadata: { contentType: "application/json", bodyByteLength: rawBody.byteLength },
  };
}

class CapturingLogger implements HandoffLogger {
  readonly records: { level: string; object: Record<string, unknown>; message: string }[] = [];
  info(object: Record<string, unknown>, message: string): void {
    this.records.push({ level: "info", object, message });
  }
  warn(object: Record<string, unknown>, message: string): void {
    this.records.push({ level: "warn", object, message });
  }
  error(object: Record<string, unknown>, message: string): void {
    this.records.push({ level: "error", object, message });
  }
}

const throwingLogger: HandoffLogger = {
  info: () => {
    throw new Error("log failed");
  },
  warn: () => {
    throw new Error("log failed");
  },
  error: () => {
    throw new Error("log failed");
  },
};

function fakeIngest(result: () => Promise<EventIngestionResult>) {
  const calls: EventIngestionInput[] = [];
  const ingest = async (_db: Database, input: EventIngestionInput) => {
    calls.push(input);
    return result();
  };
  return { ingest, calls };
}

/** Error doubles with the shapes recorded in Stage 4 (DB-T10, VPF-4). */
function adapterError(originalCode: string): Error {
  return Object.assign(new Error(`database said: ${SECRET_MARKER} password=hunter2`), {
    name: "DriverAdapterError",
    cause: { originalCode, kind: "postgres" },
  });
}

describe("HO-1: mapping", () => {
  it("maps the request to EventIngestionInput exactly, with no headers, signature or secret", () => {
    const req = request({ correlationId: "corr-1" });
    const input = toIngestionInput(req);
    assert.deepEqual(input, {
      requestId: req.requestId,
      integrationId: req.integrationId,
      externalEventId: "evt_1",
      eventType: "payment.completed",
      resourceType: "payment",
      resourceId: "pay_1",
      occurredAt: req.envelope.occurredAt,
      schemaVersion: "1",
      correlationId: "corr-1",
      payload: req.envelope.payload,
      rawBody: req.rawBody,
      receivedAt: req.receivedAt,
      contentType: "application/json",
    });
    assert.equal(input.rawBody, req.rawBody, "the same raw bytes the verifier saw");
    assert.equal(toIngestionInput(request()).correlationId, null);
  });
});

describe("HO-2 – HO-5: outcomes and logs", () => {
  it("HO-2: NEW and DUPLICATE → ACCEPTED with the event id; info log with IDs only", async () => {
    for (const result of [
      { disposition: "NEW", eventId: "e-new" },
      { disposition: "DUPLICATE", eventId: "e-dup", contentMatches: true },
    ] as const) {
      const logger = new CapturingLogger();
      const { ingest } = fakeIngest(async () => result);
      const outcome = await createDurableIngestionHandoff({ db: FAKE_DB, logger, ingest }).accept(request());
      assert.deepEqual(outcome, { status: "ACCEPTED", eventId: result.eventId });
      assert.deepEqual(logger.records.map((r) => [r.level, Object.keys(r.object).sort()]), [
        ["info", ["disposition", "eventId", "integrationId", "requestId"]],
      ]);
    }
  });

  it("a duplicate with different content is ACCEPTED and logged at warn with contentMatches false", async () => {
    const logger = new CapturingLogger();
    const { ingest } = fakeIngest(async () => ({ disposition: "DUPLICATE", eventId: "e", contentMatches: false }));
    assert.deepEqual(await createDurableIngestionHandoff({ db: FAKE_DB, logger, ingest }).accept(request()), {
      status: "ACCEPTED",
      eventId: "e",
    });
    assert.equal(logger.records[0]?.level, "warn");
    assert.equal(logger.records[0]?.object.contentMatches, false);
  });

  it("INTEGRATION_INELIGIBLE → the ineligible outcome; warn with integrationId and configStatus only", async () => {
    for (const configStatus of ["DRAFT", "DISABLED", "DECOMMISSIONED", "NOT_REGISTERED"] as const) {
      const logger = new CapturingLogger();
      const { ingest } = fakeIngest(async () => ({ disposition: "INTEGRATION_INELIGIBLE", configStatus }));
      assert.deepEqual(await createDurableIngestionHandoff({ db: FAKE_DB, logger, ingest }).accept(request()), {
        status: "INTEGRATION_INELIGIBLE",
      });
      assert.deepEqual(logger.records[0]?.object, {
        requestId: request().requestId,
        outcome: configStatus === "NOT_REGISTERED" ? "INTEGRATION_NOT_REGISTERED" : "INTEGRATION_INELIGIBLE",
        integrationId: request().integrationId,
        configStatus,
      });
    }
  });

  it("HO-3: TRANSIENT and commit-unknown → UNAVAILABLE; logs carry only errorName, code and outcome", async () => {
    // DEV-2 (FD-12, C-G4-2 amended): UNAVAILABLE carries the handoff's own classification.
    const cases: [unknown, string, string | undefined, string][] = [
      [new Error("timeout exceeded when trying to connect"), "TRANSIENT", undefined, "TRANSIENT"],
      [adapterError("57014"), "TRANSIENT", "57014", "TRANSIENT"],
      [new IngestionCommitUnknownError(adapterError("23505")), "UNKNOWN", "COMMIT_UNKNOWN", "COMMIT_UNKNOWN"],
    ];
    for (const [error, outcome, code, classification] of cases) {
      const logger = new CapturingLogger();
      const { ingest } = fakeIngest(() => Promise.reject(error));
      assert.deepEqual(await createDurableIngestionHandoff({ db: FAKE_DB, logger, ingest }).accept(request()), {
        status: "UNAVAILABLE",
        classification,
      });
      assert.equal(logger.records.length, 1);
      const record = logger.records[0];
      assert.equal(record?.level, "error");
      assert.deepEqual(Object.keys(record?.object ?? {}).sort(), ["code", "errorName", "outcome", "requestId"]);
      assert.equal(record?.object.outcome, outcome);
      assert.equal(record?.object.code, code);
      assert.doesNotMatch(JSON.stringify(logger.records), new RegExp(SECRET_MARKER));
      assert.doesNotMatch(JSON.stringify(logger.records), /hunter2/);
    }
  });

  it("HO-4: FAULT and invariant errors are rethrown (→ 500 through the server)", async () => {
    for (const error of [adapterError("23503"), new IngestionInvariantError("no row"), new TypeError("bug")]) {
      const logger = new CapturingLogger();
      const { ingest } = fakeIngest(() => Promise.reject(error));
      await assert.rejects(createDurableIngestionHandoff({ db: FAKE_DB, logger, ingest }).accept(request()), (thrown) => thrown === error);
      assert.equal(logger.records[0]?.object.outcome, "FAULT");
    }
  });

  it("HO-5: a failing logger never changes the outcome", async () => {
    const accepted = fakeIngest(async () => ({ disposition: "NEW", eventId: "e" }));
    assert.deepEqual(await createDurableIngestionHandoff({ db: FAKE_DB, logger: throwingLogger, ingest: accepted.ingest }).accept(request()), {
      status: "ACCEPTED",
      eventId: "e",
    });
    const transient = fakeIngest(() => Promise.reject(adapterError("57P01")));
    assert.deepEqual(await createDurableIngestionHandoff({ db: FAKE_DB, logger: throwingLogger, ingest: transient.ingest }).accept(request()), {
      status: "UNAVAILABLE",
      classification: "TRANSIENT",
    });
    assert.deepEqual(
      await createDurableIngestionHandoff({ db: FAKE_DB, logger: throwingLogger, ingest: accepted.ingest }).accept(request({ payload: { x: "\u0000" } })),
      { status: "UNPROCESSABLE_PAYLOAD", condition: "P1_NUL_CHARACTER" },
    );
  });
});

describe("HO-6 / HO-7: unstorable payloads and the 422 boundary", () => {
  it("HO-6: P1 or P2 → the unprocessable outcome; ingestEvent is never called; the log has the condition and request ID only", async () => {
    for (const [payload, condition, short] of [
      [{ text: "a\u0000b" }, "P1_NUL_CHARACTER", "P1"],
      [{ text: "a\uD800b" }, "P2_UNPAIRED_SURROGATE", "P2"],
    ] as const) {
      const logger = new CapturingLogger();
      const { ingest, calls } = fakeIngest(async () => ({ disposition: "NEW", eventId: "e" }));
      assert.deepEqual(await createDurableIngestionHandoff({ db: FAKE_DB, logger, ingest }).accept(request({ payload })), {
        status: "UNPROCESSABLE_PAYLOAD",
        condition,
      });
      assert.equal(calls.length, 0, "no ingestion-path query");
      assert.deepEqual(logger.records[0]?.object, { requestId: request().requestId, outcome: "UNPROCESSABLE_PAYLOAD", condition: short });
      assert.doesNotMatch(JSON.stringify(logger.records), /a\\u0000b|\\ud800/i);
    }
  });

  it("HO-7: no database-error class ever maps to the unprocessable outcome (22P05 included)", async () => {
    for (const error of [
      adapterError("22P05"),
      adapterError("22P02"),
      adapterError("22021"),
      adapterError("57014"),
      new IngestionCommitUnknownError(adapterError("22P05")),
      new Error("Connection terminated unexpectedly"),
    ]) {
      const { ingest } = fakeIngest(() => Promise.reject(error));
      const outcome = await createDurableIngestionHandoff({ db: FAKE_DB, ingest })
        .accept(request())
        .then((value) => value.status, () => "THROWN (500)");
      assert.ok(outcome === "UNAVAILABLE" || outcome === "THROWN (500)", `got ${outcome}`);
    }
  });
});

describe("DB-T16 (a)/(b): the pre-validation walk", () => {
  it("detects P1 and P2 at every position, including keys, array elements and each envelope string field", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 50; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    cursor.leaf = "x\u0000";
    const cases: [Partial<VerifiedWebhookEnvelope>, string][] = [
      [{ payload: { a: "\u0000" } }, "P1_NUL_CHARACTER"],
      [{ payload: deep }, "P1_NUL_CHARACTER"],
      [{ payload: { "k\u0000": 1 } }, "P1_NUL_CHARACTER"],
      [{ payload: { list: [1, "ok", ["\uDC00"]] } }, "P2_UNPAIRED_SURROGATE"],
      [{ payload: { "k\uD83D": 1 } }, "P2_UNPAIRED_SURROGATE"],
      [{ externalEventId: "e\u0000" }, "P1_NUL_CHARACTER"],
      [{ eventType: "t\uD800" }, "P2_UNPAIRED_SURROGATE"],
      [{ resourceType: "r\u0000" }, "P1_NUL_CHARACTER"],
      [{ resourceId: "r\uDFFF" }, "P2_UNPAIRED_SURROGATE"],
      [{ schemaVersion: "1\u0000" }, "P1_NUL_CHARACTER"],
      [{ correlationId: "c\uD800x" }, "P2_UNPAIRED_SURROGATE"],
      [{ payload: { both: "\uD800\u0000" } }, "P1_NUL_CHARACTER"],
    ];
    for (const [override, expected] of cases) {
      assert.equal(findUnstorableCondition(envelope(override)), expected, JSON.stringify(Object.keys(override)));
    }
  });

  it("does not report valid strings: well-formed surrogate pairs and other control characters pass", () => {
    assert.equal(findUnstorableCondition(envelope({ payload: { emoji: "😀𝄞", control: "\u0001\t\n\u007f", text: "é—ok" } })), undefined);
    assert.equal(findUnstorableCondition(envelope({ correlationId: "😀" })), undefined);
    assert.equal(findUnstorableCondition(envelope()), undefined);
  });

  it("a very deeply nested valid payload does not make the check itself fail", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 200_000; i += 1) nested = i % 2 === 0 ? [nested] : { n: nested };
    assert.equal(findUnstorableCondition(envelope({ payload: { root: nested } })), undefined);
  });
});
