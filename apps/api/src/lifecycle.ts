import type { DisconnectOutcome, SchemaReadiness } from "@irs/db";

/**
 * The API process lifecycle (Task 011, Rev 1.7 §11.2–§11.3; F-16 A).
 * One staged contract with injected steps: readiness → SLOT A → listen →
 * running → runShutdown (intake barrier → SLOT B → disconnect, always
 * last). Task 011 supplies no-op 011A slots; Task 011A replaces only the
 * slot functions and the intake-barrier adapter. runApi never exits the
 * process; main.ts applies the result through terminate().
 */

export type ShutdownReason = "SIGNAL" | "LISTEN_FAILED";

/**
 * D1 result. Task 011 cannot know whether closeWithGrace forced, so its
 * barrier reports "NOT_REPORTED" (AD-11 belongs to Task 011A).
 * "BARRIER_FAILED" is set by runShutdown, never by the step.
 */
export interface IntakeBarrierResult {
  readonly forced: boolean | "NOT_REPORTED" | "BARRIER_FAILED";
}

/** Result of SLOT B. Task 011's no-op returns { successAllowed: true }. */
export interface FinalizationResult {
  readonly successAllowed: boolean;
}

/** The rejection SLOT A reports when it does not complete. */
export interface StartupSlotFailure {
  readonly finalizationRequired: boolean;
}

/** Result of the bounded registration verification (F-19(a)-U = U3). */
export type RegistrationVerification =
  | { readonly kind: "CONFIRMED_PRESENT"; readonly recorderAndConsumerStarted: boolean }
  | { readonly kind: "CONFIRMED_ABSENT" }
  | { readonly kind: "STILL_UNKNOWN" };

export interface LifecycleBudgets {
  /** 10 s closeWithGrace + 1 s margin. */
  readonly intakeBarrierMs: number;
  /** Task 011 no-op: 1 s (Task 011A: D2 + D3 + margin). */
  readonly finalizationMs: number;
  /** Task 011 no-op: 1 s (Task 011A: its startup budget + margin). */
  readonly startupSlotMs: number;
  /** PROVISIONAL (AR-3): 30 s retry budget + 7 s last attempt + 1 s. */
  readonly readinessMs: number;
  /** F-11(b) option B: the bounded wait for SLOT A to settle after a signal. */
  readonly slotSignalWaitMs: number;
  /** F-19(a)-U = U3: the absolute budget for verifyRegistration. */
  readonly registrationVerificationMs: number;
}

export const DEFAULT_LIFECYCLE_BUDGETS: LifecycleBudgets = Object.freeze({
  intakeBarrierMs: 11_000,
  // Task 011A (RD-11, B-10): D2 5 s + D3 5 s + 1 s margin.
  finalizationMs: 11_000,
  // Task 011A (RD-11, B-10): the AD-7 startup retry budget of 30 s + 1 s margin.
  startupSlotMs: 31_000,
  readinessMs: 38_000,
  slotSignalWaitMs: 5_000,
  registrationVerificationMs: 1_000,
});

/** The disconnect's own 5 s bound + 1 s margin. */
export const DISCONNECT_WATCHDOG_MS = 6_000;

export interface LifecycleSteps {
  /** ping + verifySchemaReadiness, connectivity retried (§8.5). */
  readonly verifyReadiness: (signal: AbortSignal) => Promise<SchemaReadiness>;
  /** SLOT A — Task 011: no-op. */
  readonly startupSlot: (signal: AbortSignal) => Promise<void>;
  /** SLOT A′ — Task 011: no-op returning STILL_UNKNOWN (never reached). */
  readonly verifyRegistration: (deadline: number) => Promise<RegistrationVerification>;
  readonly listen: () => Promise<void>;
  /** Task 011: closeWithGrace(app, 10 s), then { forced: "NOT_REPORTED" }. */
  readonly intakeBarrier: (reason: ShutdownReason) => Promise<IntakeBarrierResult>;
  /** SLOT B — Task 011: { successAllowed: true }. */
  readonly finalizeBeforeDisconnect: (reason: ShutdownReason, intake: IntakeBarrierResult) => Promise<FinalizationResult>;
  /** disconnectWithin(db, 5 s). */
  readonly disconnect: () => Promise<DisconnectOutcome>;
  readonly budgets: LifecycleBudgets;
}

export type LifecycleStep =
  | "READINESS"
  | "STARTUP_SLOT"
  | "REGISTRATION_VERIFY"
  | "LISTEN"
  | "INTAKE"
  | "FINALIZE"
  | "DISCONNECT";

export interface LifecycleFailure {
  readonly step: LifecycleStep;
  readonly kind: "REJECTED" | "WATCHDOG" | "ABANDONED_ON_SIGNAL";
  readonly errorName?: string;
  readonly errorCode?: string;
}

export interface RunResult {
  readonly exitCode: 0 | 1;
  /** True whenever exitCode !== 0. */
  readonly forceExit: boolean;
  /** In occurrence order; failures[0] is the original cause. */
  readonly failures: readonly LifecycleFailure[];
  /** Set when the registration verification could not establish presence or absence. */
  readonly outcome?: "REGISTRATION_OUTCOME_UNKNOWN";
}

/** SIGINT/SIGTERM, delivered to the subscriber. */
export interface SignalSource {
  subscribe(listener: (signal: string) => void): void;
}

/** The logger subset the lifecycle uses (pino-compatible). */
export interface LifecycleLogger {
  error(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  flush?(callback?: (error?: Error) => void): void;
}

export interface RunOptions {
  readonly logger?: LifecycleLogger;
  /** Monotonic clock for the registration-verification deadline (default performance.now). */
  readonly now?: () => number;
}

type Settled<T> = { readonly kind: "resolved"; readonly value: T } | { readonly kind: "rejected"; readonly error: unknown };

function settle<T>(start: () => Promise<T>): Promise<Settled<T>> {
  let promise: Promise<T>;
  try {
    promise = start();
  } catch (error) {
    promise = Promise.reject(error);
  }
  return promise.then(
    (value) => ({ kind: "resolved", value }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
}

function timer(ms: number): { readonly fired: Promise<"timeout">; cancel(): void } {
  let handle: NodeJS.Timeout | undefined;
  const fired = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { fired, cancel: () => clearTimeout(handle) };
}

function nameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function codeOf(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function isStartupSlotFailure(error: unknown): error is StartupSlotFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { finalizationRequired?: unknown }).finalizationRequired === "boolean"
  );
}

function readinessCode(readiness: SchemaReadiness): string {
  if (readiness.ready) return "READY";
  return "assertion" in readiness ? `${readiness.reason}:${readiness.assertion}` : readiness.reason;
}

const STILL_UNKNOWN: RegistrationVerification = { kind: "STILL_UNKNOWN" };

/** Runs the staged lifecycle to completion and returns the exit decision. Never throws. */
export async function runApi(steps: LifecycleSteps, signals: SignalSource, options: RunOptions = {}): Promise<RunResult> {
  const { budgets } = steps;
  const now = options.now ?? (() => performance.now());
  const failures: LifecycleFailure[] = [];
  let outcome: RunResult["outcome"];

  const log = (level: "error" | "warn", object: Record<string, unknown>, message: string): void => {
    try {
      options.logger?.[level](object, message);
    } catch {
      // A throwing logger never changes the lifecycle.
    }
  };
  const record = (failure: LifecycleFailure): void => {
    failures.push(failure);
    log("error", { ...failure }, "lifecycle step failed");
  };

  let received: string | undefined;
  let notifySignal!: () => void;
  const signalled = new Promise<"signal">((resolve) => {
    notifySignal = () => resolve("signal");
  });
  signals.subscribe((signal) => {
    if (received !== undefined) return; // Later signals are ignored.
    received = signal;
    notifySignal();
  });

  /** Runs a step under a watchdog. Never throws; a hung step keeps running and its late settlement is logged once. */
  async function guarded<T>(step: LifecycleStep, budgetMs: number, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const settled = settle(fn);
    const watchdog = timer(budgetMs);
    const first = await Promise.race([settled, watchdog.fired]);
    watchdog.cancel();
    if (first === "timeout") {
      record({ step, kind: "WATCHDOG" });
      void settled.then((late) => log("warn", { step, settled: late.kind }, "late settlement after watchdog; ignored"));
      return { ok: false };
    }
    if (first.kind === "rejected") {
      record({ step, kind: "REJECTED", errorName: nameOf(first.error), errorCode: codeOf(first.error) });
      return { ok: false };
    }
    return { ok: true, value: first.value };
  }

  async function finish(exitCode: 0 | 1): Promise<RunResult> {
    return { exitCode, forceExit: exitCode !== 0, failures, ...(outcome === undefined ? {} : { outcome }) };
  }

  /** Never listened, no finalization: disconnect (guarded), then a forced exit 1. */
  async function abortStartup(): Promise<RunResult> {
    await guarded("DISCONNECT", DISCONNECT_WATCHDOG_MS, () => steps.disconnect());
    return finish(1);
  }

  /** Runs at most once (the flow below reaches it once). Exception-safe: the disconnect is always attempted, last. */
  async function runShutdown(reason: ShutdownReason): Promise<RunResult> {
    const intakeStep = await guarded("INTAKE", budgets.intakeBarrierMs, () => steps.intakeBarrier(reason));
    const intake: IntakeBarrierResult = intakeStep.ok ? intakeStep.value : { forced: "BARRIER_FAILED" };
    const finStep = await guarded("FINALIZE", budgets.finalizationMs, () => steps.finalizeBeforeDisconnect(reason, intake));
    const fin: FinalizationResult = finStep.ok ? finStep.value : { successAllowed: false };
    const outStep = await guarded("DISCONNECT", DISCONNECT_WATCHDOG_MS, () => steps.disconnect());
    const completed = outStep.ok && outStep.value.completed;
    const clean =
      reason === "SIGNAL" &&
      failures.length === 0 &&
      intake.forced !== "BARRIER_FAILED" &&
      fin.successAllowed === true &&
      completed;
    return finish(clean ? 0 : 1);
  }

  /** SLOT A settled with an unexpected error: one bounded registration verification (U3). */
  async function verifyRegistrationThenAct(): Promise<RunResult> {
    const deadline = now() + budgets.registrationVerificationMs;
    const step = await guarded("REGISTRATION_VERIFY", budgets.registrationVerificationMs, () => steps.verifyRegistration(deadline));
    const verification = step.ok ? step.value : STILL_UNKNOWN;
    if (verification.kind === "CONFIRMED_PRESENT" && verification.recorderAndConsumerStarted === true) {
      return runShutdown("LISTEN_FAILED");
    }
    if (verification.kind !== "CONFIRMED_PRESENT" && verification.kind !== "CONFIRMED_ABSENT") {
      outcome = "REGISTRATION_OUTCOME_UNKNOWN";
    }
    return abortStartup();
  }

  async function afterSlotSettled(settled: Settled<void>, afterSignal: boolean): Promise<RunResult | undefined> {
    if (settled.kind === "resolved") {
      // Completed after a signal: registered and complete → F-19(a) A finalization.
      return afterSignal ? runShutdown("LISTEN_FAILED") : undefined;
    }
    record({ step: "STARTUP_SLOT", kind: "REJECTED", errorName: nameOf(settled.error), errorCode: codeOf(settled.error) });
    if (isStartupSlotFailure(settled.error)) {
      return settled.error.finalizationRequired ? runShutdown("LISTEN_FAILED") : abortStartup();
    }
    return verifyRegistrationThenAct();
  }

  // 2. Readiness: raced against its watchdog and against a signal.
  const readinessAbort = new AbortController();
  const readiness = settle(() => steps.verifyReadiness(readinessAbort.signal));
  const readinessWatchdog = timer(budgets.readinessMs);
  const readinessFirst = await Promise.race([readiness, readinessWatchdog.fired, signalled]);
  readinessWatchdog.cancel();
  if (readinessFirst === "signal") {
    readinessAbort.abort();
    record({ step: "READINESS", kind: "ABANDONED_ON_SIGNAL" });
    return abortStartup();
  }
  if (readinessFirst === "timeout") {
    readinessAbort.abort();
    record({ step: "READINESS", kind: "WATCHDOG" });
    return abortStartup();
  }
  if (readinessFirst.kind === "rejected") {
    record({ step: "READINESS", kind: "REJECTED", errorName: nameOf(readinessFirst.error), errorCode: codeOf(readinessFirst.error) });
    return abortStartup();
  }
  if (!readinessFirst.value.ready) {
    record({ step: "READINESS", kind: "REJECTED", errorCode: readinessCode(readinessFirst.value) });
    return abortStartup();
  }
  if (received !== undefined) return abortStartup(); // A signal before SLOT A began: nothing was registered.

  // 3. SLOT A.
  const slotAbort = new AbortController();
  const slot = settle(() => steps.startupSlot(slotAbort.signal));
  const slotWatchdog = timer(budgets.startupSlotMs);
  const slotFirst = await Promise.race([slot, slotWatchdog.fired, signalled]);
  if (slotFirst === "timeout") {
    slotAbort.abort();
    record({ step: "STARTUP_SLOT", kind: "WATCHDOG" });
    return abortStartup();
  }
  let decided: RunResult | undefined;
  if (slotFirst === "signal") {
    slotAbort.abort();
    const wait = timer(budgets.slotSignalWaitMs);
    const afterSignal = await Promise.race([slot, wait.fired, slotWatchdog.fired.then(() => "watchdog" as const)]);
    wait.cancel();
    slotWatchdog.cancel();
    if (afterSignal === "timeout" || afterSignal === "watchdog") {
      record({ step: "STARTUP_SLOT", kind: afterSignal === "watchdog" ? "WATCHDOG" : "ABANDONED_ON_SIGNAL" });
      return abortStartup(); // Unsettled: never finalize concurrently with a running slot.
    }
    decided = await afterSlotSettled(afterSignal, true);
  } else {
    slotWatchdog.cancel();
    decided = await afterSlotSettled(slotFirst, false);
  }
  if (decided !== undefined) return decided;

  // The registration boundary is before listen(): a signal now takes the F-19(a) A path.
  if (received !== undefined) return runShutdown("LISTEN_FAILED");

  // 4. listen; a signal received meanwhile is held until listen settles.
  const listened = await settle(() => steps.listen());
  if (listened.kind === "rejected") {
    record({ step: "LISTEN", kind: "REJECTED", errorName: nameOf(listened.error), errorCode: codeOf(listened.error) });
    return runShutdown("LISTEN_FAILED");
  }

  // 5. Running until the first signal.
  await signalled;
  return runShutdown("SIGNAL");
}

/** The process interface terminate() uses (default: process). */
export interface TerminateRuntime {
  exitCode?: number | string | null | undefined;
  exit(code: number): void;
}

export interface TerminateOptions {
  /** PROVISIONAL (AR-3): bounded best-effort log flush before a forced exit. */
  readonly flushBudgetMs?: number;
  /** PROVISIONAL (AR-3): unref'd backstop after a clean shutdown; exits 0 (D3). */
  readonly cleanBackstopMs?: number;
}

export const DEFAULT_FLUSH_BUDGET_MS = 1_000;
export const DEFAULT_CLEAN_BACKSTOP_MS = 2_000;

/**
 * Applies a lifecycle result (§11.3 "Final termination"). Forced path: exit
 * code 1, one summary line, a flush raced against flushBudgetMs, then an
 * unconditional exit. Clean path: exit code 0 and a natural exit, with an
 * unref'd backstop that exits 0 if a lingering handle keeps the process alive.
 */
export function terminate(
  result: RunResult,
  logger: LifecycleLogger,
  options: TerminateOptions = {},
  runtime: TerminateRuntime = process,
): void {
  if (result.forceExit) {
    runtime.exitCode = result.exitCode;
    try {
      logger.error(
        {
          exitCode: result.exitCode,
          primary: result.failures[0] ?? null,
          later: result.failures.slice(1),
          ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
        },
        "API stopped after a lifecycle failure",
      );
    } catch {
      // Best effort.
    }
    let exited = false;
    const exitOnce = (): void => {
      if (exited) return;
      exited = true;
      runtime.exit(result.exitCode);
    };
    setTimeout(exitOnce, options.flushBudgetMs ?? DEFAULT_FLUSH_BUDGET_MS);
    try {
      if (logger.flush === undefined) exitOnce();
      else logger.flush(() => exitOnce());
    } catch {
      exitOnce();
    }
    return;
  }
  runtime.exitCode = 0;
  const backstop = setTimeout(() => {
    try {
      logger.warn({}, "lingering handles after clean shutdown");
    } catch {
      // Best effort.
    }
    runtime.exit(0);
  }, options.cleanBackstopMs ?? DEFAULT_CLEAN_BACKSTOP_MS);
  backstop.unref();
}

export interface ReadinessRetryOptions {
  /** True for connectivity (TRANSIENT-class) errors, which are retried. */
  readonly isConnectivityError: (error: unknown) => boolean;
  /** Attempts may start only within this budget (default 30 s). */
  readonly budgetMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(handle);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wraps one readiness attempt with the §8.5 connectivity retry: 500 ms × 2ⁿ,
 * capped at 5 s, full jitter, attempts starting only within 30 s. Any
 * ready:false result and any non-connectivity error are definitive.
 */
export function retryingReadiness(
  attempt: () => Promise<SchemaReadiness>,
  options: ReadinessRetryOptions,
): (signal: AbortSignal) => Promise<SchemaReadiness> {
  const budgetMs = options.budgetMs ?? 30_000;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  return async (signal) => {
    const started = now();
    for (let n = 0; ; n += 1) {
      if (signal.aborted) throw new Error("readiness abandoned");
      try {
        return await attempt();
      } catch (error) {
        if (!options.isConnectivityError(error)) throw error;
        const delay = random() * Math.min(maxDelayMs, baseDelayMs * 2 ** n);
        if (now() + delay - started >= budgetMs) throw error;
        await sleep(delay, signal);
      }
    }
  };
}
