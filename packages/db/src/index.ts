/**
 * @irs/db
 *
 * Database client initialization, transactions,
 * persistence utilities, and database-facing abstractions.
 *
 * Only this package imports the generated Prisma client
 * (`./generated/prisma`); callers use the types re-exported here.
 */

export {
  DEFAULT_POOL_SETTINGS,
  DEFAULT_TRANSACTION_OPTIONS,
  DISCONNECT_TIMEOUT_MS,
  createDatabase,
  disconnectWithin,
} from "./client.js";
export type {
  CreateDatabaseOptions,
  Database,
  DisconnectOutcome,
  PoolSettings,
  PrismaClient,
  TransactionClient,
  TransactionIsolationLevel,
} from "./client.js";

export {
  AdvisoryLockNotInTransactionError,
  AdvisoryLockTimeoutError,
  IngestionCommitUnknownError,
  IngestionInvariantError,
  LockedTransactionDeadlineError,
  TransactionTimeoutInvariantError,
  classifyDatabaseError,
} from "./errors.js";
export type {
  DatabaseErrorClassification,
  DatabaseFailureClass,
  LockedTransactionFailure,
  LockedTransactionOutcome,
  LockedTransactionPhase,
} from "./errors.js";

export { ingestEvent, sha256Hex } from "./event-ingestion.js";
export type { EventIngestionInput, EventIngestionResult, IneligibleConfigStatus } from "./event-ingestion.js";

export { REQUIRED_MIGRATIONS, verifySchemaReadiness } from "./schema-readiness.js";
export type { SchemaReadiness, SessionAssertion, StructureAssertion } from "./schema-readiness.js";

export {
  MAX_LOCKED_TRANSACTION_WINDOW_MS,
  advisoryLockKey,
  withAdvisoryXactLock,
} from "./advisory-lock.js";
export type { AdvisoryLockKey, LockedTransactionOptions } from "./advisory-lock.js";
