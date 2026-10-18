import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryingReadiness, runApi, terminate } from "./lifecycle.js";
import type {
  IntakeBarrierResult,
  LifecycleBudgets,
  LifecycleLogger,
  LifecycleSteps,
  RegistrationVerification,
  SignalSource,
} from "./lifecycle.js";

// Function-level lifecycle tests (Rev 1.7 §16.3 LC-*). Process-level
// termination is in lifecycle-process.test.ts.

class FakeSignals implements SignalSource {
  private listeners: ((signal: string) => void)[] = [];
  subscribe(listener: (signal: string) => void): void {
    this.listeners.push(listener);
  }
  emit(signal = "SIGTERM"): void {
    for (const listener of this.listeners) listener(signal);
  }
}

const BUDGETS: LifecycleBudgets = {
  intakeBarrierMs: 400,
  finalizationMs: 400,
  startupSlotMs: 400,
  readinessMs: 400,
  slotSignalWaitMs: 300,
  registrationVerificationMs: 200,
};

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Steps whose calls are recorded in order; overrides replace individual steps. */
function steps(overrides: Partial<LifecycleSteps> = {}, budgets: Partial<LifecycleBudgets> = {}) {
  const calls: string[] = [];
  const intakes: IntakeBarrierResult[] = [];
  const all: LifecycleSteps = {
    verifyReadiness: async () => {
      calls.push("verifyReadiness");
      return { ready: true };
    },
    startupSlot: async () => {
      calls.push("startupSlot");
    },
    verifyRegistration: async () => {
      calls.push("verifyRegistration");
      return { kind: "STILL_UNKNOWN" };
    },
    listen: async () => {
      calls.push("listen");
    },
    intakeBarrier: async (reason) => {
      calls.push(`intakeBarrier:${reason}`);
      return { forced: "NOT_REPORTED" };
    },
    finalizeBeforeDisconnect: async (reason, intake) => {
      calls.push(`finalize:${reason}`);
      intakes.push(intake);
      return { successAllowed: true };
    },
    disconnect: async () => {
      calls.push("disconnect");
      return { completed: true };
    },
    budgets: { ...BUDGETS, ...budgets },
  };
  const wrapped: LifecycleSteps = { ...all, ...overrides };
  return { steps: wrapped, calls, intakes };
}

/** Runs the lifecycle and emits SIGTERM once listen has been called. */
async function runToSignal(lifecycle: LifecycleSteps, calls: string[]) {
  const signals = new FakeSignals();
  const running = runApi(lifecycle, signals);
  while (!calls.includes("listen")) await tick(5);
  signals.emit();
  return running;
}

describe("LC-1, LC-1b: readiness", () => {
  it("LC-1: any ready:false → no retry, no startupSlot, no listen; disconnect; exit 1; the reason code is recorded", async () => {
    let attempts = 0;
    const verify = retryingReadiness(
      async () => {
        attempts += 1;
        return { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S1" };
      },
      { isConnectivityError: () => true },
    );
    const { steps: lifecycle, calls } = steps({ verifyReadiness: verify });
    const result = await runApi(lifecycle, new FakeSignals());
    assert.equal(attempts, 1, "no retry of a definitive result");
    assert.deepEqual(calls, ["disconnect"]);
    assert.deepEqual(result, {
      exitCode: 1,
      forceExit: true,
      failures: [{ step: "READINESS", kind: "REJECTED", errorCode: "STRUCTURE_MISMATCH:S1" }],
    });
  });

  it("LC-1b: connectivity failures retry with capped, jittered backoff and stop at the 30 s budget → the same abort path", async () => {
    let clock = 0;
    const delays: number[] = [];
    let attempts = 0;
    const transient = Object.assign(new Error("Connection terminated unexpectedly"));
    const verify = retryingReadiness(
      async () => {
        attempts += 1;
        throw transient;
      },
      {
        isConnectivityError: (error) => error === transient,
        now: () => clock,
        random: () => 1,
        sleep: async (ms) => {
          delays.push(ms);
          clock += ms;
        },
      },
    );
    const { steps: lifecycle, calls } = steps({ verifyReadiness: verify });
    const result = await runApi(lifecycle, new FakeSignals());
    assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000]);
    assert.equal(attempts, 9);
    assert.ok(clock < 30_000, "no attempt starts after the budget");
    assert.deepEqual(calls, ["disconnect"]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures[0]?.step, "READINESS");
    assert.equal(result.failures[0]?.kind, "REJECTED");
  });

  it("a non-connectivity error is not retried", async () => {
    let attempts = 0;
    const verify = retryingReadiness(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      },
      { isConnectivityError: () => false },
    );
    await assert.rejects(verify(new AbortController().signal));
    assert.equal(attempts, 1);
  });
});

describe("LC-2 – LC-5: order and exit codes", () => {
  it("LC-2: verifyReadiness → startupSlot → listen", async () => {
    const { steps: lifecycle, calls } = steps();
    const result = await runToSignal(lifecycle, calls);
    assert.deepEqual(calls.slice(0, 3), ["verifyReadiness", "startupSlot", "listen"]);
    assert.equal(result.exitCode, 0);
  });

  it("LC-3: listen rejects → intakeBarrier(LISTEN_FAILED) → finalize → disconnect → exit 1", async () => {
    const { steps: lifecycle, calls } = steps({
      listen: async () => {
        calls.push("listen");
        throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
      },
    });
    const result = await runApi(lifecycle, new FakeSignals());
    assert.deepEqual(calls, ["verifyReadiness", "startupSlot", "listen", "intakeBarrier:LISTEN_FAILED", "finalize:LISTEN_FAILED", "disconnect"]);
    assert.deepEqual(result.failures, [{ step: "LISTEN", kind: "REJECTED", errorName: "Error", errorCode: "EADDRINUSE" }]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.forceExit, true);
  });

  it("LC-4: SIGTERM after listen → intake(SIGNAL) → finalize → disconnect (last) → exit 0; forced NOT_REPORTED", async () => {
    const { steps: lifecycle, calls, intakes } = steps();
    const result = await runToSignal(lifecycle, calls);
    assert.deepEqual(calls.slice(3), ["intakeBarrier:SIGNAL", "finalize:SIGNAL", "disconnect"]);
    assert.deepEqual(intakes, [{ forced: "NOT_REPORTED" }]);
    assert.deepEqual(result, { exitCode: 0, forceExit: false, failures: [] });
  });

  it("LC-5: a disconnect timeout → exit 1, forceExit true", async () => {
    const { steps: lifecycle, calls } = steps({
      disconnect: async () => {
        calls.push("disconnect");
        return { completed: false, timedOut: true };
      },
    });
    const result = await runToSignal(lifecycle, calls);
    assert.equal(result.exitCode, 1);
    assert.equal(result.forceExit, true);
  });
});

describe("LC-6, LC-7: signals during startup", () => {
  it("LC-6: a signal during readiness → ABORT_STARTUP: no listen, no intake, no finalization; disconnect; exit 1", async () => {
    const signals = new FakeSignals();
    const { steps: lifecycle, calls } = steps({
      verifyReadiness: async (signal) => {
        calls.push("verifyReadiness");
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        return { ready: true };
      },
    });
    const running = runApi(lifecycle, signals);
    await tick(20);
    signals.emit();
    const result = await running;
    assert.deepEqual(calls, ["verifyReadiness", "disconnect"]);
    assert.deepEqual(result.failures, [{ step: "READINESS", kind: "ABANDONED_ON_SIGNAL" }]);
    assert.equal(result.exitCode, 1);
  });

  it("LC-6: a signal during a slot that honours the abort and rejects { finalizationRequired: false } → ABORT_STARTUP after the slot settles", async () => {
    const signals = new FakeSignals();
    let slotSettled = false;
    const { steps: lifecycle, calls } = steps({
      startupSlot: async (signal) => {
        calls.push("startupSlot");
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        await tick(50);
        slotSettled = true;
        throw Object.assign(new Error("slot aborted"), { finalizationRequired: false });
      },
      disconnect: async () => {
        calls.push(`disconnect(slotSettled=${String(slotSettled)})`);
        return { completed: true };
      },
    });
    const running = runApi(lifecycle, signals);
    while (!calls.includes("startupSlot")) await tick(5);
    signals.emit();
    const result = await running;
    assert.deepEqual(calls, ["verifyReadiness", "startupSlot", "disconnect(slotSettled=true)"]);
    assert.equal(result.exitCode, 1);
  });

  it("LC-7: a double signal runs the shutdown once; a signal while listen is pending is handled after listen settles", async () => {
    const signals = new FakeSignals();
    const { steps: lifecycle, calls } = steps({
      listen: async () => {
        calls.push("listen-start");
        signals.emit();
        signals.emit();
        await tick(50);
        calls.push("listen-done");
      },
    });
    const result = await runApi(lifecycle, signals);
    assert.deepEqual(calls, ["verifyReadiness", "startupSlot", "listen-start", "listen-done", "intakeBarrier:SIGNAL", "finalize:SIGNAL", "disconnect"]);
    assert.equal(result.exitCode, 0);
  });
});

describe("SLOT A outcomes and the registration verification (function level; LC-6b/LC-17 are process level)", () => {
  async function slotCase(slot: LifecycleSteps["startupSlot"], verification?: () => Promise<RegistrationVerification>) {
    const deadlines: number[] = [];
    let clock = 1_000;
    const { steps: lifecycle, calls } = steps({
      startupSlot: slot,
      verifyRegistration: async (deadline) => {
        calls.push("verifyRegistration");
        deadlines.push(deadline);
        return (verification ?? (async () => ({ kind: "STILL_UNKNOWN" as const })))();
      },
    });
    const result = await runApi(lifecycle, new FakeSignals(), { now: () => clock++ });
    return { result, calls, deadlines };
  }

  it("{ finalizationRequired: true } → runShutdown(LISTEN_FAILED); { false } → ABORT_STARTUP", async () => {
    const required = await slotCase(async () => {
      throw Object.assign(new Error("x"), { finalizationRequired: true });
    });
    assert.deepEqual(required.calls, ["verifyReadiness", "intakeBarrier:LISTEN_FAILED", "finalize:LISTEN_FAILED", "disconnect"]);
    const notRequired = await slotCase(async () => {
      throw Object.assign(new Error("x"), { finalizationRequired: false });
    });
    assert.deepEqual(notRequired.calls, ["verifyReadiness", "disconnect"]);
    for (const { result } of [required, notRequired]) assert.equal(result.exitCode, 1);
  });

  it("an unexpected slot error → one verification with deadline now + registrationVerificationMs, mapped per U3", async () => {
    const unexpected = async () => {
      throw new TypeError("unexpected");
    };
    const cases: [() => Promise<RegistrationVerification>, string[], string | undefined][] = [
      [async () => ({ kind: "CONFIRMED_PRESENT", recorderAndConsumerStarted: true }), ["intakeBarrier:LISTEN_FAILED", "finalize:LISTEN_FAILED", "disconnect"], undefined],
      [async () => ({ kind: "CONFIRMED_PRESENT", recorderAndConsumerStarted: false }), ["disconnect"], undefined],
      [async () => ({ kind: "CONFIRMED_ABSENT" }), ["disconnect"], undefined],
      [async () => ({ kind: "STILL_UNKNOWN" }), ["disconnect"], "REGISTRATION_OUTCOME_UNKNOWN"],
      [() => Promise.reject(new Error("verification failed")), ["disconnect"], "REGISTRATION_OUTCOME_UNKNOWN"],
    ];
    for (const [verification, after, outcome] of cases) {
      const run = await slotCase(unexpected, verification);
      assert.deepEqual(run.calls, ["verifyReadiness", "verifyRegistration", ...after]);
      assert.equal(run.deadlines.length, 1, "called at most once");
      assert.equal(run.deadlines[0], 1_000 + BUDGETS.registrationVerificationMs);
      assert.equal(run.result.outcome, outcome);
      assert.equal(run.result.exitCode, 1);
      assert.equal(run.result.failures[0]?.step, "STARTUP_SLOT");
    }
  });

  it("a verification that never settles → watchdog → STILL_UNKNOWN (REGISTRATION_VERIFY / WATCHDOG)", async () => {
    const run = await slotCase(
      async () => {
        throw new TypeError("unexpected");
      },
      () => new Promise<RegistrationVerification>(() => undefined),
    );
    assert.deepEqual(run.result.failures.map((f) => `${f.step}/${f.kind}`), ["STARTUP_SLOT/REJECTED", "REGISTRATION_VERIFY/WATCHDOG"]);
    assert.equal(run.result.outcome, "REGISTRATION_OUTCOME_UNKNOWN");
    assert.ok(!run.calls.includes("listen"));
  });

  it("a slot that hangs past startupSlotMs → STARTUP_SLOT / WATCHDOG → ABORT_STARTUP, never finalization", async () => {
    const run = await slotCase(() => new Promise<void>(() => undefined));
    assert.deepEqual(run.calls, ["verifyReadiness", "disconnect"]);
    assert.deepEqual(run.result.failures, [{ step: "STARTUP_SLOT", kind: "WATCHDOG" }]);
  });
});

describe("LC-8 – LC-10, LC-13, LC-14: shutdown properties", () => {
  it("LC-8: 011A-style doubles — forced true + successAllowed false → 1; forced true + successAllowed true → 0", async () => {
    for (const [successAllowed, expected] of [[false, 1], [true, 0]] as const) {
      const { steps: lifecycle, calls } = steps({
        intakeBarrier: async () => ({ forced: true }),
        finalizeBeforeDisconnect: async () => ({ successAllowed }),
      });
      const result = await runToSignal(lifecycle, calls);
      assert.equal(result.exitCode, expected);
    }
  });

  it("LC-9: the barrier's duration does not shorten the disconnect bound", async () => {
    const times: Record<string, number> = {};
    const { steps: lifecycle, calls } = steps({
      intakeBarrier: async () => {
        await tick(350);
        times.intakeDone = performance.now();
        return { forced: "NOT_REPORTED" };
      },
      disconnect: async () => {
        times.disconnectStart = performance.now();
        await tick(300);
        return { completed: true };
      },
    });
    const result = await runToSignal(lifecycle, calls);
    assert.equal(result.exitCode, 0, "a 350 ms barrier followed by a 300 ms disconnect still completes");
    assert.ok((times.disconnectStart ?? 0) >= (times.intakeDone ?? Infinity));
  });

  it("LC-10: a rejecting barrier → finalization (forced BARRIER_FAILED) → disconnect; failures[0] INTAKE; exit 1", async () => {
    const { steps: lifecycle, calls, intakes } = steps({
      intakeBarrier: async (reason) => {
        calls.push(`intakeBarrier:${reason}`);
        throw new Error("barrier failed");
      },
    });
    const result = await runToSignal(lifecycle, calls);
    assert.deepEqual(calls.slice(3), ["intakeBarrier:SIGNAL", "finalize:SIGNAL", "disconnect"]);
    assert.deepEqual(intakes, [{ forced: "BARRIER_FAILED" }]);
    assert.equal(result.failures[0]?.step, "INTAKE");
    assert.equal(result.exitCode, 1, "even though finalization allowed success");
  });

  it("LC-13: a rejecting disconnect is recorded (DISCONNECT); { completed: false } is not a failure entry; both exit 1, forced", async () => {
    const rejects = steps({
      disconnect: async () => {
        throw new Error("disconnect failed");
      },
    });
    const rejected = await runToSignal(rejects.steps, rejects.calls);
    assert.deepEqual(rejected.failures.map((f) => f.step), ["DISCONNECT"]);
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.forceExit, true);
    const incomplete = steps({ disconnect: async () => ({ completed: false, timedOut: true }) });
    const result = await runToSignal(incomplete.steps, incomplete.calls);
    assert.deepEqual(result.failures, []);
    assert.equal(result.exitCode, 1);
  });

  it("LC-14: a throwing logger is swallowed; order, failures and exit codes are unchanged; failures hold name and code only", async () => {
    const logger: LifecycleLogger = {
      error: () => {
        throw new Error("logger broken");
      },
      warn: () => {
        throw new Error("logger broken");
      },
    };
    const { steps: lifecycle, calls } = steps({
      intakeBarrier: async (reason) => {
        calls.push(`intakeBarrier:${reason}`);
        throw Object.assign(new Error("secret message: password=hunter2"), { code: "E_BARRIER" });
      },
    });
    const signals = new FakeSignals();
    const running = runApi(lifecycle, signals, { logger });
    while (!calls.includes("listen")) await tick(5);
    signals.emit();
    const result = await running;
    assert.deepEqual(calls.slice(3), ["intakeBarrier:SIGNAL", "finalize:SIGNAL", "disconnect"]);
    assert.deepEqual(result.failures, [{ step: "INTAKE", kind: "REJECTED", errorName: "Error", errorCode: "E_BARRIER" }]);
    assert.doesNotMatch(JSON.stringify(result), /hunter2|secret message/);
    assert.equal(result.exitCode, 1);
  });
});

describe("terminate (function level)", () => {
  function runtime() {
    const exits: number[] = [];
    const rt = { exitCode: undefined as number | string | null | undefined, exit: (code: number) => void exits.push(code) };
    return { rt, exits };
  }
  const result = (exitCode: 0 | 1) => ({ exitCode, forceExit: exitCode !== 0, failures: exitCode === 0 ? [] : [{ step: "LISTEN" as const, kind: "REJECTED" as const }] });

  it("forced: exit code 1, one summary line, exit after the flush callback", async () => {
    const { rt, exits } = runtime();
    const lines: unknown[] = [];
    terminate(result(1), { error: (o) => void lines.push(o), warn: () => undefined, flush: (cb) => cb?.() }, { flushBudgetMs: 1_000 }, rt);
    assert.equal(rt.exitCode, 1);
    assert.deepEqual(exits, [1]);
    assert.equal(lines.length, 1);
    await tick(1_100);
    assert.deepEqual(exits, [1], "exits once");
  });

  it("forced: a flush that never completes does not delay the exit beyond flushBudgetMs; a throwing logger does not block", async () => {
    const { rt, exits } = runtime();
    const started = performance.now();
    terminate(
      result(1),
      {
        error: () => {
          throw new Error("x");
        },
        warn: () => undefined,
        flush: () => undefined,
      },
      { flushBudgetMs: 150 },
      rt,
    );
    while (exits.length === 0) await tick(10);
    const elapsed = performance.now() - started;
    assert.deepEqual(exits, [1]);
    assert.ok(elapsed >= 140 && elapsed < 600, `elapsed ${elapsed}`);
  });

  it("clean: exit code 0 and no immediate exit; the backstop exits 0 with one warning", async () => {
    const { rt, exits } = runtime();
    const warnings: string[] = [];
    terminate(result(0), { error: () => undefined, warn: (_o, m) => void warnings.push(m) }, { cleanBackstopMs: 100 }, rt);
    assert.equal(rt.exitCode, 0);
    assert.deepEqual(exits, []);
    await tick(250);
    assert.deepEqual(exits, [0]);
    assert.deepEqual(warnings, ["lingering handles after clean shutdown"]);
  });
});
