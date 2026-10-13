import { loadConfig, loadWebhookSecrets } from "@irs/config";
import { createUnavailableIngestionHandoff } from "./handoff.js";
import { createSecretResolver } from "./secrets.js";
import { buildServer } from "./server.js";
import type { ServerOptions } from "./server.js";
import type { FastifyInstance } from "fastify";

export interface ProductionServer {
  readonly app: FastifyInstance;
  readonly port: number;
}

/**
 * Production wiring. Reads configuration through the `@irs/config`
 * boundary (throws `ConfigValidationError`, whose messages never contain
 * values) and installs the always-unavailable ingestion handoff, so every
 * verified delivery is answered 503 until Task 011 supplies durable
 * acceptance.
 */
export function createProductionServer(
  env: NodeJS.ProcessEnv = process.env,
  options: ServerOptions = {},
): ProductionServer {
  const config = loadConfig(env);
  const secrets = loadWebhookSecrets(env);

  const app = buildServer(
    {
      secrets: createSecretResolver(secrets),
      ingestion: createUnavailableIngestionHandoff(),
    },
    options,
  );
  return { app, port: config.api.port };
}
