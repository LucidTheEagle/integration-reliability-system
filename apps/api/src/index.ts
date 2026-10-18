/**
 * @irs/api
 *
 * HTTP API for the Integration Reliability System. Task 010A provides only
 * the webhook transport boundary: POST /api/webhooks/:integrationKey.
 */

export { buildServer, closeWithGrace, LISTEN_HOST } from "./server.js";
export type { ServerDependencies, ServerOptions } from "./server.js";
export { createProductionServer } from "./production.js";
export type { ProductionDependencies, ProductionServer } from "./production.js";
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
