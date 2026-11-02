import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigValidationError } from "@irs/config";
import type { WorkerConfig } from "@irs/config";
import type { CallGate, GateSnapshot } from "./call-gate.js";
import { DispatchRedisError } from "./dispatch-queue/index.js";
import type { DispatchErrorObserver, DispatchProbeHandle, DispatchQueueHandle } from "./dispatch-queue/index.js";
import { createErrorCounter } from "./error-counter.js";
import { fullJitterDelay, probeCycle, runWorker } from "./lifecycle.js";
import type { CycleContext, CycleFunction, ReadinessResult, WorkerDependencies } from "./lifecycle.js";
import { createLogger } from "./logger.js";
import type { DatabaseClassifier } from "./startup-outcomes.js";
import { WORKER_CONSTANTS } from "./worker-constants.js";

// Task 012B-3 (B2-1 as the founder amended it; PD-6, PD-7, PD-10; S-4, S-9):
// the lifecycle, in-process, with fake dependencies, a fake clock and fake
// timers. No real wait, no connection. main.ts is never imported.

const CONFIG: WorkerConfig = Object.freeze({
  database: Object.freeze({ url: "postgresql://irs_test_worker@127.0.0.1:55433/irs_011_test" }),
  redis: Object.freeze({ host: "127.0.0.1", port: 46379, passwordFile: "secrets/redis_test_password" }),
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve: (value: T) => resolve(value), reject: (error: unknown) => reject(error) };
}

/** Database errors for the fake classifier: TRANSIENT or FAULT by name, never by message. */
class TransientDb extends Error {
  override readonly name = "TransientDb";
}
class FaultDb extends Error {
  override readonly name = "FaultDb";
}
const classify: DatabaseClassifier = (error) =>
  error instanceof TransientDb ? { failureClass: "TRANSIENT", code: "08006" } : { failureClass: "FAULT", code: "28P01" };

interface Init {
  readonly config?: () => WorkerConfig;
  readonly transition?: () => void;
  readonly readiness?: () => Promise<ReadinessResult>;
  readonly disconnect?: () => Promise<unknown>;
  readonly openProbeError?: () => Error | undefined;
  readonly ping?: () => Promise<void>;
  readonly queueRetireThrows?: boolean;
  readonly signalAtRegistration?: boolean;
  readonly createCycle?: (context: CycleContext) => CycleFunction;
  readonly random?: () => number;
}

interface Fakes {
  readonly run: Promise<number>;
  readonly lines: string[];
  readonly calls: string[];
  readonly errorObservers: DispatchErrorObserver[];
  signal(): void;
  advance(ms: number): void;
  pendingTimers(): number;
  resolved(): number | undefined;
}

function start(init: Init = {}): Fakes {
  const lines: string[] = [];
  const calls: string[] = [];
  const errorObservers: DispatchErrorObserver[] = [];
  let t = 0;
  const timers: { readonly key: object; readonly at: number; readonly callback: () => void }[] = [];
  let handler: (() => void) | undefined;
  let queues = 0;
  let probes = 0;

  const queueHandle = (id: number): DispatchQueueHandle =>
    Object.freeze({
      close: async (): Promise<void> => undefined,
      getJob: async () => undefined,
      getJobState: async () => "waiting" as const,
      getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, prioritized: 0, "waiting-children": 0, completed: 0, failed: 0 }),
      retire: () => {
        calls.push(`retire queue ${id}`);
        if (init.queueRetireThrows === true) throw new Error("a queue error during retirement");
        return Object.freeze({ everReady: true });
      },
    });
  const probeHandle = (id: number): DispatchProbeHandle =>
    Object.freeze({
      close: async (): Promise<void> => undefined,
      ping: () => (init.ping ?? (async () => undefined))(),
      retire: () => {
        calls.push(`retire probe ${id}`);
        return Object.freeze({ everReady: true });
      },
    });

  const deps: WorkerDependencies<{ readonly fake: "database" }> = {
    env: {},
    repositoryRoot: "/repository",
    loadWorkerConfig: () => {
      calls.push("config");
      return (init.config ?? (() => CONFIG))();
    },
    loadRedisPassword: () => {
      calls.push("password");
      return "not-a-real-password";
    },
    requireAuditIdGenerator: () => {
      calls.push("uuidv7");
      return () => "0199f8a0-0000-7000-8000-000000000001";
    },
    assertEventStateTransition: () => {
      calls.push("transition");
      init.transition?.();
    },
    createDatabase: () => {
      calls.push("createDatabase");
      return { fake: "database" };
    },
    verifySchemaReadiness: () => {
      calls.push("readiness");
      return (init.readiness ?? (async (): Promise<ReadinessResult> => ({ ready: true })))();
    },
    disconnectWithin: (_db, timeoutMs) => {
      calls.push(`disconnect ${timeoutMs}`);
      return (init.disconnect ?? (async () => "disconnected"))();
    },
    classifyDatabaseError: classify,
    openQueue: (_settings, onError) => {
      calls.push("openQueue");
      errorObservers.push(onError);
      return queueHandle(++queues);
    },
    openProbe: (_settings, onError) => {
      calls.push("openProbe");
      const error = init.openProbeError?.();
      if (error !== undefined) throw error;
      errorObservers.push(onError);
      return probeHandle(++probes);
    },
    publishWith: async (_handle, eventId) => eventId,
    write: (line) => lines.push(line),
    now: () => t,
    setTimer: (callback, ms) => {
      const key = {};
      timers.push({ key, at: t + ms, callback });
      return key;
    },
    clearTimer: (ref) => {
      const index = timers.findIndex((timer) => timer.key === ref);
      if (index !== -1) timers.splice(index, 1);
    },
    random: init.random ?? (() => 0),
    onSignal: (registered) => {
      calls.push("onSignal");
      handler = registered;
      if (init.signalAtRegistration === true) registered();
    },
    ...(init.createCycle === undefined ? {} : { createCycle: init.createCycle }),
  };
  let code: number | undefined;
  const run = runWorker(deps);
  void run.then((value) => {
    code = value;
  });
  return {
    run,
    lines,
    calls,
    errorObservers,
    signal: () => handler?.(),
    advance: (ms: number): void => {
      const target = t + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        t = due.at;
        due.callback();
      }
      t = target;
    },
    pendingTimers: () => timers.length,
    resolved: () => code,
  };
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await new Promise((resolve) => setImmediate(resolve));
}

/** Advances the fake clock and lets reactions run, in steps. */
async function step(f: Fakes, ms = 0): Promise<void> {
  await flush();
  f.advance(ms);
  await flush();
}

/** A compact label per line: event and its phase, state or cause, and code. */
function labels(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const parsed: Record<string, unknown> = JSON.parse(line);
    const parts = [parsed.event, parsed.phase ?? parsed.state ?? parsed.cause ?? parsed.action ?? parsed.reason, parsed.outcome, parsed.code];
    return parts.filter((part) => part !== undefined).join(" ");
  });
}

const STARTUP_OK = [
  "startup config ok",
  "startup password ok",
  "startup uuidv7 ok",
  "startup transition ok",
  "startup database ok",
  "startup readiness ok",
  "startup queue ok",
  "startup ready ok",
];

describe("lifecycle: startup (B2-1)", () => {
  it("registers the signal handler first, then runs the phases in order, then the first cycle", async () => {
    const f = start();
    await step(f);
    assert.deepEqual(f.calls, [
      "onSignal",
      "config",
      "password",
      "uuidv7",
      "transition",
      "createDatabase",
      "readiness",
      "openQueue",
      "openProbe",
    ]);
    assert.deepEqual(labels(f.lines), [...STARTUP_OK, "cycle ok"]);
    f.signal();
    assert.equal(await f.run, 0);
    assert.deepEqual(labels(f.lines).slice(-4), ["shutdown signal", "shutdown queue-retired", "shutdown database-closed", "shutdown exit"]);
  });

  it("every classification outcome: each permanent failure exits 1 with its code, releasing only what exists", async () => {
    const cases: { readonly init: Init; readonly last: string; readonly database: boolean }[] = [
      { init: { config: () => { throw new ConfigValidationError(["WORKER_DATABASE_URL: is required"]); } }, last: "startup config exit CONFIG_INVALID", database: false },
      { init: { transition: () => { throw new Error("planted unclassifiable"); } }, last: "startup transition exit UNCLASSIFIED", database: false },
      { init: { readiness: async () => ({ ready: false, reason: "MIGRATION_MISSING" }) }, last: "startup readiness exit MIGRATION_MISSING", database: true },
      { init: { readiness: async () => { throw new FaultDb("x"); } }, last: "startup readiness exit 28P01", database: true },
    ];
    for (const { init, last, database } of cases) {
      const f = start(init);
      assert.equal(await f.run, 1);
      const shown = labels(f.lines);
      assert.equal(shown[shown.length - (database ? 3 : 2)], last);
      assert.deepEqual(shown.slice(-1), ["shutdown exit"]);
      assert.equal(f.calls.includes(`disconnect ${WORKER_CONSTANTS.databaseDisconnectMs}`), database);
      assert.ok(!f.calls.includes("openQueue"), "no gate is created");
    }
  });

  it("a transient readiness failure is degraded, then retried after a back-off, without exiting (PD-6)", async () => {
    let attempts = 0;
    const f = start({
      readiness: async () => {
        attempts++;
        if (attempts < 3) throw new TransientDb("x");
        return { ready: true };
      },
      random: () => 0.5,
    });
    await step(f);
    assert.deepEqual(labels(f.lines).slice(-1), ["degraded database 08006"]);
    await step(f, 250);
    await step(f, 500);
    assert.equal(attempts, 3);
    assert.ok(labels(f.lines).includes("startup ready ok"));
    assert.equal(f.resolved(), undefined, "never an exit");
    f.signal();
    assert.equal(await f.run, 0);
  });

  it("a queue-phase DispatchRedisError and a deferred start are degraded and retried on the same gate, never an exit", async () => {
    let opens = 0;
    const f = start({ openProbeError: () => (++opens === 1 ? new DispatchRedisError("ECONNREFUSED") : undefined) });
    await step(f);
    await step(f, 0);
    await step(f, WORKER_CONSTANTS.retireWindowMs);
    const shown = labels(f.lines);
    assert.ok(shown.includes("startup queue degraded ECONNREFUSED"));
    assert.ok(shown.includes("startup queue degraded GATE_START_DEFERRED"));
    assert.ok(shown.includes("startup queue ok"));
    assert.deepEqual(
      f.calls.filter((call) => call.startsWith("open") || call.startsWith("retire")),
      ["openQueue", "openProbe", "retire queue 1", "openProbe", "openQueue"],
    );
    f.signal();
    assert.equal(await f.run, 0);
  });
});

describe("lifecycle: the back-off (PD-6)", () => {
  it("is full jitter over 500 ms × 2^n, capped at 5,000 ms, for attempts 0 to 6", () => {
    const policy = { baseMs: WORKER_CONSTANTS.backoffBaseMs, capMs: WORKER_CONSTANTS.backoffCapMs };
    const nearlyOne = 1 - Number.EPSILON;
    const expected = [499, 999, 1999, 3999, 4999, 4999, 4999];
    for (let attempt = 0; attempt <= 6; attempt++) {
      assert.equal(fullJitterDelay(attempt, policy, () => 0), 0);
      assert.equal(fullJitterDelay(attempt, policy, () => nearlyOne), expected[attempt]);
    }
  });
});

describe("lifecycle: the cycle loop", () => {
  it("never overlaps: a slow cycle is not started again while it runs; the next starts one interval after it ends", async () => {
    const held: Deferred<void>[] = [];
    const f = start({
      createCycle: () => () => {
        const cycle = deferred<void>();
        held.push(cycle);
        return cycle.promise;
      },
    });
    await step(f);
    assert.equal(held.length, 1);
    await step(f, 10 * WORKER_CONSTANTS.cycleIntervalMs);
    assert.equal(held.length, 1, "no overlap");
    held[0]?.resolve();
    await step(f, WORKER_CONSTANTS.cycleIntervalMs - 1);
    assert.equal(held.length, 1);
    await step(f, 1);
    assert.equal(held.length, 2);
    // No catch-up burst after a long cycle.
    await step(f, 20 * WORKER_CONSTANTS.cycleIntervalMs);
    held[1]?.resolve();
    await step(f, WORKER_CONSTANTS.cycleIntervalMs);
    assert.equal(held.length, 3, "exactly one more cycle, never a burst");
    f.signal();
    await step(f, WORKER_CONSTANTS.shutdownCycleMs);
    assert.equal(await f.run, 0);
  });

  it("the cycle line's errors come from a burst counted between cycles", async () => {
    const f = start();
    await step(f);
    const observer = f.errorObservers[0];
    assert.ok(observer !== undefined);
    for (let n = 0; n < 100; n++) observer("ECONNREFUSED");
    for (let n = 0; n < 3; n++) observer("ETIMEDOUT");
    await step(f, WORKER_CONSTANTS.cycleIntervalMs);
    const cycle: Record<string, unknown> = JSON.parse(f.lines[f.lines.length - 1] ?? "{}");
    assert.equal(cycle.event, "cycle");
    assert.deepEqual(cycle.errors, [
      { code: "ECONNREFUSED", count: 100 },
      { code: "ETIMEDOUT", count: 3 },
    ]);
    assert.equal(cycle.errorsOther, 0);
    f.signal();
    assert.equal(await f.run, 0);
  });

  it("runtime vs startup: a runtime UNCLASSIFIED Redis outcome stays degraded with no exit", async () => {
    const f = start({ ping: async () => Promise.reject(new Error("not coded")) });
    await step(f);
    await step(f, WORKER_CONSTANTS.cycleIntervalMs);
    const shown = labels(f.lines);
    assert.ok(shown.includes("degraded redis UNCLASSIFIED"));
    assert.ok(shown.includes("cycle degraded"));
    assert.equal(f.resolved(), undefined, "never an exit");
    f.signal();
    assert.equal(await f.run, 0);
  });

  it("S-4: an unexpected rejection of the cycle function starts the shutdown and resolves 1, with the fault line", async () => {
    const f = start({ createCycle: () => () => Promise.reject(new Error("defect")) });
    assert.equal(await f.run, 1);
    assert.deepEqual(labels(f.lines).slice(-4), [
      "shutdown fault UNCLASSIFIED",
      "shutdown queue-retired",
      "shutdown database-closed",
      "shutdown exit",
    ]);
  });
});

describe("lifecycle: shutdown (PD-7; S-9) and the coordinator (Rev 4, (3))", () => {
  it("after a signal every step runs in order, with the database last", async () => {
    const f = start();
    await step(f);
    f.signal();
    assert.equal(await f.run, 0);
    assert.deepEqual(f.calls.slice(-3), ["retire queue 1", "retire probe 1", `disconnect ${WORKER_CONSTANTS.databaseDisconnectMs}`]);
  });

  it("a queue error during the retirement never prevents the database step", async () => {
    const f = start({ queueRetireThrows: true });
    await step(f);
    f.signal();
    assert.equal(await f.run, 0);
    assert.ok(f.calls.includes(`disconnect ${WORKER_CONSTANTS.databaseDisconnectMs}`));
    assert.deepEqual(labels(f.lines).slice(-2), ["shutdown database-closed", "shutdown exit"]);
  });

  it("the cycle timeout: a cycle still running after shutdownCycleMs is left, logged cycle-timeout", async () => {
    const f = start({ createCycle: () => () => new Promise<void>(() => undefined) });
    await step(f);
    f.signal();
    await step(f, WORKER_CONSTANTS.shutdownCycleMs - 1);
    assert.equal(f.resolved(), undefined);
    await step(f, 1);
    assert.equal(await f.run, 0);
    assert.deepEqual(labels(f.lines).slice(-5), [
      "shutdown signal",
      "shutdown cycle-timeout",
      "shutdown queue-retired",
      "shutdown database-closed",
      "shutdown exit",
    ]);
  });

  it("a cycle that ends within the bound is logged cycle-done", async () => {
    const cycle = deferred<void>();
    const f = start({ createCycle: () => () => cycle.promise });
    await step(f);
    f.signal();
    cycle.resolve();
    assert.equal(await f.run, 0);
    assert.ok(labels(f.lines).includes("shutdown cycle-done"));
  });

  it("double invocation: a second signal, a signal during an exit's cleanup, a cycle rejection during the wait: the same promise, no extra line, one retirement and one disconnect", async () => {
    const cycle = deferred<void>();
    const a = start({ createCycle: () => () => cycle.promise });
    await step(a);
    a.signal();
    a.signal();
    cycle.reject(new Error("defect during the wait"));
    assert.equal(await a.run, 0);
    const shownA = labels(a.lines);
    assert.equal(shownA.filter((line) => line === "shutdown signal").length, 1);
    assert.ok(!shownA.includes("shutdown fault UNCLASSIFIED"), "not a second fault");
    assert.equal(a.calls.filter((call) => call.startsWith("retire")).length, 2);
    assert.equal(a.calls.filter((call) => call.startsWith("disconnect")).length, 1);

    const held = deferred<unknown>();
    const b = start({ readiness: async () => { throw new FaultDb("x"); }, disconnect: () => held.promise });
    await step(b);
    b.signal();
    held.resolve("disconnected");
    assert.equal(await b.run, 1, "the first invocation's code");
    assert.ok(!labels(b.lines).includes("shutdown signal"));
    assert.equal(b.calls.filter((call) => call.startsWith("disconnect")).length, 1);
  });
});

describe("lifecycle: signals during startup (Rev 2, (D))", () => {
  it("before phase 1 (the fake fires at registration): no phase runs, nothing is released, exit 0", async () => {
    const f = start({ signalAtRegistration: true });
    assert.equal(await f.run, 0);
    assert.deepEqual(f.calls, ["onSignal"]);
    assert.deepEqual(labels(f.lines), ["shutdown signal", "shutdown exit"]);
  });

  it("during the readiness back-off: the timer is cleared, no retry, the database is disconnected, there is no gate", async () => {
    const f = start({ readiness: async () => { throw new TransientDb("x"); }, random: () => 0.5 });
    await step(f);
    assert.equal(f.pendingTimers(), 1);
    f.signal();
    assert.equal(await f.run, 0);
    await step(f, 60_000);
    assert.equal(f.calls.filter((call) => call === "readiness").length, 1);
    assert.equal(f.pendingTimers(), 0);
    assert.deepEqual(labels(f.lines).slice(-3), ["shutdown signal", "shutdown database-closed", "shutdown exit"]);
    assert.ok(!f.calls.includes("openQueue"));
  });

  it("during an in-flight readiness attempt that settles within the bound, and one that does not", async () => {
    const quick = deferred<ReadinessResult>();
    const a = start({ readiness: () => quick.promise });
    await step(a);
    a.signal();
    quick.resolve({ ready: true });
    assert.equal(await a.run, 0);
    assert.ok(!a.calls.includes("openQueue"), "no queue phase after the signal");
    assert.deepEqual(labels(a.lines).slice(-3), ["shutdown signal", "shutdown database-closed", "shutdown exit"]);

    const b = start({ readiness: () => new Promise<ReadinessResult>(() => undefined) });
    await step(b);
    b.signal();
    await step(b, WORKER_CONSTANTS.shutdownCycleMs - 1);
    assert.equal(b.resolved(), undefined);
    await step(b, 1);
    assert.equal(await b.run, 0);
    assert.deepEqual(labels(b.lines).slice(-3), ["shutdown signal", "shutdown database-closed", "shutdown exit"]);
  });

  it("during the queue-phase back-off, after a rollback: retireAll(), then the database", async () => {
    const f = start({ openProbeError: () => new DispatchRedisError("ECONNREFUSED"), random: () => 0.5 });
    await step(f);
    assert.ok(labels(f.lines).includes("startup queue degraded ECONNREFUSED"));
    f.signal();
    assert.equal(await f.run, 0);
    assert.deepEqual(labels(f.lines).slice(-4), ["shutdown signal", "shutdown queue-retired", "shutdown database-closed", "shutdown exit"]);
    assert.deepEqual(f.calls.slice(-2), ["retire queue 1", `disconnect ${WORKER_CONSTANTS.databaseDisconnectMs}`]);
  });
});

describe("lifecycle: late settlements after runWorker has resolved (Rev 3, (5))", () => {
  it("a readiness attempt resolved ready:true after shutdown: no queue phase, no gate, no line after exit, one disconnect", async () => {
    const late = deferred<ReadinessResult>();
    const f = start({ readiness: () => late.promise });
    await step(f);
    f.signal();
    await step(f, WORKER_CONSTANTS.shutdownCycleMs);
    assert.equal(await f.run, 0);
    const count = f.lines.length;
    late.resolve({ ready: true });
    await step(f, 60_000);
    assert.equal(f.lines.length, count);
    assert.ok(!f.calls.includes("openQueue"));
    assert.equal(f.calls.filter((call) => call.startsWith("disconnect")).length, 1);
  });

  it("the same attempt failing transiently after shutdown: no back-off timer, no retry", async () => {
    const late = deferred<ReadinessResult>();
    const f = start({ readiness: () => late.promise });
    await step(f);
    f.signal();
    await step(f, WORKER_CONSTANTS.shutdownCycleMs);
    assert.equal(await f.run, 0);
    const count = f.lines.length;
    late.reject(new TransientDb("x"));
    await step(f);
    assert.equal(f.pendingTimers(), 0);
    await step(f, 60_000);
    assert.equal(f.calls.filter((call) => call === "readiness").length, 1);
    assert.equal(f.lines.length, count);
  });

  it("a cycle held past shutdownCycleMs, then resolved: no cycle line, no new cycle, one retirement and one disconnect", async () => {
    const held = deferred<void>();
    let cycles = 0;
    const f = start({
      createCycle: (context) => async (n) => {
        cycles++;
        await held.promise;
        context.logger.cycle({
          n,
          state: "ok",
          redis: { outstanding: 0, terminal: 0, generation: 1, retiring: 0, probeConnections: 1 },
          errors: [],
          errorsOther: 0,
          durationMs: 0,
        });
      },
    });
    await step(f);
    f.signal();
    await step(f, WORKER_CONSTANTS.shutdownCycleMs);
    assert.equal(await f.run, 0);
    const count = f.lines.length;
    held.resolve();
    await step(f, 60_000);
    assert.equal(f.lines.length, count, "no line after the exit line");
    assert.equal(cycles, 1, "no new cycle");
    assert.equal(f.calls.filter((call) => call.startsWith("retire")).length, 2);
    assert.equal(f.calls.filter((call) => call.startsWith("disconnect")).length, 1);
  });

  it("the same cycle rejected after shutdown: no fault line and no second shutdown", async () => {
    const held = deferred<void>();
    const f = start({ createCycle: () => () => held.promise });
    await step(f);
    f.signal();
    await step(f, WORKER_CONSTANTS.shutdownCycleMs);
    assert.equal(await f.run, 0);
    const count = f.lines.length;
    held.reject(new Error("defect"));
    await step(f, 60_000);
    assert.equal(f.lines.length, count);
    assert.equal(f.calls.filter((call) => call.startsWith("disconnect")).length, 1);
  });
});

describe("lifecycle: probeCycle's degraded line", () => {
  function scripted(snapshots: GateSnapshot[]): { readonly context: CycleContext; readonly lines: string[] } {
    const lines: string[] = [];
    let index = 0;
    const gate: CallGate = {
      start: () => true,
      probe: async () => ({ kind: "confirmed", value: undefined }),
      getJob: async () => ({ kind: "not-started", cause: "unavailable" }),
      getJobState: async () => ({ kind: "not-started", cause: "unavailable" }),
      getJobCounts: async () => ({ kind: "not-started", cause: "unavailable" }),
      publish: async () => ({ kind: "not-started", cause: "unavailable" }),
      retireAll: () => undefined,
      snapshot: () => {
        const snap = snapshots[index++];
        assert.ok(snap !== undefined);
        return snap;
      },
      inspectRegistries: () => ({
        outstanding: new Map(),
        queues: { active: undefined, retiring: [] },
        probes: { active: undefined, retiring: [] },
        counters: { terminalQueue: 0, terminalProbe: 0, replacements: 0 },
      }),
    };
    return { context: { gate, counter: createErrorCounter(), logger: createLogger((line) => lines.push(line)), now: () => 0 }, lines };
  }
  const redis = { outstanding: 0, terminal: 0, generation: 1, retiring: 0, probeConnections: 1 };
  const ok: GateSnapshot = { state: "ok", redis };
  const degraded = (degradedCode: string): GateSnapshot => ({ state: "degraded", degradedCode, redis });
  const stuck: GateSnapshot = { state: "stuck", stuckReason: "replacement-limit", redis };

  async function run(snapshots: GateSnapshot[]): Promise<string[]> {
    const { context, lines } = scripted(snapshots);
    const cycle = probeCycle(context);
    for (let n = 1; n <= snapshots.length; n++) await cycle(n);
    return labels(lines).filter((line) => line.startsWith("degraded"));
  }

  it("ok to degraded: one line; degraded to degraded with the same code: none; a changed code: one", async () => {
    assert.deepEqual(await run([ok, degraded("PROBE_DEADLINE")]), ["degraded redis PROBE_DEADLINE"]);
    assert.deepEqual(await run([degraded("PROBE_DEADLINE"), degraded("PROBE_DEADLINE")]), ["degraded redis PROBE_DEADLINE"]);
    assert.deepEqual(await run([degraded("PROBE_DEADLINE"), degraded("QUEUE_CAPACITY")]), [
      "degraded redis PROBE_DEADLINE",
      "degraded redis QUEUE_CAPACITY",
    ]);
  });

  it("degraded, ok, degraded: two lines in all; degraded to stuck: no degraded line", async () => {
    assert.deepEqual(await run([degraded("PROBE_UNAVAILABLE"), ok, degraded("PROBE_UNAVAILABLE")]), [
      "degraded redis PROBE_UNAVAILABLE",
      "degraded redis PROBE_UNAVAILABLE",
    ]);
    assert.deepEqual(await run([degraded("ECONNREFUSED"), stuck]), ["degraded redis ECONNREFUSED"]);
  });

  it("each of the four codes reaches the line unchanged", async () => {
    for (const code of ["PROBE_DEADLINE", "QUEUE_CAPACITY", "PROBE_UNAVAILABLE", "ECONNREFUSED"]) {
      assert.deepEqual(await run([degraded(code)]), [`degraded redis ${code}`]);
    }
  });

  it("the cycle line carries the same snapshot's state", async () => {
    const { context, lines } = scripted([degraded("PROBE_DEADLINE")]);
    await probeCycle(context)(7);
    const cycle: Record<string, unknown> = JSON.parse(lines[lines.length - 1] ?? "{}");
    assert.equal(cycle.event, "cycle");
    assert.equal(cycle.n, 7);
    assert.equal(cycle.state, "degraded");
  });
});
