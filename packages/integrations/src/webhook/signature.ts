import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Internal helpers for the IRS V1 webhook signature protocol.
 * Not part of the package's public API.
 *
 * Header grammar (exact, no whitespace, fixed parameter order):
 *   t=<unix-seconds>,v1=<signature>
 *   - unix-seconds: 1-15 decimal digits, no leading zero except "0" itself
 *   - signature: exactly 64 lowercase hexadecimal characters
 */
const SIGNATURE_HEADER_PATTERN = /^t=(0|[1-9][0-9]{0,14}),v1=([0-9a-f]{64})$/;

export interface ParsedSignatureHeader {
  /** The exact timestamp digits, as they appear in the signed message. */
  readonly timestampDigits: string;
  readonly timestampSeconds: number;
  /** 64 lowercase hex characters (strictly validated). */
  readonly signatureHex: string;
}

/** Returns null for anything that does not match the exact grammar. */
export function parseSignatureHeader(
  header: string,
): ParsedSignatureHeader | null {
  const match = SIGNATURE_HEADER_PATTERN.exec(header);
  if (match === null) return null;
  const timestampDigits = match[1] as string;
  const signatureHex = match[2] as string;
  return {
    timestampDigits,
    // At most 15 digits, so this is always an exact safe integer.
    timestampSeconds: Number(timestampDigits),
    signatureHex,
  };
}

/**
 * HMAC-SHA256 over: timestamp digits, one ASCII period, the original raw
 * body bytes. The body is hashed in place; it is never copied or modified.
 */
export function computeSignature(
  secret: Uint8Array,
  timestampDigits: string,
  rawBody: Uint8Array,
): Buffer {
  return createHmac("sha256", secret)
    .update(Buffer.from(`${timestampDigits}.`, "ascii"))
    .update(rawBody)
    .digest();
}

/**
 * Constant-time comparison. `receivedHex` must already have passed
 * parseSignatureHeader, so it decodes to exactly 32 bytes and
 * timingSafeEqual cannot throw on a length mismatch.
 */
export function signaturesMatch(expected: Buffer, receivedHex: string): boolean {
  const received = Buffer.from(receivedHex, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

/** Inclusive window: exactly +/- toleranceSeconds is accepted. */
export function isWithinTolerance(
  now: Date,
  timestampSeconds: number,
  toleranceSeconds: number,
): boolean {
  const deltaMs = Math.abs(now.getTime() - timestampSeconds * 1000);
  return deltaMs <= toleranceSeconds * 1000;
}
