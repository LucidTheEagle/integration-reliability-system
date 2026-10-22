import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import type { RateLimitPolicies, RateLimiter } from "./rate-limit.js";
import { closeWithGrace } from "./server.js";
import type { ServerOptions } from "./server.js";
import {
  INTEGRATION_ID,
  LogCapture,
  RecordingHandoff,
  envelopeJson,
  listen,
  makeApp,
  parseJson,
  rawExchange,
  sign,
  spyLimiter,
  validRequest,
} from "./test-helpers.js";
import type { LimiterSpy } from "./test-helpers.js";

const PATH = `/api/webhooks/${INTEGRATION_ID}`;

let current: FastifyInstance | undefined;
afterEach(async () => {
  if (current !== undefined) {
    await closeWithGrace(current, 500);
    current = undefined;
  }
});

function head(extraHeaders: string[], path: string = PATH): string {
  return [
    `POST ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Connection: close",
    ...extraHeaders,
    "",
    "",
  ].join("\r\n");
}

/** Head and body in one write, so they travel in a single segment. */
function whole(headText: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(headText, "latin1"), body]);
}

async function startServer(
  options?: Parameters<typeof makeApp>[0],
  beforeListen?: (app: FastifyInstance) => void,
) {
  const t = makeApp(options);
  current = t.app;
  beforeListen?.(t.app);
  const port = await listen(t.app);
  return { ...t, port };
}

describe("real TCP - ambiguous headers", () => {
  it("answers duplicate IRS-Signature headers with a generic 401, from the original raw headers", async () => {
    const t = await startServer();
    const request = validRequest();
    const signature = request.headers["irs-signature"] as string;
    const response = await rawExchange(t.port, [
      whole(
        head([
          "Content-Type: application/json",
          `IRS-Signature: ${signature}`,
          `irs-signature: ${signature}`,
          `Content-Length: ${request.body.byteLength}`,
        ]),
        request.body,
      ),
    ]);
    assert.equal(response.status, 401);
    const flat = parseJson(response.body.slice(response.body.indexOf("{"))) as Record<string, unknown>;
    assert.deepEqual(Object.keys(flat).sort(), ["error", "requestId"]);
    assert.equal(flat.error, "UNAUTHORIZED");
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("answers duplicate IRS-Signature on an unconfigured ID with 401, before resolving a secret or reading the body", async () => {
    const t = await startServer();
    // Declares a body that is never transmitted.
    const response = await rawExchange(
      t.port,
      [
        head(
          [
            "Content-Type: application/json",
            "IRS-Signature: a",
            "IRS-Signature: b",
            "Content-Length: 500000",
          ],
          "/api/webhooks/11111111-2222-4333-8444-555555555555",
        ),
      ],
      { waitMs: 1_500 },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
  });

  it("answers duplicate Content-Type headers with 415, even though Node discards the second", async () => {
    const t = await startServer();
    const request = validRequest();
    const response = await rawExchange(t.port, [
      whole(
        head([
          "Content-Type: application/json",
          "Content-Type: application/json",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          `Content-Length: ${request.body.byteLength}`,
        ]),
        request.body,
      ),
    ]);
    assert.equal(response.status, 415);
    assert.ok(response.body.includes("UNSUPPORTED_MEDIA_TYPE"));
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
  });

  it("answers duplicate Content-Encoding headers with 415", async () => {
    const t = await startServer();
    const request = validRequest();
    const response = await rawExchange(t.port, [
      whole(
        head([
          "Content-Type: application/json",
          "Content-Encoding: identity",
          "Content-Encoding: identity",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          `Content-Length: ${request.body.byteLength}`,
        ]),
        request.body,
      ),
    ]);
    assert.equal(response.status, 415);
    assert.ok(response.body.includes("UNSUPPORTED_MEDIA_TYPE"));
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("rejects conflicting Content-Length headers", async () => {
    const t = await startServer();
    const request = validRequest();
    const response = await rawExchange(t.port, [
      Buffer.concat([
        Buffer.from(
          head([
            "Content-Type: application/json",
            `IRS-Signature: ${request.headers["irs-signature"]}`,
            `Content-Length: ${request.body.byteLength}`,
            `Content-Length: ${request.body.byteLength + 1}`,
          ]),
        ),
        request.body,
      ]),
    ]);
    // Node's HTTP parser rejects this before any application code runs. It
    // answers 400 and destroys the socket; the reset can race the client's
    // read, so the 400 itself may not be observable. What must hold is
    // that the connection ended and nothing was verified or handed off.
    assert.equal(response.closed, true);
    assert.ok(response.status === 400 || response.status === undefined);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("rejects a gzip Content-Encoding without decoding", async () => {
    const t = await startServer();
    const request = validRequest();
    const response = await rawExchange(t.port, [
      whole(
        head([
          "Content-Type: application/json",
          "Content-Encoding: gzip",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          `Content-Length: ${request.body.byteLength}`,
        ]),
        request.body,
      ),
    ]);
    assert.equal(response.status, 415);
    assert.equal(t.verifyInputs.length, 0);
  });
});

describe("real TCP - early rejection before the body is consumed", () => {
  it("answers a missing IRS-Signature with 401 while the declared body has not been sent", async () => {
    const t = await startServer();
    // Declares a 500 KB body but sends none of it; the response must not
    // depend on the body arriving.
    const response = await rawExchange(
      t.port,
      [
        head([
          "Content-Type: application/json",
          "Content-Length: 500000",
        ]),
      ],
      { waitMs: 1_500 },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("answers a missing IRS-Signature on a valid but unconfigured ID with 401 before resolving a secret or reading the body", async () => {
    const t = await startServer();
    // Declares a 500 KB body that is never transmitted.
    const response = await rawExchange(
      t.port,
      [
        head(
          ["Content-Type: application/json", "Content-Length: 500000"],
          "/api/webhooks/11111111-2222-4333-8444-555555555555",
        ),
      ],
      { waitMs: 1_500 },
    );
    assert.equal(response.status, 401);
    assert.ok(response.body.includes("UNAUTHORIZED"));
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("answers an unknown integration with 404 without waiting for the body", async () => {
    const t = await startServer();
    const response = await rawExchange(
      t.port,
      [
        head(
          ["Content-Type: application/json", "IRS-Signature: x", "Content-Length: 500000"],
          "/api/webhooks/11111111-2222-4333-8444-555555555555",
        ),
      ],
      { waitMs: 1_500 },
    );
    assert.equal(response.status, 404);
  });
});

describe("real TCP - streaming body limit", () => {
  it("rejects an oversized declared Content-Length with 413 before reading the body", async () => {
    const t = await startServer();
    const request = validRequest();
    const response = await rawExchange(
      t.port,
      [
        head([
          "Content-Type: application/json",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          `Content-Length: ${2 * 1_048_576}`,
        ]),
      ],
      { waitMs: 1_500 },
    );
    assert.equal(response.status, 413);
    assert.equal(t.verifyInputs.length, 0);
  });

  it("stops consuming a chunked body once the limit is exceeded", async () => {
    let bytesReadAtResponse: number | undefined;
    let statusAtResponse: number | undefined;
    const t = await startServer(undefined, (app) => {
      app.addHook("onResponse", (request, reply, done) => {
        bytesReadAtResponse = request.raw.socket.bytesRead;
        statusAtResponse = reply.statusCode;
        done();
      });
    });

    const request = validRequest();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const writes: Array<string | Buffer> = [
      head([
        "Content-Type: application/json",
        `IRS-Signature: ${request.headers["irs-signature"]}`,
        "Transfer-Encoding: chunked",
      ]),
    ];
    // 4 MiB offered in 64 KiB chunks against a 1 MiB limit.
    for (let i = 0; i < 64; i += 1) {
      writes.push(`${chunk.byteLength.toString(16)}\r\n`, chunk, "\r\n");
    }
    writes.push("0\r\n\r\n");

    const response = await rawExchange(t.port, writes, { gapMs: 5, waitMs: 3_000 });
    // The server must have answered 413 and closed the connection. The
    // client is still streaming when the server resets the socket, so the
    // 413 may or may not be readable on the client side; the server-side
    // hook is the authoritative record.
    assert.equal(statusAtResponse, 413);
    assert.equal(response.closed, true);
    assert.ok(response.status === 413 || response.status === undefined);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
    assert.ok(bytesReadAtResponse !== undefined);
    assert.ok(
      bytesReadAtResponse < 2 * 1_048_576,
      `server read ${bytesReadAtResponse} bytes of a 4 MiB body`,
    );
  });

  it("accepts a valid chunked body delivered in several pieces", async () => {
    const t = await startServer();
    const request = validRequest();
    const half = Math.floor(request.body.byteLength / 2);
    const first = request.body.subarray(0, half);
    const second = request.body.subarray(half);
    const response = await rawExchange(t.port, [
      head([
        "Content-Type: application/json",
        `IRS-Signature: ${request.headers["irs-signature"]}`,
        "Transfer-Encoding: chunked",
      ]),
      `${first.byteLength.toString(16)}\r\n`,
      first,
      "\r\n",
      `${second.byteLength.toString(16)}\r\n`,
      second,
      "\r\n0\r\n\r\n",
    ]);
    assert.equal(response.status, 202);
    const [handed] = t.handoff.requests;
    assert.equal(Buffer.compare(Buffer.from(handed?.rawBody ?? []), request.body), 0);
  });
});

describe("real TCP - timeouts", () => {
  it("terminates a request whose body never completes", async () => {
    const t = await startServer({
      server: { requestTimeoutMs: 400, headersTimeoutMs: 200 },
    });
    const request = validRequest();
    const response = await rawExchange(
      t.port,
      [
        head([
          "Content-Type: application/json",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          "Content-Length: 1000",
        ]),
        "{",
      ],
      { waitMs: 4_000 },
    );
    assert.equal(response.closed, true, "connection must be closed by the server");
    assert.ok(
      response.status === undefined || response.status === 408,
      `unexpected status ${String(response.status)}`,
    );
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("terminates a connection that never completes its headers", async () => {
    const t = await startServer({
      server: { requestTimeoutMs: 600, headersTimeoutMs: 200 },
    });
    const response = await rawExchange(
      t.port,
      [`POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n`],
      { waitMs: 4_000 },
    );
    assert.equal(response.closed, true);
    assert.equal(t.handoff.requests.length, 0);
  });
});

const CRLF = String.fromCharCode(13, 10);

describe("real TCP - router-level rejections", () => {
  it("answers malformed and over-long request targets with generic JSON errors", async () => {
    const t = await startServer();
    for (const [target, status, code] of [
      ["/api/webhooks/%zz-TCP-SENTINEL", 400, "BAD_REQUEST"],
      [`/api/webhooks/TCP-SENTINEL${"a".repeat(200)}`, 404, "NOT_FOUND"],
    ] as const) {
      const response = await rawExchange(
        t.port,
        [
          [
            `POST ${target} HTTP/1.1`,
            "Host: 127.0.0.1",
            "Connection: close",
            "Content-Type: application/json",
            "Content-Length: 2",
            "",
            "{}",
          ].join(CRLF),
        ],
        { waitMs: 2_000 },
      );
      assert.equal(response.status, status, target.slice(0, 40));
      assert.match(response.raw, /content-type: application\/json/i);
      const body = parseJson(response.body) as {
        error: string;
        requestId: string;
      };
      assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
      assert.equal(body.error, code);
      assert.match(body.requestId, /^[0-9a-f-]{36}$/);
      assert.ok(!response.raw.includes("TCP-SENTINEL"));
      assert.ok(!response.raw.includes("FST_ERR"));
    }
    assert.equal(t.resolved.length, 0);
    assert.equal(t.verifyInputs.length, 0);
    assert.ok(!t.logs.text().includes("TCP-SENTINEL"));
  });
});

describe("real TCP - binding and lifecycle", () => {
  it("binds to the loopback address", async () => {
    const t = await startServer();
    const address = t.app.server.address();
    assert.ok(address !== null && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
  });

  it("serves a keep-alive client, then closes idle connections and releases the port on shutdown", async () => {
    const t = await startServer();
    const socket = net.connect({ host: "127.0.0.1", port: t.port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const request = validRequest();
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    let received = "";
    socket.on("data", (data) => {
      received += data.toString("latin1");
    });
    socket.on("error", () => undefined);
    socket.write(
      [
        `POST ${PATH} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: keep-alive",
        "Content-Type: application/json",
        `IRS-Signature: ${request.headers["irs-signature"]}`,
        `Content-Length: ${request.body.byteLength}`,
        "",
        "",
      ].join("\r\n"),
    );
    socket.write(request.body);
    await new Promise((r) => setTimeout(r, 200));
    assert.match(received, /^HTTP\/1\.1 202/);

    const started = Date.now();
    await closeWithGrace(t.app, 3_000);
    await closed;
    assert.ok(Date.now() - started < 2_500, "idle connection must not delay shutdown");
    current = undefined;

    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const probe = net.connect({ host: "127.0.0.1", port: t.port });
        probe.once("connect", () => {
          probe.destroy();
          resolve();
        });
        probe.once("error", reject);
      }),
    );
  });

  it("lets an in-flight request finish during graceful shutdown", async () => {
    const handoff = new RecordingHandoff(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "ACCEPTED" }), 300);
        }),
    );
    const t = await startServer({ handoff });
    const request = validRequest();
    const inflight = fetch(`http://127.0.0.1:${t.port}${PATH}`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    // Close only once the request is demonstrably in flight (inside the
    // handoff); closing earlier correctly yields 503 for a new request.
    const deadline = Date.now() + 3_000;
    while (handoff.requests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(handoff.requests.length, 1);
    await closeWithGrace(t.app, 3_000);
    current = undefined;
    const response = await inflight;
    assert.equal(response.status, 202);
  });

  it("forces remaining connections closed after the grace period", async () => {
    const t = await startServer({
      server: { requestTimeoutMs: 30_000, headersTimeoutMs: 30_000 },
    });
    const request = validRequest();
    const stalled = rawExchange(
      t.port,
      [
        head([
          "Content-Type: application/json",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          "Content-Length: 1000",
        ]),
        "{",
      ],
      { waitMs: 5_000 },
    );
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await closeWithGrace(t.app, 300);
    current = undefined;
    assert.ok(Date.now() - started < 2_000);
    const response = await stalled;
    assert.equal(response.closed, true);
  });

  it("uses a fresh server-generated request ID for each connection", async () => {
    const t = await startServer();
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const body = Buffer.from(envelopeJson({ externalEventId: `evt_${i}` }));
      const response = await fetch(`http://127.0.0.1:${t.port}${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "irs-signature": sign(body) },
        body,
      });
      ids.add(((await response.json()) as { requestId: string }).requestId);
    }
    assert.equal(ids.size, 3);
  });
});

// ---------------------------------------------------------------------------
// Task 011B: rate limiting over real sockets

const LOCAL = "127.0.0.1";

async function startLimited(
  options: {
    policies?: Partial<RateLimitPolicies>;
    /** F5: P2's precheck always allows, so consume-time conversion is reachable. */
    stubPeek?: boolean;
    server?: ServerOptions;
    logs?: LogCapture;
  } = {},
  beforeListen?: (app: FastifyInstance) => void,
) {
  let spy: LimiterSpy | undefined;
  const t = await startServer(
    {
      ...(options.server === undefined ? {} : { server: options.server }),
      ...(options.logs === undefined ? {} : { logs: options.logs }),
      rateLimit: {
        ...(options.policies === undefined ? {} : { policies: options.policies }),
        wrap: (inner) => {
          spy = spyLimiter(
            inner,
            options.stubPeek === true
              ? { peekRejectionAllowance: () => ({ allowed: true }) }
              : {},
          );
          return spy.limiter;
        },
      },
    },
    beforeListen,
  );
  const { limiter, evidence } = t;
  assert.ok(limiter !== undefined && evidence !== undefined && spy !== undefined);
  return { ...t, limiter, evidence, spy };
}

/** Takes the default capacity of one key's bucket (no denial is recorded). */
function exhaust(
  limiter: RateLimiter,
  layer: "L1" | "L2",
  /** Explicit: a default would also replace an intended undefined. */
  address: string | undefined,
): void {
  const peer = limiter.peerKey(address);
  const capacity = layer === "L1" ? 50 : 20;
  for (let i = 0; i < capacity; i += 1) {
    const decision =
      layer === "L1" ? limiter.consumeRequest(peer) : limiter.consumeRejectionAllowance(peer);
    assert.equal(decision.allowed, true);
  }
}

function signedHead(
  request: { body: Buffer; headers: Record<string, string> },
  contentLength: number,
): string {
  return head([
    "Content-Type: application/json",
    `IRS-Signature: ${request.headers["irs-signature"]}`,
    `Content-Length: ${contentLength}`,
  ]);
}

function assertTcp429(
  response: { raw: string; status: number | undefined; body: string; closed: boolean },
  retryAfter: string,
): void {
  assert.equal(response.status, 429);
  assert.match(response.raw, new RegExp(`\r\nretry-after: ${retryAfter}\r\n`, "i"));
  assert.match(response.raw, /\r\nconnection: close\r\n/i);
  assert.ok(!/ratelimit/i.test(response.raw));
  const body = parseJson(response.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
  assert.equal(body.error, "TOO_MANY_REQUESTS");
  assert.equal(response.closed, true, "socket closed by the server");
}

/** Every numeric (or boolean) leaf of a summary section. */
function leaves(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value ? 1 : 0];
  return Object.values(value as Record<string, unknown>).flatMap(leaves);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("real TCP - T6: 429 before the body is read", () => {
  it("T6a: L1 exhausted - a head declaring 1 MiB with no body gets 429 and a closed socket", async () => {
    const t = await startLimited();
    exhaust(t.limiter, "L1", LOCAL);
    const response = await rawExchange(t.port, [signedHead(validRequest(), 1_048_576)], {
      waitMs: 1_500,
    });
    assertTcp429(response, "1");
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("T6b: L2 exhausted (L1 available) - the precheck 429 arrives before the body", async () => {
    const t = await startLimited();
    exhaust(t.limiter, "L2", LOCAL);
    t.evidence.drain();
    const response = await rawExchange(t.port, [signedHead(validRequest(), 1_048_576)], {
      waitMs: 1_500,
    });
    assertTcp429(response, "30");
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    const delta = t.evidence.drain().delta;
    assert.equal(delta.layers.L2.limitedPrecheck, 1);
    assert.equal(delta.layers.L1.limited, 0);
  });
});

describe("real TCP - T8: 413 and router-level conversion", () => {
  it("an oversized declared Content-Length is an individual 413 with Connection: close", async () => {
    const t = await startLimited();
    const response = await rawExchange(t.port, [signedHead(validRequest(), 2 * 1_048_576)], {
      waitMs: 1_500,
    });
    assert.equal(response.status, 413);
    assert.match(response.raw, /\r\nconnection: close\r\n/i);
    assert.equal(t.evidence.drain().delta.layers.L2.individualRejections, 1);
  });

  it("with L2 exhausted the same 413 converts to 429 with Connection: close and Retry-After", async () => {
    const t = await startLimited({ stubPeek: true });
    exhaust(t.limiter, "L2", LOCAL);
    t.evidence.drain();
    const response = await rawExchange(t.port, [signedHead(validRequest(), 2 * 1_048_576)], {
      waitMs: 1_500,
    });
    assertTcp429(response, "30");
    assert.equal(t.evidence.drain().delta.layers.L2.limitedConverted, 1);
    assert.equal(t.verifyInputs.length, 0);
  });

  it("a router-level 400 converts to 429 once L2 is exhausted", async () => {
    const t = await startLimited();
    exhaust(t.limiter, "L2", LOCAL);
    t.evidence.drain();
    const response = await rawExchange(
      t.port,
      [
        [
          "POST /api/webhooks/%zz HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: close",
          "Content-Type: application/json",
          "Content-Length: 2",
          "",
          "{}",
        ].join(CRLF),
      ],
      { waitMs: 2_000 },
    );
    assertTcp429(response, "30");
    assert.equal(t.evidence.drain().delta.layers.L2.limitedConverted, 1);
    assert.equal(t.spy.calls.consumeRequest, 1);
    assert.equal(t.spy.calls.peekRejectionAllowance, 0);
  });
});

describe("real TCP - T10: requests that are never answered by the application", () => {
  it("body stall: at most one response, abort recorded once, no L2 charge, no completion log", { timeout: 15_000 }, async () => {
    const logs = new LogCapture();
    let onErrorCalls = 0;
    const t = await startLimited(
      { server: { requestTimeoutMs: 400, headersTimeoutMs: 200 }, logs },
      (app) => {
        app.addHook("onError", async () => {
          onErrorCalls += 1;
        });
      },
    );
    const started = Date.now();
    const response = await rawExchange(t.port, [signedHead(validRequest(), 1_000), "{"], {
      waitMs: 4_000,
    });
    assert.equal(response.closed, true);
    assert.ok(
      response.status === undefined || response.status === 408,
      `unexpected status ${String(response.status)}`,
    );
    assert.ok((response.raw.match(/HTTP\/1\.[01] /g) ?? []).length <= 1, "at most one status line");

    // Past handlerTimeout (requestTimeout + 5 s): no second error-handler run.
    await sleep(Math.max(0, 5_900 - (Date.now() - started)));
    assert.equal(onErrorCalls, 1);
    const delta = t.evidence.drain().delta;
    assert.equal(delta.abortedBeforeResponse, 1);
    assert.equal(delta.layers.L2.individualRejections, 0);
    assert.equal(t.spy.calls.consumeRequest, 1);
    assert.equal(t.spy.calls.consumeRejectionAllowance, 0);
    assert.ok(!logs.records().some((r) => r.msg === "request completed"));
    assert.ok(!/already sent/i.test(logs.text()));
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);

    const closing = Date.now();
    await closeWithGrace(t.app, 3_000);
    current = undefined;
    assert.ok(Date.now() - closing < 1_000, "shutdown is not delayed");
  });

  it("header stall: no limiter call and an all-zero drain", { timeout: 10_000 }, async () => {
    const t = await startLimited({ server: { requestTimeoutMs: 600, headersTimeoutMs: 200 } });
    const response = await rawExchange(
      t.port,
      [`POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n`],
      { waitMs: 4_000 },
    );
    assert.equal(response.closed, true);
    assert.deepEqual(Object.values(t.spy.calls).filter((n) => n !== 0), []);
    const summary = t.evidence.drain();
    assert.ok(leaves(summary.delta).every((n) => n === 0));
    assert.ok(leaves(summary.distinctKeys).every((n) => n === 0));
    for (const gauge of Object.values(summary.gauges)) assert.equal(gauge.tableSize, 0);
  });

  it("malformed HTTP (conflicting Content-Length): no limiter call", async () => {
    const t = await startLimited();
    const request = validRequest();
    const response = await rawExchange(t.port, [
      whole(
        head([
          "Content-Type: application/json",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          `Content-Length: ${request.body.byteLength}`,
          `Content-Length: ${request.body.byteLength + 1}`,
        ]),
        request.body,
      ),
    ]);
    assert.equal(response.closed, true);
    assert.deepEqual(Object.values(t.spy.calls).filter((n) => n !== 0), []);
  });
});

describe("real TCP - DEV-1: a destroyed reply at P2 ends the lifecycle", () => {
  for (const [name, layer] of [
    ["case a: L1 exhausted", "L1"],
    ["case b: L2 exhausted (precheck)", "L2"],
  ] as const) {
    it(`DEV-1 P2 destroyed (${name}): no body parsing, handler, verifier, L3 or handoff`, { timeout: 10_000 }, async () => {
      const stages = { preParsing: 0, preHandler: 0 };
      const t = await startLimited({}, (app) => {
        // Runs before Fastify's own request listener, so P2 sees a destroyed reply.
        app.server.prependListener("request", (_request, response) => {
          response.destroy();
        });
        app.addHook("preParsing", async (_request, _reply, payload) => {
          stages.preParsing += 1;
          return payload;
        });
        app.addHook("preHandler", async () => {
          stages.preHandler += 1;
        });
      });
      // The socket address may read as undefined once destroyed.
      exhaust(t.limiter, layer, LOCAL);
      exhaust(t.limiter, layer, undefined);
      t.evidence.drain();

      const request = validRequest();
      const response = await rawExchange(
        t.port,
        [whole(signedHead(request, request.body.byteLength), request.body)],
        { waitMs: 2_000 },
      );
      await sleep(200);
      assert.equal(response.closed, true);
      assert.deepEqual(
        {
          preParsing: stages.preParsing,
          preHandler: stages.preHandler,
          verifyInputs: t.verifyInputs.length,
          consumeVerified: t.spy.calls.consumeVerified,
          handoff: t.handoff.requests.length,
          consumeRejectionAllowance: t.spy.calls.consumeRejectionAllowance,
          resolved: t.resolved.length,
        },
        {
          preParsing: 0,
          preHandler: 0,
          verifyInputs: 0,
          consumeVerified: 0,
          handoff: 0,
          consumeRejectionAllowance: 0,
          resolved: 0,
        },
        "stages reached after a destroyed P2 denial",
      );
      const delta = t.evidence.drain().delta;
      assert.equal(delta.abortedBeforeResponse, 1);
      if (layer === "L1") assert.equal(delta.layers.L1.limited, 1);
      else assert.equal(delta.layers.L2.limitedPrecheck, 1);
    });
  }
});

describe("real TCP - Task 011A AD-11: closeWithGrace reports { forced }", () => {
  it("an in-flight request that finishes within the grace period (Connection: close) → { forced: false }", async () => {
    const handoff = new RecordingHandoff(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "ACCEPTED" }), 300);
        }),
    );
    const t = await startServer({ handoff });
    const request = validRequest();
    // Connection: close, so no keep-alive connection outlives the response.
    const inflight = rawExchange(
      t.port,
      [
        whole(
          head([
            "Content-Type: application/json",
            `IRS-Signature: ${request.headers["irs-signature"]}`,
            `Content-Length: ${request.body.byteLength}`,
          ]),
          request.body,
        ),
      ],
      { waitMs: 5_000 },
    );
    const deadline = Date.now() + 3_000;
    while (handoff.requests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(handoff.requests.length, 1);
    const result = await closeWithGrace(t.app, 3_000);
    current = undefined;
    assert.deepEqual(result, { forced: false });
    assert.equal((await inflight).status, 202);
  });

  it("a connection still open when the grace period expires → { forced: true }", async () => {
    const t = await startServer({
      server: { requestTimeoutMs: 30_000, headersTimeoutMs: 30_000 },
    });
    const request = validRequest();
    const stalled = rawExchange(
      t.port,
      [
        head([
          "Content-Type: application/json",
          `IRS-Signature: ${request.headers["irs-signature"]}`,
          "Content-Length: 1000",
        ]),
        "{",
      ],
      { waitMs: 5_000 },
    );
    await new Promise((r) => setTimeout(r, 200));
    const result = await closeWithGrace(t.app, 300);
    current = undefined;
    assert.deepEqual(result, { forced: true });
    assert.equal((await stalled).closed, true);
  });
});
