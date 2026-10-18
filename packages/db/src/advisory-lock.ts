import { createHash, randomUUID } from "node:crypto";
import type { Database, TransactionClient } from "./client.js";
import {
  AdvisoryLockNotInTransactionError,
  AdvisoryLockTimeoutError,
  LockedTransactionDeadlineError,
  TransactionTimeoutInvariantError,
  markCommitUnknown,
  prismaCodeOf,
  sqlStateOf,
} from "./errors.js";
import type { LockedTransactionPhase } from "./errors.js";
import { Prisma } from "./generated/prisma/client.js";

// Lock-scoped transaction runner (Rev 1.7 §9). The only way @irs/db takes an
// advisory lock: the lock is the first thing the runner-owned transaction
// does, and the protected work runs afterwards in that same transaction.

export {
  AdvisoryLockNotInTransactionError,
  AdvisoryLockTimeoutError,
  LockedTransactionDeadlineError,
  TransactionTimeoutInvariantError,
} from "./errors.js";
export type { LockedTransactionFailure, LockedTransactionOutcome, LockedTransactionPhase } from "./errors.js";

declare const lockKeyBrand: unique symbol;
/** A signed 64-bit advisory-lock key. */
export type AdvisoryLockKey = bigint & { readonly [lockKeyBrand]: true };

/**
 * Deterministic: SHA-256(UTF-8(namespace) ‖ 0x00 ‖ UTF-8(identity)), first 8
 * bytes big-endian, as a signed 64-bit integer. Throws TypeError on an empty
 * namespace or identity.
 */
export function advisoryLockKey(namespace: string, identity: string): AdvisoryLockKey {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new TypeError("advisory-lock namespace must be a non-empty string");
  }
  if (typeof identity !== "string" || identity.length === 0) {
    throw new TypeError("advisory-lock identity must be a non-empty string");
  }
  const digest = createHash("sha256")
    .update(Buffer.concat([Buffer.from(namespace, "utf8"), Buffer.from([0]), Buffer.from(identity, "utf8")]))
    .digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)) as AdvisoryLockKey;
}

export interface LockedTransactionOptions {
  /** Absolute instant on the database's monotonic clock (ms) by which the transaction must have ended. */
  readonly deadline: number;
  /** Integer ≥ 1: bound on waiting for the advisory lock. */
  readonly lockTimeoutMs: number;
  /** Integer ≥ 1, > commitReserveMs: time reserved after the lock is held for the work and commit. */
  readonly postLockReserveMs: number;
  /** Integer ≥ 1: no COMMIT is sent later than deadline − commitReserveMs. */
  readonly commitReserveMs: number;
  /** Integer ≥ 1: connection acquisition, before the transaction starts. */
  readonly maxWaitMs: number;
}

/** Cap on (deadline − now) at call time (F-18). An absolute ceiling, not a normal duration. */
export const MAX_LOCKED_TRANSACTION_WINDOW_MS = 30_000;

/** `transaction_timeout` reads as zero, with or without a unit. */
const ZERO_DURATION = /^0(?:us|ms|s|min|h|d)?$/;

function validateOptions(options: LockedTransactionOptions): void {
  const integers = [options.lockTimeoutMs, options.postLockReserveMs, options.commitReserveMs, options.maxWaitMs];
  if (typeof options.deadline !== "number" || !Number.isFinite(options.deadline)) {
    throw new RangeError("deadline must be a finite number");
  }
  if (integers.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
    throw new RangeError("lockTimeoutMs, postLockReserveMs, commitReserveMs and maxWaitMs must be integers ≥ 1");
  }
  if (options.postLockReserveMs <= options.commitReserveMs) {
    throw new RangeError("postLockReserveMs must be greater than commitReserveMs");
  }
}

/**
 * @internal — s1–s4 (§9.3 step 4), exported for the guard test (AL-T6b) only;
 * not part of the package API. Called by the runner with its transaction client.
 */
export async function runLockSetup(
  client: Pick<TransactionClient, "$queryRaw" | "$executeRaw">,
  key: AdvisoryLockKey,
  transactionTimeoutMs: number,
  lockTimeoutMs: number,
  monotonicNow: () => number,
  deadline: number,
  onPhase: (phase: LockedTransactionPhase) => void = () => undefined,
): Promise<void> {
  const nonce = randomUUID();
  // s1
  await client.$queryRaw`SELECT set_config('transaction_timeout', ${String(transactionTimeoutMs)}, true), set_config('statement_timeout', '0', true), set_config('lock_timeout', ${String(lockTimeoutMs)}, true), set_config('irs.advisory_lock_guard', ${nonce}, true)`;
  // s2
  const guard = await client.$queryRaw<{ guard: string | null }[]>`SELECT current_setting('irs.advisory_lock_guard', true) AS guard`;
  if (guard[0]?.guard !== nonce) {
    throw new AdvisoryLockNotInTransactionError(
      "the advisory-lock statements are not running in one transaction",
      "SETUP",
      "NOT_COMMITTED",
    );
  }
  // s3: the lock statement alone; no read is ever combined with it (§9.5).
  onPhase("LOCK");
  try {
    await client.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
  } catch (error) {
    if (monotonicNow() >= deadline) {
      throw new LockedTransactionDeadlineError("transaction deadline reached during the lock wait", "LOCK", "NOT_COMMITTED", error);
    }
    if (sqlStateOf(error) === "55P03") {
      throw new AdvisoryLockTimeoutError("advisory lock not acquired within lockTimeoutMs", "LOCK", "NOT_COMMITTED", error);
    }
    throw error;
  }
  // s4: explicitly 0, not "restored" (R1.2-2).
  await client.$queryRaw`SELECT set_config('lock_timeout', '0', true)`;
}

/**
 * Opens one READ COMMITTED interactive transaction, takes the advisory lock
 * as its first statements, then runs `work` in it, bounded by an absolute
 * deadline on the database's monotonic clock. Every thrown error carries
 * `phase` and `outcome`; an error after the callback completed is
 * COMMIT/UNKNOWN.
 */
export async function withAdvisoryXactLock<T>(
  db: Database,
  key: AdvisoryLockKey,
  options: LockedTransactionOptions,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  validateOptions(options);
  const { deadline, lockTimeoutMs, postLockReserveMs, commitReserveMs, maxWaitMs } = options;
  const t0 = db.monotonicNow();
  const w0 = Math.floor(deadline - t0);
  if (w0 > MAX_LOCKED_TRANSACTION_WINDOW_MS) {
    throw new RangeError("the deadline is further away than MAX_LOCKED_TRANSACTION_WINDOW_MS");
  }
  if (w0 < maxWaitMs + lockTimeoutMs + postLockReserveMs) {
    throw new LockedTransactionDeadlineError("the window cannot fit at call time", "NOT_STARTED", "NOT_COMMITTED");
  }

  let phase: LockedTransactionPhase = "NOT_STARTED";
  let callbackCompleted = false;
  try {
    return await db.prisma.$transaction(
      async (tx) => {
        phase = "SETUP";
        // s0: the session transaction_timeout must be 0 on this physical session (§8.5, F1).
        let sessionValue: string | undefined;
        try {
          const rows = await tx.$queryRaw<{ tt: string }[]>`SELECT current_setting('transaction_timeout') AS tt`;
          sessionValue = rows[0]?.tt;
        } catch (error) {
          throw new TransactionTimeoutInvariantError("transaction_timeout is unreadable at s0", "SETUP", "NOT_COMMITTED", error);
        }
        if (sessionValue === undefined || !ZERO_DURATION.test(sessionValue)) {
          throw new TransactionTimeoutInvariantError(
            `the session transaction_timeout is ${String(sessionValue)} at s0`,
            "SETUP",
            "NOT_COMMITTED",
          );
        }
        const w1 = Math.floor(deadline - db.monotonicNow());
        if (w1 < lockTimeoutMs + postLockReserveMs) {
          throw new LockedTransactionDeadlineError("the window shrank below the minimum before s1", "SETUP", "NOT_COMMITTED");
        }
        await runLockSetup(tx, key, w1, lockTimeoutMs, db.monotonicNow, deadline, (next) => {
          phase = next;
        });

        phase = "WORK";
        const result = await work(tx);
        // Commit gate (§9.3 step 6).
        if (db.monotonicNow() >= deadline - commitReserveMs) {
          throw new LockedTransactionDeadlineError("the commit gate has passed", "WORK", "NOT_COMMITTED");
        }
        phase = "COMMIT";
        callbackCompleted = true;
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: maxWaitMs,
        timeout: w0 - maxWaitMs,
      },
    );
  } catch (error) {
    throw annotateRunnerError(error, phase, callbackCompleted, db.monotonicNow() >= deadline);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("non-error value thrown", { cause: error });
}

/** §9.4 outcome mapping. Never reports COMMITTED. */
function annotateRunnerError(
  error: unknown,
  phase: LockedTransactionPhase,
  callbackCompleted: boolean,
  pastDeadline: boolean,
): Error {
  if (callbackCompleted) {
    return markCommitUnknown(Object.assign(asError(error), { phase: "COMMIT" as const, outcome: "UNKNOWN" as const }));
  }
  if (
    error instanceof AdvisoryLockTimeoutError ||
    error instanceof AdvisoryLockNotInTransactionError ||
    error instanceof TransactionTimeoutInvariantError ||
    error instanceof LockedTransactionDeadlineError
  ) {
    return error;
  }
  const deadlineCause = pastDeadline || sqlStateOf(error) === "25P04" || prismaCodeOf(error) === "P2028";
  if ((phase === "LOCK" || phase === "WORK") && deadlineCause) {
    return new LockedTransactionDeadlineError("the transaction deadline was reached", phase, "NOT_COMMITTED", error);
  }
  return Object.assign(asError(error), { phase, outcome: "NOT_COMMITTED" as const });
}
