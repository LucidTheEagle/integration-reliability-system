// The worker's fixed-schema logger (Task 012B-3; B2-3 as the founder amended
// it; run 2 §5.2). One method per event. Each validates its fields (the exact
// set, the types and the permitted values) and writes one JSON line, keys in
// schema order. A refusal throws LogSchemaError, which names the event and the
// field, never a value, and nothing is written. Producers normalize codes
// before they reach the logger; the logger refuses rather than rewrites.

/** A Redis code (B2-6): an upper-case word of at most 48 characters. */
export const REDIS_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,47}$/;
/** A database code (S-2): SQLSTATEs, Prisma codes, adapter kinds, error names. */
export const DATABASE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export const STARTUP_PHASES = ["config", "password", "uuidv7", "transition", "database", "readiness", "queue", "ready"] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];
const STARTUP_OUTCOMES = ["ok", "degraded", "exit"] as const;
const CYCLE_STATES = ["ok", "degraded", "stuck"] as const;
const DEGRADED_CAUSES = ["database", "redis"] as const;
const RECOVERY_ACTIONS = ["replace-generation", "replace-probe", "confirmed"] as const;
const STUCK_REASONS = ["queue-ceiling", "probe-ceiling", "replacement-limit", "open-failed"] as const;
const SHUTDOWN_PHASES = ["signal", "cycle-done", "cycle-timeout", "queue-retired", "database-closed", "exit", "fault"] as const;
const MAX_ERRORS_PER_LINE = 8;

export interface StartupFields {
  readonly phase: StartupPhase;
  readonly outcome: (typeof STARTUP_OUTCOMES)[number];
  readonly code?: string;
}
export interface CycleFields {
  readonly n: number;
  readonly state: (typeof CYCLE_STATES)[number];
  readonly redis: {
    readonly outstanding: number;
    readonly terminal: number;
    readonly generation: number;
    readonly retiring: number;
    readonly probeConnections: number;
  };
  readonly errors: readonly { readonly code: string; readonly count: number }[];
  readonly errorsOther: number;
  readonly durationMs: number;
}
export interface DegradedFields {
  readonly cause: (typeof DEGRADED_CAUSES)[number];
  readonly code: string;
}
export interface RecoveryFields {
  readonly action: (typeof RECOVERY_ACTIONS)[number];
  readonly generation: number;
}
export interface StuckFields {
  readonly reason: (typeof STUCK_REASONS)[number];
}
export interface ShutdownFields {
  readonly phase: (typeof SHUTDOWN_PHASES)[number];
  readonly code?: string;
}

export interface WorkerLogger {
  startup(fields: StartupFields): void;
  cycle(fields: CycleFields): void;
  degraded(fields: DegradedFields): void;
  recovery(fields: RecoveryFields): void;
  stuck(fields: StuckFields): void;
  shutdown(fields: ShutdownFields): void;
}

export class LogSchemaError extends Error {
  override readonly name = "LogSchemaError";
  constructor(
    readonly event: string,
    readonly field: string,
  ) {
    super(`log event refused by its schema (${event}: ${field})`);
  }
}

/** The own data properties of a plain object, with exactly the required keys and only the optional ones besides. */
function fieldsOf(value: unknown, event: string, required: readonly string[], optional: readonly string[] = []): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LogSchemaError(event, "(fields)");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new LogSchemaError(event, "(fields)");
  const found = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) {
      throw new LogSchemaError(event, typeof key === "string" ? key : "(symbol)");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) throw new LogSchemaError(event, key);
    if (descriptor.value === undefined && optional.includes(key)) continue;
    found.set(key, descriptor.value);
  }
  for (const key of required) {
    if (!found.has(key)) throw new LogSchemaError(event, key);
  }
  return found;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], event: string, field: string): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new LogSchemaError(event, field);
  return match;
}

function integer(value: unknown, event: string, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new LogSchemaError(event, field);
  return value;
}

function code(value: unknown, pattern: RegExp, event: string, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new LogSchemaError(event, field);
  return value;
}

/** Validates each event and writes one JSON line per event through `write`. */
export function createLogger(write: (line: string) => void): WorkerLogger {
  const emit = (level: "info" | "warn", event: string, body: Record<string, unknown>): void => {
    write(`${JSON.stringify({ level, event, ...body })}\n`);
  };

  return Object.freeze({
    startup: (fields: StartupFields): void => {
      const f = fieldsOf(fields, "startup", ["phase", "outcome"], ["code"]);
      const phase = oneOf(f.get("phase"), STARTUP_PHASES, "startup", "phase");
      const outcome = oneOf(f.get("outcome"), STARTUP_OUTCOMES, "startup", "outcome");
      const body: Record<string, unknown> = { phase, outcome };
      if (f.has("code")) {
        body.code = code(f.get("code"), phase === "readiness" ? DATABASE_CODE_PATTERN : REDIS_CODE_PATTERN, "startup", "code");
      }
      emit(outcome === "ok" ? "info" : "warn", "startup", body);
    },
    cycle: (fields: CycleFields): void => {
      const f = fieldsOf(fields, "cycle", ["n", "state", "redis", "errors", "errorsOther", "durationMs"]);
      const n = integer(f.get("n"), "cycle", "n");
      const state = oneOf(f.get("state"), CYCLE_STATES, "cycle", "state");
      const r = fieldsOf(f.get("redis"), "cycle", ["outstanding", "terminal", "generation", "retiring", "probeConnections"]);
      const redis = {
        outstanding: integer(r.get("outstanding"), "cycle", "redis.outstanding"),
        terminal: integer(r.get("terminal"), "cycle", "redis.terminal"),
        generation: integer(r.get("generation"), "cycle", "redis.generation"),
        retiring: integer(r.get("retiring"), "cycle", "redis.retiring"),
        probeConnections: integer(r.get("probeConnections"), "cycle", "redis.probeConnections"),
      };
      const listed: unknown = f.get("errors");
      if (!Array.isArray(listed) || listed.length > MAX_ERRORS_PER_LINE) throw new LogSchemaError("cycle", "errors");
      const entries: unknown[] = listed;
      const errors = entries.map((entry) => {
        const e = fieldsOf(entry, "cycle", ["code", "count"]);
        return { code: code(e.get("code"), REDIS_CODE_PATTERN, "cycle", "errors.code"), count: integer(e.get("count"), "cycle", "errors.count") };
      });
      const errorsOther = integer(f.get("errorsOther"), "cycle", "errorsOther");
      const durationMs = integer(f.get("durationMs"), "cycle", "durationMs");
      emit(state === "ok" ? "info" : "warn", "cycle", { n, state, redis, errors, errorsOther, durationMs });
    },
    degraded: (fields: DegradedFields): void => {
      const f = fieldsOf(fields, "degraded", ["cause", "code"]);
      const cause = oneOf(f.get("cause"), DEGRADED_CAUSES, "degraded", "cause");
      const value = code(f.get("code"), cause === "database" ? DATABASE_CODE_PATTERN : REDIS_CODE_PATTERN, "degraded", "code");
      emit("warn", "degraded", { cause, code: value });
    },
    recovery: (fields: RecoveryFields): void => {
      const f = fieldsOf(fields, "recovery", ["action", "generation"]);
      const action = oneOf(f.get("action"), RECOVERY_ACTIONS, "recovery", "action");
      const generation = integer(f.get("generation"), "recovery", "generation");
      emit("info", "recovery", { action, generation });
    },
    stuck: (fields: StuckFields): void => {
      const f = fieldsOf(fields, "stuck", ["reason"]);
      const reason = oneOf(f.get("reason"), STUCK_REASONS, "stuck", "reason");
      emit("warn", "stuck", { reason });
    },
    shutdown: (fields: ShutdownFields): void => {
      const f = fieldsOf(fields, "shutdown", ["phase"], ["code"]);
      const phase = oneOf(f.get("phase"), SHUTDOWN_PHASES, "shutdown", "phase");
      const body: Record<string, unknown> = { phase };
      if (f.has("code")) body.code = code(f.get("code"), REDIS_CODE_PATTERN, "shutdown", "code");
      emit(phase === "cycle-timeout" || phase === "fault" ? "warn" : "info", "shutdown", body);
    },
  });
}
