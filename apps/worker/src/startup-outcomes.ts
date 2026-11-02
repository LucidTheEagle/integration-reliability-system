import { ConfigValidationError } from "@irs/config";
import { IllegalEventStateTransitionError } from "@irs/domain";
import { AuditIdGeneratorUnavailable } from "./audit-id.js";
import { DispatchRedisError } from "./dispatch-queue/index.js";
import { DATABASE_CODE_PATTERN, REDIS_CODE_PATTERN } from "./logger.js";
import type { StartupPhase } from "./logger.js";
import { RedisPasswordFileError } from "./redis-password.js";

// The startup classification (Task 012B-3; B2-1; FD-18; PD-10; S-1, S-2).
// By instanceof and fixed fields, never by message. A failure that matches
// no row is unclassifiable and exits 1, fail closed (PD-10). A Redis error
// while opening the queue is never an exit (DR5 §6; FD-18): it is degraded.
// The database classifier is a required parameter, passed by the lifecycle
// from its injected dependency (founder decision PD-B); this module has no
// run-time import of @irs/db.

export interface StartupOutcome {
  readonly outcome: "exit" | "degraded";
  readonly code: string;
}

/** The database classifier's shape (classifyDatabaseError's result). */
export type DatabaseClassifier = (error: unknown) => { readonly failureClass: "TRANSIENT" | "FAULT"; readonly code: string | undefined };

/** gate.start() returned false: a retiring record blocks an open (Rev 2, (B)). */
export const GATE_START_DEFERRED = "GATE_START_DEFERRED";

/** The six readiness reasons (packages/db/src/schema-readiness.ts:58-60). */
export const READINESS_REASONS = Object.freeze([
  "LEDGER_MISSING",
  "MIGRATION_MISSING",
  "MIGRATION_FAILED",
  "UNKNOWN_MIGRATION",
  "STRUCTURE_MISMATCH",
  "SESSION_INVARIANT",
] as const);

const PASSWORD_CODES = Object.freeze({
  "repository-root": "REDIS_PASSWORD_REPOSITORY_ROOT",
  "missing-variable": "REDIS_PASSWORD_MISSING_VARIABLE",
  "unreadable-file": "REDIS_PASSWORD_UNREADABLE_FILE",
  "bad-format": "REDIS_PASSWORD_BAD_FORMAT",
});

const UNCLASSIFIED_EXIT: StartupOutcome = Object.freeze({ outcome: "exit", code: "UNCLASSIFIED" });

/** S-2: a database code passes the shape check, otherwise UNCLASSIFIED. */
export function databaseCode(code: unknown): string {
  return typeof code === "string" && DATABASE_CODE_PATTERN.test(code) ? code : "UNCLASSIFIED";
}

/** A Redis code passes the Redis pattern, otherwise UNCLASSIFIED. */
export function redisCode(code: unknown): string {
  return typeof code === "string" && REDIS_CODE_PATTERN.test(code) ? code : "UNCLASSIFIED";
}

function exit(code: string): StartupOutcome {
  return Object.freeze({ outcome: "exit", code });
}

/** Classifies a thrown startup failure by phase (S-1). */
export function classifyStartupFailure(phase: StartupPhase, error: unknown, classifyDatabase: DatabaseClassifier): StartupOutcome {
  switch (phase) {
    case "config":
      return error instanceof ConfigValidationError ? exit("CONFIG_INVALID") : UNCLASSIFIED_EXIT;
    case "password":
      if (error instanceof RedisPasswordFileError) {
        const code = Object.getOwnPropertyDescriptor(PASSWORD_CODES, error.check)?.value;
        return typeof code === "string" ? exit(code) : UNCLASSIFIED_EXIT;
      }
      return UNCLASSIFIED_EXIT;
    case "uuidv7":
      return error instanceof AuditIdGeneratorUnavailable ? exit("AUDIT_ID_V7_UNAVAILABLE") : UNCLASSIFIED_EXIT;
    case "transition":
      return error instanceof IllegalEventStateTransitionError ? exit("ILLEGAL_EVENT_STATE_TRANSITION") : UNCLASSIFIED_EXIT;
    case "readiness": {
      let classification: ReturnType<DatabaseClassifier>;
      try {
        classification = classifyDatabase(error);
      } catch {
        return UNCLASSIFIED_EXIT;
      }
      const code = databaseCode(classification.code);
      if (classification.failureClass === "TRANSIENT") return Object.freeze({ outcome: "degraded", code });
      if (classification.failureClass === "FAULT") return exit(code);
      return UNCLASSIFIED_EXIT;
    }
    case "queue":
      return error instanceof DispatchRedisError ? Object.freeze({ outcome: "degraded", code: redisCode(error.code) }) : UNCLASSIFIED_EXIT;
    default:
      return UNCLASSIFIED_EXIT;
  }
}

/** A readiness result of `ready: false`: exit with its reason, one of the six (else UNCLASSIFIED). */
export function classifyReadinessResult(result: { readonly ready: false; readonly reason: string }): StartupOutcome {
  const reason = READINESS_REASONS.find((candidate) => candidate === result.reason);
  return reason === undefined ? UNCLASSIFIED_EXIT : exit(reason);
}
