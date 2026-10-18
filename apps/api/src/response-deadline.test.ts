import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { disconnectWithin } from "@irs/db";
import type { Database } from "@irs/db";
import { verifyIrsV1Webhook } from "@irs/integrations";
import type { IngestionOutcome } from "./handoff.js";
import type { Counters } from "./rate-limit.js";
import { closeWithGrace, raceResponseDeadline } from "./server.js";
import {
  LogCapture,
  RecordingHandoff,
  WEBHOOK_PATH,
  listen,
  makeApp,
  parseJson,
  rawExchange,
  spyLimiter,
  validRequest,
} from "./test-helpers.js";
import type { LimiterSpy, TestApp } from "./test-helpers.js";

// Task 011 DEV-2 (B-6, FD-12): the response deadline, database-free.
// DL-1 – DL-13 of Proposal Revision 2 §4. Real timers; the budget is
// requestTimeoutMs + 5 s, so most cases take a little over 5 s and run
// concurrently. Timing bounds are targets under a responsive event loop
// (§2.1), stated here before running; a miss is a failure, never retried.
// Cases that must show the deadline itself answering use real TCP: under
// inject() the request never emits `close`, so Fastify's handlerTimeout
// stays armed and either timer may send the (single, gated) 503.

const MARGIN_MS = 5_000;
const TOLERANCE_MS = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const open: FastifyInstance[] = [];
after(async () => {
  for (const app of open) await app.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Blocks the event loop synchronously (DL-9, DL-12 only). */
function blockEventLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // busy wait
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) assert.fail("condition not reached");
    await sleep(10);
  }
}

interface DeadlineApp extends TestApp {
  readonly spy: LimiterSpy;
  readonly budget: number;
  delta(): Counters;
  records(msg: string): Array<Record<string, unknown>>;
}

function start(
  respond: () => Promise<IngestionOutcome>,
  options: { requestTimeoutMs?: number; verifyWebhook?: typeof verifyIrsV1Webhook; keepOpen?: boolean } = {},
): DeadlineApp {
  const requestTimeoutMs = options.requestTimeoutMs ?? 100;
  let spy: LimiterSpy | undefined;
  const t = makeApp({
    handoff: new RecordingHandoff(respond),
    logs: new LogCapture(),
    server: { requestTimeoutMs },
    ...(options.verifyWebhook === undefined ? {} : { verifyWebhook: options.verifyWebhook }),
    rateLimit: {
      wrap: (inner) => {
        spy = spyLimiter(inner);
        return spy.limiter;
      },
    },
  });
  if (options.keepOpen !== true) open.push(t.app);
  assert.ok(spy !== undefined && t.evidence !== undefined);
  const evidence = t.evidence;
  return {
    ...t,
    spy,
    budget: requestTimeoutMs + MARGIN_MS,
    delta: () => evidence.drain().delta,
    records: (msg) => t.logs.records().filter((record) => record.msg === msg),
  };
}

function post(t: TestApp) {
  const request = validRequest();
  return t.app.inject({ method: "POST", url: WEBHOOK_PATH, headers: request.headers, payload: request.body });
}

function rawHead(request: { body: Buffer; headers: Record<string, string> }): string {
  return [
    `POST ${WEBHOOK_PATH} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Connection: close",
    "Content-Type: application/json",
    `IRS-Signature: ${request.headers["irs-signature"]}`,
    `Content-Length: ${request.body.byteLength}`,
    "",
    "",
  ].join("\r\n");
}

function assertGeneric503(body: string): string {
  const parsed = parseJson(body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["error", "requestId"]);
  assert.equal(parsed.error, "SERVICE_UNAVAILABLE");
  assert.match(String(parsed.requestId), UUID);
  return String(parsed.requestId);
}

/** The single response-attempt record: status 503, timed within [budget, budget + tolerance] when `timed`. */
function assertOneDeadlineAttempt(t: DeadlineApp, requestId: string, timed = true): number {
  const attempts = t.records("response attempt");
  assert.equal(attempts.length, 1, "exactly one response attempt");
  assert.equal(attempts[0]?.requestId, requestId);
  assert.equal(attempts[0]?.statusAttempted, 503);
  const time = Number(attempts[0]?.responseTimeMs);
  process.stdout.write(`[deadline] budget ${t.budget} ms → responseTimeMs ${time}${timed ? "" : " (target not asserted)"}\n`);
  assert.ok(time >= t.budget, `never early: ${time} ms < ${t.budget} ms`);
  if (timed) assert.ok(time <= t.budget + TOLERANCE_MS, `target missed: ${time} ms > ${t.budget + TOLERANCE_MS} ms`);
  return time;
}

function assertDeadlineRecord(t: DeadlineApp, requestId: string, reason = "RESPONSE_DEADLINE", outcome = "UNKNOWN"): void {
  const records = t.records("ingestion response deadline reached");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.requestId, requestId);
  assert.equal(records[0]?.outcome, outcome);
  assert.equal(records[0]?.reason, reason);
}

function assertNoAlreadySent(t: DeadlineApp): void {
  assert.doesNotMatch(t.logs.text(), /FST_ERR_REP_ALREADY_SENT|already sent/i);
}

// ---------------------------------------------------------------------------

describe("DL-1 – DL-3: raceResponseDeadline (the decision rule)", () => {
  it("DL-1: an outcome observed in time is returned and the timer is cleared; a rejection is `threw`, never a rejection", async () => {
    const t0 = performance.now();
    let calls = 0;
    const remaining = (): number => {
      calls += 1;
      return 200 - (performance.now() - t0);
    };
    const decision = await raceResponseDeadline(sleep(20).then(() => "outcome-value"), remaining);
    assert.deepEqual(decision, { kind: "outcome", outcome: "outcome-value" });
    const callsAtDecision = calls;
    await sleep(300);
    assert.equal(calls, callsAtDecision, "the cleared timer never consults the clock again");

    const error = new TypeError("boom");
    const threw = await raceResponseDeadline(Promise.reject(error), () => 200);
    assert.deepEqual(threw, { kind: "threw", error });
  });

  it("DL-2: a timer that fires early re-arms; no deadline decision while the remaining budget is above zero", async () => {
    const readings = [50, 30, 0];
    let calls = 0;
    const t0 = performance.now();
    const decision = await raceResponseDeadline(new Promise(() => undefined), () => readings[Math.min(calls++, readings.length - 1)] ?? 0);
    assert.equal(decision.kind, "deadline");
    assert.equal(calls, 3, "initial reading, one early fire (re-armed), then the deadline");
    assert.ok(performance.now() - t0 >= 75, "the re-armed timer waited for the remainder");
  });

  it("DL-3: a late settlement arrives exactly once; a late rejection never becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = deferred<unknown>();
      const t0 = performance.now();
      const decision = await raceResponseDeadline(pending.promise, () => 30 - (performance.now() - t0));
      assert.equal(decision.kind, "deadline");
      assert.ok(decision.kind === "deadline");
      let lateCount = 0;
      const late = decision.late.then((settlement) => {
        lateCount += 1;
        return settlement;
      });
      pending.reject(new RangeError("late failure"));
      assert.equal((await late).kind, "threw");
      await sleep(50);
      assert.equal(lateCount, 1);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("DL-12 (unit): a settlement observed when no budget remains is the deadline, even before the timer has run", async () => {
    const readings = [100, 0];
    let calls = 0;
    const decision = await raceResponseDeadline(Promise.resolve({ status: "ACCEPTED" }), () => readings[Math.min(calls++, 1)] ?? 0);
    assert.equal(decision.kind, "deadline");
    assert.ok(decision.kind === "deadline");
    assert.deepEqual(await decision.late, { kind: "outcome", outcome: { status: "ACCEPTED" } });
  });
});

describe("DL-4 – DL-8, DL-10, DL-13: the deadline through buildServer", { concurrency: true }, () => {
  it("DL-4 (TCP): a stalled handoff → one generic 503 in [budget, budget + 250 ms] from the deadline, logged UNKNOWN; no L2 effect", async () => {
    // Over TCP the request emits `close` once its body is read, so Fastify's
    // handlerTimeout is cleared (the production condition) and only the
    // deadline can answer: its record is written before the response.
    const t = start(() => new Promise(() => undefined));
    const port = await listen(t.app);
    t.delta();
    const request = validRequest();
    const response = await rawExchange(port, [Buffer.concat([Buffer.from(rawHead(request), "latin1"), request.body])], { waitMs: 8_000 });
    assert.equal(response.status, 503);
    assert.equal((response.raw.match(/HTTP\/1\.[01] \d{3}/g) ?? []).length, 1);
    const requestId = assertGeneric503(response.body);
    assertOneDeadlineAttempt(t, requestId);
    assertDeadlineRecord(t, requestId);
    assert.equal(t.spy.calls.consumeRejectionAllowance, 0, "503 is not L2-eligible (individualRejectionOf stays absent)");
    assert.equal(t.delta().layers.L2.individualRejections, 0);
    assert.equal(t.records("late ingestion outcome").length, 0);
    assertNoAlreadySent(t);
  });

  const lateKinds: Array<{ name: string; settle: (d: ReturnType<typeof deferred<IngestionOutcome>>) => void; expected: Record<string, unknown> }> = [
    { name: "ACCEPTED", settle: (d) => d.resolve({ status: "ACCEPTED", eventId: "evt-late" }), expected: { late: "COMMITTED_AFTER_RESPONSE", eventId: "evt-late" } },
    { name: "UNAVAILABLE (TRANSIENT)", settle: (d) => d.resolve({ status: "UNAVAILABLE", classification: "TRANSIENT" }), expected: { late: "UNAVAILABLE_AFTER_RESPONSE", handoffClassification: "TRANSIENT" } },
    { name: "UNAVAILABLE (COMMIT_UNKNOWN)", settle: (d) => d.resolve({ status: "UNAVAILABLE", classification: "COMMIT_UNKNOWN" }), expected: { late: "UNAVAILABLE_AFTER_RESPONSE", handoffClassification: "COMMIT_UNKNOWN" } },
    { name: "UNAVAILABLE (no classification)", settle: (d) => d.resolve({ status: "UNAVAILABLE" }), expected: { late: "UNAVAILABLE_AFTER_RESPONSE", handoffClassification: "UNSPECIFIED" } },
    { name: "UNPROCESSABLE_PAYLOAD", settle: (d) => d.resolve({ status: "UNPROCESSABLE_PAYLOAD", condition: "P1_NUL_CHARACTER" }), expected: { late: "REJECTED_AFTER_RESPONSE" } },
    { name: "INTEGRATION_INELIGIBLE", settle: (d) => d.resolve({ status: "INTEGRATION_INELIGIBLE" }), expected: { late: "REJECTED_AFTER_RESPONSE" } },
    { name: "a rejection", settle: (d) => d.reject(new TypeError("late fault")), expected: { late: "UNKNOWN_AFTER_RESPONSE", errorName: "TypeError" } },
    { name: "an invalid outcome", settle: (d) => d.resolve({ status: "SOMETHING_ELSE" } as unknown as IngestionOutcome), expected: { late: "INVALID_OUTCOME" } },
  ];
  for (const kind of lateKinds) {
    it(`DL-5: late ${kind.name} → exactly one "${String(kind.expected.late)}" record; no second response`, async () => {
      const d = deferred<IngestionOutcome>();
      const t = start(() => d.promise);
      const response = await post(t);
      const requestId = assertGeneric503(response.body);
      kind.settle(d);
      await until(() => t.records("late ingestion outcome").length > 0);
      await sleep(50);
      const late = t.records("late ingestion outcome");
      assert.equal(late.length, 1, "logged once");
      const { requestId: lateRequestId, lateByMs, level: _level, time: _time, pid: _pid, hostname: _host, reqId: _reqId, msg: _msg, ...fields } = late[0] ?? {};
      assert.equal(lateRequestId, requestId);
      assert.equal(typeof lateByMs, "number");
      assert.deepEqual(fields, kind.expected);
      assertOneDeadlineAttempt(t, requestId, false);
      assert.equal(t.spy.calls.consumeRejectionAllowance, 0, "a late rejection consumes no L2 allowance");
      assertNoAlreadySent(t);
    });
  }

  it("DL-6: a settlement observed just before the deadline is the response (202); no deadline record", async () => {
    let budget = 0;
    const t = start(async () => {
      await sleep(budget - 400);
      return { status: "ACCEPTED", eventId: "evt-in-time" };
    });
    budget = t.budget;
    const response = await post(t);
    assert.equal(response.statusCode, 202);
    assert.equal(t.records("ingestion response deadline reached").length, 0);
    assert.equal(t.records("late ingestion outcome").length, 0);
  });

  it("DL-7 (TCP, start point): the deadline counts body time from routing, not from handler entry", async () => {
    // requestTimeoutMs 1,500 → budget 6,500; the body arrives 1,000 ms after
    // the headers. A clock started at handler entry would answer at >= 7,500.
    const t = start(() => new Promise(() => undefined), { requestTimeoutMs: 1_500 });
    const port = await listen(t.app);
    const request = validRequest();
    const response = await rawExchange(port, [rawHead(request), request.body], { gapMs: 1_000, waitMs: 10_000 });
    assert.equal(response.status, 503);
    const requestId = assertGeneric503(response.body);
    assertOneDeadlineAttempt(t, requestId);
  });

  it("DL-8 (TCP): the client disconnects before the deadline → the deadline takes the DEV-1 destroyed path; the late result is still logged", async () => {
    const d = deferred<IngestionOutcome>();
    const t = start(() => d.promise);
    const port = await listen(t.app);
    t.delta();
    const request = validRequest();
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write(Buffer.concat([Buffer.from(rawHead(request), "latin1"), request.body]));
    await sleep(300);
    socket.destroy();
    await until(() => t.records("ingestion response deadline reached").length > 0, t.budget + 1_000);
    await sleep(50);
    const deadline = t.records("ingestion response deadline reached")[0];
    const requestId = String(deadline?.requestId);
    assert.equal(t.delta().abortedBeforeResponse, 1, "abort recorded once by the destroyed branch");
    assert.equal(t.records("response attempt").length, 0, "nothing was written to the destroyed reply");
    d.resolve({ status: "ACCEPTED", eventId: "evt-after-disconnect" });
    await until(() => t.records("late ingestion outcome").length > 0);
    const late = t.records("late ingestion outcome");
    assert.equal(late.length, 1);
    assert.equal(late[0]?.requestId, requestId);
    assert.equal(late[0]?.late, "COMMITTED_AFTER_RESPONSE");
    assertNoAlreadySent(t);
  });

  it("DL-10 (simulated pool pressure): the deadline frees nothing; a retry fails at the 2 s pool wait", async () => {
    // A one-slot pool with a 2,000 ms wait stands in for the real pool
    // (whose behaviour is DB-T13 / DB-T20 / DL-PG-2 evidence).
    let held = false;
    const original = deferred<void>();
    let calls = 0;
    const t = start(async () => {
      calls += 1;
      if (calls === 1) {
        held = true;
        await original.promise;
        held = false;
        return { status: "ACCEPTED", eventId: "evt-original" };
      }
      const waited = performance.now();
      while (held && performance.now() - waited < 2_000) await sleep(10);
      if (held) return { status: "UNAVAILABLE", classification: "TRANSIENT" };
      return { status: "ACCEPTED", eventId: "evt-retry" };
    });
    const first = post(t);
    await sleep(200);
    const retry = await post(t);
    assert.equal(retry.statusCode, 503, "the retry waits for the slot, then fails at about 2 s");
    const retryTime = Number(t.records("response attempt").find((r) => r.requestId === assertGeneric503(retry.body))?.responseTimeMs);
    assert.ok(retryTime >= 2_000 && retryTime < t.budget, `retry answered at ${retryTime} ms`);
    const originalResponse = await first;
    const originalId = assertGeneric503(originalResponse.body);
    // Under inject() the request never emits `close`, so Fastify's own
    // handlerTimeout stays armed and may send this 503 (through the same
    // gate) a fraction of a millisecond before the deadline records itself.
    await until(() => t.records("ingestion response deadline reached").length > 0, 500);
    assertDeadlineRecord(t, originalId);
    assert.equal(held, true, "the deadline 503 released nothing");
    original.resolve();
    await until(() => t.records("late ingestion outcome").length > 0);
    assert.equal(held, false);
    assert.equal(t.records("late ingestion outcome")[0]?.late, "COMMITTED_AFTER_RESPONSE");
  });

  it("DL-13 (TCP, slow body): normally bounded work that finishes after the deadline → one 503, then COMMITTED_AFTER_RESPONSE", async () => {
    // requestTimeoutMs 1,500 → budget 6,500; the body arrives at about
    // 1,400 ms; the (fake) ingestion takes 5,300 ms and then commits.
    const t = start(async () => {
      await sleep(5_300);
      return { status: "ACCEPTED", eventId: "evt-slow-body" };
    }, { requestTimeoutMs: 1_500 });
    const port = await listen(t.app);
    const request = validRequest();
    const response = await rawExchange(port, [rawHead(request), request.body], { gapMs: 1_400, waitMs: 10_000 });
    assert.equal(response.status, 503);
    assert.equal((response.raw.match(/HTTP\/1\.[01] \d{3}/g) ?? []).length, 1);
    const requestId = assertGeneric503(response.body);
    assertOneDeadlineAttempt(t, requestId);
    await until(() => t.records("late ingestion outcome").length > 0, 2_000);
    assert.equal(t.records("late ingestion outcome")[0]?.late, "COMMITTED_AFTER_RESPONSE");
  });
});

describe("DL-9: the budget is already spent before the handoff", () => {
  it("the handoff is not called; 503 with reason RESPONSE_DEADLINE_BEFORE_HANDOFF", async () => {
    // The verifier blocks the event loop past the budget (synchronous work
    // before the handoff), so no budget remains when the handler reaches it.
    let budget = 0;
    const t = start(() => Promise.resolve({ status: "ACCEPTED" }), {
      verifyWebhook: (input) => {
        blockEventLoop(budget + 20);
        return verifyIrsV1Webhook(input);
      },
    });
    budget = t.budget;
    const response = await post(t);
    const requestId = assertGeneric503(response.body);
    assert.equal(t.handoff.requests.length, 0, "accept is never called");
    assertDeadlineRecord(t, requestId, "RESPONSE_DEADLINE_BEFORE_HANDOFF", "NOT_ATTEMPTED");
    assert.equal(t.records("late ingestion outcome").length, 0);
  });
});

describe("DL-12: the event loop is blocked past the deadline, then the result settles before the timer runs", () => {
  it("one 503 and a COMMITTED_AFTER_RESPONSE record; never a 202", async () => {
    let budget = 0;
    const t = start(async () => {
      await sleep(budget - 150);
      blockEventLoop(400);
      return { status: "ACCEPTED", eventId: "evt-blocked" };
    });
    budget = t.budget;
    const response = await post(t);
    assert.equal(response.statusCode, 503, "never a 202");
    const requestId = assertGeneric503(response.body);
    // The [budget, budget + 250] target is not asserted: the loop was blocked on purpose.
    assertOneDeadlineAttempt(t, requestId, false);
    await until(() => t.records("late ingestion outcome").length > 0);
    const late = t.records("late ingestion outcome");
    assert.equal(late.length, 1);
    assert.equal(late[0]?.late, "COMMITTED_AFTER_RESPONSE");
    assert.equal(late[0]?.eventId, "evt-blocked");
    assertNoAlreadySent(t);
  });
});

describe("DL-11: shutdown with late work outstanding (lifecycle steps unchanged)", () => {
  for (const settles of [true, false]) {
    it(settles ? "(i) the late work settles within the disconnect budget → disconnect completes; the late record is written" : "(ii) it does not → disconnect times out; no late record", async () => {
      const d = deferred<IngestionOutcome>();
      const t = start(() => d.promise, { keepOpen: true });
      const response = await post(t);
      assertGeneric503(response.body);
      const closing = performance.now();
      await closeWithGrace(t.app, 3_000);
      assert.ok(performance.now() - closing < 1_000, "no open HTTP request holds the intake barrier");
      // Stand-in for prisma.$disconnect(): it waits for the checked-out work.
      const fakeDb = { prisma: { $disconnect: () => d.promise.then(() => undefined, () => undefined) } } as unknown as Database;
      if (settles) setTimeout(() => d.resolve({ status: "ACCEPTED", eventId: "evt-shutdown" }), 200);
      const outcome = await disconnectWithin(fakeDb, 500);
      await new Promise((resolve) => setImmediate(resolve));
      if (settles) {
        assert.deepEqual(outcome, { completed: true });
        assert.equal(t.records("late ingestion outcome")[0]?.late, "COMMITTED_AFTER_RESPONSE");
      } else {
        assert.deepEqual(outcome, { completed: false, timedOut: true });
        assert.equal(t.records("late ingestion outcome").length, 0);
        d.resolve({ status: "ACCEPTED" });
      }
    });
  }
});
