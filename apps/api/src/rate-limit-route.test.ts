import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyIrsV1Webhook } from "@irs/integrations";
import { DEFAULT_RATE_LIMIT_POLICIES, createRateLimiter } from "./rate-limit.js";
import type {
  Counters,
  Denial,
  RateLimitEvidence,
  RateLimitPolicies,
  RateLimiter,
  TablePolicy,
} from "./rate-limit.js";
import { createResponseGate } from "./server.js";
import {
  INTEGRATION_ID,
  LogCapture,
  ManualClock,
  NOW_SECONDS,
  OTHER_INTEGRATION_ID,
  RecordingHandoff,
  SECRET_TEXT,
  UNCONFIGURED_ID,
  WEBHOOK_PATH,
  envelopeJson,
  makeApp,
  parseJson,
  sign,
  spyLimiter,
  validRequest,
} from "./test-helpers.js";
import type { LimiterSpy, TestApp } from "./test-helpers.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL = "127.0.0.1";
const OTHER_PEER = "198.51.100.200";
const OTHER_SECRET = "another-integration-secret-0123456789";

let current: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of current) await app.close();
  current = [];
});

interface LimitedApp extends TestApp {
  readonly limiter: RateLimiter;
  readonly evidence: RateLimitEvidence;
  readonly clock: ManualClock;
  readonly spy: LimiterSpy;
  readonly policies: RateLimitPolicies;
}

interface StartOptions {
  readonly policies?: Partial<RateLimitPolicies>;
  /** Replacement limiter methods, given the real (unwrapped) limiter. */
  readonly overrides?: (inner: RateLimiter) => Partial<RateLimiter>;
  /** F5: P2's precheck always allows, so consume-time conversion is reachable. */
  readonly stubPeek?: boolean;
  readonly handoff?: RecordingHandoff;
  readonly logs?: LogCapture;
  readonly verifyWebhook?: typeof verifyIrsV1Webhook;
}

function start(options: StartOptions = {}): LimitedApp {
  let spy: LimiterSpy | undefined;
  const t = makeApp({
    ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
    ...(options.logs === undefined ? {} : { logs: options.logs }),
    ...(options.verifyWebhook === undefined ? {} : { verifyWebhook: options.verifyWebhook }),
    rateLimit: {
      ...(options.policies === undefined ? {} : { policies: options.policies }),
      wrap: (inner) => {
        const overrides: Partial<RateLimiter> = { ...options.overrides?.(inner) };
        if (options.stubPeek === true) {
          overrides.peekRejectionAllowance = () => ({ allowed: true });
        }
        spy = spyLimiter(inner, overrides);
        return spy.limiter;
      },
    },
  });
  current.push(t.app);
  const { limiter, evidence, clock } = t;
  assert.ok(limiter !== undefined && evidence !== undefined && clock !== undefined);
  assert.ok(spy !== undefined);
  return {
    ...t,
    limiter,
    evidence,
    clock,
    spy,
    policies: { ...DEFAULT_RATE_LIMIT_POLICIES, ...options.policies },
  };
}

interface PostOptions {
  readonly url?: string;
  readonly remoteAddress?: string;
}

function post(
  t: TestApp,
  request: { body: Buffer | string; headers: Record<string, string | string[]> },
  options: PostOptions = {},
) {
  return t.app.inject({
    method: "POST",
    url: options.url ?? WEBHOOK_PATH,
    headers: request.headers,
    payload: request.body,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
}

/** Signed request whose verifier result is a 401 (missing signature at P4). */
function unsigned(): { body: Buffer; headers: Record<string, string> } {
  return { body: Buffer.from(envelopeJson()), headers: { "content-type": "application/json" } };
}

/** Signed for the other configured integration. */
function validForOther(): { body: Buffer; headers: Record<string, string> } {
  const body = Buffer.from(envelopeJson());
  return {
    body,
    headers: {
      "content-type": "application/json",
      "irs-signature": sign(body, NOW_SECONDS, OTHER_SECRET),
    },
  };
}

/** Takes exactly the layer's capacity for one key: the bucket ends at 0 with no denial. */
function exhaust(
  t: LimitedApp,
  layer: "L1" | "L2" | "L3",
  address: string = LOCAL,
  integrationId: string = INTEGRATION_ID,
): void {
  const peer = t.limiter.peerKey(address);
  for (let i = 0; i < t.policies[layer].bucket.capacity; i += 1) {
    const decision =
      layer === "L1"
        ? t.limiter.consumeRequest(peer)
        : layer === "L2"
          ? t.limiter.consumeRejectionAllowance(peer)
          : t.limiter.consumeVerified(integrationId, peer);
    assert.equal(decision.allowed, true, `${layer} setup consume ${i}`);
  }
}

/** Activity since the previous call (or since creation). */
function delta(t: LimitedApp): Counters {
  return t.evidence.drain().delta;
}

function assertGeneric(
  response: { statusCode: number; body: string },
  status: number,
  code: string,
): string {
  assert.equal(response.statusCode, status);
  const body = parseJson(response.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
  assert.equal(body.error, code);
  assert.match(String(body.requestId), UUID_V4);
  return body.requestId as string;
}

function assert429(
  response: { statusCode: number; body: string; headers: Record<string, unknown> },
  retryAfter?: string,
): string {
  const requestId = assertGeneric(response, 429, "TOO_MANY_REQUESTS");
  assert.equal(response.headers.connection, "close");
  assert.match(String(response.headers["retry-after"]), /^[1-9][0-9]*$/);
  if (retryAfter !== undefined) assert.equal(response.headers["retry-after"], retryAfter);
  return requestId;
}

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One token, refilled once per 1,000 s: exhausted by a single grant. */
const SLOW_TABLE: TablePolicy = {
  bucket: { capacity: 1, refillPerSecond: 0.001 },
  overflow: { capacity: 1, refillPerSecond: 0.001 },
  maxKeys: 100,
};

// ---------------------------------------------------------------------------

describe("T1: L1 exceeded", () => {
  it("answers the generic 429 with Retry-After and Connection: close, and no quota headers", async () => {
    const t = start();
    exhaust(t, "L1");
    const response = await post(t, validRequest());
    const requestId = assert429(response, "1");
    assert.equal(
      (parseJson(response.body) as { requestId: string }).requestId,
      requestId,
    );
    for (const name of Object.keys(response.headers)) {
      assert.ok(!/ratelimit/i.test(name), `unexpected header ${name}`);
    }
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });
});

describe("T2: recovery after Retry-After", () => {
  it("L1: recovers once the advertised refill time has passed", async () => {
    const t = start();
    exhaust(t, "L1");
    const first = await post(t, validRequest());
    assert429(first, String(Math.max(1, Math.ceil(1 / 20))));
    t.clock.advance(40);
    assert429(await post(t, validRequest()), "1");
    t.clock.advance(1_000 - 40);
    assert.equal((await post(t, validRequest())).statusCode, 202);
  });

  it("L2: recovers after 30 s, the computed refill time", async () => {
    const t = start();
    exhaust(t, "L2");
    assert429(await post(t, validRequest()), "30");
    t.clock.advance(29_999);
    assert429(await post(t, validRequest()), "1");
    t.clock.advance(1);
    assert.equal((await post(t, validRequest())).statusCode, 202);
  });
});

describe("T3: independent keys and layers", () => {
  it("keys L1 by socket address, sharing IPv4-mapped forms and IPv6 /64 groups", async () => {
    const t = start();
    exhaust(t, "L1", "10.0.0.1");
    exhaust(t, "L1", "2001:db8:1:2::1");
    assert429(await post(t, validRequest(), { remoteAddress: "10.0.0.1" }));
    assert429(await post(t, validRequest(), { remoteAddress: "::ffff:10.0.0.1" }));
    assert429(await post(t, validRequest(), { remoteAddress: "2001:db8:1:2:ffff::9" }));
    assert.equal((await post(t, validRequest(), { remoteAddress: "10.0.0.2" })).statusCode, 202);
    assert.equal((await post(t, validRequest(), { remoteAddress: "2001:db8:1:3::1" })).statusCode, 202);
  });

  it("keeps layers independent", async () => {
    const t = start({ policies: { L3: SLOW_TABLE } });
    exhaust(t, "L3", LOCAL, INTEGRATION_ID);
    // L3 exhausted for one integration: its valid deliveries are limited...
    assert429(await post(t, validRequest()));
    // ...while L1/L2 still admit this peer and other integrations.
    assertGeneric(await post(t, unsigned()), 401, "UNAUTHORIZED");
    assert.equal(
      (await post(t, validForOther(), { url: `/api/webhooks/${OTHER_INTEGRATION_ID}` })).statusCode,
      202,
    );
    // L2 exhausted for another peer leaves its L1 and other peers alone.
    exhaust(t, "L2", "10.0.0.9");
    assert429(await post(t, validRequest(), { remoteAddress: "10.0.0.9" }));
    assertGeneric(await post(t, unsigned(), { remoteAddress: "10.0.0.8" }), 401, "UNAUTHORIZED");
  });
});

describe("T4: forwarding headers are never trusted", () => {
  const FORWARDING = [
    "x-forwarded-for",
    "x-real-ip",
    "forwarded",
    "true-client-ip",
    "cf-connecting-ip",
  ] as const;

  it("shares one bucket for one socket whatever the forwarding headers say", async () => {
    const t = start();
    exhaust(t, "L1");
    for (const [i, name] of FORWARDING.entries()) {
      const request = validRequest();
      const value = name === "forwarded" ? `for=203.0.113.${i}` : `203.0.113.${i}`;
      assert429(await post(t, { body: request.body, headers: { ...request.headers, [name]: value } }));
    }
  });

  it("does not charge the address named in a forwarding header", async () => {
    const t = start();
    exhaust(t, "L1", "203.0.113.50");
    for (const name of FORWARDING) {
      const request = validRequest();
      const value = name === "forwarded" ? "for=203.0.113.50" : "203.0.113.50";
      const response = await post(t, { body: request.body, headers: { ...request.headers, [name]: value } });
      assert.equal(response.statusCode, 202, name);
    }
  });
});

describe("T5 / T5b: L2 precheck (HD-20)", () => {
  it("T5: a precheck 429 leaves resolution, verification and the handoff untouched", async () => {
    const t = start();
    exhaust(t, "L2");
    delta(t);
    assert429(await post(t, validRequest()), "30");
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
    const d = delta(t);
    assert.equal(d.layers.L2.limitedPrecheck, 1);
    assert.equal(d.layers.L2.limited, 1);
  });

  it("T5b: steps (a)-(g)", async () => {
    const t = start();
    const peer = t.limiter.peerKey(LOCAL);
    const otherPeerUnaffected = async (step: string): Promise<void> => {
      const response = await post(t, validRequest(), { remoteAddress: OTHER_PEER });
      assert.equal(response.statusCode, 202, `other peer at ${step}`);
    };

    // (a) 20 individually delivered rejections exhaust L2.
    for (let i = 0; i < 20; i += 1) {
      assertGeneric(await post(t, unsigned()), 401, "UNAUTHORIZED");
    }
    assert.equal(delta(t).layers.L2.individualRejections, 20);
    await otherPeerUnaffected("a");

    // (b) A valid signed request is refused before verification.
    const verifiedBefore = t.verifyInputs.length;
    const handedBefore = t.handoff.requests.length;
    const resolvedBefore = t.resolved.length;
    assert429(await post(t, validRequest()), "30");
    assert.equal(t.verifyInputs.length, verifiedBefore);
    assert.equal(t.handoff.requests.length, handedBefore);
    assert.equal(t.resolved.length, resolvedBefore);
    await otherPeerUnaffected("b");

    // (c) +15 s: half a token.
    t.clock.advance(15_000);
    assert429(await post(t, validRequest()), "15");
    await otherPeerUnaffected("c");

    // (d) +15 s: exactly one token; valid requests pass without consuming it.
    t.clock.advance(15_000);
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await post(t, validRequest())).statusCode, 202);
    }
    assert.equal(t.limiter.peekRejectionAllowance(peer).allowed, true);
    await otherPeerUnaffected("d");

    // (e) One rejected request takes the token.
    delta(t);
    assertGeneric(await post(t, unsigned()), 401, "UNAUTHORIZED");
    assert.equal(delta(t).layers.L2.individualRejections, 1);

    // (f) The next valid request is refused again for 30 s.
    assert429(await post(t, validRequest()), "30");
    assert.equal(delta(t).layers.L2.limitedPrecheck, 1);

    // (g)
    await otherPeerUnaffected("g");
  });
});

describe("T7: concurrent rejections", () => {
  it("gives exactly k individual rejections and N - k conversions", async () => {
    const t = start({
      policies: {
        L1: { ...DEFAULT_RATE_LIMIT_POLICIES.L1, bucket: { capacity: 100, refillPerSecond: 20 } },
        L2: {
          bucket: { capacity: 5, refillPerSecond: 1 / 30 },
          overflow: { capacity: 5, refillPerSecond: 1 / 30 },
          maxKeys: 10_000,
        },
      },
    });
    const body = Buffer.from(envelopeJson());
    const wrong = { body, headers: { "content-type": "application/json", "irs-signature": `t=${NOW_SECONDS},v1=${"0".repeat(64)}` } };
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(t, wrong)));
    const statuses = responses.map((r) => r.statusCode);
    assert.equal(statuses.filter((s) => s === 401).length, 5);
    assert.equal(statuses.filter((s) => s === 429).length, 45);
    const d = delta(t);
    assert.equal(d.layers.L2.individualRejections, 5);
    assert.equal(d.layers.L2.limitedConverted, 45);
    assert.equal(d.layers.L2.limitedPrecheck, 0);
    assert.equal(t.verifyInputs.length, 50);
  });
});

describe("T8: conversion on every eligible path (inject)", () => {
  const big = Buffer.alloc(1_048_577, 0x20);
  const cases: Array<{
    name: string;
    individual: { status: number; code: string };
    inject: (t: LimitedApp) => ReturnType<typeof post>;
    verifyWebhook?: typeof verifyIrsV1Webhook;
    connectionClose?: boolean;
    routerLevel?: boolean;
  }> = [
    {
      name: "guard 401 (no signature)",
      individual: { status: 401, code: "UNAUTHORIZED" },
      inject: (t) => post(t, unsigned()),
    },
    {
      name: "guard 400 (duplicate Transfer-Encoding)",
      individual: { status: 400, code: "BAD_REQUEST" },
      inject: (t) => {
        const request = validRequest();
        return post(t, {
          body: request.body,
          headers: { ...request.headers, "transfer-encoding": ["chunked", "chunked"] },
        });
      },
    },
    {
      name: "guard 415 (content type)",
      individual: { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" },
      inject: (t) => {
        const request = validRequest();
        return post(t, { body: request.body, headers: { ...request.headers, "content-type": "text/plain" } });
      },
    },
    {
      name: "guard 404 (malformed ID)",
      individual: { status: 404, code: "NOT_FOUND" },
      inject: (t) => post(t, validRequest(), { url: "/api/webhooks/not-a-uuid" }),
    },
    {
      name: "guard 404 (unconfigured ID)",
      individual: { status: 404, code: "NOT_FOUND" },
      inject: (t) => post(t, validRequest(), { url: `/api/webhooks/${UNCONFIGURED_ID}` }),
    },
    {
      name: "not-found 404",
      individual: { status: 404, code: "NOT_FOUND" },
      inject: (t) => t.app.inject({ method: "GET", url: "/" }),
    },
    {
      name: "parser 413",
      individual: { status: 413, code: "PAYLOAD_TOO_LARGE" },
      inject: (t) => post(t, validRequest(big)),
      connectionClose: true,
    },
    {
      // F6 (founder decision 2026-10-16): only a malformed media type reaches
      // the framework's 415; see the F6 test below for a well-formed one.
      name: "parser 415 (not-found route, malformed media type)",
      individual: { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" },
      inject: (t) =>
        t.app.inject({
          method: "POST",
          url: "/api/events",
          headers: { "content-type": "text/" },
          payload: "x",
        }),
    },
    {
      name: "verifier 401",
      individual: { status: 401, code: "UNAUTHORIZED" },
      inject: (t) => {
        const request = validRequest();
        return post(t, {
          body: request.body,
          headers: { ...request.headers, "irs-signature": `t=${NOW_SECONDS},v1=${"0".repeat(64)}` },
        });
      },
    },
    {
      name: "verifier 400",
      individual: { status: 400, code: "BAD_REQUEST" },
      inject: (t) => post(t, validRequest("not json")),
    },
    {
      name: "verifier 413",
      individual: { status: 413, code: "PAYLOAD_TOO_LARGE" },
      inject: (t) => post(t, validRequest()),
      verifyWebhook: (input) => verifyIrsV1Webhook({ ...input, maxBodyBytes: 1 }),
    },
    {
      name: "router-level 400",
      individual: { status: 400, code: "BAD_REQUEST" },
      inject: (t) => post(t, validRequest(), { url: "/api/webhooks/%zz" }),
      routerLevel: true,
    },
    {
      name: "router-level 404",
      individual: { status: 404, code: "NOT_FOUND" },
      inject: (t) => post(t, validRequest(), { url: `/api/webhooks/${"a".repeat(150)}` }),
      routerLevel: true,
    },
  ];

  it("F6: only a malformed Content-Type reaches the framework 415 (via the error handler) on the not-found route; a well-formed unsupported one is a 404", async () => {
    const t = start();
    const errorCodes: unknown[] = [];
    t.app.addHook("onError", async (_request, _reply, error) => {
      errorCodes.push((error as { code?: unknown }).code);
    });
    const malformed = await t.app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "content-type": "text/" },
      payload: "x",
    });
    assertGeneric(malformed, 415, "UNSUPPORTED_MEDIA_TYPE");
    assert.deepEqual(errorCodes, ["FST_ERR_CTP_INVALID_MEDIA_TYPE"]);
    const wellFormed = await t.app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "content-type": "text/plain" },
      payload: "x",
    });
    assertGeneric(wellFormed, 404, "NOT_FOUND");
    assert.equal(errorCodes.length, 1);
  });

  for (const c of cases) {
    it(`${c.name}: individual rejection first, then converted to 429 once L2 is empty`, async () => {
      const options = c.verifyWebhook === undefined ? {} : { verifyWebhook: c.verifyWebhook };
      // The path really produces this individual rejection (and F6 holds).
      const plain = start(options);
      const individual = await c.inject(plain);
      assertGeneric(individual, c.individual.status, c.individual.code);
      assert.equal(delta(plain).layers.L2.individualRejections, 1);
      if (c.connectionClose === true) assert.equal(individual.headers.connection, "close");

      // With L2 exhausted (and the precheck stubbed open), it converts.
      const t = start({ ...options, stubPeek: true });
      exhaust(t, "L2");
      delta(t);
      const response = await c.inject(t);
      assert429(response, "30");
      const d = delta(t);
      assert.equal(d.layers.L2.limitedConverted, 1);
      assert.equal(d.layers.L2.limited, 1);
      assert.equal(d.layers.L2.individualRejections, 0);
      assert.equal(t.handoff.requests.length, 0);
      if (c.routerLevel === true) {
        assert.equal(t.spy.calls.consumeRequest, 1, "P1 charged L1 once");
        assert.equal(t.spy.calls.peekRejectionAllowance, 0, "P2 did not run");
      }
    });
  }
});

// Task 011, approved 011B amendment B-5: the ingestion 404 and 422 join the
// eligible-path conversions. Added alongside T8; the T8 cases above are
// unchanged (they assert the handoff is never called, which by definition
// does not hold for a rejection the handoff decides).
describe("T8 extension (B-5): ingestion 404 and 422 (inject)", () => {
  const cases = [
    { name: "ingestion 422 (unstorable payload)", outcome: { status: "UNPROCESSABLE_PAYLOAD", condition: "P1_NUL_CHARACTER" } as const, status: 422, code: "UNPROCESSABLE_PAYLOAD" },
    { name: "ingestion 404 (ineligible integration)", outcome: { status: "INTEGRATION_INELIGIBLE" } as const, status: 404, code: "NOT_FOUND" },
  ];
  for (const c of cases) {
    it(`${c.name}: individual rejection first, then converted to 429 once L2 is empty`, async () => {
      const handoff = () => new RecordingHandoff(() => Promise.resolve(c.outcome));
      const plain = start({ handoff: handoff() });
      const individual = await post(plain, validRequest());
      assertGeneric(individual, c.status, c.code);
      assert.equal(delta(plain).layers.L2.individualRejections, 1);

      const t = start({ handoff: handoff(), stubPeek: true });
      exhaust(t, "L2");
      delta(t);
      const response = await post(t, validRequest());
      assert429(response, "30");
      const d = delta(t);
      assert.equal(d.layers.L2.limitedConverted, 1);
      assert.equal(d.layers.L2.limited, 1);
      assert.equal(d.layers.L2.individualRejections, 0);
      assert.equal(t.handoff.requests.length, 1, "the handoff decided the rejection");
    });
  }
});

describe("T9: 429, 503, 500 and 202 never consume L2", () => {
  const cases: Array<{
    name: string;
    status: number;
    handoff?: () => RecordingHandoff;
    policies?: Partial<RateLimitPolicies>;
    setup?: (t: LimitedApp) => void;
  }> = [
    { name: "202", status: 202 },
    { name: "503", status: 503, handoff: () => new RecordingHandoff(() => Promise.resolve({ status: "UNAVAILABLE" })) },
    { name: "500 (handoff throws)", status: 500, handoff: () => new RecordingHandoff(() => Promise.reject(new Error("x"))) },
    { name: "500 (invalid outcome)", status: 500, handoff: () => new RecordingHandoff(() => Promise.resolve({ status: "?" } as never)) },
    { name: "429 (L1)", status: 429, setup: (t) => exhaust(t, "L1") },
    { name: "429 (L3)", status: 429, policies: { L3: SLOW_TABLE }, setup: (t) => exhaust(t, "L3") },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const t = start({
        ...(c.handoff === undefined ? {} : { handoff: c.handoff() }),
        ...(c.policies === undefined ? {} : { policies: c.policies }),
      });
      c.setup?.(t);
      delta(t);
      const response = await post(t, validRequest());
      assert.equal(response.statusCode, c.status);
      assert.equal(t.spy.calls.consumeRejectionAllowance, 0);
      assert.equal(delta(t).layers.L2.individualRejections, 0);
    });
  }
});

describe("T11: L3 only after verification", () => {
  it("charges L3 after the verifier accepts and before the handoff, never for rejected requests", async () => {
    const order: string[] = [];
    const t = start({
      verifyWebhook: (input) => {
        order.push("verify");
        return verifyIrsV1Webhook(input);
      },
      overrides: (inner) => ({
        consumeVerified: (integrationId, peer) => {
          order.push("L3");
          return inner.consumeVerified(integrationId, peer);
        },
      }),
      handoff: new RecordingHandoff(() => {
        order.push("handoff");
        return Promise.resolve({ status: "ACCEPTED" });
      }),
    });
    // A correctly signed bad envelope, and an unsigned flood.
    assertGeneric(await post(t, validRequest(JSON.stringify({ unexpected: true }))), 400, "BAD_REQUEST");
    for (let i = 0; i < 10; i += 1) {
      assertGeneric(await post(t, unsigned()), 401, "UNAUTHORIZED");
    }
    assert.equal(t.spy.calls.consumeVerified, 0);
    assert.equal(t.evidence.drain().gauges.L3.tableSize, 0);

    order.length = 0;
    assert.equal((await post(t, validRequest())).statusCode, 202);
    assert.deepEqual(order, ["verify", "L3", "handoff"]);
    assert.equal(t.spy.calls.consumeVerified, 1);
    assert.equal(t.evidence.drain().gauges.L3.tableSize, 1);
  });
});

describe("T12: limiter faults (inject)", () => {
  const boom = (): never => {
    throw new Error("LIMITER-FAULT-SENTINEL");
  };
  const cases: Array<{
    name: keyof RateLimiter;
    request: () => { body: Buffer; headers: Record<string, string> };
    setup?: (t: LimitedApp) => void;
  }> = [
    { name: "consumeRequest", request: validRequest },
    { name: "peekRejectionAllowance", request: validRequest },
    { name: "recordPrecheckDenied", request: validRequest, setup: (t) => exhaust(t, "L2") },
    { name: "consumeRejectionAllowance", request: unsigned },
    { name: "consumeVerified", request: validRequest },
  ];
  for (const c of cases) {
    for (const recordFaultThrows of [false, true]) {
      it(`a fault in ${c.name} gives the generic 500${recordFaultThrows ? " even when recordFault throws" : ""}`, async () => {
        const t = start({
          overrides: () => ({
            [c.name]: boom,
            ...(recordFaultThrows ? { recordFault: boom } : {}),
          }),
        });
        c.setup?.(t);
        delta(t);
        const response = await post(t, c.request());
        assertGeneric(response, 500, "INTERNAL_ERROR");
        assert.equal(response.headers["retry-after"], undefined);
        assert.ok(!response.body.includes("SENTINEL"));
        assert.ok(!t.logs.text().includes("LIMITER-FAULT-SENTINEL"));
        assert.equal(delta(t).limiterFaults, recordFaultThrows ? 0 : 1);
        assert.equal(t.handoff.requests.length, 0);
      });
    }
  }

  it("a throwing warning log gives one generic 500, counts the fault and keeps the denial", async () => {
    const t = start({ logs: new LogCapture("rate limit exceeded") });
    exhaust(t, "L1");
    delta(t);
    const response = await post(t, validRequest());
    assertGeneric(response, 500, "INTERNAL_ERROR");
    assert.equal(response.headers["retry-after"], undefined);
    const d = delta(t);
    assert.equal(d.limiterFaults, 1);
    assert.equal(d.layers.L1.limited, 1);
    assert.ok(!/already sent/i.test(t.logs.text()));
  });
});

describe("T13b: saturation precheck (inject)", () => {
  it("refuses a new peer with the overflow Retry-After once the overflow bucket is empty", async () => {
    const t = start({
      policies: {
        L2: {
          bucket: { capacity: 20, refillPerSecond: 1 / 30 },
          overflow: { capacity: 2, refillPerSecond: 1 / 60 },
          maxKeys: 1,
        },
      },
    });
    for (const address of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
      assertGeneric(await post(t, unsigned(), { remoteAddress: address }), 401, "UNAUTHORIZED");
    }
    delta(t);
    assert429(await post(t, validRequest(), { remoteAddress: "10.0.0.4" }), "60");
    const d = delta(t);
    assert.equal(d.layers.L2.limitedPrecheck, 1);
    assert.equal(d.layers.L2.limitedViaOverflow, 1);
    // The live peer A keeps its own bucket.
    assert.equal((await post(t, validRequest(), { remoteAddress: "10.0.0.1" })).statusCode, 202);
  });
});

describe("T14b: composition", () => {
  it("shares state between the server's limiter and its evidence", async () => {
    const t = start();
    assertGeneric(await post(t, unsigned()), 401, "UNAUTHORIZED");
    const summary = t.evidence.drain();
    assert.equal(summary.delta.layers.L2.individualRejections, 1);
    assert.equal(summary.gauges.L1.tableSize, 1);
    assert.equal(summary.gauges.L2.tableSize, 1);
  });

  it("isolates separate pairs", async () => {
    const one = start();
    const two = start();
    exhaust(one, "L1");
    assert429(await post(one, validRequest()));
    assert.equal((await post(two, validRequest())).statusCode, 202);
    assert.equal(two.evidence.drain().delta.layers.L1.limited, 0);
  });

  it("still enforces limits with the default composition (no injected limiter)", async () => {
    const t = makeApp();
    current.push(t.app);
    for (let i = 0; i < 20; i += 1) {
      assertGeneric(await post(t, unsigned()), 401, "UNAUTHORIZED");
    }
    assert429(await post(t, unsigned()));
  });
});

describe("T15: rate-limit logging (inject)", () => {
  it("logs layer, request ID and a fingerprint only; never raw addresses or Task 010A sentinels", async () => {
    const t = start({ policies: { L1: SLOW_TABLE, L2: SLOW_TABLE, L3: SLOW_TABLE } });
    const sentinelRequest = (remoteAddress: string) => {
      const request = validRequest(envelopeJson({ payload: { note: "BODY-SENTINEL-VALUE" } }));
      return t.app.inject({
        method: "POST",
        url: `${WEBHOOK_PATH}?token=QUERY-SENTINEL-VALUE`,
        headers: {
          ...request.headers,
          authorization: "Bearer AUTH-SENTINEL-VALUE",
          cookie: "session=COOKIE-SENTINEL-VALUE",
        },
        payload: request.body,
        remoteAddress,
      });
    };
    exhaust(t, "L1", "::ffff:198.51.100.7");
    exhaust(t, "L2", "198.51.100.8");
    exhaust(t, "L3", "198.51.100.9");
    const expected: Array<[string, string]> = [];
    for (const [address, layer] of [
      ["::ffff:198.51.100.7", "L1"],
      ["198.51.100.8", "L2"],
      ["198.51.100.9", "L3"],
    ] as const) {
      expected.push([assert429(await sentinelRequest(address)), layer]);
    }

    const records = t.logs.records().filter((r) => r.msg === "rate limit exceeded");
    assert.equal(records.length, 3);
    for (const [requestId, layer] of expected) {
      const record = records.find((r) => r.reqId === requestId);
      assert.ok(record, `log line for ${layer}`);
      assert.equal(record.layer, layer);
      assert.match(String(record.peer), /^[0-9a-f]{16}$/);
      assert.equal(record.level, 40);
    }
    const signature = sign(Buffer.from(envelopeJson({ payload: { note: "BODY-SENTINEL-VALUE" } })));
    const text = t.logs.text();
    for (const leaked of [
      "198.51.100.7",
      "198.51.100.8",
      "198.51.100.9",
      "::ffff:",
      "BODY-SENTINEL-VALUE",
      "QUERY-SENTINEL-VALUE",
      "AUTH-SENTINEL-VALUE",
      "COOKIE-SENTINEL-VALUE",
      SECRET_TEXT,
      signature.split("v1=")[1] as string,
    ]) {
      assert.ok(!text.includes(leaked), `log leaked ${leaked.slice(0, 16)}`);
    }
  });
});

describe("DEV-1: destroyed replies end the lifecycle", () => {
  for (const [name, url, request] of [
    ["unconfigured ID (P4 404)", `/api/webhooks/${UNCONFIGURED_ID}`, validRequest],
    ["missing signature (P4 401)", WEBHOOK_PATH, unsigned],
  ] as const) {
    it(`DEV-1 P4 destroyed: ${name} - no body parsing, handler, verifier, L3 or handoff`, { timeout: 10_000 }, async () => {
      const t = start();
      const stages = { preParsing: 0, preHandler: 0 };
      // Registered after P2, so it runs between P2 and the route's onRequest (P4).
      t.app.addHook("onRequest", async (_request, reply) => {
        reply.raw.destroy();
      });
      t.app.addHook("preParsing", async (_request, _reply, payload) => {
        stages.preParsing += 1;
        return payload;
      });
      t.app.addHook("preHandler", async () => {
        stages.preHandler += 1;
      });
      delta(t);
      await post(t, request(), { url }).then(
        () => undefined,
        () => undefined,
      );
      await settle();
      assert.deepEqual(
        {
          preParsing: stages.preParsing,
          preHandler: stages.preHandler,
          verifyInputs: t.verifyInputs.length,
          consumeVerified: t.spy.calls.consumeVerified,
          handoff: t.handoff.requests.length,
          consumeRejectionAllowance: t.spy.calls.consumeRejectionAllowance,
        },
        {
          preParsing: 0,
          preHandler: 0,
          verifyInputs: 0,
          consumeVerified: 0,
          handoff: 0,
          consumeRejectionAllowance: 0,
        },
        "stages reached after a destroyed P4 rejection",
      );
      assert.equal(delta(t).abortedBeforeResponse, 1);
    });
  }

  it("DEV-1 normal paths never hijack: 202, L3 429 and a P4 individual rejection", async () => {
    const t = start({ policies: { L3: SLOW_TABLE } });
    let hijacks = 0;
    t.app.addHook("onRequest", async (_request, reply) => {
      const original = reply.hijack.bind(reply);
      reply.hijack = () => {
        hijacks += 1;
        return original();
      };
    });
    assert.equal((await post(t, validRequest())).statusCode, 202);
    assert429(await post(t, validRequest()));
    assertGeneric(await post(t, unsigned()), 401, "UNAUTHORIZED");
    assert.equal(hijacks, 0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests of the response gate with fake request/reply objects.

interface FakeExchange {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly calls: {
    code: number[];
    header: Array<[string, string]>;
    send: unknown[];
    hijack: number;
    warn: number;
  };
}

function fakeExchange(
  options: { destroyed: boolean; warnThrows?: boolean; hijackThrows?: boolean },
): FakeExchange {
  const calls: FakeExchange["calls"] = { code: [], header: [], send: [], hijack: 0, warn: 0 };
  const reply = {
    raw: { destroyed: options.destroyed },
    code(status: number) {
      calls.code.push(status);
      return reply;
    },
    header(name: string, value: string) {
      calls.header.push([name, value]);
      return reply;
    },
    send(body: unknown) {
      calls.send.push(body);
      return reply;
    },
    hijack() {
      calls.hijack += 1;
      if (options.hijackThrows === true) throw new Error("hijack failed");
      return reply;
    },
  };
  const request = {
    id: "req-unit",
    raw: { socket: { remoteAddress: LOCAL } },
    log: {
      warn() {
        calls.warn += 1;
        if (options.warnThrows === true) throw new Error("log write failed");
      },
    },
  };
  return {
    request: request as unknown as FastifyRequest,
    reply: reply as unknown as FastifyReply,
    calls,
  };
}

function gateFixture(overrides: Partial<RateLimiter> = {}) {
  const clock = new ManualClock();
  const pair = createRateLimiter({
    policies: { L1: SLOW_TABLE },
    monotonicNow: clock.now,
    wallNow: clock.wall,
  });
  const spy = spyLimiter(pair.limiter, overrides);
  const gate = createResponseGate(spy.limiter);
  /** A real L1 denial for 127.0.0.1 whose log line is permitted. */
  const denial = (): Denial => {
    const peer = pair.limiter.peerKey(LOCAL);
    pair.limiter.consumeRequest(peer);
    const decision = pair.limiter.consumeRequest(peer);
    assert.ok(!decision.allowed && decision.log !== null);
    return decision;
  };
  return { ...pair, spy, gate, denial };
}

describe("T10b: delivery guard (unit)", () => {
  it("never writes status, headers or body to a destroyed reply, and hijacks once per delivery", () => {
    const { gate, denial } = gateFixture();
    const d = denial();
    const operations: Array<[string, (x: FakeExchange) => void]> = [
      ["deliver 202", (x) => gate.deliver(x.request, x.reply, 202)],
      ["deliver error with headers", (x) => gate.deliver(x.request, x.reply, "BAD_REQUEST", { connection: "close" })],
      ["rejectWith eligible", (x) => gate.rejectWith(x.request, x.reply, "UNAUTHORIZED")],
      ["rejectWith eligible with headers", (x) => gate.rejectWith(x.request, x.reply, "PAYLOAD_TOO_LARGE", { connection: "close" })],
      ["rejectWith not eligible", (x) => gate.rejectWith(x.request, x.reply, "SERVICE_UNAVAILABLE")],
      ["send429", (x) => gate.send429(x.request, x.reply, d)],
      ["fault", (x) => gate.fault(x.request, x.reply)],
    ];
    for (const [name, operation] of operations) {
      const x = fakeExchange({ destroyed: true });
      operation(x);
      assert.deepEqual(x.calls.code, [], name);
      assert.deepEqual(x.calls.header, [], name);
      assert.deepEqual(x.calls.send, [], name);
      assert.equal(x.calls.hijack, 1, name);
    }
  });

  it("records the abort once across two response paths and never consumes L2", () => {
    const { gate, spy, evidence } = gateFixture();
    evidence.drain();
    const x = fakeExchange({ destroyed: true });
    gate.rejectWith(x.request, x.reply, "UNAUTHORIZED");
    gate.deliver(x.request, x.reply, "INTERNAL_ERROR");
    assert.equal(spy.calls.recordAbortedBeforeResponse, 1);
    assert.equal(spy.calls.consumeRejectionAllowance, 0);
    assert.equal(x.calls.hijack, 2);
    assert.equal(gate.individualRejectionOf(x.request), undefined);
    const d = evidence.drain().delta;
    assert.equal(d.abortedBeforeResponse, 1);
    assert.equal(d.layers.L2.individualRejections, 0);
  });

  it("swallows a throwing recordAbortedBeforeResponse and a throwing hijack", () => {
    const { gate, spy } = gateFixture({
      recordAbortedBeforeResponse: () => {
        throw new Error("record failed");
      },
    });
    const x = fakeExchange({ destroyed: true, hijackThrows: true });
    assert.doesNotThrow(() => gate.deliver(x.request, x.reply, 202));
    assert.doesNotThrow(() => gate.rejectWith(x.request, x.reply, "NOT_FOUND"));
    assert.equal(spy.calls.recordAbortedBeforeResponse, 1);
    assert.equal(x.calls.hijack, 2);
    assert.deepEqual([x.calls.code, x.calls.header, x.calls.send], [[], [], []]);
  });

  it("keeps a denial decided before the abort in limited", () => {
    const { gate, evidence, denial } = gateFixture();
    evidence.drain();
    const d = denial();
    const x = fakeExchange({ destroyed: true });
    gate.send429(x.request, x.reply, d);
    const delta = evidence.drain().delta;
    assert.equal(delta.layers.L1.limited, 1);
    assert.equal(delta.abortedBeforeResponse, 1);
    assert.equal(x.calls.warn, 1, "the decision is still logged");
  });

  it("never hijacks a live reply", () => {
    const { gate, denial } = gateFixture();
    const accepted = fakeExchange({ destroyed: false });
    gate.deliver(accepted.request, accepted.reply, 202);
    assert.deepEqual(accepted.calls.code, [202]);
    assert.deepEqual(accepted.calls.send, [{ status: "ACCEPTED", requestId: "req-unit" }]);
    assert.equal(accepted.calls.hijack, 0);

    const limited = fakeExchange({ destroyed: false });
    gate.send429(limited.request, limited.reply, denial());
    assert.deepEqual(limited.calls.code, [429]);
    assert.deepEqual(limited.calls.header, [["retry-after", "1000"], ["connection", "close"]]);
    assert.deepEqual(limited.calls.send, [{ error: "TOO_MANY_REQUESTS", requestId: "req-unit" }]);
    assert.equal(limited.calls.hijack, 0);

    const rejected = fakeExchange({ destroyed: false });
    gate.rejectWith(rejected.request, rejected.reply, "UNAUTHORIZED");
    assert.deepEqual(rejected.calls.code, [401]);
    assert.equal(rejected.calls.hijack, 0);
    assert.equal(gate.individualRejectionOf(rejected.request), "UNAUTHORIZED");
  });
});

describe("T12: throwing warning log (unit)", () => {
  it("live reply: exactly one generic 500, no Retry-After, fault counted, denial kept", () => {
    const { gate, evidence, denial } = gateFixture();
    evidence.drain();
    const d = denial();
    const x = fakeExchange({ destroyed: false, warnThrows: true });
    gate.send429(x.request, x.reply, d);
    assert.deepEqual(x.calls.code, [500]);
    assert.deepEqual(x.calls.header, []);
    assert.deepEqual(x.calls.send, [{ error: "INTERNAL_ERROR", requestId: "req-unit" }]);
    assert.equal(x.calls.hijack, 0);
    const delta = evidence.drain().delta;
    assert.equal(delta.limiterFaults, 1);
    assert.equal(delta.layers.L1.limited, 1);
  });

  it("destroyed reply: nothing written, abort counted", () => {
    const { gate, evidence, denial } = gateFixture();
    evidence.drain();
    const d = denial();
    const x = fakeExchange({ destroyed: true, warnThrows: true });
    gate.send429(x.request, x.reply, d);
    assert.deepEqual([x.calls.code, x.calls.header, x.calls.send], [[], [], []]);
    const delta = evidence.drain().delta;
    assert.equal(delta.abortedBeforeResponse, 1);
    assert.equal(delta.limiterFaults, 1);
    assert.equal(delta.layers.L1.limited, 1);
  });
});
