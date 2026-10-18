/**
 * Child-process fixture for the process-level lifecycle tests (LC-1c,
 * LC-6b, LC-11, LC-12, LC-15, LC-16, LC-17). It wires runApi + terminate
 * with step doubles chosen by the scenario named in argv[2], prints JSON
 * marker lines to stdout, and lets the real process exit. Signals arrive
 * over IPC ("SIGTERM"): Node on Windows cannot deliver a catchable SIGTERM
 * to a child. The IPC channel is closed when the signal arrives (or at
 * start, for scenarios without one), so it never keeps the process alive.
 */
import Fastify from "fastify";
import { runApi, terminate } from "../lifecycle.js";
import type {
  LifecycleBudgets,
  LifecycleLogger,
  LifecycleSteps,
  RegistrationVerification,
  SignalSource,
  TerminateRuntime,
} from "../lifecycle.js";

const scenario = process.argv[2] ?? "";
const started = performance.now();
const elapsed = (): number => Math.round(performance.now() - started);

function mark(name: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ mark: name, t: elapsed(), ...extra })}\n`);
}

/** An active handle that would keep the process alive on its own. */
function holdHandle(): void {
  setInterval(() => undefined, 1_000);
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function slotFailure(finalizationRequired: boolean): Error {
  return Object.assign(new Error("startup slot did not complete"), { finalizationRequired });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const BUDGETS: LifecycleBudgets = {
  intakeBarrierMs: 500,
  finalizationMs: 500,
  startupSlotMs: 1_000,
  readinessMs: 1_000,
  slotSignalWaitMs: 5_000,
  registrationVerificationMs: 1_000,
};

const base: LifecycleSteps = {
  verifyReadiness: async () => {
    mark("verifyReadiness");
    return { ready: true };
  },
  startupSlot: async () => {
    mark("startupSlot");
  },
  verifyRegistration: async (deadline) => {
    mark("verifyRegistration", { deadlineDelta: Math.round(deadline - performance.now()) });
    return { kind: "STILL_UNKNOWN" };
  },
  listen: async () => {
    mark("listen");
  },
  intakeBarrier: async (reason) => {
    mark("intakeBarrier", { reason });
    return { forced: "NOT_REPORTED" };
  },
  finalizeBeforeDisconnect: async (reason, intake) => {
    mark("finalize", { reason, forced: intake.forced });
    return { successAllowed: true };
  },
  disconnect: async () => {
    mark("disconnect");
    return { completed: true };
  },
  budgets: BUDGETS,
};

/** A slot that marks its start, waits for the abort signal, then does `then`. */
function slotOnSignal(then: () => Promise<void>): LifecycleSteps["startupSlot"] {
  return async (signal) => {
    mark("slot-started");
    await untilAborted(signal);
    await pause(50);
    await then();
  };
}

function verification(result: () => Promise<RegistrationVerification>): LifecycleSteps["verifyRegistration"] {
  return async (deadline) => {
    mark("verifyRegistration", { deadlineDelta: Math.round(deadline - performance.now()) });
    return result();
  };
}

const unsettledReadiness: LifecycleSteps["verifyReadiness"] = async () => {
  mark("readiness-started");
  holdHandle();
  return never();
};

const otherError = (): Promise<void> => Promise.reject(new TypeError("unexpected slot failure"));

interface Scenario {
  readonly signal: boolean;
  readonly steps: Partial<LifecycleSteps>;
  readonly budgets?: Partial<LifecycleBudgets>;
  readonly leakHandle?: boolean;
  readonly hangingFlush?: boolean;
}

const lc17 = (result: () => Promise<RegistrationVerification>): Scenario => ({
  signal: true,
  steps: { startupSlot: slotOnSignal(otherError), verifyRegistration: verification(result) },
});

const SCENARIOS: Record<string, Scenario> = {
  // LC-1c: unsettled readiness holding an active handle.
  "lc1c-watchdog": { signal: false, steps: { verifyReadiness: unsettledReadiness }, budgets: { readinessMs: 600 } },
  "lc1c-signal": { signal: true, steps: { verifyReadiness: unsettledReadiness }, budgets: { readinessMs: 20_000 } },
  "lc1c-signal-disconnect-rejects": {
    signal: true,
    steps: {
      verifyReadiness: unsettledReadiness,
      disconnect: async () => {
        mark("disconnect");
        throw Object.assign(new Error("disconnect failed"), { code: "E_TEST_DISCONNECT" });
      },
    },
    budgets: { readinessMs: 20_000 },
  },
  // LC-6b: SLOT A outcomes.
  "lc6b-reject-finalization-required": {
    signal: true,
    steps: { startupSlot: slotOnSignal(() => Promise.reject(slotFailure(true))) },
  },
  "lc6b-resolve-after-signal": { signal: true, steps: { startupSlot: slotOnSignal(async () => undefined) } },
  "lc6b-other-error": {
    signal: true,
    steps: { startupSlot: slotOnSignal(otherError), verifyRegistration: verification(async () => ({ kind: "CONFIRMED_ABSENT" })) },
  },
  "lc6b-hang": {
    signal: false,
    steps: {
      startupSlot: async () => {
        mark("slot-started");
        holdHandle();
        return never();
      },
    },
    budgets: { startupSlotMs: 600 },
  },
  "lc6b-unsettled-after-signal": {
    signal: true,
    steps: {
      startupSlot: async () => {
        mark("slot-started");
        holdHandle();
        return never();
      },
    },
    budgets: { startupSlotMs: 30_000, slotSignalWaitMs: 800 },
  },
  // LC-17: the bounded registration verification after an unexpected slot error.
  "lc17-present-started": lc17(async () => ({ kind: "CONFIRMED_PRESENT", recorderAndConsumerStarted: true })),
  "lc17-present-not-started": lc17(async () => ({ kind: "CONFIRMED_PRESENT", recorderAndConsumerStarted: false })),
  "lc17-absent": lc17(async () => ({ kind: "CONFIRMED_ABSENT" })),
  "lc17-still-unknown": lc17(async () => ({ kind: "STILL_UNKNOWN" })),
  "lc17-never-settles": lc17(() => {
    holdHandle();
    return never();
  }),
  "lc17-rejects": lc17(() => Promise.reject(new Error("verification failed"))),
  "lc17-no-signal": {
    signal: false,
    steps: {
      startupSlot: async () => {
        mark("slot-started");
        throw new TypeError("unexpected slot failure");
      },
      verifyRegistration: verification(async () => ({ kind: "STILL_UNKNOWN" })),
    },
  },
  // LC-11: the intake barrier hangs (holding a handle), then settles late.
  "lc11-intake-hangs": {
    signal: true,
    steps: {
      intakeBarrier: async (reason) => {
        mark("intakeBarrier", { reason });
        holdHandle();
        await pause(1_200);
        mark("intakeBarrier-late-settlement");
        return { forced: "NOT_REPORTED" };
      },
      disconnect: async () => {
        mark("disconnect");
        await pause(1_000);
        mark("disconnect-completed");
        return { completed: true };
      },
    },
  },
  // LC-12 (+ LC-10): finalization rejects, or hangs holding a handle.
  "lc12-finalize-rejects": {
    signal: true,
    steps: {
      finalizeBeforeDisconnect: async () => {
        mark("finalize");
        throw new Error("finalize failed");
      },
    },
  },
  "lc12-finalize-hangs": {
    signal: true,
    steps: {
      finalizeBeforeDisconnect: async () => {
        mark("finalize");
        holdHandle();
        return never();
      },
    },
  },
  "lc12-intake-and-finalize-reject": {
    signal: true,
    steps: {
      intakeBarrier: async (reason) => {
        mark("intakeBarrier", { reason });
        throw new Error("barrier failed");
      },
      finalizeBeforeDisconnect: async (reason, intake) => {
        mark("finalize", { reason, forced: intake.forced });
        throw new Error("finalize failed");
      },
    },
  },
  // LC-15: forced termination paths, each holding an active handle.
  "lc15-abort-startup": {
    signal: false,
    leakHandle: true,
    steps: {
      verifyReadiness: async () => {
        mark("verifyReadiness");
        return { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.b" };
      },
    },
  },
  "lc15-listen-failed": {
    signal: false,
    leakHandle: true,
    steps: {
      listen: async () => {
        mark("listen");
        throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
      },
    },
  },
  "lc15-disconnect-incomplete": {
    signal: true,
    leakHandle: true,
    steps: {
      disconnect: async () => {
        mark("disconnect");
        return { completed: false, timedOut: true };
      },
    },
  },
  "lc15-flush-hangs": {
    signal: false,
    leakHandle: true,
    hangingFlush: true,
    steps: {
      verifyReadiness: async () => {
        mark("verifyReadiness");
        return { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.b" };
      },
    },
  },
  // LC-16: clean SIGTERM shutdown, with no lingering handle and with one.
  "lc16-clean": { signal: true, steps: {} },
  "lc16-leaked-handle": { signal: true, leakHandle: true, steps: {} },
};

async function main(): Promise<void> {
  const chosen = SCENARIOS[scenario];
  if (chosen === undefined) {
    mark("unknown-scenario");
    process.exitCode = 2;
    process.disconnect?.();
    return;
  }
  if (!chosen.signal) process.disconnect?.();
  if (chosen.leakHandle === true) holdHandle();

  const signals: SignalSource = {
    subscribe(listener) {
      process.on("message", (message) => {
        if (message !== "SIGTERM") return;
        mark("signal");
        process.disconnect?.();
        listener("SIGTERM");
      });
    },
  };

  // A real pino logger (through Fastify; the app never listens), so flush timing is real.
  // FastifyBaseLogger's type omits pino's flush, which exists at runtime.
  const pinoLog = Fastify({ logger: { level: "info" } }).log as ReturnType<typeof Fastify>["log"] & {
    flush(callback: (error?: Error) => void): void;
  };
  const logger: LifecycleLogger = {
    error: (object, message) => pinoLog.error(object, message),
    warn: (object, message) => pinoLog.warn(object, message),
    flush: chosen.hangingFlush === true
      ? () => {
          mark("flush-hangs");
        }
      : (callback) => {
          const flushStarted = performance.now();
          pinoLog.flush(() => {
            mark("flush-completed", { flushMs: Math.round(performance.now() - flushStarted) });
            callback?.();
          });
        },
  };

  const steps: LifecycleSteps = {
    ...base,
    ...chosen.steps,
    budgets: { ...BUDGETS, ...chosen.budgets },
  };
  const result = await runApi(steps, signals, { logger });
  mark("result", { exitCode: result.exitCode, forceExit: result.forceExit, failures: result.failures, outcome: result.outcome });

  const decided = performance.now();
  const runtime: TerminateRuntime = {
    get exitCode() {
      return process.exitCode;
    },
    set exitCode(value) {
      process.exitCode = value as number | undefined;
    },
    exit(code: number) {
      mark("process.exit", { code, sinceDecisionMs: Math.round(performance.now() - decided) });
      process.exit(code);
    },
  };
  process.on("exit", (code) => mark("exit-event", { code, sinceDecisionMs: Math.round(performance.now() - decided) }));
  mark("terminate");
  terminate(result, logger, { flushBudgetMs: 300, cleanBackstopMs: 300 }, runtime);
}

void main();
