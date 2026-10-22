import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { VerifyIrsV1WebhookResult } from "@irs/integrations";
import { createInMemoryEvidenceStore } from "./evidence-store.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createRateLimiter } from "./rate-limit.js";
import type { Denial, RateLimiter } from "./rate-limit.js";
import { DEFAULT_AUDIT_POLICIES, createRejectionAuditRecorder } from "./rejection-audit.js";
import type { RejectionCandidate } from "./rejection-audit.js";
import { closeWithGrace, createResponseGate, stageForErrorHandler } from "./server.js";
import {
  INTEGRATION_ID,
  LogCapture,
  NOW,
  RecordingHandoff,
  RecordingSink,
  assertNoUnmappedLog,
  envelopeJson,
  listen,
  makeApp,
  parseJson,
  rawExchange,
  settleTurns,
  sign,
  spyLimiter,
  validRequest,
} from "./test-helpers.js";
import type { TestApp } from "./test-helpers.js";

// Task 011A server integration (Stage 6): A-T6 (with the AN4 E6/E7
// stages), A-T7, A-T8, A-T15, the RD-15 mapping test with its designated
// synthetic test, and the B-4 TCP coverage (test-owned loopback listener).
//
// Unmapped-log accounting (R5 Stage 6 step 3): every test's log capture is
// checked for REJECTION_STAGE_UNMAPPED; only the designated synthetic RD-15
// test may produce one (and must produce exactly one).

const PATH = `/api/webhooks/${INTEGRATION_ID}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const captures: LogCapture[] = [];
const servers: FastifyInstance[] = [];
let designatedUnmapped = false;

afterEach(async () => {
  for (const app of servers.splice(0)) await closeWithGrace(app, 500);
  const logs = captures.splice(0);
  if (designatedUnmapped) {
    designatedUnmapped = false;
    return;
  }
  for (const capture of logs) assertNoUnmappedLog(capture);
});

/** A fresh app per case (P-1 L2 lesson), with a recording sink and a log capture. */
function app(options: Parameters<typeof makeApp>[0] = {}): TestApp & { sink: RecordingSink } {
  const sink = (options.rejectionAudit as RecordingSink | undefined) ?? new RecordingSink();
  const logs = options.logs ?? new LogCapture();
  captures.push(logs);
  const t = makeApp({ ...options, rejectionAudit: sink, logs });
  servers.push(t.app);
  return { ...t, sink };
}

function post(t: TestApp, request: { body: Buffer | string; headers: Record<string, string | string[]> }, url = PATH) {
  return t.app.inject({ method: "POST", url, headers: request.headers, payload: request.body });
}

function body(text: string): { error: string; requestId: string } {
  return parseJson(text) as { error: string; requestId: string };
}

/** The allowlisted candidate shape (§5.2). */
function assertCandidate(
  candidate: RejectionCandidate | undefined,
  expected: Partial<RejectionCandidate>,
  requestId: string,
): void {
  assert.ok(candidate !== undefined, "a candidate was submitted");
  assert.deepEqual(Object.keys(candidate).sort(), [
    "claimedIntegrationId",
    "errorCode",
    "httpStatus",
    "receivedAt",
    "requestId",
    "responseCompletion",
    "stage",
    "verifierReason",
  ]);
  assert.equal(candidate.requestId, requestId);
  assert.equal(candidate.receivedAt, NOW.toISOString());
  assert.equal(candidate.responseCompletion, "FINISH_OBSERVED");
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(candidate[key as keyof RejectionCandidate], value, key);
  }
}

const verifierRejection = (reason: string) =>
  (() => ({ ok: false, rejection: { reason } }) as unknown as VerifyIrsV1WebhookResult) as never;

describe("A-T6: one candidate per eligible webhook-route rejection, with allowlisted fields", () => {
  it("ROUTE_GUARD: 404 malformed id (claimed id null), 400 duplicate framing header, 401 missing signature, 415 content type, 404 unknown secret", async () => {
    const valid = validRequest();
    const cases: readonly (readonly [string, number, string, () => { body: Buffer | string; headers: Record<string, string | string[]> }, string, string | null])[] = [
      ["malformed id", 404, "NOT_FOUND", () => valid, "/api/webhooks/not-a-uuid", null],
      ["duplicate Transfer-Encoding", 400, "BAD_REQUEST", () => ({ body: "{}", headers: { ...valid.headers, "transfer-encoding": ["chunked", "chunked"] } }), PATH, INTEGRATION_ID],
      ["missing IRS-Signature", 401, "UNAUTHORIZED", () => ({ body: valid.body, headers: { "content-type": "application/json" } }), PATH, INTEGRATION_ID],
      ["unsupported content type", 415, "UNSUPPORTED_MEDIA_TYPE", () => ({ body: valid.body, headers: { ...valid.headers, "content-type": "text/plain" } }), PATH, INTEGRATION_ID],
      ["no secret for the id", 404, "NOT_FOUND", () => valid, `/api/webhooks/${randomUUID()}`, "*"],
    ];
    for (const [label, status, code, request, url, claimed] of cases) {
      const t = app();
      const response = await post(t, request(), url);
      assert.equal(response.statusCode, status, label);
      await settleTurns(2);
      assert.equal(t.sink.candidates.length, 1, label);
      const candidate = t.sink.candidates[0];
      assertCandidate(candidate, { stage: "ROUTE_GUARD", httpStatus: status as RejectionCandidate["httpStatus"], errorCode: code as RejectionCandidate["errorCode"], verifierReason: null }, body(response.body).requestId);
      if (claimed === "*") assert.equal(candidate?.claimedIntegrationId, url.split("/").at(-1), label);
      else assert.equal(candidate?.claimedIntegrationId, claimed, label);
    }
  });

  it("BODY: 413 over the body limit and 400 Content-Length mismatch (setErrorHandler, RD-15)", async () => {
    const huge = Buffer.alloc(1_048_577, 0x20);
    for (const [label, request, status] of [
      ["413", { body: huge, headers: { "content-type": "application/json", "irs-signature": sign(huge) } }, 413],
      ["400 length mismatch", { body: "{}", headers: { "content-type": "application/json", "irs-signature": sign(Buffer.from("{}")), "content-length": "5" } }, 400],
    ] as const) {
      const t = app();
      const response = await post(t, request);
      assert.equal(response.statusCode, status, label);
      await settleTurns(2);
      assertCandidate(t.sink.candidates[0], { stage: "BODY", httpStatus: status, claimedIntegrationId: INTEGRATION_ID }, body(response.body).requestId);
    }
  });

  it("VERIFIER: 401 (bad signature), 400 (malformed payload), 413 (verifier override) with the fixed rejection reason", async () => {
    const valid = validRequest();
    const cases = [
      ["bad signature", { body: valid.body, headers: { ...valid.headers, "irs-signature": sign(Buffer.from("other")) } }, undefined, 401, "SIGNATURE_MISMATCH"],
      ["malformed payload", { body: "not json", headers: { "content-type": "application/json", "irs-signature": sign(Buffer.from("not json")) } }, undefined, 400, "MALFORMED_PAYLOAD"],
      ["verifier BODY_TOO_LARGE", valid, verifierRejection("BODY_TOO_LARGE"), 413, "BODY_TOO_LARGE"],
    ] as const;
    for (const [label, request, verifyWebhook, status, reason] of cases) {
      const t = app(verifyWebhook === undefined ? {} : { verifyWebhook });
      const response = await post(t, request);
      assert.equal(response.statusCode, status, label);
      await settleTurns(2);
      assertCandidate(t.sink.candidates[0], { stage: "VERIFIER", httpStatus: status, verifierReason: reason, claimedIntegrationId: INTEGRATION_ID }, body(response.body).requestId);
    }
  });

  it("INGESTION_PAYLOAD 422 and INGESTION_INTEGRATION 404 (AN4 E6, E7)", async () => {
    for (const [status, outcome, stage] of [
      [422, "UNPROCESSABLE_PAYLOAD", "INGESTION_PAYLOAD"],
      [404, "INTEGRATION_INELIGIBLE", "INGESTION_INTEGRATION"],
    ] as const) {
      const t = app({ handoff: new RecordingHandoff(() => Promise.resolve({ status: outcome } as never)) });
      const response = await post(t, validRequest());
      assert.equal(response.statusCode, status);
      await settleTurns(2);
      assertCandidate(t.sink.candidates[0], { stage, httpStatus: status, verifierReason: null, claimedIntegrationId: INTEGRATION_ID }, body(response.body).requestId);
    }
  });

  it("HANDLER 400 is not reachable by HTTP (an empty body reaches the verifier); the gate seam with the server's context yields the candidate", async () => {
    const t = app();
    const empty = await post(t, { body: "", headers: { "content-type": "application/json", "irs-signature": sign(Buffer.from("")) } });
    assert.equal(empty.statusCode, 400);
    await settleTurns(2);
    assert.equal(t.sink.candidates[0]?.stage, "VERIFIER", "reachability recorded: the handler precondition is not reached");
    const { gate, sink, request, reply } = gateSeam();
    gate.noteReceivedAt(request, NOW);
    gate.noteClaimedIntegrationId(request, INTEGRATION_ID);
    gate.rejectWith(request, reply, "BAD_REQUEST", undefined, { stage: "HANDLER" });
    reply.raw.emit("finish");
    assertCandidate(sink.candidates[0], { stage: "HANDLER", httpStatus: 400, errorCode: "BAD_REQUEST", claimedIntegrationId: INTEGRATION_ID }, request.id);
  });

  it("no candidate for L1, L2 precheck, L2 converted and L3 429s, 202, 500 or 503", async () => {
    const valid = validRequest();
    const deny = (layer: "L1" | "L2" | "L3"): Denial => ({ allowed: false, layer, retryAfterSeconds: 1, log: null });
    const cases: readonly (readonly [string, Parameters<typeof makeApp>[0], number])[] = [
      ["L1 429", { rateLimit: { wrap: (inner) => spyLimiter(inner, { consumeRequest: () => deny("L1") }).limiter } }, 429],
      ["L2 precheck 429", { rateLimit: { wrap: (inner) => spyLimiter(inner, { peekRejectionAllowance: () => ({ allowed: false, retryAfterSeconds: 1, bucket: "EXISTING" }) }).limiter } }, 429],
      ["L3 429", { rateLimit: { wrap: (inner) => spyLimiter(inner, { consumeVerified: () => deny("L3") }).limiter } }, 429],
      ["202", {}, 202],
      ["500", { handoff: new RecordingHandoff(() => Promise.reject(new Error("boom"))) }, 500],
      ["503", { handoff: new RecordingHandoff(() => Promise.resolve({ status: "UNAVAILABLE" } as never)) }, 503],
    ];
    for (const [label, options, status] of cases) {
      const t = app(options);
      const response = await post(t, valid);
      assert.equal(response.statusCode, status, label);
      await settleTurns(2);
      assert.equal(t.sink.candidates.length, 0, label);
    }
    // L2 converted: a granted precheck, then a denied rejection allowance at rejectWith.
    const converted = app({ rateLimit: { wrap: (inner) => spyLimiter(inner, { consumeRejectionAllowance: () => deny("L2") }).limiter } });
    const response = await post(converted, { body: valid.body, headers: { ...valid.headers, "irs-signature": sign(Buffer.from("x")) } });
    assert.equal(response.statusCode, 429);
    await settleTurns(2);
    assert.equal(converted.sink.candidates.length, 0);
  });

  it("NOT_FOUND (an unknown route) yields a candidate that the recorder counts ineligibleNonWebhook, with no AuditEntry", async () => {
    const store = createInMemoryEvidenceStore();
    const recorder = createRejectionAuditRecorder({ store, limiterInstanceId: randomUUID() });
    recorder.control.start();
    const logs = new LogCapture();
    captures.push(logs);
    const t = makeApp({ rejectionAudit: recorder.sink, logs });
    servers.push(t.app);
    const response = await t.app.inject({ method: "GET", url: "/nowhere" });
    assert.equal(response.statusCode, 404);
    await settleTurns(2);
    const counters = recorder.control.cumulative();
    assert.deepEqual([counters.submitted, counters.ineligibleNonWebhook, counters.admitted], [1, 1, 0]);
    assert.equal(store.raw.rejectionRows().length, 0);
  });
});

describe("B-4 over real TCP (a test-owned loopback listener): ROUTER and DEV-2", () => {
  it("ROUTER (frameworkErrors): a malformed request target → a ROUTER candidate, counted ineligible", async () => {
    const t = app();
    const port = await listen(t.app);
    const response = await rawExchange(port, [["POST /api/webhooks/%zz HTTP/1.1", "Host: 127.0.0.1", "Connection: close", "Content-Length: 0", "", ""].join("\r\n")], { waitMs: 2_000 });
    assert.equal(response.status, 400);
    await settleTurns();
    assert.equal(t.sink.candidates.length, 1);
    assert.equal(t.sink.candidates[0]?.stage, "ROUTER");
    assert.equal(t.sink.candidates[0]?.claimedIntegrationId, null);
    assert.equal(t.sink.candidates[0]?.receivedAt, NOW.toISOString());
  });

  it("DEV-2: the response-deadline 503 yields no candidate and exactly one response", { timeout: 20_000 }, async () => {
    const t = app({
      server: { requestTimeoutMs: 1_000, headersTimeoutMs: 1_000 },
      handoff: new RecordingHandoff(() => new Promise(() => undefined)),
    });
    const port = await listen(t.app);
    const request = validRequest();
    const head = [
      `POST ${PATH} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Connection: close",
      "Content-Type: application/json",
      `IRS-Signature: ${request.headers["irs-signature"]}`,
      `Content-Length: ${request.body.byteLength}`,
      "",
      "",
    ].join("\r\n");
    const response = await rawExchange(port, [Buffer.concat([Buffer.from(head, "latin1"), request.body])], { waitMs: 10_000 });
    assert.equal(response.status, 503);
    assert.equal((response.raw.match(/HTTP\/1\.1 /g) ?? []).length, 1, "exactly one response");
    await settleTurns();
    assert.equal(t.sink.candidates.length, 0);
  });
});

/** A gate on a fake request and reply (unit seam): reply.raw is an EventEmitter we drive. */
function gateSeam(options: { destroyed?: boolean; sink?: RecordingSink } = {}) {
  const sink = options.sink ?? new RecordingSink();
  const limiter: RateLimiter = createRateLimiter().limiter;
  const gate = createResponseGate(limiter, sink, { now: () => NOW });
  const raw = Object.assign(new EventEmitter(), { destroyed: options.destroyed === true });
  const reply = {
    raw,
    elapsedTime: 0,
    sent: false,
    header() {
      return reply;
    },
    code() {
      return reply;
    },
    send() {
      return reply;
    },
    hijack() {
      return reply;
    },
  } as unknown as FastifyReply & { raw: EventEmitter };
  const request = {
    id: randomUUID(),
    raw: { socket: { remoteAddress: "127.0.0.1" } },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as unknown as FastifyRequest;
  return { gate, sink, request, reply };
}

describe("A-T7: response completion", () => {
  it("submitted only after 'finish'; 'close' first → CLOSE_BEFORE_FINISH; both events → one submission", () => {
    for (const [events, expected] of [
      [["finish", "close"], "FINISH_OBSERVED"],
      [["close", "finish"], "CLOSE_BEFORE_FINISH"],
      [["close"], "CLOSE_BEFORE_FINISH"],
    ] as const) {
      const { gate, sink, request, reply } = gateSeam();
      gate.rejectWith(request, reply, "UNAUTHORIZED", undefined, { stage: "VERIFIER", verifierReason: "SIGNATURE_MISMATCH" });
      assert.equal(sink.candidates.length, 0, "nothing before a settlement event");
      for (const event of events) reply.raw.emit(event);
      assert.equal(sink.candidates.length, 1, events.join(","));
      assert.equal(sink.candidates[0]?.responseCompletion, expected);
    }
  });

  it("a reply destroyed before the grant yields no candidate (unit) and no candidate over TCP (aborted body)", async () => {
    const { gate, sink, request, reply } = gateSeam({ destroyed: true });
    gate.rejectWith(request, reply, "UNAUTHORIZED", undefined, { stage: "VERIFIER" });
    reply.raw.emit("close");
    assert.equal(sink.candidates.length, 0);
    const t = app();
    const port = await listen(t.app);
    const request2 = validRequest();
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      [
        `POST ${PATH} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Content-Type: application/json",
        `IRS-Signature: ${request2.headers["irs-signature"]}`,
        "Content-Length: 1000",
        "",
        "{",
      ].join("\r\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(t.sink.candidates.length, 0);
  });

  it("finishObserved + closeBeforeFinish = submitted (the recorder over a run of rejections)", async () => {
    const store = createInMemoryEvidenceStore();
    const recorder = createRejectionAuditRecorder({ store, limiterInstanceId: randomUUID() });
    const logs = new LogCapture();
    captures.push(logs);
    const t = makeApp({ rejectionAudit: recorder.sink, logs, rateLimit: { policies: { L2: { ...DEFAULT_L2, bucket: { capacity: 100, refillPerSecond: 1 } } } } });
    servers.push(t.app);
    for (let n = 0; n < 5; n += 1) await post(t, { body: "x", headers: { "content-type": "application/json", "irs-signature": sign(Buffer.from("y")) } });
    await settleTurns(2);
    const counters = recorder.control.cumulative();
    assert.equal(counters.submitted, 5);
    assert.equal(counters.finishObserved + counters.closeBeforeFinish, counters.submitted);
  });
});

const DEFAULT_L2 = createRateLimiterDefaults();
function createRateLimiterDefaults() {
  return { bucket: { capacity: 20, refillPerSecond: 1 / 30 }, overflow: { capacity: 20, refillPerSecond: 1 / 30 }, maxKeys: 10_000 };
}

describe("A-T8: isolation of the response path", () => {
  it("a throwing sink, a hanging store and a throwing store leave status, headers, body (except requestId) and limiter deltas identical to no auditing", async () => {
    const hanging: EvidenceStore = { ...createInMemoryEvidenceStore(), writeRejections: () => new Promise(() => undefined) };
    const throwing: EvidenceStore = { ...createInMemoryEvidenceStore(), writeRejections: () => Promise.reject(new Error("store down")) };
    const sinks = {
      none: undefined,
      throwingSink: new RecordingSink(true),
      hangingStore: startedSink(hanging),
      throwingStore: startedSink(throwing),
    } as const;
    const valid = validRequest();
    const requests = [
      { body: valid.body, headers: { ...valid.headers, "irs-signature": sign(Buffer.from("bad")) } },
      { body: valid.body, headers: { "content-type": "application/json" } },
      valid,
      { body: "not json", headers: { "content-type": "application/json", "irs-signature": sign(Buffer.from("not json")) } },
    ];
    const observed: Record<string, unknown[]> = {};
    for (const [name, sink] of Object.entries(sinks)) {
      const logs = new LogCapture();
      captures.push(logs);
      const t = makeApp({ logs, rateLimit: {}, ...(sink === undefined ? {} : { rejectionAudit: sink }) });
      servers.push(t.app);
      const results: unknown[] = [];
      for (const request of requests) {
        const response = await post(t, request);
        const { requestId: _ignored, ...rest } = body(response.body) as { requestId: string } & Record<string, unknown>;
        results.push({ status: response.statusCode, headers: response.headers, body: rest });
      }
      await settleTurns(2);
      results.push(t.evidence?.drain().delta);
      observed[name] = results;
    }
    for (const name of ["throwingSink", "hangingStore", "throwingStore"]) {
      assert.deepEqual(observed[name], observed.none, name);
    }
  });
});

function startedSink(store: EvidenceStore) {
  const recorder = createRejectionAuditRecorder({ store, limiterInstanceId: randomUUID(), policies: DEFAULT_AUDIT_POLICIES });
  recorder.control.start();
  return recorder.sink;
}

describe("A-T15: no request data in any record or Task 011A log line", () => {
  it("sentinels in the body, signature, Authorization, cookie, query, path parameter and peer address never appear", async () => {
    const sentinels = ["S1-BODY-7e2a", "S2-SIG-91c4", "S3-AUTH-55d0", "S4-COOKIE-a1b2", "S5-QUERY-c3d4", "S6-PATH-e5f6", "203.0.113.77"];
    const store = createInMemoryEvidenceStore();
    const recorder = createRejectionAuditRecorder({ store, limiterInstanceId: randomUUID() });
    recorder.control.start();
    const logs = new LogCapture();
    captures.push(logs);
    const sink = new RecordingSink();
    const both = { submit: (candidate: RejectionCandidate) => { sink.submit(candidate); recorder.sink.submit(candidate); } };
    const t = makeApp({ rejectionAudit: both, logs });
    servers.push(t.app);
    const payload = envelopeJson({ externalEventId: "S1-BODY-7e2a" });
    for (const url of [`${PATH}?q=S5-QUERY-c3d4`, "/api/webhooks/S6-PATH-e5f6"]) {
      await t.app.inject({
        method: "POST",
        url,
        remoteAddress: "203.0.113.77",
        headers: {
          "content-type": "application/json",
          "irs-signature": "t=1760000000,v1=S2-SIG-91c4",
          authorization: "Bearer S3-AUTH-55d0",
          cookie: "session=S4-COOKIE-a1b2",
        },
        payload,
      });
    }
    await settleTurns(2);
    assert.equal(sink.candidates.length, 2);
    const records = JSON.stringify([sink.candidates, store.raw.rejectionRows()]);
    const elevenA = logs.records().filter((record) => typeof record.event === "string").map((record) => JSON.stringify(record)).join("\n");
    for (const sentinel of sentinels) {
      assert.ok(!records.includes(sentinel), `records: ${sentinel}`);
      assert.ok(!elevenA.includes(sentinel), `011A log lines: ${sentinel}`);
    }
    for (const candidate of sink.candidates) assert.ok(candidate.claimedIntegrationId === null || UUID.test(candidate.claimedIntegrationId));
  });
});

describe("RD-15: setErrorHandler rejections, by route, then code", () => {
  it("the mapping table", () => {
    assert.deepEqual(stageForErrorHandler(undefined, "FST_ERR_CTP_BODY_TOO_LARGE"), { stage: "NOT_FOUND" });
    assert.deepEqual(stageForErrorHandler("/other", null), { stage: "NOT_FOUND" });
    assert.deepEqual(stageForErrorHandler("/api/webhooks/:integrationKey", "FST_ERR_CTP_BODY_TOO_LARGE"), { stage: "BODY" });
    assert.deepEqual(stageForErrorHandler("/api/webhooks/:integrationKey", "FST_ERR_CTP_INVALID_CONTENT_LENGTH"), { stage: "BODY" });
    assert.deepEqual(stageForErrorHandler("/api/webhooks/:integrationKey", "FST_ERR_ANY_OTHER"), { stage: "HANDLER", unmappedCode: "FST_ERR_ANY_OTHER" });
    assert.deepEqual(stageForErrorHandler("/api/webhooks/:integrationKey", null), { stage: "HANDLER", unmappedCode: null });
  });

  it("side effects per row: BODY → candidate, admitted, a record, no log; not routed → counted only, no record, no log; destroyed → nothing", async () => {
    const store = createInMemoryEvidenceStore();
    const recorder = createRejectionAuditRecorder({ store, limiterInstanceId: randomUUID() });
    recorder.control.start();
    const logs = new LogCapture();
    captures.push(logs);
    const t = makeApp({ rejectionAudit: recorder.sink, logs });
    servers.push(t.app);
    const huge = Buffer.alloc(1_048_577, 0x20);
    const big = await post(t, { body: huge, headers: { "content-type": "application/json", "irs-signature": sign(huge) } });
    assert.equal(big.statusCode, 413);
    await t.app.inject({ method: "GET", url: "/nowhere" });
    await settleTurns(2);
    const counters = recorder.control.cumulative();
    assert.deepEqual([counters.submitted, counters.admitted, counters.ineligibleNonWebhook, counters.persisted], [2, 1, 1, 1]);
    assert.equal(store.raw.rejectionRows().length, 1);
    assert.equal(store.raw.rejectionRows()[0]?.id, body(big.body).requestId);
    assert.equal(logs.count("REJECTION_STAGE_UNMAPPED"), 0);
  });

  it("DESIGNATED SYNTHETIC TEST: an unmapped code on the webhook route → HANDLER, one candidate, a record, exactly one log carrying only the code", async () => {
    designatedUnmapped = true;
    const store = createInMemoryEvidenceStore();
    const recorder = createRejectionAuditRecorder({ store, limiterInstanceId: randomUUID() });
    recorder.control.start();
    const sink = new RecordingSink();
    const logs = new LogCapture();
    captures.push(logs);
    const t = makeApp({
      rejectionAudit: { submit: (candidate) => { sink.submit(candidate); recorder.sink.submit(candidate); } },
      logs,
      verifyWebhook: (() => {
        throw Object.assign(new Error("synthetic"), { statusCode: 400, code: "FST_ERR_IRS_SYNTHETIC_UNMAPPED" });
      }) as never,
    });
    servers.push(t.app);
    const response = await post(t, validRequest());
    assert.equal(response.statusCode, 400);
    await settleTurns(2);
    assert.equal(sink.candidates.length, 1);
    assertCandidate(sink.candidates[0], { stage: "HANDLER", httpStatus: 400, errorCode: "BAD_REQUEST", claimedIntegrationId: INTEGRATION_ID, verifierReason: null }, body(response.body).requestId);
    assert.equal(recorder.control.cumulative().persisted, 1);
    assert.equal(logs.count("REJECTION_STAGE_UNMAPPED"), 1);
    const record = logs.records().find((entry) => entry.msg === "REJECTION_STAGE_UNMAPPED") as Record<string, unknown>;
    assert.equal(record.fastifyCode, "FST_ERR_IRS_SYNTHETIC_UNMAPPED");
    assert.equal(record.event, "REJECTION_STAGE_UNMAPPED");
    assert.equal("reqId" in record, false, "no request bindings");
    const extra = Object.keys(record).filter((key) => !["level", "time", "pid", "hostname", "msg", "service"].includes(key));
    assert.deepEqual(extra.sort(), ["event", "fastifyCode"]);
  });
});
