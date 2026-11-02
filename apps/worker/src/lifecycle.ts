import type { WorkerConfig } from "@irs/config";
import type { CreateDatabaseOptions } from "@irs/db";
import { createCallGate } from "./call-gate.js";
import type { CallGate, GateEvent } from "./call-gate.js";
import type {
  DispatchErrorObserver,
  DispatchJobData,
  DispatchProbeHandle,
  DispatchQueueHandle,
  DispatchSettings,
} from "./dispatch-queue/index.js";
import { createErrorCounter } from "./error-counter.js";
import type { ErrorCounter } from "./error-counter.js";
import { createLogger } from "./logger.js";
import type { ShutdownFields, StartupPhase, WorkerLogger } from "./logger.js";
import { GATE_START_DEFERRED, classifyReadinessResult, classifyStartupFailure } from "./startup-outcomes.js";
import type { DatabaseClassifier } from "./startup-outcomes.js";
import { openWorkerDatabase } from "./worker-database.js";
import { WORKER_CONSTANTS } from "./worker-constants.js";
import type { WorkerConstants } from "./worker-constants.js";

// The worker's lifecycle (Task 012B-3; B2-1 as the founder amended it; PD-6,
// PD-7, PD-10; S-4, S-9). Every dependency is injected, so the lifecycle is
// tested in-process with fakes; main.ts composes the real ones.
//
// One guarded coordinator, finish(code, firstLine), is the only sequence
// that ends runWorker: a signal, a startup exit outcome, and S-4's fault all
// reach it. Its steps never consult the stopping latch. The latch suppresses
// normal progression only: phases, retries, back-off ends, cycle scheduling
// and late settlements. After `stopped`, nothing writes a line.

/** The readiness result the lifecycle reads. */
export type ReadinessResult = { readonly ready: true } | { readonly ready: false; readonly reason: string };

/** What a cycle receives (012B-3's cycle is probeCycle; 012B-4 plugs in its steps). */
export interface CycleContext {
  readonly gate: CallGate;
  readonly counter: ErrorCounter;
  readonly logger: WorkerLogger;
  readonly now: () => number;
}

export type CycleFunction = (n: number) => Promise<void>;

export interface WorkerDependencies<D> {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repositoryRoot: string;
  readonly loadWorkerConfig: (env: Readonly<Record<string, string | undefined>>) => WorkerConfig;
  readonly loadRedisPassword: (env: Readonly<Record<string, string | undefined>>, repositoryRoot: string) => string;
  readonly requireAuditIdGenerator: () => () => string;
  readonly assertEventStateTransition: (from: "VALIDATED", to: "QUEUED") => void;
  readonly createDatabase: (options: CreateDatabaseOptions) => D;
  readonly verifySchemaReadiness: (db: D, profile: "worker") => Promise<ReadinessResult>;
  readonly disconnectWithin: (db: D, timeoutMs: number) => Promise<unknown>;
  readonly classifyDatabaseError: DatabaseClassifier;
  /** The gate factory's inputs. */
  readonly openQueue: (settings: DispatchSettings, onError: DispatchErrorObserver) => DispatchQueueHandle;
  readonly openProbe: (settings: DispatchSettings, onError: DispatchErrorObserver) => DispatchProbeHandle;
  readonly publishWith: (handle: DispatchQueueHandle, eventId: string, data: DispatchJobData) => Promise<string>;
  readonly write: (line: string) => void;
  /** A monotonic clock (ms). */
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (ref: unknown) => void;
  readonly random: () => number;
  /** Registers the signal handler (SIGINT and SIGTERM in production); called before any startup work. */
  readonly onSignal: (handler: () => void) => void;
  readonly constants?: WorkerConstants;
  /** The cycle; absent: probeCycle. */
  readonly createCycle?: (context: CycleContext) => CycleFunction;
}

/** Full jitter: a uniform delay in [0, min(cap, base × 2^attempt)) (PD-6; apps/api/src/rejection-audit.ts:169-171). */
export function fullJitterDelay(attempt: number, policy: { baseMs: number; capMs: number }, random: () => number): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

/**
 * 012B-3's cycle: one probe, one snapshot, at most one `degraded` line (on
 * entering degraded, or on a changed code while degraded; the first cycle
 * counts as coming from ok), then the cycle line from the same snapshot.
 * Entering stuck is logged by the gate's own `stuck` event.
 */
export function probeCycle(context: CycleContext): CycleFunction {
  let previous: { state: string; degradedCode: string | undefined } = { state: "ok", degradedCode: undefined };
  return async (n: number): Promise<void> => {
    const started = context.now();
    await context.gate.probe();
    const snap = context.gate.snapshot();
    if (snap.state === "degraded") {
      const code = snap.degradedCode ?? "UNCLASSIFIED";
      if (previous.state !== "degraded" || previous.degradedCode !== code) {
        context.logger.degraded({ cause: "redis", code });
      }
    }
    previous = { state: snap.state, degradedCode: snap.degradedCode };
    const counts = context.counter.takeCounts();
    context.logger.cycle({
      n,
      state: snap.state,
      redis: snap.redis,
      errors: counts.errors,
      errorsOther: counts.errorsOther,
      durationMs: Math.max(0, Math.round(context.now() - started)),
    });
  };
}

/** Runs the worker; resolves to the process exit code. */
export function runWorker<D>(deps: WorkerDependencies<D>): Promise<number> {
  const constants = deps.constants ?? WORKER_CONSTANTS;
  let stopping = false;
  let stopped = false;
  const logger = createLogger((line) => {
    if (!stopped) deps.write(line);
  });

  let database: { readonly db: D } | undefined;
  let gate: CallGate | undefined;
  let inFlight: { readonly kind: "readiness" | "cycle"; readonly promise: Promise<unknown> } | undefined;
  let backoff: { readonly ref: unknown; readonly wake: () => void } | undefined;
  let cycleTimer: { readonly ref: unknown } | undefined;
  let finishing: Promise<number> | undefined;
  let resolveRun: (code: number) => void = () => undefined;
  const run = new Promise<number>((resolve) => {
    resolveRun = resolve;
  });

  /** Waits for a promise to settle, for at most `ms`: true if it settled, false at the bound. */
  const boundedWait = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const ref = deps.setTimer(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, ms);
      const settle = (): void => {
        if (done) return;
        done = true;
        deps.clearTimer(ref);
        resolve(true);
      };
      promise.then(settle, settle);
    });

  /** The shutdown coordinator: the only sequence that ends runWorker; a later call returns the same promise. */
  const finish = (code: number, firstLine?: ShutdownFields): Promise<number> => {
    if (finishing !== undefined) return finishing;
    stopping = true;
    finishing = (async (): Promise<number> => {
      // 1. Its first line, if any.
      if (firstLine !== undefined) logger.shutdown(firstLine);
      // 2. Stop normal work: the cycle timer and any back-off timer (a back-off ends at once).
      if (cycleTimer !== undefined) {
        deps.clearTimer(cycleTimer.ref);
        cycleTimer = undefined;
      }
      if (backoff !== undefined) {
        const current = backoff;
        backoff = undefined;
        deps.clearTimer(current.ref);
        current.wake();
      }
      // 3. An in-flight cycle or readiness attempt: the coordinator's own bounded wait.
      const current = inFlight;
      if (current !== undefined) {
        const settled = await boundedWait(current.promise, constants.shutdownCycleMs);
        if (current.kind === "cycle") logger.shutdown({ phase: settled ? "cycle-done" : "cycle-timeout" });
      }
      // 4. The queue generations and probe connections, if the gate exists.
      if (gate !== undefined) {
        try {
          gate.retireAll();
        } catch {
          // A queue error never prevents the database step.
        }
        logger.shutdown({ phase: "queue-retired" });
      }
      // 5. The database, last, if it was created (disconnectWithin never rejects).
      if (database !== undefined) {
        try {
          await deps.disconnectWithin(database.db, constants.databaseDisconnectMs);
        } catch {
          // Contractually unreachable; the exit still follows.
        }
        logger.shutdown({ phase: "database-closed" });
      }
      // 6. The exit line; nothing writes after it.
      logger.shutdown({ phase: "exit" });
      stopped = true;
      return code;
    })();
    void finishing.then(resolveRun);
    return finishing;
  };

  /** A capped, jittered wait; resolves false at once if shutdown cancels it. */
  const backoffWait = (attempt: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const ms = fullJitterDelay(attempt, { baseMs: constants.backoffBaseMs, capMs: constants.backoffCapMs }, deps.random);
      const ref = deps.setTimer(() => {
        backoff = undefined;
        resolve(true);
      }, ms);
      backoff = { ref, wake: () => resolve(false) };
    });

  /** A startup exit outcome: its line, then the coordinator with code 1. */
  const exitWith = (phase: StartupPhase, code: string): void => {
    logger.startup({ phase, outcome: "exit", code });
    void finish(1);
  };

  const failed = (phase: StartupPhase, error: unknown): void => {
    exitWith(phase, classifyStartupFailure(phase, error, deps.classifyDatabaseError).code);
  };

  const startCycles = (context: CycleContext): void => {
    const cycle = (deps.createCycle ?? probeCycle)(context);
    let n = 0;
    const runCycle = (): void => {
      cycleTimer = undefined;
      if (stopping) return;
      n++;
      let promise: Promise<void>;
      try {
        promise = cycle(n);
      } catch (error) {
        promise = Promise.reject(error);
      }
      inFlight = { kind: "cycle", promise };
      promise.then(
        () => {
          inFlight = undefined;
          if (stopping) return;
          cycleTimer = { ref: deps.setTimer(runCycle, constants.cycleIntervalMs) };
        },
        () => {
          inFlight = undefined;
          if (stopping) return; // after a signal, a cycle's rejection is never a second fault
          void finish(1, { phase: "fault", code: "UNCLASSIFIED" });
        },
      );
    };
    runCycle();
  };

  const startup = async (): Promise<void> => {
    // Phases 1 to 5 call only synchronous functions.
    if (stopping) return;
    let config: WorkerConfig;
    try {
      config = deps.loadWorkerConfig(deps.env);
    } catch (error) {
      failed("config", error);
      return;
    }
    logger.startup({ phase: "config", outcome: "ok" });

    if (stopping) return;
    let password: string;
    try {
      password = deps.loadRedisPassword(deps.env, deps.repositoryRoot);
    } catch (error) {
      failed("password", error);
      return;
    }
    logger.startup({ phase: "password", outcome: "ok" });

    if (stopping) return;
    try {
      // The generator is kept for 012B-4's audit rows.
      deps.requireAuditIdGenerator();
    } catch (error) {
      failed("uuidv7", error);
      return;
    }
    logger.startup({ phase: "uuidv7", outcome: "ok" });

    if (stopping) return;
    try {
      deps.assertEventStateTransition("VALIDATED", "QUEUED");
    } catch (error) {
      failed("transition", error);
      return;
    }
    logger.startup({ phase: "transition", outcome: "ok" });

    if (stopping) return;
    try {
      database = { db: openWorkerDatabase(deps.createDatabase, config.database.url) };
    } catch (error) {
      failed("database", error);
      return;
    }
    logger.startup({ phase: "database", outcome: "ok" });
    const db = database.db;

    // 6. Readiness: transient failures retry with back-off, without limit while degraded (PD-6).
    for (let attempt = 0; ; attempt++) {
      if (stopping) return;
      const promise = deps.verifySchemaReadiness(db, "worker");
      inFlight = { kind: "readiness", promise };
      let result: ReadinessResult | undefined;
      let failure: { readonly error: unknown } | undefined;
      try {
        result = await promise;
      } catch (error) {
        failure = { error };
      } finally {
        inFlight = undefined;
      }
      if (stopping) return; // a late settlement never begins a phase or a retry
      if (failure === undefined && result !== undefined) {
        if (result.ready) {
          logger.startup({ phase: "readiness", outcome: "ok" });
          break;
        }
        exitWith("readiness", classifyReadinessResult(result).code);
        return;
      }
      const outcome = classifyStartupFailure("readiness", failure?.error, deps.classifyDatabaseError);
      if (outcome.outcome === "exit") {
        exitWith("readiness", outcome.code);
        return;
      }
      logger.degraded({ cause: "database", code: outcome.code });
      const waited = await backoffWait(attempt);
      if (!waited || stopping) return;
    }

    // 7. The queue: the error counter, then the gate, then gate.start() (a Redis error is never an exit).
    if (stopping) return;
    const counter = createErrorCounter();
    const settings: DispatchSettings = { host: config.redis.host, port: config.redis.port, password };
    const created = createCallGate({
      openQueue: () => deps.openQueue(settings, counter.count),
      openProbe: () => deps.openProbe(settings, counter.count),
      publishWith: deps.publishWith,
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      onEvent: (event: GateEvent) => {
        if (event.event === "stuck") logger.stuck({ reason: event.reason });
        else logger.recovery({ action: event.action, generation: event.generation });
      },
      constants,
    });
    gate = created;
    for (let attempt = 0; ; attempt++) {
      if (stopping) return;
      let started: boolean;
      try {
        started = created.start();
      } catch (error) {
        const outcome = classifyStartupFailure("queue", error, deps.classifyDatabaseError);
        if (outcome.outcome === "exit") {
          exitWith("queue", outcome.code);
          return;
        }
        logger.startup({ phase: "queue", outcome: "degraded", code: outcome.code });
        const waited = await backoffWait(attempt);
        if (!waited || stopping) return;
        continue;
      }
      if (started) {
        logger.startup({ phase: "queue", outcome: "ok" });
        break;
      }
      logger.startup({ phase: "queue", outcome: "degraded", code: GATE_START_DEFERRED });
      const waited = await backoffWait(attempt);
      if (!waited || stopping) return;
    }

    // 8. Ready: the cycle loop.
    if (stopping) return;
    logger.startup({ phase: "ready", outcome: "ok" });
    startCycles({ gate: created, counter, logger, now: deps.now });
  };

  // Signals first (S-9): registered before any startup work.
  deps.onSignal(() => {
    void finish(0, { phase: "signal" });
  });
  startup().then(
    () => undefined,
    () => {
      // An unexpected internal failure fails closed.
      void finish(1, { phase: "fault", code: "UNCLASSIFIED" });
    },
  );
  return run;
}
