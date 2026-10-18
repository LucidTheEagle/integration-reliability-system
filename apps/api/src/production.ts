import { loadConfig, loadWebhookSecrets } from "@irs/config";
import { createDatabase } from "@irs/db";
import type { CreateDatabaseOptions, Database } from "@irs/db";
import type { FastifyInstance } from "fastify";
import { createDurableIngestionHandoff } from "./durable-ingestion.js";
import type { HandoffLogger } from "./durable-ingestion.js";
import { createSecretResolver } from "./secrets.js";
import { buildServer } from "./server.js";
import type { ServerOptions } from "./server.js";

export interface ProductionServer {
  readonly app: FastifyInstance;
  readonly port: number;
  /** The process's single database; the lifecycle owns its readiness check and disconnect. */
  readonly db: Database;
}

export interface ProductionDependencies {
  /** Injectable for tests that build without a database (default createDatabase; no I/O). */
  readonly createDatabase?: (options: CreateDatabaseOptions) => Database;
}

/**
 * Production wiring. Reads configuration through the `@irs/config`
 * boundary (throws `ConfigValidationError`, whose messages never contain
 * values; no database is created then), creates the database client
 * without I/O, and installs the durable ingestion handoff. Rate-limit
 * evidence wiring belongs to Task 011A.
 */
export function createProductionServer(
  env: NodeJS.ProcessEnv = process.env,
  options: ServerOptions = {},
  dependencies: ProductionDependencies = {},
): ProductionServer {
  const config = loadConfig(env);
  const secrets = loadWebhookSecrets(env);
  const db = (dependencies.createDatabase ?? createDatabase)({ connectionString: config.database.url });

  // The handoff logs through the server's logger, which exists once the server is built.
  let app: FastifyInstance | undefined;
  const logger: HandoffLogger = {
    info: (object, message) => app?.log.info(object, message),
    warn: (object, message) => app?.log.warn(object, message),
    error: (object, message) => app?.log.error(object, message),
  };
  app = buildServer(
    {
      secrets: createSecretResolver(secrets),
      ingestion: createDurableIngestionHandoff({ db, logger }),
    },
    options,
  );
  return { app, port: config.api.port, db };
}
