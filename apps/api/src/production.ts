import { loadConfig, loadWebhookSecrets } from "@irs/config";
import { createDatabase } from "@irs/db";
import type { CreateDatabaseOptions, Database } from "@irs/db";
import type { FastifyInstance } from "fastify";
import { createDurableIngestionHandoff } from "./durable-ingestion.js";
import type { HandoffLogger } from "./durable-ingestion.js";
import { DEFAULT_EVIDENCE_POLICIES, createEvidenceConsumer } from "./evidence-consumer.js";
import type { EvidenceConsumer, EvidencePolicies } from "./evidence-consumer.js";
import { freezeJson } from "./evidence-records.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createPostgresEvidenceStore } from "./evidence-store-postgres.js";
import type { EvidenceStoreCutoff } from "./evidence-store-postgres.js";
import type { FinalizationResult, IntakeBarrierResult, RegistrationVerification, ShutdownReason } from "./lifecycle.js";
import { DEFAULT_RATE_LIMIT_POLICIES, createRateLimiter } from "./rate-limit.js";
import type { RateLimitPolicies, RateLimiter } from "./rate-limit.js";
import {
  DEFAULT_AUDIT_POLICIES,
  DEFAULT_EVIDENCE_CLOCK,
  DEFAULT_EVIDENCE_SCHEDULER,
  createRejectionAuditRecorder,
} from "./rejection-audit.js";
import type {
  AuditPolicies,
  EvidenceClock,
  EvidenceLogger,
  EvidenceScheduler,
  RecorderControl,
  RejectionAuditSink,
} from "./rejection-audit.js";
import { createSecretResolver } from "./secrets.js";
import { buildServer } from "./server.js";
import type { ServerOptions } from "./server.js";

/** AD-8: the code-defined evidence scope of this API's webhook limiter. */
export const EVIDENCE_SCOPE = "irs.api.webhooks";

/** §8.3 sequential finalization budgets (provisional). */
export const RECORDER_FINALIZE_MS = 5_000; // D2
export const EVIDENCE_FINALIZE_MS = 5_000; // D3

/** A store as the composition uses it: the port, plus the adapter-only PA-3 cutoff when it has one. */
export type ComposedEvidenceStore = EvidenceStore & Partial<EvidenceStoreCutoff>;

export interface EvidenceComposition {
  /** The request-path half of the one createRateLimiter() pair; given to buildServer only. */
  readonly limiter: RateLimiter;
  /** The request-path audit capability; given to buildServer only. */
  readonly sink: RejectionAuditSink;
  readonly limiterInstanceId: string;
  /** Deep-frozen copies, as recorded in INSTANCE_STARTED. */
  readonly policies: { readonly rateLimit: RateLimitPolicies; readonly audit: AuditPolicies };
  readonly recorder: RecorderControl;
  readonly consumer: EvidenceConsumer;
  readonly store: ComposedEvidenceStore;
  /** The lifecycle slots Task 011 provides for Task 011A (E8). */
  readonly slots: {
    readonly startupSlot: (signal: AbortSignal) => Promise<void>;
    readonly verifyRegistration: (deadline: number) => Promise<RegistrationVerification>;
    readonly finalizeBeforeDisconnect: (reason: ShutdownReason, intake: IntakeBarrierResult) => Promise<FinalizationResult>;
  };
}

/**
 * The one 011A composition (§10 composition rule): one limiter pair, one
 * recorder, one consumer, over the given store. It performs no I/O and
 * arms no timer; everything starts in the startup slot.
 */
export function composeEvidence(options: {
  readonly store: ComposedEvidenceStore;
  readonly rateLimitPolicies: RateLimitPolicies;
  readonly auditPolicies: AuditPolicies;
  readonly evidencePolicies?: EvidencePolicies;
  readonly scope?: string;
  readonly logger?: EvidenceLogger;
  readonly clock?: EvidenceClock;
  readonly scheduler?: EvidenceScheduler;
  readonly random?: () => number;
}): EvidenceComposition {
  const { store } = options;
  const clock = options.clock ?? DEFAULT_EVIDENCE_CLOCK;
  const scheduler = options.scheduler ?? DEFAULT_EVIDENCE_SCHEDULER;
  const scope = options.scope ?? EVIDENCE_SCOPE;
  const rateLimitPolicies = options.rateLimitPolicies;
  const auditPolicies = options.auditPolicies;
  const { limiter, evidence } = createRateLimiter({
    policies: rateLimitPolicies,
    monotonicNow: clock.monotonicNow,
    wallNow: clock.wallNow,
  });
  const common = {
    clock,
    scheduler,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.random === undefined ? {} : { random: options.random }),
  };
  const recorder = createRejectionAuditRecorder({
    store,
    limiterInstanceId: evidence.limiterInstanceId,
    policies: auditPolicies,
    ...common,
  });
  const consumer = createEvidenceConsumer({
    evidence,
    recorderControl: recorder.control,
    store,
    scope,
    rateLimitPolicies,
    auditPolicies,
    policies: options.evidencePolicies ?? DEFAULT_EVIDENCE_POLICIES,
    ...common,
  });

  async function finalizeBeforeDisconnect(_reason: ShutdownReason, intake: IntakeBarrierResult): Promise<FinalizationResult> {
    // PA-3: from the start of SLOT B, no evidence operation may start after D3. D3 starts
    // after D2, so the bound known now is start + D2 + D3; the exact D3 deadline follows,
    // and the earliest deadline given to the store applies.
    store.cutoffAt?.(clock.monotonicNow() + RECORDER_FINALIZE_MS + EVIDENCE_FINALIZE_MS);
    await recorder.control.finalize(RECORDER_FINALIZE_MS);
    const deadline = clock.monotonicNow() + EVIDENCE_FINALIZE_MS;
    store.cutoffAt?.(deadline);
    try {
      const result = await consumer.finalize({ intake, deadline });
      return { successAllowed: result.successAllowed };
    } finally {
      // Finalization has resolved: nothing of 011A may start any more.
      store.cutoffAt?.(Math.min(deadline, clock.monotonicNow()));
    }
  }

  return Object.freeze({
    limiter,
    sink: recorder.sink,
    limiterInstanceId: evidence.limiterInstanceId,
    policies: Object.freeze({ rateLimit: rateLimitPolicies, audit: auditPolicies }),
    recorder: recorder.control,
    consumer,
    store,
    slots: Object.freeze({
      startupSlot: (signal: AbortSignal) => consumer.startup(signal),
      verifyRegistration: (deadline: number) => consumer.verifyRegistration(deadline),
      finalizeBeforeDisconnect,
    }),
  });
}

export interface ProductionServer {
  readonly app: FastifyInstance;
  readonly port: number;
  /** The process's single database; the lifecycle owns its readiness check and disconnect. */
  readonly db: Database;
  /** Task 011A: the evidence composition and its lifecycle slots. */
  readonly evidence: EvidenceComposition;
}

export interface ProductionDependencies {
  /** Injectable for tests that build without a database (default createDatabase; no I/O). */
  readonly createDatabase?: (options: CreateDatabaseOptions) => Database;
  /** RD-13: the evidence store over the composition's one Database (default: the PostgreSQL store). */
  readonly createEvidenceStore?: (db: Database) => ComposedEvidenceStore;
}

/**
 * Production wiring. Reads configuration through the `@irs/config`
 * boundary (throws `ConfigValidationError`, whose messages never contain
 * values; no database is created then), creates the database client
 * without I/O, and installs the durable ingestion handoff and the Task
 * 011A evidence composition over that same client.
 */
export function createProductionServer(
  env: NodeJS.ProcessEnv = process.env,
  options: ServerOptions = {},
  dependencies: ProductionDependencies = {},
): ProductionServer {
  const config = loadConfig(env);
  const secrets = loadWebhookSecrets(env);
  const db = (dependencies.createDatabase ?? createDatabase)({ connectionString: config.database.url });

  // The handoff and evidence log through the server's logger, which exists once the server is built.
  let app: FastifyInstance | undefined;
  const logger: HandoffLogger = {
    info: (object, message) => app?.log.info(object, message),
    warn: (object, message) => app?.log.warn(object, message),
    error: (object, message) => app?.log.error(object, message),
  };
  const store = (dependencies.createEvidenceStore ?? ((database: Database) => createPostgresEvidenceStore({ db: database })))(db);
  // RD-13: the policies are deep-copied and deep-frozen here, at the call site.
  const evidence = composeEvidence({
    store,
    rateLimitPolicies: freezeJson(DEFAULT_RATE_LIMIT_POLICIES) as unknown as RateLimitPolicies,
    auditPolicies: freezeJson(DEFAULT_AUDIT_POLICIES) as unknown as AuditPolicies,
    logger: { warn: logger.warn, error: logger.error },
  });
  app = buildServer(
    {
      secrets: createSecretResolver(secrets),
      ingestion: createDurableIngestionHandoff({ db, logger }),
      rateLimiter: evidence.limiter,
      rejectionAudit: evidence.sink,
    },
    options,
  );
  return { app, port: config.api.port, db, evidence };
}
