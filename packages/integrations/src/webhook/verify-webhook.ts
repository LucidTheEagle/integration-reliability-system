import { TextDecoder } from "node:util";
import type { FailureClass } from "@irs/domain";
import { validateEnvelope } from "./envelope.js";
import type { VerifiedWebhookEnvelope } from "./envelope.js";
import {
  computeSignature,
  isWithinTolerance,
  parseSignatureHeader,
  signaturesMatch,
} from "./signature.js";

export type { VerifiedWebhookEnvelope } from "./envelope.js";

/** Bounded set of expected sender-side verification failures. */
export type WebhookRejectionReason =
  | "BODY_TOO_LARGE"
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "SIGNATURE_MISMATCH"
  | "TIMESTAMP_OUT_OF_TOLERANCE"
  | "MALFORMED_PAYLOAD"
  | "INVALID_ENVELOPE";

/**
 * An expected verification failure. `message` is a fixed string that
 * never contains the secret, the received signature, or body content.
 */
export interface WebhookRejection {
  readonly reason: WebhookRejectionReason;
  readonly message: string;
  readonly failureClass: FailureClass;
}

export interface VerifyIrsV1WebhookInput {
  /** The exact original request body bytes. Never modified. */
  readonly rawBody: Uint8Array;
  /** Value of the `IRS-Signature` header, or undefined when absent. */
  readonly signatureHeader: string | undefined;
  /** Shared secret bytes; at least 32 bytes. */
  readonly secret: Uint8Array;
  /** The current time. Required: the system clock is never used implicitly. */
  readonly now: Date;
  /** Allowed clock skew in whole seconds, 1-3600. Default 300. */
  readonly toleranceSeconds?: number;
  /** Maximum body size in bytes (positive safe integer). Default 1 MiB. */
  readonly maxBodyBytes?: number;
}

export type VerifyIrsV1WebhookResult =
  | { readonly ok: true; readonly envelope: VerifiedWebhookEnvelope }
  | { readonly ok: false; readonly rejection: WebhookRejection };

const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const MIN_SECRET_BYTES = 32;
const MAX_TOLERANCE_SECONDS = 3600;

const REJECTIONS: Readonly<Record<WebhookRejectionReason, WebhookRejection>> = {
  BODY_TOO_LARGE: {
    reason: "BODY_TOO_LARGE",
    message: "Webhook body exceeds the maximum allowed size.",
    failureClass: "VALIDATION",
  },
  MISSING_SIGNATURE: {
    reason: "MISSING_SIGNATURE",
    message: "Webhook signature is missing.",
    failureClass: "SECURITY",
  },
  MALFORMED_SIGNATURE: {
    reason: "MALFORMED_SIGNATURE",
    message: "Webhook signature is malformed.",
    failureClass: "SECURITY",
  },
  SIGNATURE_MISMATCH: {
    reason: "SIGNATURE_MISMATCH",
    message: "Webhook signature does not match.",
    failureClass: "SECURITY",
  },
  TIMESTAMP_OUT_OF_TOLERANCE: {
    reason: "TIMESTAMP_OUT_OF_TOLERANCE",
    message: "Webhook timestamp is outside the allowed tolerance.",
    failureClass: "SECURITY",
  },
  MALFORMED_PAYLOAD: {
    reason: "MALFORMED_PAYLOAD",
    message: "Webhook payload is not valid UTF-8 JSON.",
    failureClass: "VALIDATION",
  },
  INVALID_ENVELOPE: {
    reason: "INVALID_ENVELOPE",
    message: "Webhook envelope is invalid.",
    failureClass: "VALIDATION",
  },
};

function reject(reason: WebhookRejectionReason): VerifyIrsV1WebhookResult {
  return { ok: false, rejection: { ...REJECTIONS[reason] } };
}

function isInvalidEncodingError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    (error as { code?: unknown }).code === "ERR_ENCODING_INVALID_ENCODED_DATA"
  );
}

function assertValidInput(input: VerifyIrsV1WebhookInput): void {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("input must be an object");
  }
  if (!(input.rawBody instanceof Uint8Array)) {
    throw new TypeError("rawBody must be a Uint8Array");
  }
  if (
    input.signatureHeader !== undefined &&
    typeof input.signatureHeader !== "string"
  ) {
    throw new TypeError("signatureHeader must be a string or undefined");
  }
  if (!(input.secret instanceof Uint8Array)) {
    throw new TypeError("secret must be a Uint8Array");
  }
  if (input.secret.byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(`secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (input.toleranceSeconds !== undefined) {
    if (typeof input.toleranceSeconds !== "number") {
      throw new TypeError("toleranceSeconds must be a number");
    }
    if (
      !Number.isInteger(input.toleranceSeconds) ||
      input.toleranceSeconds < 1 ||
      input.toleranceSeconds > MAX_TOLERANCE_SECONDS
    ) {
      throw new RangeError(
        `toleranceSeconds must be an integer from 1 to ${MAX_TOLERANCE_SECONDS}`,
      );
    }
  }
  if (input.maxBodyBytes !== undefined) {
    if (typeof input.maxBodyBytes !== "number") {
      throw new TypeError("maxBodyBytes must be a number");
    }
    if (
      !Number.isSafeInteger(input.maxBodyBytes) ||
      input.maxBodyBytes < 1
    ) {
      throw new RangeError("maxBodyBytes must be a positive safe integer");
    }
  }
}

/**
 * Verifies an IRS V1 webhook (IRS-owned HMAC-SHA256 protocol for the
 * controlled IRS implementation and mock providers; not a claim of
 * compatibility with any third-party provider) and returns the
 * validated, normalized envelope.
 *
 * Synchronous and framework-independent: no HTTP, database, queue,
 * secret resolution, or logging.
 *
 * Signed message: the exact timestamp digits, one ASCII ".", then the
 * original raw body bytes. Header: `IRS-Signature: t=<unix-seconds>,v1=<64
 * lowercase hex>`; the grammar is exact (order, no whitespace, no extras).
 *
 * Defaults (used when the option is omitted):
 * - `toleranceSeconds`: 300. Exactly +/- 300 s is accepted.
 * - `maxBodyBytes`: 1,048,576 (1 MiB). A body exactly at the limit passes
 *   the size check. This is defense in depth: an HTTP boundary must still
 *   enforce a streaming size limit before buffering the body.
 *
 * Order: argument validation, body size, signature header, HMAC,
 * timestamp tolerance, strict UTF-8 decode and JSON parse, envelope
 * validation. JSON is never parsed before the signature verifies.
 *
 * Expected sender failures are returned as `{ ok: false, rejection }`.
 * Invalid arguments throw TypeError/RangeError with safe messages.
 * Unexpected internal errors are not caught.
 *
 * Limitations: a secret's length is only a guard and does not prove
 * entropy. Replay protection is limited to the timestamp window.
 * Duplicate JSON keys follow `JSON.parse` (last wins); downstream code
 * must use the returned envelope and never reparse the raw body.
 */
export function verifyIrsV1Webhook(
  input: VerifyIrsV1WebhookInput,
): VerifyIrsV1WebhookResult {
  assertValidInput(input);

  const { rawBody, signatureHeader, secret, now } = input;
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  if (rawBody.byteLength > maxBodyBytes) return reject("BODY_TOO_LARGE");

  if (signatureHeader === undefined) return reject("MISSING_SIGNATURE");
  const parsed = parseSignatureHeader(signatureHeader);
  if (parsed === null) return reject("MALFORMED_SIGNATURE");

  const expected = computeSignature(secret, parsed.timestampDigits, rawBody);
  if (!signaturesMatch(expected, parsed.signatureHex)) {
    return reject("SIGNATURE_MISMATCH");
  }

  if (!isWithinTolerance(now, parsed.timestampSeconds, toleranceSeconds)) {
    return reject("TIMESTAMP_OUT_OF_TOLERANCE");
  }

  // ignoreBOM: true keeps a leading BOM in the text so JSON.parse rejects
  // it, rather than the decoder silently discarding it.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(rawBody);
  } catch (error) {
    if (isInvalidEncodingError(error)) return reject("MALFORMED_PAYLOAD");
    throw error;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch (error) {
    // The SyntaxError message may echo body content; it is discarded.
    if (error instanceof SyntaxError) return reject("MALFORMED_PAYLOAD");
    throw error;
  }

  const validation = validateEnvelope(parsedBody);
  if (!validation.ok) return reject("INVALID_ENVELOPE");

  return { ok: true, envelope: validation.envelope };
}
