import { Prisma } from "./generated/prisma/client.js";

// Database error classification (Rev 1.7 §8.4, amended by Addendum VPF-4).
// The layered rule, in order: phase (commit boundary) first; runner error
// classes; Prisma codes; SQLSTATE; driver-adapter kinds; an exact-match
// allowlist of four plain-Error messages; everything else is FAULT.

export type DatabaseFailureClass = "TRANSIENT" | "FAULT";

export interface DatabaseErrorClassification {
  readonly failureClass: DatabaseFailureClass;
  /** SQLSTATE, Prisma code, driver-adapter kind or error name, for logs only. */
  readonly code: string | undefined;
}

export type LockedTransactionPhase = "NOT_STARTED" | "SETUP" | "LOCK" | "WORK" | "COMMIT";
export type LockedTransactionOutcome = "NOT_COMMITTED" | "UNKNOWN";

/** Attached to every error thrown by withAdvisoryXactLock (§9.2). Never "COMMITTED". */
export interface LockedTransactionFailure {
  readonly phase: LockedTransactionPhase;
  readonly outcome: LockedTransactionOutcome;
}

abstract class LockedTransactionError extends Error implements LockedTransactionFailure {
  readonly phase: LockedTransactionPhase;
  readonly outcome: LockedTransactionOutcome;
  constructor(
    message: string,
    phase: LockedTransactionPhase,
    outcome: LockedTransactionOutcome,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.phase = phase;
    this.outcome = outcome;
  }
}

/** The advisory-lock wait exceeded lockTimeoutMs (55P03). TRANSIENT. */
export class AdvisoryLockTimeoutError extends LockedTransactionError {
  override readonly name = "AdvisoryLockTimeoutError";
}
/** The guard showed the lock statements were not in one transaction. A defect: FAULT. */
export class AdvisoryLockNotInTransactionError extends LockedTransactionError {
  override readonly name = "AdvisoryLockNotInTransactionError";
}
/** The session transaction_timeout was not 0, or unreadable, at s0. A configuration fault: FAULT. */
export class TransactionTimeoutInvariantError extends LockedTransactionError {
  override readonly name = "TransactionTimeoutInvariantError";
}
/** The deadline was reached, or would be reached first. TRANSIENT. */
export class LockedTransactionDeadlineError extends LockedTransactionError {
  override readonly name = "LockedTransactionDeadlineError";
}

/** The ingestion transaction failed after its callback completed: the outcome is unknown (§7.8). */
export class IngestionCommitUnknownError extends Error {
  override readonly name = "IngestionCommitUnknownError";
  constructor(cause: unknown) {
    super("ingestion transaction failed after its callback completed; outcome unknown", { cause });
  }
}

/** An insert that returned no row without a row to explain it (§7.3), or another broken invariant. */
export class IngestionInvariantError extends Error {
  override readonly name = "IngestionInvariantError";
}

// Errors the runner raised after its callback completed (phase COMMIT,
// outcome UNKNOWN). Tracked by identity so that no arbitrary object can
// claim the commit-unknown classification by carrying an `outcome` field.
const commitUnknownErrors = new WeakSet<object>();

/** @internal — used by the runner only. */
export function markCommitUnknown<T extends object>(error: T): T {
  commitUnknownErrors.add(error);
  return error;
}

/**
 * The four plain-Error messages pinned to pg 8.23.1 / pg-pool 3.14.0
 * (VPF-4). Matched exactly; changing this list is a founder decision.
 */
export const TRANSIENT_DRIVER_MESSAGES: readonly string[] = Object.freeze([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Client has encountered a connection error and is not queryable",
  "Connection terminated unexpectedly",
]);

/** The driver versions the allowlist is pinned to; a version test forces review on upgrade. */
export const PINNED_DRIVER_VERSIONS = Object.freeze({ pg: "8.23.1", "pg-pool": "3.14.0" });

const TRANSIENT_PRISMA_CODES = new Set(["P2028", "P1001", "P1017", "P2024"]);
const FAULT_PRISMA_CODES = new Set(["P2003"]);
const TRANSIENT_SQLSTATES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "40001",
  "40P01",
  "55P03",
  "57014",
  // transaction_timeout and idle_in_transaction_session_timeout terminations (§8.4).
  "25P04",
  "25P03",
]);
const TRANSIENT_SQLSTATE_CLASSES = ["08", "53"];
const TRANSIENT_ADAPTER_KINDS = new Set(["DatabaseNotReachable", "ConnectionClosed"]);

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The driver-adapter error cause: from a Prisma error's meta, or a bare DriverAdapterError. */
function adapterCause(error: unknown): unknown {
  const fromMeta = property(property(property(error, "meta"), "driverAdapterError"), "cause");
  if (fromMeta !== undefined) return fromMeta;
  if (error instanceof Error && error.name === "DriverAdapterError") return property(error, "cause");
  return undefined;
}

/** The SQLSTATE carried by a Prisma or driver-adapter error, if any. */
export function sqlStateOf(error: unknown): string | undefined {
  const cause = adapterCause(error);
  return asString(property(cause, "originalCode")) ?? asString(property(cause, "code"));
}

/** The Prisma error code (P....), if any. */
export function prismaCodeOf(error: unknown): string | undefined {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
}

function classifySqlState(sqlState: string): DatabaseFailureClass {
  if (TRANSIENT_SQLSTATES.has(sqlState)) return "TRANSIENT";
  if (TRANSIENT_SQLSTATE_CLASSES.some((prefix) => sqlState.startsWith(prefix))) return "TRANSIENT";
  return "FAULT";
}

/**
 * Classifies a database-path error as TRANSIENT (→ 503) or FAULT (→ 500).
 * It never reads an error message except for the exact allowlist, and it
 * never yields anything that could become a 2xx or a 422.
 */
export function classifyDatabaseError(error: unknown): DatabaseErrorClassification {
  // 1. Phase first: after the commit boundary the outcome is unknown, whatever the shape.
  if (error instanceof IngestionCommitUnknownError) return { failureClass: "TRANSIENT", code: "COMMIT_UNKNOWN" };
  if (typeof error === "object" && error !== null && commitUnknownErrors.has(error)) {
    return { failureClass: "TRANSIENT", code: "COMMIT_UNKNOWN" };
  }

  // 2. Runner and ingestion error classes.
  if (error instanceof AdvisoryLockTimeoutError || error instanceof LockedTransactionDeadlineError) {
    return { failureClass: "TRANSIENT", code: error.name };
  }
  if (
    error instanceof AdvisoryLockNotInTransactionError ||
    error instanceof TransactionTimeoutInvariantError ||
    error instanceof IngestionInvariantError
  ) {
    return { failureClass: "FAULT", code: error.name };
  }

  // 3. Prisma codes.
  const prismaCode = prismaCodeOf(error);
  if (prismaCode !== undefined && TRANSIENT_PRISMA_CODES.has(prismaCode)) {
    return { failureClass: "TRANSIENT", code: prismaCode };
  }
  if (prismaCode !== undefined && FAULT_PRISMA_CODES.has(prismaCode)) {
    return { failureClass: "FAULT", code: prismaCode };
  }

  // 4. SQLSTATE.
  const sqlState = sqlStateOf(error);
  if (sqlState !== undefined) return { failureClass: classifySqlState(sqlState), code: sqlState };

  // 5. Driver-adapter kinds without a SQLSTATE.
  const kind = asString(property(adapterCause(error), "kind"));
  if (kind !== undefined) {
    return { failureClass: TRANSIENT_ADAPTER_KINDS.has(kind) ? "TRANSIENT" : "FAULT", code: kind };
  }

  // 6. Exact allowlist: a plain Error (not a subclass) with no code property.
  if (
    error instanceof Error &&
    Object.getPrototypeOf(error) === Error.prototype &&
    !("code" in error) &&
    TRANSIENT_DRIVER_MESSAGES.includes(error.message)
  ) {
    return { failureClass: "TRANSIENT", code: undefined };
  }

  // 7. Everything else.
  return { failureClass: "FAULT", code: prismaCode ?? (error instanceof Error ? error.name : undefined) };
}
