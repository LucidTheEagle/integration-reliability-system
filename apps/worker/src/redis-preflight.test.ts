import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_REDIS_VERSION, EXPECTED_SERVER_CONFIG, USED_MEMORY_LIMIT_BYTES } from "./test-support/redis-registry.js";
import { PreflightFailure, preflightReport, runPreflightWith, withinUsedMemoryLimit } from "./test-support/redis-preflight.js";
import type { PreflightReads } from "./test-support/redis-preflight.js";

// The preflight's D-F2 threshold (item 4), with injected readings and no
// Redis: it passes at or below 25,165,824 bytes of used_memory and refuses
// above it with "founder reset required".

const BASELINE = {
  redisVersion: EXPECTED_REDIS_VERSION,
  config: Object.fromEntries(Object.entries(EXPECTED_SERVER_CONFIG).map(([name, value]) => [name, [name, value]])),
};

function reads(usedMemory: number, overrides: Partial<PreflightReads> = {}): PreflightReads {
  return {
    checkEndpoint: async () => undefined,
    serverBaseline: async () => BASELINE,
    usedMemory: async () => usedMemory,
    ...overrides,
  };
}

async function refusesWith(pattern: RegExp, preflight: Promise<unknown>): Promise<void> {
  await assert.rejects(preflight, (error: unknown) => error instanceof PreflightFailure && pattern.test(error.message));
}

describe("redis preflight: the used_memory threshold", () => {
  it("is 24 MiB, 25,165,824 bytes", () => {
    assert.equal(USED_MEMORY_LIMIT_BYTES, 25_165_824);
    assert.equal(USED_MEMORY_LIMIT_BYTES, 24 * 1024 * 1024);
  });

  it("passes at exactly 25,165,824 bytes and below", async () => {
    for (const value of [25_165_824, 25_165_823, 1_198_344, 0]) {
      assert.equal(withinUsedMemoryLimit(value), true, `${value}`);
      assert.deepEqual(await runPreflightWith(reads(value)), { usedMemory: value });
    }
  });

  it("refuses at 25,165,825 bytes and above, with \"founder reset required\"", async () => {
    for (const value of [25_165_825, 25_165_826, 67_108_864]) {
      assert.equal(withinUsedMemoryLimit(value), false, `${value}`);
      await refusesWith(/founder reset required/, runPreflightWith(reads(value)));
    }
  });

  it("refuses a reading that is not a byte count", async () => {
    for (const value of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await refusesWith(/not a byte count/, runPreflightWith(reads(value)));
    }
  });

  it("reports the reading and the limit when it passes", () => {
    const lines = preflightReport({ usedMemory: 1_198_344 });
    assert.equal(lines.at(-1), "[redis-preflight] used_memory 1198344 bytes (limit 25165824): within the limit");
  });
});

describe("redis preflight: order and the server baseline", () => {
  it("reads used_memory only after the guard and the baseline pass", async () => {
    let memoryRead = false;
    const guardRefusal = new Error("guard refused");
    await assert.rejects(
      runPreflightWith(
        reads(0, {
          checkEndpoint: async () => {
            throw guardRefusal;
          },
          usedMemory: async () => {
            memoryRead = true;
            return 0;
          },
        }),
      ),
      (error: unknown) => error === guardRefusal,
    );
    assert.equal(memoryRead, false);
  });

  it("refuses a wrong version or a wrong server setting", async () => {
    await refusesWith(/redis_version/, runPreflightWith(reads(0, { serverBaseline: async () => ({ ...BASELINE, redisVersion: "7.4.10" }) })));
    await refusesWith(
      /CONFIG GET maxmemory-policy/,
      runPreflightWith(
        reads(0, {
          serverBaseline: async () => ({ ...BASELINE, config: { ...BASELINE.config, "maxmemory-policy": ["maxmemory-policy", "allkeys-lru"] } }),
        }),
      ),
    );
  });
});
