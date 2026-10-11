import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { FailureClass } from "@irs/domain";
import { verifyIrsV1Webhook } from "../index.js";
import type {
  VerifyIrsV1WebhookInput,
  VerifyIrsV1WebhookResult,
  WebhookRejectionReason,
} from "../index.js";

// ---------------------------------------------------------------------
// Test helpers. Signatures are computed here, independently of the
// implementation, directly from the documented protocol:
//   HMAC-SHA256(secret, `${timestampDigits}.` + rawBodyBytes) as hex.
// ---------------------------------------------------------------------
const SECRET = Buffer.from("irs-unit-test-secret-0123456789ab");
const NOW_SECONDS = 1_760_000_000;
const NOW = new Date(NOW_SECONDS * 1000);

function sign(
  body: Uint8Array,
  timestamp: number | string,
  secret: Uint8Array = SECRET,
): string {
  return createHmac("sha256", secret)
    .update(Buffer.from(`${timestamp}.`, "ascii"))
    .update(body)
    .digest("hex");
}

function header(timestamp: number | string, signatureHex: string): string {
  return `t=${timestamp},v1=${signatureHex}`;
}

function validHeader(body: Uint8Array, timestamp = NOW_SECONDS): string {
  return header(timestamp, sign(body, timestamp));
}

function inputFor(
  body: Uint8Array,
  overrides: Partial<VerifyIrsV1WebhookInput> = {},
): VerifyIrsV1WebhookInput {
  return {
    rawBody: body,
    signatureHeader: validHeader(body),
    secret: SECRET,
    now: NOW,
    ...overrides,
  };
}

function envelopeObject(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    externalEventId: "evt_123",
    eventType: "payment.completed",
    resourceType: "payment",
    resourceId: "pay_456",
    occurredAt: "2025-10-10T12:00:00Z",
    schemaVersion: "1",
    payload: { amount: 1000, nested: { ok: true, list: [1, 2] } },
    ...overrides,
  };
}

function bodyOf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function verifySigned(body: Uint8Array): VerifyIrsV1WebhookResult {
  return verifyIrsV1Webhook(inputFor(body));
}

function verifyEnvelope(
  overrides: Record<string, unknown>,
  remove: readonly string[] = [],
): VerifyIrsV1WebhookResult {
  const object = envelopeObject(overrides);
  for (const key of remove) delete object[key];
  return verifySigned(bodyOf(object));
}

function expectRejection(
  result: VerifyIrsV1WebhookResult,
  reason: WebhookRejectionReason,
): void {
  assert.equal(result.ok, false, `expected ${reason}, got success`);
  if (result.ok) return;
  assert.equal(result.rejection.reason, reason);
  const security: WebhookRejectionReason[] = [
    "MISSING_SIGNATURE",
    "MALFORMED_SIGNATURE",
    "SIGNATURE_MISMATCH",
    "TIMESTAMP_OUT_OF_TOLERANCE",
  ];
  assert.equal(
    result.rejection.failureClass,
    security.includes(reason) ? FailureClass.SECURITY : FailureClass.VALIDATION,
  );
  assert.equal(typeof result.rejection.message, "string");
  assert.notEqual(result.rejection.message.length, 0);
}

function expectEnvelope(result: VerifyIrsV1WebhookResult) {
  assert.equal(result.ok, true, "expected success");
  if (!result.ok) throw new Error("unreachable");
  return result.envelope;
}

// ---------------------------------------------------------------------

describe("verifyIrsV1Webhook: valid verification", () => {
  it("returns the normalized envelope for a correctly signed body", () => {
    const envelope = expectEnvelope(verifySigned(bodyOf(envelopeObject())));
    assert.deepEqual(envelope, {
      externalEventId: "evt_123",
      eventType: "payment.completed",
      resourceType: "payment",
      resourceId: "pay_456",
      occurredAt: new Date("2025-10-10T12:00:00.000Z"),
      schemaVersion: "1",
      payload: { amount: 1000, nested: { ok: true, list: [1, 2] } },
    });
    assert.equal(Object.hasOwn(envelope, "correlationId"), false);
    assert.ok(envelope.occurredAt instanceof Date);
  });

  it("returns a frozen top-level envelope whose payload is left unfrozen", () => {
    for (const overrides of [{}, { correlationId: "corr-1" }]) {
      const envelope = expectEnvelope(verifyEnvelope(overrides));
      assert.equal(Object.isFrozen(envelope), true);
      assert.equal(Object.isFrozen(envelope.payload), false);
      assert.equal(Object.isFrozen(envelope.payload["nested"]), false);
      assert.equal(envelope.externalEventId, "evt_123");
      assert.equal(envelope.eventType, "payment.completed");
      assert.equal(envelope.resourceType, "payment");
      assert.equal(envelope.resourceId, "pay_456");
      assert.equal(
        envelope.occurredAt.toISOString(),
        "2025-10-10T12:00:00.000Z",
      );
      assert.equal(envelope.schemaVersion, "1");
      assert.deepEqual(envelope.payload, envelopeObject()["payload"]);
      assert.equal(
        Object.hasOwn(envelope, "correlationId"),
        "correlationId" in overrides,
      );
    }
  });

  it("includes correlationId when supplied and preserves identifiers verbatim", () => {
    const envelope = expectEnvelope(
      verifyEnvelope({
        correlationId: " corr-1 ",
        externalEventId: "  evt with spaces  ",
      }),
    );
    assert.equal(envelope.correlationId, " corr-1 ");
    assert.equal(envelope.externalEventId, "  evt with spaces  ");
  });

  it("verifies a body that is a view into a larger buffer", () => {
    const body = bodyOf(envelopeObject());
    const backing = Buffer.concat([Buffer.from("xxxx"), body, Buffer.from("yyyy")]);
    const view = backing.subarray(4, 4 + body.length);
    expectEnvelope(verifyIrsV1Webhook(inputFor(view)));
  });

  it("accepts a plain Uint8Array body and secret", () => {
    const body = new Uint8Array(bodyOf(envelopeObject()));
    const secret = new Uint8Array(SECRET);
    expectEnvelope(
      verifyIrsV1Webhook({
        rawBody: body,
        signatureHeader: header(NOW_SECONDS, sign(body, NOW_SECONDS, secret)),
        secret,
        now: NOW,
      }),
    );
  });

  it("treats t=0 as syntactically valid and stale under a normal clock", () => {
    const body = bodyOf(envelopeObject());
    const result = verifyIrsV1Webhook(
      inputFor(body, { signatureHeader: validHeader(body, 0) }),
    );
    expectRejection(result, "TIMESTAMP_OUT_OF_TOLERANCE");

    // Same header is accepted when the supplied clock is within tolerance
    // of the epoch, which proves it was not rejected as malformed.
    expectEnvelope(
      verifyIrsV1Webhook(
        inputFor(body, {
          signatureHeader: validHeader(body, 0),
          now: new Date(0),
        }),
      ),
    );
  });
});

describe("verifyIrsV1Webhook: signature verification", () => {
  it("rejects an incorrect secret", () => {
    const body = bodyOf(envelopeObject());
    const wrong = Buffer.from("a-different-secret-of-32-bytes-or-more!");
    const result = verifyIrsV1Webhook(
      inputFor(body, {
        signatureHeader: header(NOW_SECONDS, sign(body, NOW_SECONDS, wrong)),
      }),
    );
    expectRejection(result, "SIGNATURE_MISMATCH");
  });

  it("rejects a tampered body", () => {
    const body = bodyOf(envelopeObject());
    const signatureHeader = validHeader(body);
    const tampered = Buffer.from(body);
    tampered[tampered.length - 3] ^= 0x01;
    expectRejection(
      verifyIrsV1Webhook(inputFor(tampered, { signatureHeader })),
      "SIGNATURE_MISMATCH",
    );
  });

  it("rejects a body with an appended byte or trailing whitespace", () => {
    const body = bodyOf(envelopeObject());
    const signatureHeader = validHeader(body);
    const padded = Buffer.concat([body, Buffer.from("\n")]);
    expectRejection(
      verifyIrsV1Webhook(inputFor(padded, { signatureHeader })),
      "SIGNATURE_MISMATCH",
    );
  });

  it("rejects a tampered timestamp (signature covers the timestamp)", () => {
    const body = bodyOf(envelopeObject());
    const hex = sign(body, NOW_SECONDS);
    const result = verifyIrsV1Webhook(
      inputFor(body, { signatureHeader: header(NOW_SECONDS + 1, hex) }),
    );
    expectRejection(result, "SIGNATURE_MISMATCH");
  });

  it("rejects a signature computed without the period separator", () => {
    const body = bodyOf(envelopeObject());
    const hex = createHmac("sha256", SECRET)
      .update(Buffer.from(String(NOW_SECONDS), "ascii"))
      .update(body)
      .digest("hex");
    expectRejection(
      verifyIrsV1Webhook(
        inputFor(body, { signatureHeader: header(NOW_SECONDS, hex) }),
      ),
      "SIGNATURE_MISMATCH",
    );
  });

  it("verifies the signature before the timestamp tolerance", () => {
    const body = bodyOf(envelopeObject());
    const result = verifyIrsV1Webhook(
      inputFor(body, { signatureHeader: header(1, "0".repeat(64)) }),
    );
    expectRejection(result, "SIGNATURE_MISMATCH");
  });

  it("does not parse JSON before the signature verifies", () => {
    const body = Buffer.from("{ this is not json");
    const result = verifyIrsV1Webhook(
      inputFor(body, { signatureHeader: header(NOW_SECONDS, "0".repeat(64)) }),
    );
    expectRejection(result, "SIGNATURE_MISMATCH");
  });
});

describe("verifyIrsV1Webhook: signature header grammar", () => {
  const body = bodyOf(envelopeObject());
  const hex = sign(body, NOW_SECONDS);
  const t = NOW_SECONDS;

  it("treats an absent header as MISSING_SIGNATURE", () => {
    expectRejection(
      verifyIrsV1Webhook(inputFor(body, { signatureHeader: undefined })),
      "MISSING_SIGNATURE",
    );
  });

  const malformed: ReadonlyArray<[string, string]> = [
    ["empty string", ""],
    ["no parameters", "v1"],
    ["wrong scheme name", `ts=${t},v1=${hex}`],
    ["wrong version name", `t=${t},v2=${hex}`],
    ["reordered parameters", `v1=${hex},t=${t}`],
    ["duplicate timestamp", `t=${t},t=${t},v1=${hex}`],
    ["duplicate signature", `t=${t},v1=${hex},v1=${hex}`],
    ["extra parameter", `t=${t},v1=${hex},v0=abc`],
    ["trailing comma", `t=${t},v1=${hex},`],
    ["whitespace after comma", `t=${t}, v1=${hex}`],
    ["leading whitespace", ` t=${t},v1=${hex}`],
    ["trailing whitespace", `t=${t},v1=${hex} `],
    ["trailing newline", `t=${t},v1=${hex}\n`],
    ["missing signature", `t=${t}`],
    ["missing timestamp", `v1=${hex}`],
    ["empty timestamp", `t=,v1=${hex}`],
    ["non-digit timestamp", `t=12a,v1=${hex}`],
    ["negative timestamp", `t=-1,v1=${hex}`],
    ["decimal timestamp", `t=1.5,v1=${hex}`],
    ["leading-zero timestamp", `t=0${t},v1=${hex}`],
    ["double-zero timestamp", `t=00,v1=${hex}`],
    ["16-digit timestamp", `t=1000000000000000,v1=${hex}`],
    ["uppercase hex", `t=${t},v1=${hex.toUpperCase()}`],
    ["63 hex characters", `t=${t},v1=${hex.slice(0, 63)}`],
    ["65 hex characters", `t=${t},v1=${hex}0`],
    ["non-hex characters", `t=${t},v1=${"g".repeat(64)}`],
    ["0x prefix", `t=${t},v1=0x${hex.slice(2)}`],
    ["very long value", `t=${t},v1=${hex}${"a".repeat(10_000)}`],
  ];

  for (const [name, value] of malformed) {
    it(`rejects ${name} as MALFORMED_SIGNATURE`, () => {
      expectRejection(
        verifyIrsV1Webhook(inputFor(body, { signatureHeader: value })),
        "MALFORMED_SIGNATURE",
      );
    });
  }

  it("accepts a 15-digit timestamp as well-formed (then fails tolerance)", () => {
    const ts = "999999999999999";
    expectRejection(
      verifyIrsV1Webhook(
        inputFor(body, { signatureHeader: header(ts, sign(body, ts)) }),
      ),
      "TIMESTAMP_OUT_OF_TOLERANCE",
    );
  });
});

describe("verifyIrsV1Webhook: timestamp tolerance", () => {
  const body = bodyOf(envelopeObject());

  function withTimestamp(ts: number, extra: Partial<VerifyIrsV1WebhookInput> = {}) {
    return verifyIrsV1Webhook(
      inputFor(body, { signatureHeader: validHeader(body, ts), ...extra }),
    );
  }

  it("accepts exactly +300 and -300 seconds by default", () => {
    expectEnvelope(withTimestamp(NOW_SECONDS - 300));
    expectEnvelope(withTimestamp(NOW_SECONDS + 300));
  });

  it("rejects 301 seconds in either direction by default", () => {
    expectRejection(
      withTimestamp(NOW_SECONDS - 301),
      "TIMESTAMP_OUT_OF_TOLERANCE",
    );
    expectRejection(
      withTimestamp(NOW_SECONDS + 301),
      "TIMESTAMP_OUT_OF_TOLERANCE",
    );
  });

  it("honours a custom tolerance at both ends of the allowed range", () => {
    expectEnvelope(withTimestamp(NOW_SECONDS - 1, { toleranceSeconds: 1 }));
    expectEnvelope(withTimestamp(NOW_SECONDS + 1, { toleranceSeconds: 1 }));
    expectRejection(
      withTimestamp(NOW_SECONDS + 2, { toleranceSeconds: 1 }),
      "TIMESTAMP_OUT_OF_TOLERANCE",
    );
    expectEnvelope(withTimestamp(NOW_SECONDS - 3600, { toleranceSeconds: 3600 }));
    expectRejection(
      withTimestamp(NOW_SECONDS - 3601, { toleranceSeconds: 3600 }),
      "TIMESTAMP_OUT_OF_TOLERANCE",
    );
  });

  it("is millisecond-exact: 300.001 s of skew is outside the window", () => {
    const ts = NOW_SECONDS;
    const result = verifyIrsV1Webhook(
      inputFor(body, {
        signatureHeader: validHeader(body, ts),
        now: new Date(ts * 1000 + 300_001),
      }),
    );
    expectRejection(result, "TIMESTAMP_OUT_OF_TOLERANCE");
  });
});

describe("verifyIrsV1Webhook: body size", () => {
  it("accepts a body exactly at maxBodyBytes and rejects one byte over", () => {
    const body = bodyOf(envelopeObject());
    expectEnvelope(
      verifyIrsV1Webhook(inputFor(body, { maxBodyBytes: body.length })),
    );
    expectRejection(
      verifyIrsV1Webhook(inputFor(body, { maxBodyBytes: body.length - 1 })),
      "BODY_TOO_LARGE",
    );
  });

  it("defaults to 1 MiB (1,048,576 bytes)", () => {
    const atLimit = Buffer.alloc(1_048_576, 0x20);
    const overLimit = Buffer.alloc(1_048_577, 0x20);
    const fakeHeader = header(NOW_SECONDS, "0".repeat(64));
    // At the limit the size check passes, so the (invalid) signature is
    // what rejects it.
    expectRejection(
      verifyIrsV1Webhook(inputFor(atLimit, { signatureHeader: fakeHeader })),
      "SIGNATURE_MISMATCH",
    );
    expectRejection(
      verifyIrsV1Webhook(inputFor(overLimit, { signatureHeader: fakeHeader })),
      "BODY_TOO_LARGE",
    );
  });

  it("checks size before looking at the signature header", () => {
    const over = Buffer.alloc(11, 0x20);
    expectRejection(
      verifyIrsV1Webhook(
        inputFor(over, { signatureHeader: undefined, maxBodyBytes: 10 }),
      ),
      "BODY_TOO_LARGE",
    );
  });
});

describe("verifyIrsV1Webhook: payload decoding and JSON", () => {
  const validJson = bodyOf(envelopeObject());

  const malformed: ReadonlyArray<[string, Uint8Array]> = [
    ["invalid UTF-8 byte", Buffer.from([0x7b, 0xff, 0x7d])],
    ["truncated UTF-8 sequence", Buffer.from([0x7b, 0x22, 0xc3])],
    ["overlong UTF-8 encoding", Buffer.from([0x7b, 0x22, 0xc0, 0xaf, 0x22])],
    ["UTF-8 encoded surrogate", Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22])],
    ["UTF-8 BOM before valid JSON", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), validJson])],
    ["empty body", Buffer.alloc(0)],
    ["whitespace only", Buffer.from("   ")],
    ["truncated JSON", Buffer.from('{"externalEventId":"a"')],
    ["trailing garbage", Buffer.concat([validJson, Buffer.from("x")])],
    ["single-quoted JSON", Buffer.from("{'a':1}")],
    ["trailing comma", Buffer.from('{"a":1,}')],
    ["plain text", Buffer.from("not json at all")],
  ];

  for (const [name, body] of malformed) {
    it(`rejects ${name} as MALFORMED_PAYLOAD (after a valid signature)`, () => {
      expectRejection(verifySigned(body), "MALFORMED_PAYLOAD");
    });
  }

  const wrongTopLevel: ReadonlyArray<[string, string]> = [
    ["null", "null"],
    ["an array", "[]"],
    ["an array of envelopes", JSON.stringify([envelopeObject()])],
    ["a number", "42"],
    ["a string", '"text"'],
    ["a boolean", "true"],
  ];

  for (const [name, text] of wrongTopLevel) {
    it(`rejects ${name} at the top level as INVALID_ENVELOPE`, () => {
      expectRejection(verifySigned(Buffer.from(text)), "INVALID_ENVELOPE");
    });
  }

  it("accepts a JSON body with insignificant whitespace", () => {
    const text = `\n  ${JSON.stringify(envelopeObject(), null, 2)}\n`;
    expectEnvelope(verifySigned(Buffer.from(text)));
  });

  it("accepts valid multi-byte UTF-8 content", () => {
    const envelope = expectEnvelope(
      verifyEnvelope({ payload: { name: "Zoë 東京 🚀" } }),
    );
    assert.deepEqual(envelope.payload, { name: "Zoë 東京 🚀" });
  });

  it("uses last-wins for duplicate JSON keys (standard JSON.parse)", () => {
    const text =
      '{"externalEventId":"evt_1","eventType":"first.type",' +
      '"eventType":"second.type","resourceType":"payment","resourceId":"p1",' +
      '"occurredAt":"2025-10-10T12:00:00Z","schemaVersion":"1","payload":{}}';
    const envelope = expectEnvelope(verifySigned(Buffer.from(text)));
    assert.equal(envelope.eventType, "second.type");
  });

  it("does not let a __proto__ key in the payload pollute prototypes", () => {
    const text =
      '{"externalEventId":"evt_1","eventType":"a.b","resourceType":"r",' +
      '"resourceId":"1","occurredAt":"2025-10-10T12:00:00Z","schemaVersion":"1",' +
      '"payload":{"__proto__":{"polluted":true}}}';
    const envelope = expectEnvelope(verifySigned(Buffer.from(text)));
    assert.equal(Object.hasOwn(envelope.payload, "__proto__"), true);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    assert.equal((envelope.payload as Record<string, unknown>)["polluted"], undefined);
  });

  it("rejects a top-level __proto__ key as an unknown field", () => {
    const text =
      '{"__proto__":{"x":1},"externalEventId":"evt_1","eventType":"a.b",' +
      '"resourceType":"r","resourceId":"1","occurredAt":"2025-10-10T12:00:00Z",' +
      '"schemaVersion":"1","payload":{}}';
    expectRejection(verifySigned(Buffer.from(text)), "INVALID_ENVELOPE");
  });
});

describe("verifyIrsV1Webhook: envelope validation", () => {
  it("rejects each missing required field", () => {
    for (const key of [
      "externalEventId",
      "eventType",
      "resourceType",
      "resourceId",
      "occurredAt",
      "schemaVersion",
      "payload",
    ]) {
      expectRejection(verifyEnvelope({}, [key]), "INVALID_ENVELOPE");
    }
  });

  it("rejects wrong field types", () => {
    const cases: Array<Record<string, unknown>> = [
      { externalEventId: 123 },
      { externalEventId: null },
      { eventType: ["a.b"] },
      { resourceType: {} },
      { resourceId: 7 },
      { occurredAt: 1_760_000_000 },
      { occurredAt: null },
      { schemaVersion: 1 },
      { correlationId: 5 },
      { correlationId: null },
      { payload: null },
      { payload: [] },
      { payload: "text" },
      { payload: 1 },
    ];
    for (const overrides of cases) {
      expectRejection(verifyEnvelope(overrides), "INVALID_ENVELOPE");
    }
  });

  it("rejects unknown fields, including ingestion-owned ones", () => {
    for (const key of [
      "id",
      "integrationId",
      "receivedAt",
      "status",
      "metadata",
      "extra",
    ]) {
      expectRejection(verifyEnvelope({ [key]: "x" }), "INVALID_ENVELOPE");
    }
  });

  it("rejects empty and whitespace-only identifiers", () => {
    for (const key of [
      "externalEventId",
      "resourceType",
      "resourceId",
      "schemaVersion",
      "correlationId",
    ]) {
      expectRejection(verifyEnvelope({ [key]: "" }), "INVALID_ENVELOPE");
      expectRejection(verifyEnvelope({ [key]: " \t\n " }), "INVALID_ENVELOPE");
    }
  });

  it("enforces identifier limits exactly (UTF-8 bytes unless noted)", () => {
    const limits: ReadonlyArray<[string, number]> = [
      ["externalEventId", 255],
      ["resourceType", 128],
      ["resourceId", 255],
      ["schemaVersion", 64],
      ["correlationId", 128],
    ];
    for (const [key, limit] of limits) {
      expectEnvelope(verifyEnvelope({ [key]: "a".repeat(limit) }));
      expectRejection(
        verifyEnvelope({ [key]: "a".repeat(limit + 1) }),
        "INVALID_ENVELOPE",
      );
      // Two-byte characters: `limit / 2` of them is at the limit when the
      // limit is even; one more pushes it over.
      const even = Math.floor(limit / 2);
      expectEnvelope(verifyEnvelope({ [key]: "é".repeat(even) }));
      expectRejection(
        verifyEnvelope({ [key]: "é".repeat(even + 1) }),
        "INVALID_ENVELOPE",
      );
    }
  });

  it("limits eventType to 128 characters", () => {
    expectEnvelope(verifyEnvelope({ eventType: "a".repeat(128) }));
    expectRejection(
      verifyEnvelope({ eventType: "a".repeat(129) }),
      "INVALID_ENVELOPE",
    );
  });

  it("accepts well-formed event types", () => {
    for (const eventType of [
      "order",
      "order.created",
      "payment.refund_issued",
      "a1.b_2.c3",
    ]) {
      expectEnvelope(verifyEnvelope({ eventType }));
    }
  });

  it("rejects malformed event types", () => {
    for (const eventType of [
      "",
      "Order.created",
      "order.Created",
      "order..created",
      ".order",
      "order.",
      "1order",
      "order.1created",
      "_order",
      "order-created",
      "order created",
      "order.created\n",
      "órder.created",
    ]) {
      expectRejection(verifyEnvelope({ eventType }), "INVALID_ENVELOPE");
    }
  });

  it("normalizes occurredAt to the validated instant", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["2025-10-10T12:00:00Z", "2025-10-10T12:00:00.000Z"],
      ["2025-10-10T12:00:00.5Z", "2025-10-10T12:00:00.500Z"],
      ["2025-10-10T12:00:00.12Z", "2025-10-10T12:00:00.120Z"],
      ["2025-10-10T12:00:00.123Z", "2025-10-10T12:00:00.123Z"],
      ["2025-10-10T14:00:00+02:00", "2025-10-10T12:00:00.000Z"],
      ["2025-10-10T05:30:00-05:30", "2025-10-10T11:00:00.000Z"],
      ["2025-10-10T00:30:00+01:00", "2025-10-09T23:30:00.000Z"],
      ["2025-12-31T23:30:00-01:00", "2026-01-01T00:30:00.000Z"],
      ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
      ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"],
      ["0050-06-15T00:00:00Z", "0050-06-15T00:00:00.000Z"],
    ];
    for (const [input, instant] of cases) {
      const envelope = expectEnvelope(verifyEnvelope({ occurredAt: input }));
      assert.equal(envelope.occurredAt.toISOString(), instant, input);
    }
  });

  it("rejects invalid occurredAt values", () => {
    for (const occurredAt of [
      "",
      "2025-10-10",
      "2025-10-10T12:00:00",
      "2025-10-10T12:00",
      "2025-10-10 12:00:00Z",
      "2025-10-10t12:00:00Z",
      "2025-10-10T12:00:00z",
      "2025-10-10T12:00:00.Z",
      "2025-10-10T12:00:00.1234Z",
      "2025-10-10T12:00:00+0200",
      "2025-10-10T12:00:00+02",
      "2025-10-10T12:00:00+24:00",
      "2025-10-10T12:00:00+02:60",
      "2025-10-10T12:00:00Z ",
      " 2025-10-10T12:00:00Z",
      "25-10-10T12:00:00Z",
      "2025-13-10T12:00:00Z",
      "2025-00-10T12:00:00Z",
      "2025-10-00T12:00:00Z",
      "2025-10-32T12:00:00Z",
      "2025-04-31T12:00:00Z",
      "2025-02-29T12:00:00Z",
      "2100-02-29T12:00:00Z",
      "2025-10-10T24:00:00Z",
      "2025-10-10T12:60:00Z",
      "2025-10-10T12:00:60Z",
      "Fri, 10 Oct 2025 12:00:00 GMT",
      "10/10/2025",
    ]) {
      expectRejection(verifyEnvelope({ occurredAt }), "INVALID_ENVELOPE");
    }
  });

  it("does not restrict nested payload content", () => {
    const payload = {
      anything: [null, true, 1.5, "x", { deep: { deeper: [] } }],
      "": "empty key",
    };
    const envelope = expectEnvelope(verifyEnvelope({ payload }));
    assert.deepEqual(envelope.payload, payload);
  });

  it("does not apply an event-type allowlist", () => {
    expectEnvelope(verifyEnvelope({ eventType: "totally.unknown.event" }));
  });
});

describe("verifyIrsV1Webhook: argument and configuration validation", () => {
  const body = bodyOf(envelopeObject());
  const good = inputFor(body);

  function call(overrides: Record<string, unknown>) {
    return () =>
      verifyIrsV1Webhook({ ...good, ...overrides } as VerifyIrsV1WebhookInput);
  }

  it("throws TypeError for a non-object input", () => {
    for (const bad of [undefined, null, "x", 1]) {
      assert.throws(
        () => verifyIrsV1Webhook(bad as unknown as VerifyIrsV1WebhookInput),
        TypeError,
      );
    }
  });

  it("throws TypeError for an invalid rawBody", () => {
    for (const rawBody of [undefined, null, "string", [1, 2], {}, 5, new ArrayBuffer(4)]) {
      assert.throws(call({ rawBody }), TypeError);
    }
  });

  it("throws TypeError for a non-string signatureHeader", () => {
    for (const signatureHeader of [null, 5, {}, ["t=1"], Buffer.from("t=1")]) {
      assert.throws(call({ signatureHeader }), TypeError);
    }
  });

  it("throws for an invalid secret", () => {
    for (const secret of [undefined, null, "a".repeat(40), [1, 2, 3]]) {
      assert.throws(call({ secret }), TypeError);
    }
    assert.throws(call({ secret: Buffer.alloc(0) }), RangeError);
    assert.throws(call({ secret: Buffer.alloc(31, 1) }), RangeError);
    expectEnvelope(
      verifyIrsV1Webhook(
        inputFor(body, {
          secret: Buffer.alloc(32, 1),
          signatureHeader: header(
            NOW_SECONDS,
            sign(body, NOW_SECONDS, Buffer.alloc(32, 1)),
          ),
        }),
      ),
    );
  });

  it("requires now to be a valid Date and never defaults to the clock", () => {
    for (const now of [undefined, null, NOW.getTime(), "2025-01-01", {}]) {
      assert.throws(call({ now }), TypeError);
    }
    assert.throws(call({ now: new Date(Number.NaN) }), TypeError);
    const { now: _omitted, ...withoutNow } = good;
    assert.throws(
      () => verifyIrsV1Webhook(withoutNow as unknown as VerifyIrsV1WebhookInput),
      TypeError,
    );
  });

  it("validates toleranceSeconds", () => {
    for (const toleranceSeconds of ["300", null, {}, true]) {
      assert.throws(call({ toleranceSeconds }), TypeError);
    }
    for (const toleranceSeconds of [0, -1, 3601, 1.5, Number.NaN, Infinity]) {
      assert.throws(call({ toleranceSeconds }), RangeError);
    }
    for (const toleranceSeconds of [1, 300, 3600]) {
      expectEnvelope(verifyIrsV1Webhook({ ...good, toleranceSeconds }));
    }
  });

  it("validates maxBodyBytes", () => {
    for (const maxBodyBytes of ["10", null, {}, true]) {
      assert.throws(call({ maxBodyBytes }), TypeError);
    }
    for (const maxBodyBytes of [
      0,
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(call({ maxBodyBytes }), RangeError);
    }
    expectEnvelope(
      verifyIrsV1Webhook({ ...good, maxBodyBytes: Number.MAX_SAFE_INTEGER }),
    );
  });

  it("validates arguments before any rejection result is produced", () => {
    // An oversized body with a bad option still throws rather than rejects.
    assert.throws(
      call({ maxBodyBytes: 1, toleranceSeconds: 0 }),
      RangeError,
    );
  });
});

describe("verifyIrsV1Webhook: no secret, signature, or body leakage", () => {
  const SECRET_CANARY = "SECRET-CANARY-do-not-leak-0123456789";
  const BODY_CANARY = "BODY-CANARY-private-customer-data";
  const secret = Buffer.from(SECRET_CANARY);
  const leakChecks = [SECRET_CANARY, BODY_CANARY];

  function assertClean(text: string, extra: readonly string[] = []): void {
    for (const needle of [...leakChecks, ...extra]) {
      assert.equal(text.includes(needle), false, `leaked ${needle}`);
    }
  }

  it("keeps rejection results free of sensitive values", () => {
    const results: VerifyIrsV1WebhookResult[] = [];
    const received: string[] = [];

    const push = (body: Uint8Array, signatureHeader: string | undefined) => {
      if (signatureHeader !== undefined) received.push(signatureHeader);
      results.push(
        verifyIrsV1Webhook({
          rawBody: body,
          signatureHeader,
          secret,
          now: NOW,
          maxBodyBytes: 4096,
        }),
      );
    };

    const canaryBody = bodyOf(envelopeObject({ payload: { note: BODY_CANARY } }));
    const signed = (body: Uint8Array, ts = NOW_SECONDS) =>
      header(ts, sign(body, ts, secret));

    push(Buffer.alloc(5000, 0x41), undefined);
    push(canaryBody, undefined);
    push(canaryBody, `t=${NOW_SECONDS},v1=NOT-HEX-${BODY_CANARY}`);
    push(canaryBody, header(NOW_SECONDS, "ab".repeat(32)));
    push(canaryBody, signed(canaryBody, 5));
    const badUtf8 = Buffer.concat([Buffer.from(BODY_CANARY), Buffer.from([0xff])]);
    push(badUtf8, signed(badUtf8));
    const badJson = Buffer.from(`{"x":"${BODY_CANARY}`);
    push(badJson, signed(badJson));
    const badEnvelope = bodyOf(
      envelopeObject({ payload: { note: BODY_CANARY }, [BODY_CANARY]: 1 }),
    );
    push(badEnvelope, signed(badEnvelope));
    const badDate = bodyOf(envelopeObject({ occurredAt: BODY_CANARY }));
    push(badDate, signed(badDate));

    const reasons = results.map((r) => (r.ok ? "OK" : r.rejection.reason));
    assert.deepEqual(reasons, [
      "BODY_TOO_LARGE",
      "MISSING_SIGNATURE",
      "MALFORMED_SIGNATURE",
      "SIGNATURE_MISMATCH",
      "TIMESTAMP_OUT_OF_TOLERANCE",
      "MALFORMED_PAYLOAD",
      "MALFORMED_PAYLOAD",
      "INVALID_ENVELOPE",
      "INVALID_ENVELOPE",
    ]);

    const receivedSignatures = received
      .map((h) => /v1=([0-9a-f]{64})/.exec(h)?.[1])
      .filter((s): s is string => s !== undefined);
    for (const result of results) {
      assert.equal(result.ok, false);
      assertClean(JSON.stringify(result), receivedSignatures);
    }
  });

  it("keeps thrown messages free of sensitive values", () => {
    const shortSecret = Buffer.from("SECRET-CANARY");
    const attempts: Array<() => unknown> = [
      () =>
        verifyIrsV1Webhook({
          rawBody: Buffer.from(BODY_CANARY),
          signatureHeader: "t=1,v1=" + "0".repeat(64),
          secret: shortSecret,
          now: NOW,
        }),
      () =>
        verifyIrsV1Webhook({
          rawBody: BODY_CANARY as unknown as Uint8Array,
          signatureHeader: undefined,
          secret,
          now: NOW,
        }),
      () =>
        verifyIrsV1Webhook({
          rawBody: Buffer.from(BODY_CANARY),
          signatureHeader: SECRET_CANARY as string,
          secret,
          now: "x" as unknown as Date,
        }),
      () =>
        verifyIrsV1Webhook({
          rawBody: Buffer.from(BODY_CANARY),
          signatureHeader: undefined,
          secret,
          now: NOW,
          toleranceSeconds: BODY_CANARY as unknown as number,
        }),
      () =>
        verifyIrsV1Webhook({
          rawBody: Buffer.from(BODY_CANARY),
          signatureHeader: undefined,
          secret: SECRET_CANARY as unknown as Uint8Array,
          now: NOW,
        }),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        assert.fail("expected a throw");
      } catch (error) {
        assert.ok(error instanceof TypeError || error instanceof RangeError);
        assertClean(error.message, ["SECRET-CANARY"]);
      }
    }
  });

  it("returns fresh rejection objects that callers cannot use to alter later results", () => {
    const body = bodyOf(envelopeObject());
    const first = verifyIrsV1Webhook(inputFor(body, { signatureHeader: undefined }));
    assert.equal(first.ok, false);
    if (first.ok) return;
    (first.rejection as { message: string }).message = "mutated";
    const second = verifyIrsV1Webhook(inputFor(body, { signatureHeader: undefined }));
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.notEqual(second.rejection.message, "mutated");
  });
});

describe("verifyIrsV1Webhook: original body immutability", () => {
  it("leaves the body bytes unchanged on success and on rejection", () => {
    const body = bodyOf(envelopeObject());
    const snapshot = Buffer.from(body);
    const secretSnapshot = Buffer.from(SECRET);

    expectEnvelope(verifyIrsV1Webhook(inputFor(body)));
    assert.deepEqual(body, snapshot);

    verifyIrsV1Webhook(inputFor(body, { signatureHeader: undefined }));
    verifyIrsV1Webhook(
      inputFor(body, { signatureHeader: header(NOW_SECONDS, "0".repeat(64)) }),
    );
    verifyIrsV1Webhook(inputFor(body, { maxBodyBytes: 1 }));
    assert.deepEqual(body, snapshot);
    assert.deepEqual(SECRET, secretSnapshot);

    const invalid = Buffer.from([0x7b, 0xff, 0x7d]);
    const invalidSnapshot = Buffer.from(invalid);
    expectRejection(verifySigned(invalid), "MALFORMED_PAYLOAD");
    assert.deepEqual(invalid, invalidSnapshot);
  });

  it("verifies against the bytes as received, not a re-serialization", () => {
    // Semantically identical JSON with different whitespace has a
    // different signature; only the exact bytes verify.
    const compact = bodyOf(envelopeObject());
    const pretty = Buffer.from(JSON.stringify(envelopeObject(), null, 2));
    expectRejection(
      verifyIrsV1Webhook(
        inputFor(pretty, { signatureHeader: validHeader(compact) }),
      ),
      "SIGNATURE_MISMATCH",
    );
  });
});
