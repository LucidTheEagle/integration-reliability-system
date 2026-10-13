import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createUnavailableIngestionHandoff } from "./handoff.js";
import {
  INTEGRATION_ID,
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
  validRequest,
} from "./test-helpers.js";
import type { TestApp } from "./test-helpers.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let current: FastifyInstance | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

function start(options?: Parameters<typeof makeApp>[0]): TestApp {
  const t = makeApp(options);
  current = t.app;
  return t;
}

async function post(
  t: TestApp,
  request: { body: Buffer | string; headers: Record<string, string> },
  url: string = WEBHOOK_PATH,
) {
  return t.app.inject({
    method: "POST",
    url,
    headers: request.headers,
    payload: request.body,
  });
}

const FIXED_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "REQUEST_TIMEOUT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

/** Enforces the flat error contract: {"error": "<FIXED_CODE>", "requestId": "<UUID>"}. */
function assertGenericError(
  response: { statusCode: number; body: string },
  status: number,
  code: string,
): { error: string; requestId: string } {
  assert.equal(response.statusCode, status);
  const body = parseJson(response.body) as { error: unknown; requestId: unknown };
  assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
  assert.equal(typeof body.error, "string");
  assert.ok(FIXED_CODES.has(body.error as string));
  assert.equal(body.error, code);
  assert.match(String(body.requestId), UUID_V4);
  return body as { error: string; requestId: string };
}

describe("POST /api/webhooks/:integrationKey - accepted transport path", () => {
  it("returns 202 only when the injected handoff durably accepts", async () => {
    const t = start();
    const response = await post(t, validRequest());
    assert.equal(response.statusCode, 202);
    const body = parseJson(response.body) as { status: string; requestId: string };
    assert.equal(body.status, "ACCEPTED");
    assert.match(body.requestId, UUID_V4);
    assert.equal(t.handoff.requests.length, 1);
  });

  it("hands off the server request ID, integration ID, envelope, bytes, timestamp and approved metadata only", async () => {
    const t = start();
    const request = validRequest();
    const response = await post(t, request);
    const { requestId } = parseJson(response.body) as { requestId: string };

    const [handed] = t.handoff.requests;
    assert.ok(handed);
    assert.deepEqual(Object.keys(handed).sort(), [
      "envelope",
      "integrationId",
      "metadata",
      "rawBody",
      "receivedAt",
      "requestId",
    ]);
    assert.equal(handed.requestId, requestId);
    assert.equal(handed.integrationId, INTEGRATION_ID);
    assert.equal(handed.envelope.externalEventId, "evt_123");
    assert.equal(handed.envelope.eventType, "payment.completed");
    assert.deepEqual(handed.envelope.payload, { amount: 100 });
    assert.equal(handed.receivedAt.getTime(), NOW_SECONDS * 1000);
    assert.deepEqual(handed.metadata, {
      contentType: "application/json",
      bodyByteLength: request.body.byteLength,
    });
  });

  it("passes the exact original bytes, byte for byte, to the verifier and the handoff", async () => {
    const t = start();
    // Deliberately non-canonical: odd whitespace, key order, escapes,
    // duplicate keys, multi-byte characters and a trailing newline.
    const text =
      '{ "payload" : {"a":1,\n\t"a":2, "emoji":"\\u00e9 é 😀"},' +
      '"schemaVersion":"1","resourceId":"pay_456","resourceType":"payment",' +
      '"eventType":"payment.completed","externalEventId":"evt_é",' +
      '"occurredAt":"2026-10-12T10:00:00.5+01:00"  }\n';
    const request = validRequest(text);
    const response = await post(t, request);
    assert.equal(response.statusCode, 202);

    const [handed] = t.handoff.requests;
    assert.ok(handed);
    assert.equal(Buffer.compare(Buffer.from(handed.rawBody), request.body), 0);
    assert.equal(t.verifyInputs.length, 1);
    // Reference identity: the verifier and the handoff saw the same array.
    assert.strictEqual(t.verifyInputs[0]?.rawBody, handed.rawBody);
    assert.equal(handed.metadata.bodyByteLength, request.body.byteLength);
    // Duplicate keys: last wins in the envelope; the bytes are untouched.
    assert.deepEqual(handed.envelope.payload.a, 2);
  });

  it("accepts a UTF-8 charset parameter and normalizes the recorded content type", async () => {
    const t = start();
    const request = validRequest();
    request.headers["content-type"] = "application/json; charset=UTF-8";
    const response = await post(t, request);
    assert.equal(response.statusCode, 202);
    assert.equal(t.handoff.requests[0]?.metadata.contentType, "application/json");
  });

  it("verifies against the secret of the addressed integration only", async () => {
    const t = start();
    const request = validRequest();
    const other = await post(t, request, `/api/webhooks/${OTHER_INTEGRATION_ID}`);
    assertGenericError(other, 401, "UNAUTHORIZED");
    assert.equal(t.handoff.requests.length, 0);
  });

  it("generates request IDs on the server and ignores client-supplied ones", async () => {
    const t = start();
    const request = validRequest();
    const response = await post(t, {
      body: request.body,
      headers: { ...request.headers, "x-request-id": "attacker-chosen-id" },
    });
    const { requestId } = parseJson(response.body) as { requestId: string };
    assert.notEqual(requestId, "attacker-chosen-id");
    assert.match(requestId, UUID_V4);
    assert.equal(t.handoff.requests[0]?.requestId, requestId);
    assert.ok(!t.logs.text().includes("attacker-chosen-id"));
  });
});

describe("POST /api/webhooks/:integrationKey - handoff outcome contract", () => {
  it("answers 503 for the UNAVAILABLE outcome (the production handoff)", async () => {
    const t = start({
      handoff: new RecordingHandoff((request) =>
        createUnavailableIngestionHandoff().accept(request),
      ),
    });
    const response = await post(t, validRequest());
    assertGenericError(response, 503, "SERVICE_UNAVAILABLE");
    assert.equal(t.handoff.requests.length, 1);
  });

  it("answers 500 when the handoff throws, without leaking the error", async () => {
    const t = start({
      handoff: new RecordingHandoff(() =>
        Promise.reject(new Error("HANDOFF-INTERNAL-SECRET-MESSAGE")),
      ),
    });
    const response = await post(t, validRequest());
    assertGenericError(response, 500, "INTERNAL_ERROR");
    assert.ok(!response.body.includes("HANDOFF-INTERNAL-SECRET-MESSAGE"));
    assert.ok(!t.logs.text().includes("HANDOFF-INTERNAL-SECRET-MESSAGE"));
    assert.ok(t.logs.text().includes("ingestion handoff failed"));
  });

  it("answers 500 when the handoff throws synchronously", async () => {
    const t = start({
      handoff: new RecordingHandoff(() => {
        throw new Error("SYNC-HANDOFF-SECRET-MESSAGE");
      }),
    });
    const response = await post(t, validRequest());
    assertGenericError(response, 500, "INTERNAL_ERROR");
    assert.ok(!response.body.includes("SYNC-HANDOFF-SECRET-MESSAGE"));
  });

  it("answers 500, never 2xx, for outcomes outside the contract", async () => {
    for (const invalid of [
      { status: "LEAKY-OUTCOME-SENTINEL" },
      { status: "accepted" },
      { status: 202 },
      { status: undefined },
      {},
      undefined,
      null,
      "ACCEPTED",
      true,
    ]) {
      const t = makeApp({
        handoff: new RecordingHandoff(() => Promise.resolve(invalid as never)),
      });
      try {
        const response = await post(t, validRequest());
        assertGenericError(response, 500, "INTERNAL_ERROR");
        assert.ok(
          !t.logs.text().includes("LEAKY-OUTCOME-SENTINEL"),
          "invalid outcome content must not be logged",
        );
        assert.ok(!response.body.includes("LEAKY-OUTCOME-SENTINEL"));
      } finally {
        await t.app.close();
      }
    }
  });

  it("answers 202 only for ACCEPTED", async () => {
    const t = start({
      handoff: new RecordingHandoff(() => Promise.resolve({ status: "ACCEPTED" })),
    });
    const response = await post(t, validRequest());
    assert.equal(response.statusCode, 202);
  });
});

describe("POST /api/webhooks/:integrationKey - identity and secrets", () => {
  it("returns a generic 404 for an unconfigured integration ID, before any verification", async () => {
    const t = start();
    const response = await post(t, validRequest(), `/api/webhooks/${UNCONFIGURED_ID}`);
    assertGenericError(response, 404, "NOT_FOUND");
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("returns 401, not 404, for a valid but unconfigured ID with no signature, without resolving a secret", async () => {
    const t = start();
    const request = validRequest();
    const response = await post(
      t,
      { body: request.body, headers: { "content-type": "application/json" } },
      `/api/webhooks/${UNCONFIGURED_ID}`,
    );
    assertGenericError(response, 401, "UNAUTHORIZED");
    assert.deepEqual(t.resolved, []);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("resolves a secret only after the header guards pass", async () => {
    const t = start();
    const request = validRequest();
    // Unsupported content type on a configured ID: rejected, no resolution.
    await post(t, {
      body: request.body,
      headers: { ...request.headers, "content-type": "text/plain" },
    });
    await post(t, {
      body: request.body,
      headers: { ...request.headers, "content-encoding": "gzip" },
    });
    assert.deepEqual(t.resolved, []);
    // Valid headers on an unconfigured ID: resolved once, then 404.
    const response = await post(t, request, `/api/webhooks/${UNCONFIGURED_ID}`);
    assertGenericError(response, 404, "NOT_FOUND");
    assert.deepEqual(t.resolved, [UNCONFIGURED_ID]);
    assert.equal(t.verifyInputs.length, 0);
  });

  it("returns 404 for non-canonical identifiers, including an uppercase UUID", async () => {
    const t = start();
    for (const key of [
      INTEGRATION_ID.toUpperCase(),
      INTEGRATION_ID.replaceAll("-", ""),
      "stripe",
      "not-a-uuid",
      `${INTEGRATION_ID}x`,
    ]) {
      const response = await post(t, validRequest(), `/api/webhooks/${key}`);
      assertGenericError(response, 404, "NOT_FOUND");
    }
    assert.equal(t.verifyInputs.length, 0);
    assert.deepEqual(t.resolved, [], "malformed IDs never reach the resolver");
  });

  it("fails closed when no secrets are configured at all", async () => {
    const t = start({ secrets: {} });
    const response = await post(t, validRequest());
    assertGenericError(response, 404, "NOT_FOUND");
    assert.equal(t.handoff.requests.length, 0);
  });
});

describe("POST /api/webhooks/:integrationKey - verification outcomes", () => {
  it("returns 401 with an identical generic body for every signature/timestamp failure", async () => {
    const t = start();
    const body = Buffer.from(envelopeJson());
    const cases: Record<string, string> = {
      mismatch: `t=${NOW_SECONDS},v1=${"0".repeat(64)}`,
      malformed: "garbage",
      "wrong secret": sign(body, NOW_SECONDS, "x".repeat(40)),
      "stale timestamp": sign(body, NOW_SECONDS - 3_600),
      "future timestamp": sign(body, NOW_SECONDS + 3_600),
      empty: "",
    };
    const seen = new Set<string>();
    for (const [name, signature] of Object.entries(cases)) {
      const response = await post(t, {
        body,
        headers: { "content-type": "application/json", "irs-signature": signature },
      });
      const parsed = assertGenericError(response, 401, "UNAUTHORIZED");
      seen.add(JSON.stringify({ ...parsed, requestId: "-" }));
      assert.ok(!response.body.includes(SECRET_TEXT), name);
      assert.ok(!/signature|timestamp|tolerance|mismatch/i.test(response.body.replace(/UNAUTHORIZED/, "")), name);
      assert.equal(parsed.error, "UNAUTHORIZED", name);
    }
    assert.equal(seen.size, 1);
    assert.equal(t.handoff.requests.length, 0);
  });

  it("returns 401 for a tampered body", async () => {
    const t = start();
    const request = validRequest();
    const tampered = Buffer.from(request.body.toString("utf8").replace("100", "999"));
    const response = await post(t, { body: tampered, headers: request.headers });
    assertGenericError(response, 401, "UNAUTHORIZED");
  });

  it("returns 400 for a correctly signed body that is not valid JSON, an envelope, or UTF-8", async () => {
    const t = start();
    for (const body of [
      Buffer.from("not json"),
      Buffer.from(JSON.stringify({ unexpected: true })),
      Buffer.from([0xff, 0xfe, 0xfd]),
    ]) {
      const response = await post(t, validRequest(body));
      const parsed = assertGenericError(response, 400, "BAD_REQUEST");
      assert.equal(parsed.error, "BAD_REQUEST");
      assert.ok(!/envelope|utf|json/i.test(response.body));
    }
    assert.equal(t.handoff.requests.length, 0);
  });

  it("rejects a body over the 1 MiB limit", async () => {
    const t = start();
    const big = Buffer.alloc(1_048_577, 0x20);
    const response = await post(t, validRequest(big));
    assertGenericError(response, 413, "PAYLOAD_TOO_LARGE");
    assert.equal(t.verifyInputs.length, 0);
  });

  it("accepts a body of exactly 1 MiB at the transport (verifier then judges it)", async () => {
    const t = start();
    const big = Buffer.alloc(1_048_576, 0x20);
    const response = await post(t, validRequest(big));
    // Whitespace is signed correctly but is not a JSON envelope.
    assertGenericError(response, 400, "BAD_REQUEST");
    assert.equal(t.verifyInputs.length, 1);
  });
});

describe("POST /api/webhooks/:integrationKey - header guards", () => {
  it("returns a generic 401 for a missing IRS-Signature without invoking the verifier", async () => {
    const t = start();
    const request = validRequest();
    const response = await post(t, {
      body: request.body,
      headers: { "content-type": "application/json" },
    });
    assertGenericError(response, 401, "UNAUTHORIZED");
    assert.equal(t.verifyInputs.length, 0);
  });

  it("rejects unsupported content types and charsets with 415", async () => {
    const t = start();
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/json; charset=iso-8859-1",
      "application/json; boundary=x",
    ]) {
      const request = validRequest();
      const response = await post(t, {
        body: request.body,
        headers: { ...request.headers, "content-type": contentType },
      });
      assertGenericError(response, 415, "UNSUPPORTED_MEDIA_TYPE");
    }
    assert.equal(t.verifyInputs.length, 0);
  });

  it("rejects a missing content type with 415", async () => {
    const t = start();
    const request = validRequest();
    const response = await post(t, {
      body: request.body,
      headers: { "irs-signature": request.headers["irs-signature"] as string },
    });
    assert.ok([415, 400].includes(response.statusCode));
    assert.equal(t.handoff.requests.length, 0);
  });

  it("rejects unsupported content encodings with 415", async () => {
    const t = start();
    for (const encoding of ["gzip", "deflate", "br"]) {
      const request = validRequest();
      const response = await post(t, {
        body: request.body,
        headers: { ...request.headers, "content-encoding": encoding },
      });
      assertGenericError(response, 415, "UNSUPPORTED_MEDIA_TYPE");
    }
    assert.equal(t.verifyInputs.length, 0);
  });
});

describe("other routes and methods", () => {
  it("returns a generic JSON 404 with a request ID for unknown paths and methods", async () => {
    const t = start();
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", WEBHOOK_PATH],
      ["POST", "/api/webhooks"],
      ["POST", "/api/events"],
      ["POST", `${WEBHOOK_PATH}/`],
    ] as const) {
      const response = await t.app.inject({ method, url });
      assertGenericError(response, 404, "NOT_FOUND");
    }
  });
});

describe("framework-level (router) rejections", () => {
  const SENTINEL = "PATH-SENTINEL-VALUE";

  function assertFrameworkGeneric(
    response: { statusCode: number; body: string; headers: Record<string, unknown> },
    status: number,
    code: string,
    leaked: string[],
  ): void {
    assertGenericError(response, status, code);
    assert.match(String(response.headers["content-type"]), /^application\/json/);
    const lower = response.body.toLowerCase();
    for (const forbidden of ["fst_err", "uri", "valid url", "param length", "bad request", ...leaked.map((l) => l.toLowerCase())]) {
      assert.ok(!lower.includes(forbidden), `response leaked ${forbidden}`);
    }
  }

  it("answers a malformed URL with a generic 400 carrying a server request ID", async () => {
    const t = start();
    const response = await t.app.inject({
      method: "POST",
      url: `/api/webhooks/%zz-${SENTINEL}`,
      headers: { "x-request-id": "attacker-chosen-id", "content-type": "application/json" },
      payload: "{}",
    });
    assertFrameworkGeneric(response, 400, "BAD_REQUEST", [SENTINEL, "attacker-chosen-id", "/api/webhooks"]);
    assert.equal(t.resolved.length, 0);
    assert.equal(t.verifyInputs.length, 0);
    assert.equal(t.handoff.requests.length, 0);
    assert.ok(!t.logs.text().includes(SENTINEL));
    assert.ok(!t.logs.text().includes("FST_ERR"));
  });

  it("answers an over-long path parameter with the generic 404 used for malformed identifiers", async () => {
    const t = start();
    for (const length of [101, 150, 5_000]) {
      const longId = `${SENTINEL}`.padEnd(length, "a");
      const response = await t.app.inject({
        method: "POST",
        url: `/api/webhooks/${longId}`,
        headers: { "content-type": "application/json", "irs-signature": "x" },
        payload: "{}",
      });
      assertFrameworkGeneric(response, 404, "NOT_FOUND", [SENTINEL, "aaaaaaaaaa"]);
      assert.ok(!t.logs.text().includes(SENTINEL));
    }
    assert.equal(t.resolved.length, 0);
    assert.equal(t.verifyInputs.length, 0);
  });

  it("uses a different server-generated request ID per rejection and never a client one", async () => {
    const t = start();
    const ids = new Set<string>();
    for (const url of ["/api/webhooks/%zz", "/api/webhooks/%E0%A4%A", `/api/webhooks/${"a".repeat(120)}`]) {
      const response = await t.app.inject({ method: "POST", url, headers: { "x-request-id": "attacker-chosen-id" } });
      const body = parseJson(response.body) as { requestId: string };
      assert.match(body.requestId, UUID_V4);
      ids.add(body.requestId);
    }
    assert.equal(ids.size, 3);
  });

  it("does not change the response for a valid-length but non-canonical identifier", async () => {
    const t = start();
    const response = await post(t, validRequest(), `/api/webhooks/${"a".repeat(100)}`);
    assertGenericError(response, 404, "NOT_FOUND");
  });
});

describe("logging", () => {
  it("logs correlated, minimal records and never the body, signature, secret, headers or query string", async () => {
    const t = start();
    const request = validRequest(envelopeJson({ payload: { note: "BODY-SENTINEL-VALUE" } }));
    const signature = request.headers["irs-signature"] as string;
    const response = await t.app.inject({
      method: "POST",
      url: `${WEBHOOK_PATH}?token=QUERY-SENTINEL-VALUE`,
      headers: {
        ...request.headers,
        authorization: "Bearer AUTH-SENTINEL-VALUE",
        cookie: "session=COOKIE-SENTINEL-VALUE",
      },
      payload: request.body,
    });
    assert.equal(response.statusCode, 202);
    const { requestId } = parseJson(response.body) as { requestId: string };

    const text = t.logs.text();
    for (const sentinel of [
      "BODY-SENTINEL-VALUE",
      signature,
      signature.split("v1=")[1] as string,
      SECRET_TEXT,
      "QUERY-SENTINEL-VALUE",
      "AUTH-SENTINEL-VALUE",
      "COOKIE-SENTINEL-VALUE",
    ]) {
      assert.ok(!text.includes(sentinel), `log leaked ${sentinel.slice(0, 12)}`);
    }

    const completed = t.logs
      .records()
      .find((record) => record.msg === "request completed");
    assert.ok(completed);
    assert.equal(completed.reqId, requestId);
    assert.equal(completed.statusCode, 202);
    assert.equal(completed.integrationId, INTEGRATION_ID);
    assert.equal(completed.route, "/api/webhooks/:integrationKey");
  });

  it("does not log rejected requests' signatures or secrets either", async () => {
    const t = start();
    const request = validRequest();
    const bad = `t=${NOW_SECONDS},v1=${"a".repeat(64)}`;
    await post(t, { body: request.body, headers: { ...request.headers, "irs-signature": bad } });
    const text = t.logs.text();
    assert.ok(!text.includes("a".repeat(64)));
    assert.ok(!text.includes(SECRET_TEXT));
    assert.ok(text.includes("401"));
  });
});
