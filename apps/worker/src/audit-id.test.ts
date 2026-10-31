import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPOSITORY_ROOT } from "./repository-root.js";
import { AUDIT_ID_V7_UNAVAILABLE, AuditIdGeneratorUnavailable, requireAuditIdGenerator } from "./audit-id.js";
import type { AuditIdSource } from "./audit-id.js";

// Task 012B (Gate A, PL-7): the worker's UUIDv7 generator, on the real runtime
// and with injected sources. No v4 fallback exists.

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAMPLE = 10_000;

/** The 48-bit Unix millisecond timestamp in the first 12 hex digits (RFC 9562 §5.7). */
function embeddedMillis(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

function unavailable(error: unknown): boolean {
  assert.ok(error instanceof AuditIdGeneratorUnavailable, `expected AuditIdGeneratorUnavailable, got ${String(error)}`);
  assert.equal(error.code, AUDIT_ID_V7_UNAVAILABLE);
  return true;
}

describe("Gate A: the worker's audit id generator (Node's randomUUIDv7)", () => {
  it(`${SAMPLE} values on this runtime: version 7, the RFC 9562 variant, the embedded time inside the call's window, no duplicate`, () => {
    const generate = requireAuditIdGenerator();
    const before = Date.now();
    const ids = Array.from({ length: SAMPLE }, () => generate());
    const after = Date.now();
    assert.equal(ids.filter((id) => V7.test(id)).length, SAMPLE, "every value is v7 with variant 8-b");
    assert.equal(ids.filter((id) => embeddedMillis(id) >= before && embeddedMillis(id) <= after).length, SAMPLE, "inside the window");
    assert.equal(new Set(ids).size, SAMPLE, "no duplicate");
  });

  it("control: the v7 pattern rejects v4 values, so the check above is not vacuous", () => {
    assert.doesNotMatch("3b241101-e2bb-4255-8caf-4136c566a962", V7);
  });

  it("a source without randomUUIDv7 (but with randomUUID) throws the classified code; there is no v4 path", () => {
    let v4Calls = 0;
    // Typed as the runtime it imitates: a crypto module with randomUUID and no randomUUIDv7.
    const source: AuditIdSource & { readonly randomUUID: () => string } = {
      randomUUID: () => {
        v4Calls += 1;
        return "3b241101-e2bb-4255-8caf-4136c566a962";
      },
    };
    assert.throws(() => requireAuditIdGenerator(source), unavailable);
    assert.equal(v4Calls, 0);
  });

  it("a non-function randomUUIDv7 throws the classified code", () => {
    for (const value of [undefined, null, "v7", 7, {}]) {
      assert.throws(() => requireAuditIdGenerator({ randomUUIDv7: value }), unavailable, String(value));
    }
  });

  it("a spy proves randomUUID is never called; the injected v7 generator is used for every id", () => {
    let v4Calls = 0;
    let v7Calls = 0;
    const source = {
      randomUUID: () => {
        v4Calls += 1;
        return "3b241101-e2bb-4255-8caf-4136c566a962";
      },
      randomUUIDv7: () => {
        v7Calls += 1;
        return "01933b5c-7f2a-7c3d-9e4f-0123456789ab";
      },
    };
    const generate = requireAuditIdGenerator(source);
    for (let i = 0; i < 100; i += 1) assert.equal(generate(), "01933b5c-7f2a-7c3d-9e4f-0123456789ab");
    assert.deepEqual({ v4Calls, v7Calls }, { v4Calls: 0, v7Calls: 100 });
  });

  it("the module's source names no v4 generator (no randomUUID call, only randomUUIDv7)", () => {
    const source = readFileSync(join(REPOSITORY_ROOT, "apps", "worker", "src", "audit-id.ts"), "utf8");
    assert.doesNotMatch(source, /randomUUID(?!v7)/);
    assert.match(source, /randomUUIDv7/, "positive control");
  });
});
