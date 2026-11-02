// The worker's constants (Task 012B-3; B2-9; PD-6 to PD-9; FD-21, FD-22).
// Every value here is PROVISIONAL UNDER O-013: the founder approved them as
// initial values, to be revisited when operating evidence exists. The time
// values are injectable (S-11) so that tests can shorten them without
// changing their meaning; the FD-21 ceilings are fixed and cannot be
// overridden.

/** The injectable values (milliseconds unless the name says otherwise). */
export interface WorkerConstants {
  /** The next cycle starts this long after the previous one ends (PD-8). */
  readonly cycleIntervalMs: number;
  /** The call gate's deadline per Redis operation and per probe (PD-8; B2-13). */
  readonly redisDeadlineMs: number;
  /** An active-generation operation this old requires a replacement (PD-8; B2-13). */
  readonly recoveryPeriodMs: number;
  /** A retiring record counts this long after its retirement step (FD-21, T_retire). */
  readonly retireWindowMs: number;
  /** The degraded back-off: base × 2^n, capped, full jitter (PD-6). */
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  /** Shutdown waits at most this long for the current cycle or readiness attempt (PD-7). */
  readonly shutdownCycleMs: number;
  /** Shutdown waits at most this long for the database (PD-7; equal to @irs/db's DISCONNECT_TIMEOUT_MS). */
  readonly databaseDisconnectMs: number;
  /** 012B-4's values (B2-9), held here so that one module owns them. */
  readonly retryAgeMs: number;
  readonly auditAgeMs: number;
  readonly auditRepairBound: number;
  readonly attemptWarningThreshold: number;
  readonly auditIntervalMs: number;
  readonly claimBatch: number;
}

/** The initial values (B2-9, PD-6 to PD-8); provisional under O-013. */
export const WORKER_CONSTANTS: WorkerConstants = Object.freeze({
  cycleIntervalMs: 1000,
  redisDeadlineMs: 3000,
  recoveryPeriodMs: 30000,
  retireWindowMs: 5000,
  backoffBaseMs: 500,
  backoffCapMs: 5000,
  shutdownCycleMs: 5000,
  databaseDisconnectMs: 5000,
  retryAgeMs: 30000,
  auditAgeMs: 300000,
  auditRepairBound: 3,
  attemptWarningThreshold: 10,
  auditIntervalMs: 30000,
  claimBatch: 100,
});

/**
 * The FD-21 resource ceilings (provisional under O-013, but fixed in code):
 * Q queue generations and P probe connections, each 1 active + 1 retiring;
 * O = 15 normal operations + 1 reserved probe slot; K_max replacements
 * without a confirmed recovery. Not injectable.
 */
export const GATE_CEILINGS = Object.freeze({
  queueGenerations: 2,
  probeConnections: 2,
  normalOperations: 15,
  probeOperations: 1,
  replacementsWithoutRecovery: 3,
});

/** At most this many distinct codes are listed per cycle line (PD-9); the rest go to errorsOther. */
export const MAX_CODES_PER_LINE = 8;

/** At most this many distinct codes are tracked between cycle lines (S-5); further new codes go to the overflow. */
export const MAX_TRACKED_CODES = 64;

export class WorkerConstantsError extends Error {
  override readonly name = "WorkerConstantsError";
  constructor(readonly key: string) {
    super(`worker constant refused: ${key}`);
  }
}

/**
 * The constants with some values overridden (tests; S-11). An unknown key, or
 * a value that is not a positive safe integer, is refused. The ceilings are
 * not part of WorkerConstants, so they cannot be overridden.
 */
export function withConstants(overrides: Partial<Record<string, unknown>>): WorkerConstants {
  const accepted: Record<string, number> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(WORKER_CONSTANTS, key)) throw new WorkerConstantsError(key);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new WorkerConstantsError(key);
    accepted[key] = value;
  }
  return Object.freeze({ ...WORKER_CONSTANTS, ...accepted });
}
