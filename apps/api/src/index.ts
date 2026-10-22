/**
 * @irs/api
 *
 * HTTP API for the Integration Reliability System. Task 010A provides only
 * the webhook transport boundary: POST /api/webhooks/:integrationKey.
 */

export { buildServer, closeWithGrace, LISTEN_HOST } from "./server.js";
export type { ServerDependencies, ServerOptions } from "./server.js";
export {
  EVIDENCE_FINALIZE_MS,
  EVIDENCE_SCOPE,
  RECORDER_FINALIZE_MS,
  composeEvidence,
  createProductionServer,
} from "./production.js";
export type {
  ComposedEvidenceStore,
  EvidenceComposition,
  ProductionDependencies,
  ProductionServer,
} from "./production.js";
// Task 011A: rejection auditing, evidence records, the store port, the consumer and coverage.
export { DEFAULT_AUDIT_POLICIES, createRejectionAuditRecorder } from "./rejection-audit.js";
export type {
  AuditPolicies,
  AuditRecorderCounters,
  AuditRecorderGauges,
  AuditRecorderSnapshot,
  EligibleErrorCode,
  EvidenceClock,
  EvidenceLogger,
  EvidenceScheduler,
  RecorderControl,
  RejectionAuditRecorder,
  RejectionAuditSink,
  RejectionCandidate,
  RejectionContext,
  RejectionStage,
  ResponseCompletion,
} from "./rejection-audit.js";
export { canonicalJson, foldAudit, mergeEvidenceSummaries, recordHash } from "./evidence-records.js";
export type {
  EvidenceKind,
  EvidenceMergeResult,
  EvidenceSummary,
  FrozenEvidenceRecord,
  FrozenRejectionRecord,
} from "./evidence-records.js";
export { classifyRegistrationVerification, storeErrorOutcome } from "./evidence-store.js";
export type {
  DurableInstanceState,
  EvidenceStore,
  HistoricalGapVerdict,
  RecoveryCandidate,
  WriteResult,
} from "./evidence-store.js";
export { EvidenceCutoffError, createPostgresEvidenceStore } from "./evidence-store-postgres.js";
export type { EvidenceConnectionCap, EvidenceStoreCutoff, PostgresEvidenceStore } from "./evidence-store-postgres.js";
export { DEFAULT_EVIDENCE_POLICIES, StartupSlotError, createEvidenceConsumer } from "./evidence-consumer.js";
export type {
  ConsumerFinalization,
  EvidenceConsumer,
  EvidencePolicies,
  FinalizationOutcome,
  PairOutcome,
} from "./evidence-consumer.js";
export { classifyCoverage } from "./coverage.js";
export type { CoverageResult, CoverageSegment } from "./coverage.js";
export { createUnavailableIngestionHandoff } from "./handoff.js";
export type {
  IngestionHandoff,
  IngestionMetadata,
  IngestionOutcome,
  IngestionRequest,
  UnavailableClassification,
  UnprocessableCondition,
} from "./handoff.js";
export { createDurableIngestionHandoff } from "./durable-ingestion.js";
export type { DurableIngestionDependencies, HandoffLogger } from "./durable-ingestion.js";
export {
  DEFAULT_LIFECYCLE_BUDGETS,
  retryingReadiness,
  runApi,
  terminate,
} from "./lifecycle.js";
export type { LifecycleSteps, RunResult, SignalSource } from "./lifecycle.js";
export { createSecretResolver } from "./secrets.js";
export type { SecretResolver } from "./secrets.js";
export { createRateLimiter, mergeSummaries } from "./rate-limit.js";
export type {
  BucketPolicy,
  Counters,
  Decision,
  Denial,
  DistinctKeys,
  Layer,
  LayerCounters,
  MergeResult,
  PeekResult,
  PeerKey,
  RateLimitEvidence,
  RateLimitPolicies,
  RateLimitSummary,
  RateLimiter,
  TableGauge,
  TablePolicy,
} from "./rate-limit.js";
