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
export type { ReadinessProfile, SchemaReadiness, SessionAssertion, StructureAssertion } from "./schema-readiness.js";

// Task 012B (B2-11, FD-5): the dispatcher's audit insert; its callers are 012B-3/012B-4's.
export { insertDispatchAuditEntry } from "./dispatch-audit.js";
export type {
  DispatchAuditAction,
  DispatchAuditEntryInput,
  DispatchAuditJson,
  DispatchAuditMetadata,
  DispatchAuditRefusalCode,
} from "./dispatch-audit.js";

export {
  MAX_LOCKED_TRANSACTION_WINDOW_MS,
  advisoryLockKey,
  withAdvisoryXactLock,
} from "./advisory-lock.js";
export type { AdvisoryLockKey, LockedTransactionOptions } from "./advisory-lock.js";

// Task 011A evidence-store primitives (addendum RD-2).
export {
  EVIDENCE_MAX_WAIT_MS,
  findEvidenceRecoveryCandidates,
  readEvidenceDurableState,
  readEvidenceRegistration,
  validateEvidenceHistoricalGap,
  writeEvidenceGroup,
  writeEvidenceUncleanGap,
} from "./rate-limit-evidence-store.js";
export type {
  EvidenceDurableState,
  EvidenceGapVerdict,
  EvidenceJson,
  EvidencePrimitive,
  EvidenceRecordRow,
  EvidenceRecoveryCandidate,
  EvidenceRegistrationRead,
  EvidenceStoreHooks,
  EvidenceWriteResult,
} from "./rate-limit-evidence-store.js";
export { writeRejectionAuditRows } from "./rejection-audit-store.js";
export type { RejectionAuditRow } from "./rejection-audit-store.js";
