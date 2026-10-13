import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRequestHeaders,
  isSupportedContentType,
  parseIntegrationId,
  rawHeaderValues,
} from "./guards.js";
import { codeForFrameworkError, errorBody, statusFor } from "./errors.js";
import { safePath } from "./logging.js";

describe("parseIntegrationId", () => {
  it("accepts canonical lowercase UUIDs of any version", () => {
    for (const id of [
      "6fa459ea-ee8a-3ca4-894e-db77e160355e", // v3
      "3f2b8a64-1c9d-4e7a-9b21-5d6e7f8a9b0c", // v4
      "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61", // v7
      "00000000-0000-0000-0000-000000000000", // nil
      "ffffffff-ffff-ffff-ffff-ffffffffffff", // max
    ]) {
      assert.equal(parseIntegrationId(id), id);
    }
  });

  it("rejects non-canonical forms instead of repairing them", () => {
    for (const id of [
      "0190F3A2-7B1C-7A55-8F0E-2B6D3C4A5E61",
      "0190f3a27b1c7a558f0e2b6d3c4a5e61",
      "{0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61}",
      " 0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61",
      "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61\n",
      "urn:uuid:0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61",
      "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e6",
      "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61a",
      "gggggggg-gggg-gggg-gggg-gggggggggggg",
      "",
      "stripe",
    ]) {
      assert.equal(parseIntegrationId(id), null, JSON.stringify(id));
    }
    assert.equal(parseIntegrationId(undefined), null);
    assert.equal(parseIntegrationId(42), null);
  });
});

describe("rawHeaderValues", () => {
  it("returns every occurrence case-insensitively, in order", () => {
    const raw = ["IRS-Signature", "a", "content-type", "x", "irs-signature", "b"];
    assert.deepEqual(rawHeaderValues(raw, "IRS-SIGNATURE"), ["a", "b"]);
    assert.deepEqual(rawHeaderValues(raw, "content-type"), ["x"]);
    assert.deepEqual(rawHeaderValues(raw, "missing"), []);
  });
});

describe("isSupportedContentType", () => {
  it("accepts application/json with optional UTF-8 charset", () => {
    for (const value of [
      "application/json",
      "Application/JSON",
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      'application/json; charset="utf-8"',
    ]) {
      assert.equal(isSupportedContentType(value), true, value);
    }
  });

  it("rejects other types, charsets and parameters", () => {
    for (const value of [
      "text/plain",
      "application/jsonp",
      "application/json-patch+json",
      "application/x-www-form-urlencoded",
      "application/json; charset=iso-8859-1",
      "application/json; charset=utf-16",
      "application/json; charset=utf-8; boundary=x",
      "application/json; boundary=x",
      "application/json; charset=utf-8x",
      "",
    ]) {
      assert.equal(isSupportedContentType(value), false, value);
    }
  });
});

describe("evaluateRequestHeaders", () => {
  const good = [
    "Content-Type",
    "application/json",
    "IRS-Signature",
    "t=1,v1=" + "0".repeat(64),
  ];

  it("returns the signature header and normalized content type", () => {
    const result = evaluateRequestHeaders([
      "Content-Type",
      "application/json; charset=UTF-8",
      "IRS-Signature",
      "opaque-value",
    ]);
    assert.deepEqual(result, {
      ok: true,
      signatureHeader: "opaque-value",
      contentType: "application/json",
    });
  });

  it("treats a missing IRS-Signature as UNAUTHORIZED", () => {
    assert.deepEqual(
      evaluateRequestHeaders(["Content-Type", "application/json"]),
      { ok: false, code: "UNAUTHORIZED" },
    );
  });

  it("reports a missing signature ahead of content-type problems", () => {
    assert.deepEqual(evaluateRequestHeaders(["Content-Type", "text/plain"]), {
      ok: false,
      code: "UNAUTHORIZED",
    });
  });

  it("passes an empty signature value through to the verifier", () => {
    const result = evaluateRequestHeaders([
      "Content-Type",
      "application/json",
      "IRS-Signature",
      "",
    ]);
    assert.equal(result.ok, true);
  });

  it("maps a duplicate IRS-Signature (any name case) to UNAUTHORIZED", () => {
    for (const name of ["IRS-Signature", "irs-signature", "IRS-SIGNATURE"]) {
      assert.deepEqual(
        evaluateRequestHeaders([
          "Content-Type",
          "application/json",
          name,
          "a",
          "IRS-Signature",
          "b",
        ]),
        { ok: false, code: "UNAUTHORIZED" },
        name,
      );
    }
  });

  it("maps a duplicate Content-Type to UNSUPPORTED_MEDIA_TYPE, even if both are supported", () => {
    assert.deepEqual(
      evaluateRequestHeaders([
        "IRS-Signature",
        "x",
        "Content-Type",
        "application/json",
        "content-type",
        "application/json",
      ]),
      { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" },
    );
  });

  it("maps a duplicate Content-Encoding to UNSUPPORTED_MEDIA_TYPE, even if both are identity", () => {
    assert.deepEqual(
      evaluateRequestHeaders([
        ...good,
        "Content-Encoding",
        "identity",
        "content-encoding",
        "identity",
      ]),
      { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" },
    );
  });

  it("checks IRS-Signature ahead of Content-Type and Content-Encoding duplicates", () => {
    assert.deepEqual(
      evaluateRequestHeaders([
        "Content-Type",
        "application/json",
        "Content-Type",
        "application/json",
        "Content-Encoding",
        "gzip",
        "Content-Encoding",
        "gzip",
      ]),
      { ok: false, code: "UNAUTHORIZED" },
    );
  });

  it("rejects duplicate framing headers as BAD_REQUEST", () => {
    for (const name of ["Content-Length", "Transfer-Encoding"]) {
      assert.deepEqual(
        evaluateRequestHeaders([...good, name, "1", name, "2"]),
        { ok: false, code: "BAD_REQUEST" },
        name,
      );
    }
  });

  it("rejects an unsupported or missing content type", () => {
    assert.deepEqual(
      evaluateRequestHeaders(["IRS-Signature", "x"]),
      { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" },
    );
    assert.deepEqual(
      evaluateRequestHeaders(["IRS-Signature", "x", "Content-Type", "text/plain"]),
      { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" },
    );
  });

  it("rejects any content encoding other than identity", () => {
    for (const encoding of ["gzip", "deflate", "br", "gzip, identity"]) {
      assert.deepEqual(
        evaluateRequestHeaders([...good, "Content-Encoding", encoding]),
        { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" },
        encoding,
      );
    }
    assert.equal(
      evaluateRequestHeaders([...good, "Content-Encoding", "Identity"]).ok,
      true,
    );
  });
});

describe("generic errors", () => {
  it("builds the flat body: only a fixed code and the request ID", () => {
    const body = errorBody("UNAUTHORIZED", "req-1");
    assert.deepEqual(body, { error: "UNAUTHORIZED", requestId: "req-1" });
    assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
    assert.equal(statusFor("UNAUTHORIZED"), 401);
  });

  it("maps framework errors by status only and never reads the message", () => {
    const withMessage = (statusCode: number) => ({
      statusCode,
      message: "SECRET-MESSAGE",
    });
    assert.equal(codeForFrameworkError(withMessage(404)), "NOT_FOUND");
    assert.equal(codeForFrameworkError(withMessage(408)), "REQUEST_TIMEOUT");
    assert.equal(codeForFrameworkError(withMessage(413)), "PAYLOAD_TOO_LARGE");
    assert.equal(codeForFrameworkError(withMessage(415)), "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(codeForFrameworkError(withMessage(422)), "BAD_REQUEST");
    assert.equal(codeForFrameworkError(withMessage(503)), "SERVICE_UNAVAILABLE");
    assert.equal(codeForFrameworkError(withMessage(500)), "INTERNAL_ERROR");
    assert.equal(codeForFrameworkError(new Error("x")), "INTERNAL_ERROR");
    assert.equal(codeForFrameworkError(undefined), "INTERNAL_ERROR");
  });
});

describe("safePath", () => {
  it("removes query strings and fragments", () => {
    assert.equal(safePath("/a/b?token=secret"), "/a/b");
    assert.equal(safePath("/a/b#frag"), "/a/b");
    assert.equal(safePath("/a/b"), "/a/b");
    assert.equal(safePath(undefined), "");
  });
});
