import { ConfigValidationError } from "@irs/config";
import { DISCONNECT_TIMEOUT_MS, classifyDatabaseError, disconnectWithin, verifySchemaReadiness } from "@irs/db";
import { DEFAULT_LIFECYCLE_BUDGETS, retryingReadiness, runApi, terminate } from "./lifecycle.js";
import type { LifecycleLogger, LifecycleSteps, SignalSource } from "./lifecycle.js";
import { createProductionServer } from "./production.js";
import type { ProductionServer } from "./production.js";
import { LISTEN_HOST, closeWithGrace } from "./server.js";

/** Maximum time to wait for in-flight requests on shutdown (D1). */
const SHUTDOWN_GRACE_MS = 10_000;

const processSignals: SignalSource = {
  subscribe(listener) {
    process.on("SIGINT", () => listener("SIGINT"));
    process.on("SIGTERM", () => listener("SIGTERM"));
  },
};

async function main(): Promise<void> {
  let server: ProductionServer;
  try {
    server = createProductionServer();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // Messages are value-free by construction; no database was created.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { app, port, db, evidence } = server;
  const steps: LifecycleSteps = {
    verifyReadiness: retryingReadiness(() => verifySchemaReadiness(db), {
      isConnectivityError: (error) => classifyDatabaseError(error).failureClass === "TRANSIENT",
    }),
    startupSlot: (signal) => evidence.slots.startupSlot(signal), // SLOT A (Task 011A).
    verifyRegistration: (deadline) => evidence.slots.verifyRegistration(deadline), // SLOT A′ (U3).
    listen: async () => {
      await app.listen({ host: LISTEN_HOST, port });
    },
    // AD-11: the barrier reports whether closeWithGrace forced; a server that never listened did not.
    intakeBarrier: async (reason) => {
      const { forced } = await closeWithGrace(app, SHUTDOWN_GRACE_MS);
      return { forced: reason === "LISTEN_FAILED" ? false : forced };
    },
    finalizeBeforeDisconnect: (reason, intake) => evidence.slots.finalizeBeforeDisconnect(reason, intake), // SLOT B.
    disconnect: () => disconnectWithin(db, DISCONNECT_TIMEOUT_MS),
    budgets: DEFAULT_LIFECYCLE_BUDGETS,
  };

  // FastifyBaseLogger's type omits pino's flush, which exists at runtime; terminate() needs it
  // for the bounded flush before a forced exit.
  const pinoLog = app.log as typeof app.log & { flush?: (callback: (error?: Error) => void) => void };
  const logger: LifecycleLogger = {
    error: (object, message) => pinoLog.error(object, message),
    warn: (object, message) => pinoLog.warn(object, message),
    ...(typeof pinoLog.flush === "function"
      ? { flush: (callback?: (error?: Error) => void) => pinoLog.flush?.(callback ?? (() => undefined)) }
      : {}),
  };

  const result = await runApi(steps, processSignals, { logger });
  const primary = result.failures[0];
  if (primary?.step === "READINESS") {
    // The reason code (and assertion ID) only; never connection details.
    process.stderr.write(`Readiness failed: ${primary.errorCode ?? primary.errorName ?? primary.kind}\n`);
  }
  terminate(result, logger);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`Failed to start API: ${name}\n`);
  process.exitCode = 1;
});
