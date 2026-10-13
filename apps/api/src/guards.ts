import type { ApiErrorCode } from "./errors.js";

/** Maximum accepted request-body size: 1 MiB. */
export const MAX_BODY_BYTES = 1_048_576;

/** Canonical lowercase UUID text of any version (8-4-4-4-12 lowercase hex). */
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Returns the integration ID if `value` is a canonical lowercase UUID,
 * otherwise null. No other normalization is applied: uppercase, braced,
 * unhyphenated or padded forms are rejected, not repaired.
 */
export function parseIntegrationId(value: unknown): string | null {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Values of every occurrence of a header, in order, read from Node's
 * `rawHeaders` (alternating name/value). Node's parsed `headers` object
 * silently discards or joins duplicates, so it cannot be used to detect
 * them. Names are matched case-insensitively.
 */
export function rawHeaderValues(
  rawHeaders: readonly string[],
  name: string,
): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] as string).toLowerCase() === wanted) {
      values.push(rawHeaders[i + 1] as string);
    }
  }
  return values;
}

/**
 * Accepts `application/json` with no parameters, or with exactly one
 * `charset` parameter whose value is `utf-8` (case-insensitive, optionally
 * quoted). Anything else is rejected.
 */
export function isSupportedContentType(value: string): boolean {
  const [mediaType, ...params] = value.split(";");
  if ((mediaType as string).trim().toLowerCase() !== "application/json") {
    return false;
  }
  if (params.length === 0) return true;
  if (params.length > 1) return false;

  const match = /^\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*$/i.exec(
    params[0] as string,
  );
  return match !== null;
}

/** Normalized content type recorded in handoff metadata. */
export const NORMALIZED_CONTENT_TYPE = "application/json";

/**
 * Framing headers that must appear at most once. A duplicate is ambiguous
 * request framing and is rejected as a generic 400. (Node's own parser
 * normally rejects conflicting Content-Length values before this runs.)
 */
const FRAMING_HEADERS = ["content-length", "transfer-encoding"] as const;

export type HeaderGuardResult =
  | {
      readonly ok: true;
      readonly signatureHeader: string;
      readonly contentType: typeof NORMALIZED_CONTENT_TYPE;
    }
  | { readonly ok: false; readonly code: ApiErrorCode };

/**
 * Header-only checks that run before the request body is consumed.
 *
 * Order and status mapping (approved contract):
 *
 * 1. Duplicate framing headers (Content-Length, Transfer-Encoding): 400.
 * 2. `IRS-Signature` missing or duplicated: generic 401. The body is never
 *    read and no secret is resolved.
 * 3. `Content-Type` missing, duplicated or unsupported: 415.
 * 4. `Content-Encoding` duplicated or unsupported: 415.
 *
 * Duplicates are detected from the original raw headers, because Node's
 * parsed header map discards or joins them. No cryptographic work happens
 * here; that is the Task 010 verifier's sole responsibility.
 */
export function evaluateRequestHeaders(
  rawHeaders: readonly string[],
): HeaderGuardResult {
  for (const name of FRAMING_HEADERS) {
    if (rawHeaderValues(rawHeaders, name).length > 1) {
      return { ok: false, code: "BAD_REQUEST" };
    }
  }

  const signatures = rawHeaderValues(rawHeaders, "irs-signature");
  if (signatures.length !== 1) {
    return { ok: false, code: "UNAUTHORIZED" };
  }
  const signature = signatures[0] as string;

  const contentTypes = rawHeaderValues(rawHeaders, "content-type");
  if (
    contentTypes.length !== 1 ||
    !isSupportedContentType(contentTypes[0] as string)
  ) {
    return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" };
  }

  const encodings = rawHeaderValues(rawHeaders, "content-encoding");
  if (
    encodings.length > 1 ||
    (encodings.length === 1 &&
      (encodings[0] as string).trim().toLowerCase() !== "identity")
  ) {
    return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" };
  }

  return {
    ok: true,
    signatureHeader: signature,
    contentType: NORMALIZED_CONTENT_TYPE,
  };
}
