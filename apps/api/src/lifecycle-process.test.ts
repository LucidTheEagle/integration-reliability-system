import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// Process-level lifecycle tests (LC-1c, LC-6b, LC-11, LC-12, LC-15, LC-16,
// LC-17): the fixture runs the real runApi + terminate in a child process,
// and the child must actually exit, with the right code, within the bound.
// Tolerance: every bound below is the path's budgets plus the 300 ms flush
// plus 1,500 ms of process and scheduling margin, measured on the child's
// own clock from its signal marker (or from its start without a signal).

const FIXTURE = fileURLToPath(new URL("./test-fixtures/lifecycle-child.js", import.meta.url));
const MARGIN_MS = 1_500;
const FLUSH_MS = 300;

interface Line {
  readonly mark?: string;
  readonly t?: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

interface ChildRun {
  readonly code: number | null;
  readonly lines: Line[];
  marks(name: string): Line[];
  first(name: string): Line | undefined;
}

function runChild(scenario: string, signalAfter?: string, timeoutMs = 60_000): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = fork(FIXTURE, [scenario], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const lines: Line[] = [];
    let buffer = "";
    let signalled = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${scenario}: the child did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const text = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (text === "") continue;
        let line: Line;
        try {
          line = JSON.parse(text) as Line;
        } catch {
          continue;
        }
        lines.push(line);
        if (!signalled && signalAfter !== undefined && line.mark === signalAfter) {
          signalled = true;
          setTimeout(() => {
            if (child.connected) child.send("SIGTERM");
          }, 100);
        }
      }
    });
    child.stderr?.resume();
    child.on("exit", (code) => {
      clearTimeout(timer);
      setTimeout(() => {
        const marks = (name: string) => lines.filter((line) => line.mark === name);
        resolve({ code, lines, marks, first: (name) => marks(name)[0] });
      }, 50);
    });
  });
}

function failuresOf(run: ChildRun): string[] {
  const failures = (run.first("result")?.failures ?? []) as { step: string; kind: string }[];
  return failures.map((failure) => `${failure.step}/${failure.kind}`);
}

/**
 * ms from the child's signal marker to its process.exit / exit event; without a
 * signal, from the marker that starts the measured path (never from process
 * start, which includes module loading and varies with machine load).
 */
function exitAfter(run: ChildRun, pathStart?: string): number {
  const exit = run.first("process.exit") ?? run.first("exit-event");
  const from = run.first("signal")?.t ?? (pathStart === undefined ? undefined : run.first(pathStart)?.t);
  assert.ok(from !== undefined, "a signal or a path-start marker is required");
  return (exit?.t ?? Number.POSITIVE_INFINITY) - from;
}

function summary(run: ChildRun): Line | undefined {
  return run.lines.find((line) => line.msg === "API stopped after a lifecycle failure");
}

describe("LC-1c: unsettled readiness holding an active handle", () => {
  it("(i) no signal: READINESS/WATCHDOG; no startupSlot or listen; disconnect; exits 1 within readinessMs + flush + margin", async () => {
    const run = await runChild("lc1c-watchdog");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["READINESS/WATCHDOG"]);
    assert.equal(run.marks("startupSlot").length + run.marks("listen").length, 0);
    assert.equal(run.marks("disconnect").length, 1);
    assert.ok(exitAfter(run, "readiness-started") <= 600 + FLUSH_MS + MARGIN_MS, `exit after ${exitAfter(run, "readiness-started")} ms`);
  });

  it("(ii) SIGTERM while unsettled: stops waiting at once; READINESS/ABANDONED_ON_SIGNAL; exits 1 within flush + margin of the signal", async () => {
    const run = await runChild("lc1c-signal", "readiness-started");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["READINESS/ABANDONED_ON_SIGNAL"]);
    assert.ok(exitAfter(run) <= FLUSH_MS + MARGIN_MS, `exit ${exitAfter(run)} ms after the signal (readinessMs is 20 s)`);
  });

  it("(iii) the cleanup failure is observable: [READINESS, DISCONNECT] in order; still exit 1", async () => {
    const run = await runChild("lc1c-signal-disconnect-rejects", "readiness-started");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["READINESS/ABANDONED_ON_SIGNAL", "DISCONNECT/REJECTED"]);
    const line = summary(run);
    assert.equal((line?.primary as { step?: string } | undefined)?.step, "READINESS");
    assert.deepEqual(((line?.later ?? []) as { step: string }[]).map((f) => f.step), ["DISCONNECT"]);
  });
});

describe("LC-6b: the SLOT A invariant at process level (F-19(a) A, F-11(b) B)", () => {
  const settledAfterSignalBound = 50 + 500 + 500 + FLUSH_MS + MARGIN_MS;

  it("(i) rejects { finalizationRequired: true } after the signal → the LISTEN_FAILED path; exit 1", async () => {
    const run = await runChild("lc6b-reject-finalization-required", "slot-started");
    assert.equal(run.code, 1);
    assert.equal(run.marks("listen").length, 0);
    assert.equal(run.first("intakeBarrier")?.reason, "LISTEN_FAILED");
    assert.equal(run.first("finalize")?.reason, "LISTEN_FAILED");
    assert.equal(run.marks("disconnect").length, 1);
    assert.deepEqual(failuresOf(run), ["STARTUP_SLOT/REJECTED"]);
    assert.ok(exitAfter(run) <= settledAfterSignalBound, `exit after ${exitAfter(run)} ms`);
  });

  it("(ii) resolves after the signal → registered and complete → the LISTEN_FAILED path; exit 1", async () => {
    const run = await runChild("lc6b-resolve-after-signal", "slot-started");
    assert.equal(run.code, 1);
    assert.equal(run.marks("listen").length, 0);
    assert.equal(run.first("finalize")?.reason, "LISTEN_FAILED");
    assert.equal(run.marks("disconnect").length, 1);
    assert.ok(exitAfter(run) <= settledAfterSignalBound);
  });

  it("(iii) throws a non-StartupSlotFailure error → one verification (here CONFIRMED_ABSENT) → ABORT_STARTUP; exit 1", async () => {
    const run = await runChild("lc6b-other-error", "slot-started");
    assert.equal(run.code, 1);
    assert.equal(run.marks("verifyRegistration").length, 1);
    assert.equal(run.marks("finalize").length, 0);
    assert.equal(run.marks("listen").length, 0);
    assert.equal(run.marks("disconnect").length, 1);
    assert.ok(exitAfter(run) <= 50 + 1_000 + FLUSH_MS + MARGIN_MS);
  });

  it("(iv) hangs past startupSlotMs holding a handle → ABORT_STARTUP, no finalization; exits 1", async () => {
    const run = await runChild("lc6b-hang");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["STARTUP_SLOT/WATCHDOG"]);
    assert.equal(run.marks("finalize").length + run.marks("listen").length, 0);
    assert.equal(run.marks("disconnect").length, 1);
    assert.ok(exitAfter(run, "slot-started") <= 600 + FLUSH_MS + MARGIN_MS, `exit after ${exitAfter(run, "slot-started")} ms`);
  });

  it("(v) still unsettled slotSignalWaitMs after the signal → ABORT_STARTUP; exit measured from the signal", async () => {
    const run = await runChild("lc6b-unsettled-after-signal", "slot-started");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["STARTUP_SLOT/ABANDONED_ON_SIGNAL"]);
    assert.equal(run.marks("finalize").length, 0);
    const after = exitAfter(run);
    assert.ok(after >= 800 && after <= 800 + FLUSH_MS + MARGIN_MS, `exit ${after} ms after the signal (startupSlotMs 30 s)`);
    assert.equal((summary(run)?.primary as { step?: string } | undefined)?.step, "STARTUP_SLOT");
  });
});

describe("LC-17: the bounded registration verification (U3)", () => {
  const cases: [string, boolean, string | undefined, string[]][] = [
    ["lc17-present-started", true, undefined, ["STARTUP_SLOT/REJECTED"]],
    ["lc17-present-not-started", false, undefined, ["STARTUP_SLOT/REJECTED"]],
    ["lc17-absent", false, undefined, ["STARTUP_SLOT/REJECTED"]],
    ["lc17-still-unknown", false, "REGISTRATION_OUTCOME_UNKNOWN", ["STARTUP_SLOT/REJECTED"]],
    ["lc17-never-settles", false, "REGISTRATION_OUTCOME_UNKNOWN", ["STARTUP_SLOT/REJECTED", "REGISTRATION_VERIFY/WATCHDOG"]],
    ["lc17-rejects", false, "REGISTRATION_OUTCOME_UNKNOWN", ["STARTUP_SLOT/REJECTED", "REGISTRATION_VERIFY/REJECTED"]],
  ];
  for (const [scenario, finalizes, outcome, failures] of cases) {
    it(`${scenario}: ${finalizes ? "finalization (LISTEN_FAILED)" : "ABORT_STARTUP"}; verification once with deadline now + 1000; exit 1 within the bound`, async () => {
      const run = await runChild(scenario, "slot-started");
      assert.equal(run.code, 1);
      assert.equal(run.marks("listen").length, 0);
      assert.equal(run.marks("verifyRegistration").length, 1);
      const delta = run.first("verifyRegistration")?.deadlineDelta as number;
      assert.ok(delta > 900 && delta <= 1_000, `deadline − now = ${delta}`);
      assert.equal(run.marks("finalize").length, finalizes ? 1 : 0);
      assert.equal(run.marks("disconnect").length, 1);
      assert.equal(run.first("result")?.outcome, outcome);
      assert.deepEqual(failuresOf(run), failures);
      if (outcome !== undefined) assert.equal(summary(run)?.outcome, outcome);
      const bound = 50 + 1_000 + (finalizes ? 500 + 500 : 0) + FLUSH_MS + MARGIN_MS;
      assert.ok(exitAfter(run) <= bound, `exit after ${exitAfter(run)} ms (bound ${bound})`);
    });
  }

  it("lc17-no-signal: an unexpected slot error without a signal also verifies once → STILL_UNKNOWN → ABORT_STARTUP", async () => {
    const run = await runChild("lc17-no-signal");
    assert.equal(run.code, 1);
    assert.equal(run.marks("verifyRegistration").length, 1);
    assert.equal(run.first("result")?.outcome, "REGISTRATION_OUTCOME_UNKNOWN");
    assert.equal(run.marks("listen").length, 0);
  });
});

describe("LC-11, LC-12: hanging or failing shutdown steps never skip the disconnect", () => {
  it("LC-11: a hanging barrier (holding a handle) → INTAKE/WATCHDOG; finalization and disconnect run; exit 1; the late settlement is logged once", async () => {
    const run = await runChild("lc11-intake-hangs", "listen");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["INTAKE/WATCHDOG"]);
    assert.equal(run.first("finalize")?.forced, "BARRIER_FAILED");
    assert.equal(run.marks("disconnect-completed").length, 1);
    assert.equal(run.lines.filter((line) => line.msg === "late settlement after watchdog; ignored").length, 1);
    assert.ok(exitAfter(run) <= 500 + 500 + 1_000 + FLUSH_MS + MARGIN_MS, `exit after ${exitAfter(run)} ms`);
  });

  it("LC-12: finalization rejects → disconnect runs; FINALIZE recorded; exit 1", async () => {
    const run = await runChild("lc12-finalize-rejects", "listen");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["FINALIZE/REJECTED"]);
    assert.equal(run.marks("disconnect").length, 1);
  });

  it("LC-12: finalization hangs (holding a handle) → FINALIZE/WATCHDOG; disconnect runs; the child still exits 1", async () => {
    const run = await runChild("lc12-finalize-hangs", "listen");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["FINALIZE/WATCHDOG"]);
    assert.equal(run.marks("disconnect").length, 1);
    assert.ok(exitAfter(run) <= 500 + FLUSH_MS + MARGIN_MS);
  });

  it("LC-10 + LC-12: barrier and finalization both reject → failures [INTAKE, FINALIZE] in order (original cause first)", async () => {
    const run = await runChild("lc12-intake-and-finalize-reject", "listen");
    assert.equal(run.code, 1);
    assert.deepEqual(failuresOf(run), ["INTAKE/REJECTED", "FINALIZE/REJECTED"]);
    assert.equal(run.first("finalize")?.forced, "BARRIER_FAILED");
    assert.equal((summary(run)?.primary as { step?: string } | undefined)?.step, "INTAKE");
  });
});

describe("LC-15: forced termination paths, each holding an active handle (with §23.2 timing evidence)", () => {
  for (const [scenario, signalAfter, failures] of [
    ["lc15-abort-startup", undefined, ["READINESS/REJECTED"]],
    ["lc15-listen-failed", undefined, ["LISTEN/REJECTED"]],
    ["lc15-disconnect-incomplete", "listen", []],
  ] as const) {
    it(`${scenario}: exits 1 despite the handle`, async () => {
      const run = await runChild(scenario, signalAfter);
      assert.equal(run.code, 1);
      assert.deepEqual(failuresOf(run), failures);
      const exit = run.first("process.exit");
      assert.equal(exit?.code, 1);
      process.stdout.write(
        `[LC-15 evidence] ${scenario}: decision → process.exit ${String(exit?.sinceDecisionMs)} ms; real pino flush ${String(run.first("flush-completed")?.flushMs)} ms\n`,
      );
      assert.ok((exit?.sinceDecisionMs as number) <= FLUSH_MS + 200);
    });
  }

  it("lc15-flush-hangs: a logger flush that never completes does not delay the exit beyond flushBudgetMs + tolerance", async () => {
    const run = await runChild("lc15-flush-hangs");
    assert.equal(run.code, 1);
    assert.equal(run.marks("flush-hangs").length, 1);
    const since = run.first("process.exit")?.sinceDecisionMs as number;
    assert.ok(since >= FLUSH_MS - 20 && since <= FLUSH_MS + 200, `exit ${since} ms after the decision`);
  });
});

describe("LC-16: the clean path (D3: backstop exit code 0), with §23.2 timing evidence", () => {
  it("(i) no lingering handle: exits naturally with 0; the backstop never fires (no process.exit call)", async () => {
    const run = await runChild("lc16-clean", "listen");
    assert.equal(run.code, 0);
    assert.equal(run.marks("process.exit").length, 0, "no unconditional exit on success");
    const exitEvent = run.first("exit-event");
    assert.equal(exitEvent?.code, 0);
    process.stdout.write(`[LC-16 evidence] natural exit ${String(exitEvent?.sinceDecisionMs)} ms after terminate()\n`);
  });

  it("(ii) one leaked handle: the unref'd backstop fires after cleanBackstopMs, warns, and exits 0", async () => {
    const run = await runChild("lc16-leaked-handle", "listen");
    assert.equal(run.code, 0);
    const exit = run.first("process.exit");
    assert.equal(exit?.code, 0);
    assert.equal(run.lines.filter((line) => line.msg === "lingering handles after clean shutdown").length, 1);
    process.stdout.write(`[LC-16 evidence] backstop fired ${String(exit?.sinceDecisionMs)} ms after terminate() (cleanBackstopMs 300)\n`);
    assert.ok((exit?.sinceDecisionMs as number) >= 290 && (exit?.sinceDecisionMs as number) <= 300 + 300);
  });
});
