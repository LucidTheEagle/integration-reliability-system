import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LogSchemaError, createLogger } from "./logger.js";
import type { WorkerLogger } from "./logger.js";

// Task 012B-3 (B2-3 as the founder amended it; run 2 §5.2): every event's
// schema pinned, with planted controls. A refusal writes nothing and carries
// no value.

const MARKER = "planted-marker-7f3a";
const REDIS = { outstanding: 1, terminal: 0, generation: 1, retiring: 0, probeConnections: 1 };

function capture(): { readonly logger: WorkerLogger; readonly lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger((line) => lines.push(line)), lines };
}

/** An untyped copy, so that a test can plant what the types forbid. */
function untyped<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value));
}

function refused(action: (logger: WorkerLogger) => void): void {
  const { logger, lines } = capture();
  assert.throws(
    () => action(logger),
    (error: unknown) => {
      assert.ok(error instanceof LogSchemaError);
      assert.ok(!error.message.includes(MARKER), "a refusal carries no value");
      return true;
    },
  );
  assert.deepEqual(lines, [], "nothing is written");
}

describe("logger: the event schemas", () => {
  it("startup: phase, outcome and an optional code, keys in schema order, one line each", () => {
    const { logger, lines } = capture();
    logger.startup({ phase: "config", outcome: "ok" });
    logger.startup({ phase: "readiness", outcome: "exit", code: "MIGRATION_MISSING" });
    logger.startup({ phase: "queue", outcome: "degraded", code: "GATE_START_DEFERRED" });
    assert.deepEqual(lines, [
      '{"level":"info","event":"startup","phase":"config","outcome":"ok"}\n',
      '{"level":"warn","event":"startup","phase":"readiness","outcome":"exit","code":"MIGRATION_MISSING"}\n',
      '{"level":"warn","event":"startup","phase":"queue","outcome":"degraded","code":"GATE_START_DEFERRED"}\n',
    ]);
  });

  it("cycle: the fixed fields; warn when the state is not ok", () => {
    const { logger, lines } = capture();
    logger.cycle({ n: 1, state: "ok", redis: REDIS, errors: [{ code: "ECONNREFUSED", count: 2 }], errorsOther: 0, durationMs: 3 });
    logger.cycle({ n: 2, state: "degraded", redis: REDIS, errors: [], errorsOther: 0, durationMs: 0 });
    logger.cycle({ n: 3, state: "stuck", redis: REDIS, errors: [], errorsOther: 5, durationMs: 0 });
    assert.deepEqual(lines, [
      '{"level":"info","event":"cycle","n":1,"state":"ok","redis":{"outstanding":1,"terminal":0,"generation":1,"retiring":0,"probeConnections":1},"errors":[{"code":"ECONNREFUSED","count":2}],"errorsOther":0,"durationMs":3}\n',
      '{"level":"warn","event":"cycle","n":2,"state":"degraded","redis":{"outstanding":1,"terminal":0,"generation":1,"retiring":0,"probeConnections":1},"errors":[],"errorsOther":0,"durationMs":0}\n',
      '{"level":"warn","event":"cycle","n":3,"state":"stuck","redis":{"outstanding":1,"terminal":0,"generation":1,"retiring":0,"probeConnections":1},"errors":[],"errorsOther":5,"durationMs":0}\n',
    ]);
  });

  it("degraded, recovery, stuck and shutdown: their fixed fields and levels", () => {
    const { logger, lines } = capture();
    logger.degraded({ cause: "database", code: "08006" });
    logger.degraded({ cause: "redis", code: "PROBE_DEADLINE" });
    logger.recovery({ action: "replace-generation", generation: 2 });
    logger.stuck({ reason: "replacement-limit" });
    logger.shutdown({ phase: "signal" });
    logger.shutdown({ phase: "cycle-timeout" });
    logger.shutdown({ phase: "fault", code: "UNCLASSIFIED" });
    logger.shutdown({ phase: "exit" });
    assert.deepEqual(lines, [
      '{"level":"warn","event":"degraded","cause":"database","code":"08006"}\n',
      '{"level":"warn","event":"degraded","cause":"redis","code":"PROBE_DEADLINE"}\n',
      '{"level":"info","event":"recovery","action":"replace-generation","generation":2}\n',
      '{"level":"warn","event":"stuck","reason":"replacement-limit"}\n',
      '{"level":"info","event":"shutdown","phase":"signal"}\n',
      '{"level":"warn","event":"shutdown","phase":"cycle-timeout"}\n',
      '{"level":"warn","event":"shutdown","phase":"fault","code":"UNCLASSIFIED"}\n',
      '{"level":"info","event":"shutdown","phase":"exit"}\n',
    ]);
  });

  it("each code position checks the pattern it requires (Redis or S-2's database pattern)", () => {
    const { logger } = capture();
    logger.startup({ phase: "readiness", outcome: "exit", code: "PrismaClientKnownRequestError" });
    logger.degraded({ cause: "database", code: "P1001" });
    refused((l) => l.startup({ phase: "queue", outcome: "degraded", code: "PrismaClientKnownRequestError" }));
    refused((l) => l.degraded({ cause: "redis", code: "08006a" }));
  });
});

describe("logger: planted controls (each refused, nothing written)", () => {
  it("an extra field", () => {
    const fields = { phase: "config", outcome: "ok", extra: MARKER } as const;
    refused((l) => l.startup(fields));
    const redis = { ...REDIS, extra: 1 };
    refused((l) => l.cycle({ n: 1, state: "ok", redis, errors: [], errorsOther: 0, durationMs: 0 }));
  });

  it("a missing field", () => {
    refused((l) => l.startup(untyped({ phase: "config" })));
    refused((l) => l.cycle(untyped({ n: 1, state: "ok", redis: REDIS, errors: [], durationMs: 0 })));
    refused((l) => l.recovery(untyped({ action: "confirmed" })));
  });

  it("a value outside an enum", () => {
    refused((l) => l.startup(untyped({ phase: "dispatch", outcome: "ok" })));
    refused((l) => l.cycle(untyped({ n: 1, state: "healthy", redis: REDIS, errors: [], errorsOther: 0, durationMs: 0 })));
    refused((l) => l.stuck(untyped({ reason: MARKER })));
    refused((l) => l.shutdown(untyped({ phase: "crash" })));
  });

  it("a non-integer where an int is required", () => {
    refused((l) => l.cycle({ n: 1.5, state: "ok", redis: REDIS, errors: [], errorsOther: 0, durationMs: 0 }));
    refused((l) => l.cycle({ n: 1, state: "ok", redis: { ...REDIS, outstanding: -1 }, errors: [], errorsOther: 0, durationMs: 0 }));
    refused((l) => l.recovery(untyped({ action: "confirmed", generation: "1" })));
  });

  it("a raw Error as a value", () => {
    const error = new Error(MARKER);
    refused((l) => l.degraded({ cause: "redis", code: untypedError(error) }));
    refused((l) => l.shutdown({ phase: "fault", code: untypedError(error) }));
    refused((l) => l.cycle({ n: 1, state: "ok", redis: REDIS, errors: [], errorsOther: 0, durationMs: untypedNumber(error) }));
  });

  it("a 49-character code and a lower-case Redis code", () => {
    refused((l) => l.degraded({ cause: "redis", code: `E${"X".repeat(48)}` }));
    refused((l) => l.degraded({ cause: "redis", code: "econnrefused" }));
  });

  it("a planted secret marker in every free position", () => {
    refused((l) => l.startup({ phase: "queue", outcome: "degraded", code: MARKER }));
    refused((l) => l.startup({ phase: "readiness", outcome: "exit", code: `${MARKER} x` }));
    refused((l) => l.degraded({ cause: "redis", code: MARKER }));
    refused((l) => l.degraded({ cause: "database", code: `${MARKER} x` }));
    refused((l) => l.shutdown({ phase: "fault", code: MARKER }));
    refused((l) => l.cycle({ n: 1, state: "ok", redis: REDIS, errors: [{ code: MARKER, count: 1 }], errorsOther: 0, durationMs: 0 }));
  });

  it("nine errors entries", () => {
    const errors = Array.from({ length: 9 }, (_, index) => ({ code: `CODE_${index}`, count: 1 }));
    refused((l) => l.cycle({ n: 1, state: "ok", redis: REDIS, errors, errorsOther: 0, durationMs: 0 }));
  });
});

/** An Error where the types expect a string (Object() of an object returns that same object, typed any). */
function untypedError(error: Error): string {
  return Object(error);
}

/** An Error where the types expect a number. */
function untypedNumber(error: Error): number {
  return Object(error);
}
