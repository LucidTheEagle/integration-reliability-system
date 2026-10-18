import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database, EventIngestionInput, EventIngestionResult } from "@irs/db";
import { createDurableIngestionHandoff } from "./durable-ingestion.js";
import { DEFAULT_RATE_LIMIT_POLICIES, createRateLimiter } from "./rate-limit.js";
import type { Counters, RateLimiter } from "./rate-limit.js";
import { createResponseGate } from "./server.js";
import {
  LogCapture,
  ManualClock,
  RecordingHandoff,
  SECRET_TEXT,
  UNCONFIGURED_ID,
  WEBHOOK_PATH,
  envelopeJson,
  makeApp,
  parseJson,
  spyLimiter,
  validRequest,
} from "./test-helpers.js";
import type { LimiterSpy, TestApp } from "./test-helpers.js";

// Task 011's ingestion outcomes at the HTTP boundary (inject; no database):
// HT-5, HT-6, HT-7, HT-10b, HT-12, the request-level halves of HT-10, HT-11
// and SEC-1, and the C-G4-1 assertions (status/body, L2 consumption,
// individualRejectionOf) in place of a rejection-audit sink double.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FAKE_DB = {} as Database;
const BODY_MARKER = "irs-body-marker-7c1d";
const DATABASE_PASSWORD = "irs-db-password-sentinel-4f2a";

let current: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of current) await app.close();
  current = [];
});

/** A durable handoff over a spied fake repository, wrapped in a RecordingHandoff spy. */
function durable(result: (input: EventIngestionInput) => Promise<EventIngestionResult>) {
  const ingested: EventIngestionInput[] = [];
  const inner = createDurableIngestionHandoff({
    db: FAKE_DB,
    ingest: async (_db, input) => {
      ingested.push(input);
      return result(input);
    },
  });
  return { handoff: new RecordingHandoff((request) => inner.accept(request)), ingested };
}

function start(handoff: RecordingHandoff, options: { stubPeek?: boolean; deny?: boolean; logs?: LogCapture } = {}) {
  let spy: LimiterSpy | undefined;
  const t = makeApp({
    handoff,
    ...(options.logs === undefined ? {} : { logs: options.logs }),
    rateLimit: {
      wrap: (inner) => {
        const overrides: Partial<RateLimiter> = {};
        if (options.stubPeek === true) overrides.peekRejectionAllowance = () => ({ allowed: true });
        if (options.deny === true) {
          overrides.consumeRejectionAllowance = () => ({
            allowed: false,
            layer: "L2",
            retryAfterSeconds: 30,
            log: null,
          });
        }
        spy = spyLimiter(inner, overrides);
        return spy.limiter;
      },
    },
  });
  current.push(t.app);
  assert.ok(spy !== undefined && t.evidence !== undefined && t.limiter !== undefined);
  return { ...t, spy, evidence: t.evidence, limiter: t.limiter };
}

function post(t: TestApp, request: { body: Buffer; headers: Record<string, string> }, url = WEBHOOK_PATH) {
  return t.app.inject({ method: "POST", url, headers: request.headers, payload: request.body });
}

function delta(t: { evidence: { drain(): { delta: Counters } } }): Counters {
  return t.evidence.drain().delta;
}

function body(response: { body: string }): Record<string, unknown> {
  return parseJson(response.body) as Record<string, unknown>;
}

function genericError(response: { statusCode: number; body: string }, status: number, code: string): void {
  assert.equal(response.statusCode, status);
  const parsed = body(response);
  assert.deepEqual(Object.keys(parsed).sort(), ["error", "requestId"]);
  assert.equal(parsed.error, code);
  assert.match(String(parsed.requestId), UUID_V4);
}

const P1_REQUEST = () => validRequest(envelopeJson({ payload: { text: `x\u0000${BODY_MARKER}` } }));
const P2_REQUEST = () => validRequest(envelopeJson({ payload: { text: `x\uD800${BODY_MARKER}` } }));

describe("HT-10 / HT-11 (request level): the ingestion rejections", () => {
  it("HT-10 case 1: P1 and P2 → 422 UNPROCESSABLE_PAYLOAD through rejectWith; one L2 allowance; ingestEvent never called", async () => {
    for (const request of [P1_REQUEST, P2_REQUEST]) {
      const { handoff, ingested } = durable(async () => ({ disposition: "NEW", eventId: "e" }));
      const t = start(handoff);
      delta(t);
      const response = await post(t, request());
      genericError(response, 422, "UNPROCESSABLE_PAYLOAD");
      assert.equal(handoff.requests.length, 1, "the handoff decided");
      assert.equal(ingested.length, 0, "no ingestion-path query");
      assert.equal(t.spy.calls.consumeRejectionAllowance, 1);
      assert.equal(delta(t).layers.L2.individualRejections, 1);
    }
  });

  it("HT-11 case 2: an ineligible integration → the generic 404 (indistinguishable from the route 404); one L2 allowance", async () => {
    for (const configStatus of ["DRAFT", "DISABLED", "DECOMMISSIONED", "NOT_REGISTERED"] as const) {
      const { handoff, ingested } = durable(async () => ({ disposition: "INTEGRATION_INELIGIBLE", configStatus }));
      const t = start(handoff);
      delta(t);
      const response = await post(t, validRequest());
      genericError(response, 404, "NOT_FOUND");
      assert.equal(ingested.length, 1, "only the status check ran (in the repository)");
      assert.equal(t.spy.calls.consumeRejectionAllowance, 1);
      assert.equal(delta(t).layers.L2.individualRejections, 1);
      const routeNotFound = await post(t, validRequest(), `/api/webhooks/${UNCONFIGURED_ID}`);
      assert.deepEqual(Object.keys(body(routeNotFound)).sort(), Object.keys(body(response)).sort());
      assert.equal(routeNotFound.headers["content-type"], response.headers["content-type"]);
    }
  });

  it("HT-11 case 3 (retained order, D2): an inactive integration sending a P1 payload → 422; the status check never runs", async () => {
    const { handoff, ingested } = durable(async () => ({ disposition: "INTEGRATION_INELIGIBLE", configStatus: "DISABLED" }));
    const t = start(handoff);
    genericError(await post(t, P1_REQUEST()), 422, "UNPROCESSABLE_PAYLOAD");
    assert.equal(ingested.length, 0);
  });
});

describe("HT-10b: L2 exhausted with a P1 payload", () => {
  it("(a) precheck path: 429 before verification; the handoff is never called; no L2 consumed", async () => {
    const { handoff } = durable(async () => ({ disposition: "NEW", eventId: "e" }));
    const t = start(handoff);
    const peer = t.limiter.peerKey("127.0.0.1");
    for (let i = 0; i < DEFAULT_RATE_LIMIT_POLICIES.L2.bucket.capacity; i += 1) {
      assert.equal(t.limiter.consumeRejectionAllowance(peer).allowed, true, `L2 setup consume ${i}`);
    }
    delta(t);
    const response = await post(t, P1_REQUEST());
    genericError(response, 429, "TOO_MANY_REQUESTS");
    assert.match(String(response.headers["retry-after"]), /^[1-9][0-9]*$/);
    assert.equal(response.headers.connection, "close");
    assert.equal(handoff.requests.length, 0);
    assert.equal(t.spy.calls.consumeRejectionAllowance, 0);
    assert.equal(delta(t).layers.L2.individualRejections, 0);
  });

  it("(b) gate path: the 422 is converted to 429; no individual rejection; ingestEvent never called", async () => {
    const { handoff, ingested } = durable(async () => ({ disposition: "NEW", eventId: "e" }));
    const t = start(handoff, { stubPeek: true, deny: true });
    delta(t);
    const response = await post(t, P1_REQUEST());
    genericError(response, 429, "TOO_MANY_REQUESTS");
    assert.equal(response.headers["retry-after"], "30");
    assert.equal(response.headers.connection, "close");
    assert.equal(ingested.length, 0);
    assert.equal(t.spy.calls.consumeRejectionAllowance, 1);
    assert.equal(delta(t).layers.L2.individualRejections, 0);
  });
});

describe("HT-5 / HT-6: requests that never reach ingestion, and outcomes that never consume L2", () => {
  it("HT-5: a verifier rejection or a pre-body 404 never calls the handoff (no ingestion-path query)", async () => {
    const { handoff, ingested } = durable(async () => ({ disposition: "NEW", eventId: "e" }));
    const t = start(handoff);
    const bad = validRequest();
    await post(t, { body: bad.body, headers: { ...bad.headers, "irs-signature": `t=1760000000,v1=${"0".repeat(64)}` } });
    await post(t, validRequest(), `/api/webhooks/${UNCONFIGURED_ID}`);
    await post(t, validRequest(), "/api/webhooks/not-a-uuid");
    assert.equal(handoff.requests.length, 0);
    assert.equal(ingested.length, 0);
  });

  it("HT-6: 202, 503 and 500 from ingestion consume no L2 allowance and record no individual rejection", async () => {
    const cases: [number, () => Promise<EventIngestionResult>][] = [
      [202, async () => ({ disposition: "NEW", eventId: "e" })],
      [202, async () => ({ disposition: "DUPLICATE", eventId: "e", contentMatches: false })],
      [503, () => Promise.reject(new Error("timeout exceeded when trying to connect"))],
      [500, () => Promise.reject(new TypeError("bug"))],
    ];
    for (const [status, result] of cases) {
      const { handoff } = durable(result);
      const t = start(handoff);
      delta(t);
      const response = await post(t, validRequest());
      assert.equal(response.statusCode, status);
      assert.equal(t.spy.calls.consumeRejectionAllowance, 0, `status ${status}`);
      assert.equal(delta(t).layers.L2.individualRejections, 0);
    }
  });
});

describe("C-G4-1 / HT-7: individualRejectionOf at the gate", () => {
  function exchange(destroyed = false) {
    const raw = Object.assign(new EventEmitter(), { destroyed, writableFinished: false });
    const reply = { raw, code: () => reply, header: () => reply, send: () => reply, hijack: () => reply, elapsedTime: 1 };
    const request = { id: "req-gate", raw: { socket: { remoteAddress: "127.0.0.1" } }, log: { info: () => undefined, warn: () => undefined } };
    return { request: request as unknown as FastifyRequest, reply: reply as unknown as FastifyReply };
  }

  it("equals the code when an allowance was consumed (422, ingestion 404); absent for 202, 503, 500 and 429", () => {
    const clock = new ManualClock();
    const gate = createResponseGate(createRateLimiter({ monotonicNow: clock.now, wallNow: clock.wall }).limiter);
    const rejected422 = exchange();
    gate.rejectWith(rejected422.request, rejected422.reply, "UNPROCESSABLE_PAYLOAD");
    assert.equal(gate.individualRejectionOf(rejected422.request), "UNPROCESSABLE_PAYLOAD");
    const rejected404 = exchange();
    gate.rejectWith(rejected404.request, rejected404.reply, "NOT_FOUND");
    assert.equal(gate.individualRejectionOf(rejected404.request), "NOT_FOUND");
    const accepted = exchange();
    gate.deliver(accepted.request, accepted.reply, 202);
    assert.equal(gate.individualRejectionOf(accepted.request), undefined, "HT-7: a 202 is never an individual rejection");
    for (const code of ["SERVICE_UNAVAILABLE", "INTERNAL_ERROR"] as const) {
      const x = exchange();
      gate.rejectWith(x.request, x.reply, code);
      assert.equal(gate.individualRejectionOf(x.request), undefined, code);
    }
    const limited = exchange();
    gate.send429(limited.request, limited.reply, { allowed: false, layer: "L1", retryAfterSeconds: 1, log: null });
    assert.equal(gate.individualRejectionOf(limited.request), undefined);
  });
});

describe("HT-12: response-attempt telemetry (B-4)", () => {
  function telemetry(logs: LogCapture) {
    return logs.records().filter((record) => record.msg === "response attempt");
  }

  it("one record per response attempt: request ID, event ID when known, disposition, status attempted, timing, completion", async () => {
    const logs = new LogCapture();
    const { handoff } = durable(async () => ({ disposition: "NEW", eventId: "0190f3a2-0000-7000-8000-0000000000e9" }));
    const t = start(handoff, { logs });
    const accepted = await post(t, validRequest());
    const rejected = await post(t, P1_REQUEST());
    const records = telemetry(logs);
    assert.equal(records.length, 2);
    const [first, second] = records;
    assert.equal(first?.requestId, body(accepted).requestId);
    assert.equal(first?.eventId, "0190f3a2-0000-7000-8000-0000000000e9");
    assert.equal(first?.disposition, "ACCEPTED");
    assert.equal(first?.statusAttempted, 202);
    assert.equal(first?.completion, "FINISH_OBSERVED");
    assert.equal(typeof first?.responseTimeMs, "number");
    assert.equal(second?.requestId, body(rejected).requestId);
    assert.equal("eventId" in (second ?? {}), false);
    assert.equal(second?.disposition, "UNPROCESSABLE_PAYLOAD");
    assert.equal(second?.statusAttempted, 422);
  });

  it("a throwing logger changes no response; sentinels never appear; nothing claims the sender received it", async () => {
    const logs = new LogCapture("response attempt");
    const { handoff } = durable(async () => ({ disposition: "NEW", eventId: "e" }));
    const t = start(handoff, { logs });
    const response = await post(t, validRequest(envelopeJson({ payload: { note: BODY_MARKER } })));
    assert.equal(response.statusCode, 202);
    assert.match(String(body(response).requestId), UUID_V4);
    assert.equal(telemetry(logs).length, 0, "the telemetry write threw and was swallowed");
    const quiet = new LogCapture();
    const second = start(durable(async () => ({ disposition: "NEW", eventId: "e" })).handoff, { logs: quiet });
    const request = validRequest(envelopeJson({ payload: { note: BODY_MARKER } }));
    await post(second, request);
    const text = JSON.stringify(telemetry(quiet));
    for (const sentinel of [SECRET_TEXT, BODY_MARKER, request.headers["irs-signature"] ?? "x"]) {
      assert.equal(text.includes(sentinel), false, sentinel);
    }
    assert.doesNotMatch(text, /receiv|deliver/i);
  });

  it("completion is CLOSED_BEFORE_FINISH or DELIVERY_ERROR when the connection says so; a destroyed reply gets no record", () => {
    const clock = new ManualClock();
    const gate = createResponseGate(createRateLimiter({ monotonicNow: clock.now, wallNow: clock.wall }).limiter);
    const seen: Record<string, unknown>[] = [];
    function exchange(destroyed: boolean) {
      const raw = Object.assign(new EventEmitter(), { destroyed, writableFinished: false });
      const reply = { raw, code: () => reply, header: () => reply, send: () => reply, hijack: () => reply, elapsedTime: 3 };
      const request = {
        id: `req-${seen.length}`,
        raw: { socket: { remoteAddress: "127.0.0.1" } },
        log: { info: (object: Record<string, unknown>) => void seen.push(object), warn: () => undefined },
      };
      return { raw, request: request as unknown as FastifyRequest, reply: reply as unknown as FastifyReply };
    }
    const closed = exchange(false);
    gate.deliver(closed.request, closed.reply, 202);
    closed.raw.emit("close");
    const errored = exchange(false);
    gate.rejectWith(errored.request, errored.reply, "SERVICE_UNAVAILABLE");
    errored.raw.emit("error", new Error("socket error"));
    errored.raw.emit("close");
    const destroyed = exchange(true);
    gate.deliver(destroyed.request, destroyed.reply, 202);
    assert.deepEqual(seen.map((record) => record.completion), ["CLOSED_BEFORE_FINISH", "DELIVERY_ERROR"]);
  });
});

describe("SEC-1 (request level): sentinels never leak on ingestion paths", () => {
  it("database errors whose messages carry connection details produce generic bodies and name/code-only logs", async () => {
    const leaky = (code?: string) =>
      Object.assign(new Error(`connect to postgresql://irs:${DATABASE_PASSWORD}@db.internal:5432/irs?sslmode=disable failed`), {
        name: "DriverAdapterError",
        cause: code === undefined ? { kind: "DatabaseNotReachable" } : { originalCode: code, kind: "postgres" },
      });
    for (const [error, status] of [
      [leaky(), 503],
      [leaky("23503"), 500],
    ] as const) {
      const logs = new LogCapture();
      const { handoff } = durable(() => Promise.reject(error));
      const t = start(handoff, { logs });
      const request = validRequest(envelopeJson({ payload: { note: BODY_MARKER } }));
      const response = await post(t, request);
      assert.equal(response.statusCode, status);
      for (const text of [response.body, logs.text()]) {
        for (const sentinel of [DATABASE_PASSWORD, "sslmode", "db.internal", SECRET_TEXT, BODY_MARKER, request.headers["irs-signature"] ?? "x"]) {
          assert.equal(text.includes(sentinel), false, `${status}: ${sentinel}`);
        }
      }
    }
  });

  it("the signed request bytes and the secret never reach the 422/404 bodies or logs", async () => {
    for (const result of [async () => ({ disposition: "INTEGRATION_INELIGIBLE" as const, configStatus: "DISABLED" as const })]) {
      const logs = new LogCapture();
      const t = start(durable(result).handoff, { logs });
      const p1 = P1_REQUEST();
      const responses = [await post(t, p1), await post(t, validRequest(envelopeJson({ payload: { note: BODY_MARKER } })))];
      for (const text of [...responses.map((r) => r.body), logs.text()]) {
        assert.equal(text.includes(BODY_MARKER), false);
        assert.equal(text.includes(SECRET_TEXT), false);
        assert.equal(text.includes(p1.headers["irs-signature"] ?? "x"), false);
      }
      assert.deepEqual(responses.map((r) => r.statusCode), [422, 404]);
    }
  });
});
