/**
 * @irs/api
 *
 * HTTP API for the Integration Reliability System. Task 010A provides only
 * the webhook transport boundary: POST /api/webhooks/:integrationKey.
 */

export { buildServer, closeWithGrace, LISTEN_HOST } from "./server.js";
export type { ServerDependencies, ServerOptions } from "./server.js";
export { createProductionServer } from "./production.js";
export { createUnavailableIngestionHandoff } from "./handoff.js";
export type {
  IngestionHandoff,
  IngestionMetadata,
  IngestionOutcome,
  IngestionRequest,
} from "./handoff.js";
export { createSecretResolver } from "./secrets.js";
export type { SecretResolver } from "./secrets.js";
