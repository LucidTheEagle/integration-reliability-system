import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadWebhookSecrets } from "./index.js";

const ID_A = "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61"; // version 7
const ID_B = "3f2b8a64-1c9d-4e7a-9b21-5d6e7f8a9b0c"; // version 4
const ID_C = "6fa459ea-ee8a-3ca4-894e-db77e160355e"; // version 3

// Synthetic test values only; not real secrets.
const HEX_A = "0123456789abcdef".repeat(4); // 64 hex chars = 32 bytes
const HEX_B = "fedcba9876543210".repeat(6); // 96 hex chars = 48 bytes

function env(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { IRS_WEBHOOK_SECRETS: value };
}

function messageOf(value: string): string {
  try {
    loadWebhookSecrets(env(value));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as ConfigValidationError).message;
  }
  throw new Error("expected loadWebhookSecrets to throw");
}

describe("loadWebhookSecrets - valid configuration", () => {
  it("decodes lowercase hex secrets to exact bytes, keyed by integration ID", () => {
    const secrets = loadWebhookSecrets(env(`${ID_A}=${HEX_A},${ID_B}=${HEX_B}`));
    expect(secrets.size).toBe(2);
    expect(secrets.get(ID_A)).toEqual(new Uint8Array(Buffer.from(HEX_A, "hex")));
    expect(secrets.get(ID_B)).toEqual(new Uint8Array(Buffer.from(HEX_B, "hex")));
    expect(secrets.get(ID_A)?.byteLength).toBe(32);
    expect(secrets.get(ID_B)?.byteLength).toBe(48);
    expect(secrets.get(ID_A)).toBeInstanceOf(Uint8Array);
  });

  it("accepts UUIDs of any version", () => {
    const secrets = loadWebhookSecrets(
      env([ID_A, ID_B, ID_C].map((id) => `${id}=${HEX_A}`).join(",")),
    );
    expect([...secrets.keys()]).toEqual([ID_A, ID_B, ID_C]);
  });

  it("accepts a single entry", () => {
    expect(loadWebhookSecrets(env(`${ID_A}=${HEX_A}`)).size).toBe(1);
  });

  it("decodes bytes, not text (an all-zero secret is 32 zero bytes)", () => {
    const secrets = loadWebhookSecrets(env(`${ID_A}=${"00".repeat(32)}`));
    expect(secrets.get(ID_A)).toEqual(new Uint8Array(32));
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("yields an empty map when the variable is %s", (_name, value) => {
    const secrets = loadWebhookSecrets(env(value));
    expect(secrets.size).toBe(0);
  });

  it("ignores unrelated variables and does not require loadConfig variables", () => {
    expect(
      loadWebhookSecrets({
        IRS_WEBHOOK_SECRETS: `${ID_A}=${HEX_A}`,
        PATH: "/x",
      }).size,
    ).toBe(1);
  });
});

describe("loadWebhookSecrets - invalid configuration", () => {
  it.each([
    ["no separator", `${ID_A}${HEX_A}`],
    ["empty secret", `${ID_A}=`],
    ["empty key", `=${HEX_A}`],
    ["two separators", `${ID_A}=${HEX_A}=${HEX_A}`],
    ["trailing comma (empty entry)", `${ID_A}=${HEX_A},`],
    ["leading comma (empty entry)", `,${ID_A}=${HEX_A}`],
    ["doubled comma (empty entry)", `${ID_A}=${HEX_A},,${ID_B}=${HEX_A}`],
    ["a lone comma", ","],
  ])("rejects a malformed entry: %s", (_name, value) => {
    expect(messageOf(value)).toContain("IRS_WEBHOOK_SECRETS: entry");
  });

  it.each([
    ["uppercase UUID", ID_A.toUpperCase()],
    ["UUID without hyphens", ID_A.replaceAll("-", "")],
    ["braced UUID", `{${ID_A}}`],
    ["URN form", `urn:uuid:${ID_A}`],
    ["non-UUID key", "stripe"],
    ["UUID with a trailing character", `${ID_A}0`],
    ["padded UUID", ` ${ID_A}`],
    ["__proto__", "__proto__"],
  ])("rejects an invalid integration ID: %s", (_name, key) => {
    expect(messageOf(`${key}=${HEX_A}`)).toContain("canonical lowercase UUID");
  });

  it.each([
    ["uppercase hex", HEX_A.toUpperCase()],
    ["mixed-case hex", `A${HEX_A.slice(1)}`],
    ["non-hex characters", `${"zz".repeat(32)}`],
    ["a 0x prefix", `0x${HEX_A}`],
    ["whitespace in the secret", `${HEX_A} `],
    ["base64 padding", `${HEX_A}==`],
  ])("rejects a secret with %s", (_name, secret) => {
    expect(messageOf(`${ID_A}=${secret}`)).toMatch(
      /lowercase hexadecimal|must be <integration-uuid>=<hex-secret>/,
    );
  });

  it("rejects an odd-length secret", () => {
    expect(messageOf(`${ID_A}=${HEX_A}a`)).toContain("even number of hex characters");
  });

  it("rejects a secret shorter than 32 bytes (62 hex characters)", () => {
    expect(messageOf(`${ID_A}=${HEX_A.slice(0, 62)}`)).toContain("at least 32 bytes");
  });

  it("rejects an odd-length secret even when it is long enough", () => {
    expect(messageOf(`${ID_A}=${HEX_A}${"a".repeat(7)}`)).toContain("even number");
  });

  it("accepts a secret of exactly 32 bytes and rejects 31 bytes", () => {
    expect(() => loadWebhookSecrets(env(`${ID_A}=${"ab".repeat(32)}`))).not.toThrow();
    expect(messageOf(`${ID_A}=${"ab".repeat(31)}`)).toContain("at least 32 bytes");
  });

  it("rejects duplicate integration IDs, even with identical secrets", () => {
    const message = messageOf(`${ID_A}=${HEX_A},${ID_B}=${HEX_B},${ID_A}=${HEX_A}`);
    expect(message).toContain("entry 3");
    expect(message).toContain("duplicate integration ID");
  });

  it("identifies the failing entry by its 1-based index", () => {
    const message = messageOf(`${ID_A}=${HEX_A},${ID_B}=${HEX_B},${ID_C}=${"ab".repeat(8)}`);
    expect(message).toBe(
      "Invalid configuration:\n  - IRS_WEBHOOK_SECRETS: entry 3: secret must be at least 32 bytes (64 hex characters)",
    );
  });

  it("is all-or-nothing: one bad entry rejects the whole configuration", () => {
    expect(() =>
      loadWebhookSecrets(env(`${ID_A}=${HEX_A},${ID_B}=nothex`)),
    ).toThrow(ConfigValidationError);
  });

  it("never includes secrets, integration IDs, or the raw value in error messages", () => {
    const bad = [
      `${ID_A}=${HEX_B.toUpperCase()}`, // uppercase hex
      `${ID_A}=${HEX_A.slice(0, 40)}`, // too short
      `${ID_A}=${HEX_A}a`, // odd length
      `${ID_A}=${HEX_A},${ID_A}=${HEX_B}`, // duplicate
      `${ID_A.toUpperCase()}=${HEX_B}`, // bad key
      `${ID_A}${HEX_B}`, // malformed
    ];
    for (const raw of bad) {
      const message = messageOf(raw);
      for (const sensitive of [HEX_A, HEX_B, HEX_B.toUpperCase(), ID_A, ID_A.toUpperCase(), raw]) {
        expect(message).not.toContain(sensitive);
      }
      // Partial secret material must not appear either.
      expect(message).not.toContain(HEX_A.slice(0, 16));
      expect(message).not.toContain(HEX_B.slice(0, 16));
    }
  });
});
