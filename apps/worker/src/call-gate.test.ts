import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallGate } from "./call-gate.js";
import type { CallGate, Entry, GateEvent, GateOutcome } from "./call-gate.js";
import { DispatchQueueError, DispatchRedisError } from "./dispatch-queue/index.js";
import type {
  DispatchJobCounts,
  DispatchJobRecord,
  DispatchJobState,
  DispatchProbeHandle,
  DispatchQueueHandle,
} from "./dispatch-queue/index.js";
import { WORKER_CONSTANTS } from "./worker-constants.js";

// Task 012B-3 (B2-13 as the founder amended it; FD-15, FD-19, FD-21; S-6 to
// S-8, S-12): the call gate's state machine, with fake handles, a fake clock
// and fake timers. These are unit proofs of the gate's control logic only.
// They are never transport proofs: real retirement, reconnects, head-of-line
// blocking and the probe's transport behaviour are 012B-5's (FD-18 E10).

const EVENT_ID = "0199f8a0-0000-7000-8000-000000000001";
const DEADLINE = WORKER_CONSTANTS.redisDeadlineMs;
const RECOVERY = WORKER_CONSTANTS.recoveryPeriodMs;
const WINDOW = WORKER_CONSTANTS.retireWindowMs;
const COUNTS: DispatchJobCounts = Object.freeze({
  waiting: 0,
  active: 0,
  delayed: 0,
  prioritized: 0,
  "waiting-children": 0,
  completed: 0,
  failed: 0,
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

type Mode = "auto" | "hold";

interface Fake<H> {
  readonly id: number;
  readonly handle: H;
  everReady: boolean;
  retired: number;
  readonly ops: Deferred<unknown>[];
}

interface Harness {
  readonly gate: CallGate;
  readonly queues: Fake<DispatchQueueHandle>[];
  readonly probes: Fake<DispatchProbeHandle>[];
  readonly events: GateEvent[];
  /** Every open and retire, in order. */
  readonly log: string[];
  readonly state: {
    queueMode: Mode;
    probeMode: Mode;
    queueEverReady: boolean;
    probeEverReady: boolean;
    openQueueError: Error | undefined;
    openProbeError: Error | undefined;
  };
  advance(ms: number): void;
  now(): number;
  pendingTimers(): number;
}

function harness(init: Partial<Harness["state"]> = {}): Harness {
  const state: Harness["state"] = {
    queueMode: "auto",
    probeMode: "auto",
    queueEverReady: true,
    probeEverReady: true,
    openQueueError: undefined,
    openProbeError: undefined,
    ...init,
  };
  let t = 0;
  const timers: { readonly key: object; readonly at: number; readonly callback: () => void }[] = [];
  const queues: Fake<DispatchQueueHandle>[] = [];
  const probes: Fake<DispatchProbeHandle>[] = [];
  const events: GateEvent[] = [];
  const log: string[] = [];

  const op = <T>(ops: Deferred<unknown>[], mode: Mode, value: T): Promise<T> => {
    if (mode === "auto") return Promise.resolve(value);
    const held = deferred<T>();
    ops.push(held);
    return held.promise;
  };

  const gate = createCallGate({
    openQueue: () => {
      log.push("openQueue");
      if (state.openQueueError !== undefined) throw state.openQueueError;
      const id = queues.length + 1;
      const ops: Deferred<unknown>[] = [];
      const fake: Fake<DispatchQueueHandle> = {
        id,
        everReady: state.queueEverReady,
        retired: 0,
        ops,
        handle: Object.freeze({
          close: async (): Promise<void> => undefined,
          getJob: (): Promise<DispatchJobRecord | undefined> => op(ops, state.queueMode, undefined),
          getJobState: (): Promise<DispatchJobState> => op(ops, state.queueMode, "waiting"),
          getJobCounts: (): Promise<DispatchJobCounts> => op(ops, state.queueMode, COUNTS),
          retire: () => {
            fake.retired++;
            log.push(`retire queue ${id}`);
            return Object.freeze({ everReady: fake.everReady });
          },
        }),
      };
      queues.push(fake);
      return fake.handle;
    },
    openProbe: () => {
      log.push("openProbe");
      if (state.openProbeError !== undefined) throw state.openProbeError;
      const id = probes.length + 1;
      const ops: Deferred<unknown>[] = [];
      const fake: Fake<DispatchProbeHandle> = {
        id,
        everReady: state.probeEverReady,
        retired: 0,
        ops,
        handle: Object.freeze({
          close: async (): Promise<void> => undefined,
          ping: (): Promise<void> => op(ops, state.probeMode, undefined),
          retire: () => {
            fake.retired++;
            log.push(`retire probe ${id}`);
            return Object.freeze({ everReady: fake.everReady });
          },
        }),
      };
      probes.push(fake);
      return fake.handle;
    },
    publishWith: (handle, eventId) => {
      const fake = queues.find((candidate) => candidate.handle === handle);
      if (fake === undefined) return Promise.reject(new Error("not a fake handle"));
      return op(fake.ops, state.queueMode, eventId);
    },
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
    onEvent: (event) => events.push(event),
    constants: WORKER_CONSTANTS,
  });

  return {
    gate,
    queues,
    probes,
    events,
    log,
    state,
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
    now: () => t,
    pendingTimers: () => timers.length,
  };
}

/** Lets promise reactions run. */
async function flush(): Promise<void> {
  for (let n = 0; n < 4; n++) await new Promise((resolve) => setImmediate(resolve));
}

function lastOp<H>(fake: Fake<H> | undefined): Deferred<unknown> {
  const held = fake?.ops[fake.ops.length - 1];
  assert.ok(held !== undefined, "a held operation");
  return held;
}

/** Live handles per kind, from the registries: active plus retiring. */
function live(h: Harness): { queue: number; probe: number; retiringProbes: number } {
  const registries = h.gate.inspectRegistries();
  return {
    queue: (registries.queues.active === undefined ? 0 : 1) + registries.queues.retiring.length,
    probe: (registries.probes.active === undefined ? 0 : 1) + registries.probes.retiring.length,
    retiringProbes: registries.probes.retiring.length,
  };
}

function assertCeilings(h: Harness): void {
  const now = live(h);
  assert.ok(now.queue <= 2, "I-Q: at most 2 live queue generations");
  assert.ok(now.probe <= 2, "I-P: at most 2 live probe connections");
  assert.ok(now.retiringProbes <= 1, "I-P: never 2 retiring probe connections");
}

function started(h: Harness): Harness {
  assert.equal(h.gate.start(), true);
  return h;
}

/** Holds `count` normal operations on the active queue generation. */
function holdNormal(h: Harness, count: number): Promise<GateOutcome<unknown>>[] {
  const previous = h.state.queueMode;
  h.state.queueMode = "hold";
  const calls: Promise<GateOutcome<unknown>>[] = [];
  for (let n = 0; n < count; n++) calls.push(h.gate.getJob(EVENT_ID));
  h.state.queueMode = previous;
  return calls;
}

/** Every object reachable from `root` through own properties, arrays and Map entries. */
function reaches(root: unknown, target: unknown, seen: Set<unknown> = new Set()): boolean {
  if (root === target) return true;
  if (typeof root !== "object" || root === null || seen.has(root)) return false;
  seen.add(root);
  if (root instanceof Map) {
    for (const [key, value] of root) if (reaches(key, target, seen) || reaches(value, target, seen)) return true;
    return false;
  }
  for (const key of Reflect.ownKeys(root)) {
    if (reaches(Object.getOwnPropertyDescriptor(root, key)?.value, target, seen)) return true;
  }
  return false;
}

describe("call gate: start() and the partial-start rollback (Rev 2, (B))", () => {
  it("openQueue succeeds, openProbe throws a DispatchQueueError: the queue is retired before the throw, kept as retiring, swept later", () => {
    const h = harness({ openProbeError: new DispatchQueueError("settings", "host is malformed") });
    assert.throws(() => h.gate.start(), (error: unknown) => error instanceof DispatchQueueError);
    assert.deepEqual(h.log, ["openQueue", "openProbe", "retire queue 1"]);
    assert.equal(h.queues[0]?.retired, 1);
    const registries = h.gate.inspectRegistries();
    assert.equal(registries.queues.active, undefined);
    assert.equal(registries.queues.retiring.length, 1);
    h.advance(WINDOW);
    h.gate.snapshot();
    assert.equal(h.gate.inspectRegistries().queues.retiring.length, 0);
  });

  it("the same with a DispatchRedisError: start() returns false until the sweep, then true; never more than 1 active + 1 retiring", () => {
    const h = harness({ openProbeError: new DispatchRedisError("ECONNREFUSED") });
    assert.throws(() => h.gate.start(), (error: unknown) => error instanceof DispatchRedisError);
    h.state.openProbeError = undefined;
    assert.equal(h.gate.start(), false, "the queue is blocked by its retiring record");
    assertCeilings(h);
    assert.equal(h.queues.length, 1, "no second queue open while one is retiring");
    h.advance(WINDOW - 1);
    assert.equal(h.gate.start(), false);
    h.advance(1);
    assert.equal(h.gate.start(), true);
    assertCeilings(h);
    assert.deepEqual(h.log, ["openQueue", "openProbe", "retire queue 1", "openProbe", "openQueue"]);
  });

  it("a second start() opens nothing more", () => {
    const h = started(harness());
    assert.equal(h.gate.start(), true);
    assert.deepEqual(h.log, ["openQueue", "openProbe"]);
  });
});

describe("call gate: snapshot() and its precedence (Rev 3, (4); Rev 4, (2))", () => {
  it("the review's sequence: a retiring queue, a probe-only start, a confirmed probe: degraded PROBE_UNAVAILABLE, never ok, until both resources exist", async () => {
    const h = harness({ openProbeError: new DispatchRedisError("ECONNREFUSED") });
    assert.throws(() => h.gate.start());
    h.state.openProbeError = undefined;
    assert.equal(h.gate.start(), false, "start() opens the probe connection but not the queue");
    assert.equal((await h.gate.probe()).kind, "confirmed");
    assert.deepEqual(h.gate.snapshot().state, "degraded");
    assert.equal(h.gate.snapshot().degradedCode, "PROBE_UNAVAILABLE");
    h.advance(WINDOW);
    assert.equal(h.gate.start(), true);
    assert.equal((await h.gate.probe()).kind, "confirmed");
    assert.deepEqual(h.gate.snapshot(), {
      state: "ok",
      redis: { outstanding: 0, terminal: 0, generation: 2, retiring: 0, probeConnections: 1 },
    });
  });

  it("each rule alone: no probe outcome yet, closed, no probe connection, a pending replacement: PROBE_UNAVAILABLE", async () => {
    const fresh = started(harness());
    assert.equal(fresh.gate.snapshot().degradedCode, "PROBE_UNAVAILABLE", "no latest probe outcome yet");
    const closed = started(harness());
    await closed.gate.probe();
    closed.gate.retireAll();
    assert.equal(closed.gate.snapshot().degradedCode, "PROBE_UNAVAILABLE");
    const noProbe = harness({ openProbeError: new DispatchRedisError("ECONNREFUSED") });
    assert.throws(() => noProbe.gate.start());
    assert.equal(noProbe.gate.snapshot().degradedCode, "PROBE_UNAVAILABLE");
  });

  it("each rule alone: deadline, error code (normalized), capacity, ok", async () => {
    const deadline = started(harness({ probeMode: "hold", probeEverReady: false }));
    const pending = deadline.gate.probe();
    deadline.advance(DEADLINE);
    assert.deepEqual(await pending, { kind: "unconfirmed", cause: "deadline" });
    assert.equal(deadline.gate.snapshot().degradedCode, "PROBE_DEADLINE");

    const error = started(harness({ probeMode: "hold" }));
    const failing = error.gate.probe();
    lastOp(error.probes[0]).reject(new DispatchRedisError("ECONNREFUSED"));
    assert.deepEqual(await failing, { kind: "unconfirmed", cause: "error", code: "ECONNREFUSED" });
    assert.equal(error.gate.snapshot().degradedCode, "ECONNREFUSED");

    const unclassified = started(harness({ probeMode: "hold" }));
    const odd = unclassified.gate.probe();
    lastOp(unclassified.probes[0]).reject(new Error("not coded"));
    assert.deepEqual(await odd, { kind: "unconfirmed", cause: "error", code: "UNCLASSIFIED" });
    assert.equal(unclassified.gate.snapshot().degradedCode, "UNCLASSIFIED");

    const capacity = started(harness());
    await capacity.gate.probe();
    holdNormal(capacity, 15);
    assert.equal(capacity.gate.snapshot().degradedCode, "QUEUE_CAPACITY");

    const ok = started(harness());
    await ok.gate.probe();
    assert.equal(ok.gate.snapshot().state, "ok");
  });

  it("each adjacent pair: the higher rule wins", async () => {
    // stuck with no probe connection: stuck.
    const stuck = started(harness());
    await stuck.gate.probe();
    holdNormal(stuck, 1);
    stuck.advance(RECOVERY);
    stuck.state.openQueueError = new Error("cannot open");
    await stuck.gate.probe();
    stuck.gate.retireAll();
    assert.equal(stuck.gate.inspectRegistries().probes.active, undefined, "no probe connection");
    assert.equal(stuck.gate.snapshot().state, "stuck");
    // unavailable with a deadline outcome: PROBE_UNAVAILABLE.
    const unavailable = started(harness({ probeMode: "hold", probeEverReady: false }));
    const pending = unavailable.gate.probe();
    unavailable.advance(DEADLINE);
    await pending;
    unavailable.gate.retireAll();
    assert.equal(unavailable.gate.snapshot().degradedCode, "PROBE_UNAVAILABLE");
    // a deadline with the cap full: PROBE_DEADLINE.
    const deadline = started(harness({ probeMode: "hold", probeEverReady: false }));
    holdNormal(deadline, 15);
    const late = deadline.gate.probe();
    deadline.advance(DEADLINE);
    await late;
    assert.equal(deadline.gate.snapshot().degradedCode, "PROBE_DEADLINE");
    // an error code with the cap full: the code.
    const error = started(harness({ probeMode: "hold" }));
    holdNormal(error, 15);
    const failing = error.gate.probe();
    lastOp(error.probes[0]).reject(new DispatchRedisError("OFFLINE"));
    await failing;
    assert.equal(error.gate.snapshot().degradedCode, "OFFLINE");
  });

  it("degradedCode and stuckReason are present only in their states (own keys)", async () => {
    const ok = started(harness());
    await ok.gate.probe();
    assert.deepEqual(Reflect.ownKeys(ok.gate.snapshot()).sort(), ["redis", "state"]);
    const degraded = started(harness());
    assert.deepEqual(Reflect.ownKeys(degraded.gate.snapshot()).sort(), ["degradedCode", "redis", "state"]);
    const stuck = started(harness());
    await stuck.gate.probe();
    holdNormal(stuck, 1);
    stuck.advance(RECOVERY);
    stuck.state.openQueueError = new Error("cannot open");
    await stuck.gate.probe();
    const snap = stuck.gate.snapshot();
    assert.deepEqual(Reflect.ownKeys(snap).sort(), ["redis", "state", "stuckReason"]);
    assert.equal(snap.stuckReason, "open-failed");
    assert.ok(Object.isFrozen(snap));
  });

  it("snapshot().redis: O, the terminal counters, the active generation, retiring generations, probe connections", async () => {
    const h = started(harness({ queueEverReady: false }));
    holdNormal(h, 2);
    h.gate.retireAll();
    assert.deepEqual(h.gate.snapshot().redis, { outstanding: 0, terminal: 2, generation: 0, retiring: 1, probeConnections: 1 });
  });
});

describe("call gate: the outcomes (S-6) and the settlement rules", () => {
  it("a fulfilment before the deadline on the active generation is confirmed with its value", async () => {
    const h = started(harness());
    assert.deepEqual(await h.gate.getJobState(EVENT_ID), { kind: "confirmed", value: "waiting" });
    assert.deepEqual(await h.gate.publish(EVENT_ID, { eventId: EVENT_ID }), { kind: "confirmed", value: EVENT_ID });
    assert.equal(h.gate.snapshot().redis.outstanding, 0);
  });

  it("a DispatchRedisError is unconfirmed with its code; anything else is UNCLASSIFIED; a DispatchQueueError rejects the caller", async () => {
    const h = started(harness({ queueMode: "hold" }));
    const coded = h.gate.getJob(EVENT_ID);
    lastOp(h.queues[0]).reject(new DispatchRedisError("COMMAND_TIMEOUT"));
    assert.deepEqual(await coded, { kind: "unconfirmed", cause: "error", code: "COMMAND_TIMEOUT" });
    const other = h.gate.getJob(EVENT_ID);
    lastOp(h.queues[0]).reject(new TypeError("raw"));
    assert.deepEqual(await other, { kind: "unconfirmed", cause: "error", code: "UNCLASSIFIED" });
    const refused = h.gate.getJob(EVENT_ID);
    lastOp(h.queues[0]).reject(new DispatchQueueError("event-id", "the event id must be a lower-case UUID"));
    await assert.rejects(refused, (error: unknown) => error instanceof DispatchQueueError);
    assert.equal(h.gate.snapshot().redis.outstanding, 0, "every settled slot is released");
  });

  it("with no active queue generation a normal call starts nothing (unavailable); in stuck, stuck (Rev 4)", async () => {
    const h = harness({ openProbeError: new DispatchRedisError("ECONNREFUSED") });
    assert.throws(() => h.gate.start());
    assert.deepEqual(await h.gate.getJob(EVENT_ID), { kind: "not-started", cause: "unavailable" });
    const stuck = started(harness());
    await stuck.gate.probe();
    holdNormal(stuck, 1);
    stuck.advance(RECOVERY);
    stuck.state.openQueueError = new Error("cannot open");
    await stuck.gate.probe();
    assert.deepEqual(await stuck.gate.getJob(EVENT_ID), { kind: "not-started", cause: "stuck" });
    assert.deepEqual(await stuck.gate.probe(), { kind: "not-started", cause: "stuck" });
  });
});

describe("call gate: B2-13's required tests (unit, 012B-3; the state machine only)", () => {
  it("deadline expiry: the caller is answered unconfirmed/deadline; the entry stays in O", async () => {
    const h = started(harness());
    const [call] = holdNormal(h, 1);
    h.advance(DEADLINE - 1);
    await flush();
    assert.equal(h.gate.snapshot().redis.outstanding, 1);
    h.advance(1);
    assert.deepEqual(await call, { kind: "unconfirmed", cause: "deadline" });
    assert.equal(h.gate.snapshot().redis.outstanding, 1, "a deadline never frees a slot");
  });

  it("operations settling late: the late settlement releases the slot and changes no answer", async () => {
    const h = started(harness());
    const [call] = holdNormal(h, 1);
    h.advance(DEADLINE);
    assert.deepEqual(await call, { kind: "unconfirmed", cause: "deadline" });
    lastOp(h.queues[0]).resolve(undefined);
    await flush();
    assert.equal(h.gate.snapshot().redis.outstanding, 0);
  });

  it("ignored late success: after the deadline, and before it but after its generation was retired: never confirmed", async () => {
    const h = started(harness());
    const [late] = holdNormal(h, 1);
    h.advance(DEADLINE);
    lastOp(h.queues[0]).resolve(undefined);
    assert.deepEqual(await late, { kind: "unconfirmed", cause: "deadline" });

    const r = started(harness());
    const [retired] = holdNormal(r, 1);
    r.gate.retireAll();
    lastOp(r.queues[0]).resolve(undefined);
    assert.deepEqual(await retired, { kind: "unconfirmed", cause: "retired" });
  });

  it("single-flight probe: a second probe while one is held is in-flight, even after the first one's deadline", async () => {
    const h = started(harness({ probeMode: "hold" }));
    const first = h.gate.probe();
    assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "in-flight" });
    h.advance(DEADLINE);
    assert.deepEqual(await first, { kind: "unconfirmed", cause: "deadline" });
    assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "in-flight" });
  });

  it("the cap of 16 with one reserved slot: the 16th normal call gets capacity while 15 are held; a probe still starts", async () => {
    const h = started(harness());
    holdNormal(h, 15);
    assert.deepEqual(await h.gate.getJob(EVENT_ID), { kind: "not-started", cause: "capacity" });
    assert.deepEqual(await h.gate.probe(), { kind: "confirmed", value: undefined });
    assert.equal(h.gate.snapshot().redis.outstanding, 15);
  });

  it("recovery with a held old operation, and replacement with generation tagging (state machine only)", async () => {
    const h = started(harness());
    const [old] = holdNormal(h, 1);
    h.advance(RECOVERY);
    assert.deepEqual(await old, { kind: "unconfirmed", cause: "deadline" });
    assert.deepEqual(await h.gate.probe(), { kind: "confirmed", value: undefined });
    assert.deepEqual(h.log, ["openQueue", "openProbe", "retire queue 1", "openQueue"]);
    assert.deepEqual(h.events, [{ event: "recovery", action: "replace-generation", generation: 2 }]);
    assert.equal(h.gate.snapshot().redis.generation, 2);
    // A new operation goes to generation 2; the held old one still counts until it settles.
    holdNormal(h, 1);
    assert.equal(h.queues[1]?.ops.length, 1);
    assert.equal(h.gate.snapshot().redis.outstanding, 2);
    lastOp(h.queues[0]).resolve(undefined);
    await flush();
    assert.equal(h.gate.snapshot().redis.outstanding, 1);
  });

  it("replacement failure: openQueue throws: stuck open-failed", async () => {
    const h = started(harness());
    holdNormal(h, 1);
    h.advance(RECOVERY);
    h.state.openQueueError = new Error("cannot open");
    await h.gate.probe();
    assert.deepEqual(h.events, [{ event: "stuck", reason: "open-failed" }]);
    assert.equal(h.gate.snapshot().stuckReason, "open-failed");
  });

  it("persistent stuck: no later success leaves it", async () => {
    const h = started(harness());
    holdNormal(h, 1);
    h.advance(RECOVERY);
    h.state.openQueueError = new Error("cannot open");
    await h.gate.probe();
    h.state.openQueueError = undefined;
    lastOp(h.queues[0]).resolve(undefined);
    await flush();
    h.advance(10 * RECOVERY);
    assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "stuck" });
    assert.equal(h.gate.start(), false);
    assert.equal(h.gate.snapshot().state, "stuck");
  });

  it("terminal accounting only for everReady false; an ever-ready generation keeps counting", () => {
    const never = started(harness({ queueEverReady: false }));
    holdNormal(never, 3);
    never.gate.retireAll();
    assert.deepEqual(never.gate.snapshot().redis.outstanding, 0);
    assert.deepEqual(never.gate.inspectRegistries().counters.terminalQueue, 3);

    const ever = started(harness({ queueEverReady: true }));
    holdNormal(ever, 3);
    ever.gate.retireAll();
    assert.deepEqual(ever.gate.snapshot().redis.outstanding, 3);
    assert.deepEqual(ever.gate.inspectRegistries().counters.terminalQueue, 0);
  });

  it("the registries hold no handle after retirement", () => {
    const h = started(harness());
    holdNormal(h, 1);
    const queueHandle = h.queues[0]?.handle;
    const probeHandle = h.probes[0]?.handle;
    h.gate.retireAll();
    const registries = h.gate.inspectRegistries();
    assert.equal(reaches(registries, queueHandle), false);
    assert.equal(reaches(registries, probeHandle), false);
  });
});

describe("call gate: retireAll() (shutdown)", () => {
  it("retires each active handle exactly once, closes the gate, and is idempotent", async () => {
    const h = started(harness());
    h.gate.retireAll();
    h.gate.retireAll();
    assert.equal(h.queues[0]?.retired, 1);
    assert.equal(h.probes[0]?.retired, 1);
    assert.deepEqual(await h.gate.getJob(EVENT_ID), { kind: "not-started", cause: "unavailable" });
    assert.deepEqual(await h.gate.getJobCounts(), { kind: "not-started", cause: "unavailable" });
    assert.deepEqual(await h.gate.publish(EVENT_ID, { eventId: EVENT_ID }), { kind: "not-started", cause: "unavailable" });
    assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "unavailable" });
    h.advance(WINDOW);
    assert.equal(h.gate.start(), false);
    assert.deepEqual(h.log, ["openQueue", "openProbe", "retire queue 1", "retire probe 1"]);
  });

  it("discards a pending probe replacement", async () => {
    const h = started(harness({ probeMode: "hold", probeEverReady: false }));
    const first = h.gate.probe();
    h.advance(DEADLINE);
    await first;
    const second = h.gate.probe();
    h.advance(DEADLINE);
    await second;
    h.gate.retireAll();
    h.advance(WINDOW);
    h.gate.snapshot();
    assert.equal(h.probes.length, 2, "the pending replacement never opens a third probe connection");
  });
});

describe("call gate: the invariants (FD-21), each shown unable to be exceeded", () => {
  it("I-Q: a replacement required while a queue generation is retiring gives stuck queue-ceiling, with no third open", async () => {
    const h = started(harness({ queueEverReady: true }));
    holdNormal(h, 1);
    h.advance(RECOVERY);
    await h.gate.probe();
    assertCeilings(h);
    assert.equal(h.queues.length, 2);
    holdNormal(h, 1);
    h.advance(RECOVERY);
    assertCeilings(h);
    await h.gate.probe();
    assertCeilings(h);
    assert.equal(h.queues.length, 2, "no third open");
    assert.equal(h.gate.snapshot().stuckReason, "queue-ceiling");
  });

  it("I-P: a replacement while one probe connection is retiring is deferred, stays pending across probes and clock advances, then is done exactly once", async () => {
    const h = started(harness({ probeMode: "hold", probeEverReady: false }));
    const first = h.gate.probe();
    h.advance(DEADLINE);
    await first;
    assert.equal(h.probes.length, 2, "an immediate replacement: 1 active + 1 retiring");
    const second = h.gate.probe();
    h.advance(DEADLINE);
    await second;
    assert.equal(h.probes.length, 2, "deferred: no open while one is retiring");
    lastOp(h.probes[1]).resolve(undefined);
    await flush();
    for (let n = 0; n < 3; n++) {
      assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "unavailable" }, "no probe while the replacement is pending");
      assert.equal(h.gate.snapshot().degradedCode, "PROBE_UNAVAILABLE");
      h.advance(500);
      assertCeilings(h);
      assert.equal(h.probes.length, 2);
    }
    h.advance(WINDOW);
    h.gate.snapshot();
    assert.equal(h.probes.length, 3, "done once the sweep removes the retiring record");
    h.gate.snapshot();
    h.advance(WINDOW);
    h.gate.snapshot();
    assert.equal(h.probes.length, 3, "exactly once");
    assertCeilings(h);
    assert.deepEqual(
      h.events.filter((event) => event.event === "recovery").map((event) => (event.event === "recovery" ? event.action : "")),
      ["replace-probe", "replace-probe"],
    );
  });

  it("I-P (F-PROBE-CEILING-UNREACHABLE, public API): a retiring ever-ready probe connection holding an entry blocks every probe, so no replacement is requested", async () => {
    const h = started(harness({ probeMode: "hold", probeEverReady: true }));
    const first = h.gate.probe();
    h.advance(DEADLINE);
    await first;
    assert.equal(h.probes.length, 2);
    for (let n = 0; n < 4; n++) {
      assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "in-flight" });
      h.advance(WINDOW);
      assertCeilings(h);
    }
    assert.equal(h.probes.length, 2, "no replacement is requested and no open happens");
    assert.notEqual(h.gate.snapshot().state, "stuck");
  });

  it("I-P (F-PROBE-CEILING-UNREACHABLE, PLANTED STATE): an entry planted for the retiring record while a replacement is pending gives stuck probe-ceiling past the window", async () => {
    const h = started(harness({ probeMode: "hold", probeEverReady: false }));
    const first = h.gate.probe();
    h.advance(DEADLINE);
    await first;
    const second = h.gate.probe();
    h.advance(DEADLINE);
    await second;
    const registries = h.gate.inspectRegistries();
    const record = registries.probes.retiring[0];
    assert.ok(record !== undefined);
    // PLANTED: the public API cannot produce this state (see the test above).
    const planted: Entry = { generationId: record.id, kind: "probe", startedAt: h.now() };
    Reflect.apply(Map.prototype.set, registries.outstanding, [999_999, planted]);
    h.advance(WINDOW);
    assert.equal(h.gate.snapshot().stuckReason, "probe-ceiling");
    assert.deepEqual(h.events[h.events.length - 1], { event: "stuck", reason: "probe-ceiling" });
    assert.equal(h.probes.length, 2);
  });

  it("I-P: a probe connection never enters the queue registry", () => {
    const h = started(harness());
    const registries = h.gate.inspectRegistries();
    assert.equal(registries.queues.active?.handle, h.queues[0]?.handle);
    assert.notEqual(registries.queues.active?.handle, h.probes[0]?.handle);
    assert.equal(reaches(registries.queues, h.probes[0]?.handle), false);
    assert.equal(reaches(registries.probes, h.queues[0]?.handle), false);
  });

  it("I-O: a deadline does not free a slot; an ever-ready retirement does not; settlement and a never-ready retirement do", async () => {
    const h = started(harness({ queueEverReady: true }));
    holdNormal(h, 15);
    h.advance(DEADLINE);
    await flush();
    assert.deepEqual(await h.gate.getJob(EVENT_ID), { kind: "not-started", cause: "capacity" });
    lastOp(h.queues[0]).resolve(undefined);
    await flush();
    assert.equal(h.gate.snapshot().redis.outstanding, 14, "settlement frees one slot");

    const ever = started(harness({ queueEverReady: true }));
    holdNormal(ever, 15);
    ever.gate.retireAll();
    assert.equal(ever.gate.snapshot().redis.outstanding, 15, "an ever-ready retirement frees nothing");

    const never = started(harness({ queueEverReady: false }));
    holdNormal(never, 15);
    never.gate.retireAll();
    assert.equal(never.gate.snapshot().redis.outstanding, 0, "a never-ready retirement terminal-accounts its entries");
  });

  it("I-O and S-12, gate level: a never-ready probe connection's held probe is terminal-accounted at its replacement; the new connection's probe starts; a third is in-flight; the old release changes nothing", async () => {
    const h = started(harness({ probeMode: "hold", probeEverReady: false }));
    const old = h.gate.probe();
    h.advance(DEADLINE);
    assert.deepEqual(await old, { kind: "unconfirmed", cause: "deadline" });
    assert.equal(h.gate.inspectRegistries().counters.terminalProbe, 1);
    const fresh = h.gate.probe();
    await flush();
    assert.equal(h.probes[1]?.ops.length, 1, "the new probe runs on the new connection");
    assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "in-flight" });
    const before = h.gate.snapshot();
    lastOp(h.probes[0]).resolve(undefined);
    await flush();
    assert.deepEqual(h.gate.snapshot(), before, "no entry, no outcome");
    lastOp(h.probes[1]).resolve(undefined);
    assert.equal((await fresh).kind, "confirmed");
  });

  it("I-O and S-12, the ever-ready counterpart: the new probe is in-flight until the old call settles", async () => {
    const h = started(harness({ probeMode: "hold", probeEverReady: true }));
    const old = h.gate.probe();
    h.advance(DEADLINE);
    await old;
    assert.equal(h.gate.inspectRegistries().counters.terminalProbe, 0);
    assert.deepEqual(await h.gate.probe(), { kind: "not-started", cause: "in-flight" });
    lastOp(h.probes[0]).resolve(undefined);
    await flush();
    h.state.probeMode = "auto";
    assert.equal((await h.gate.probe()).kind, "confirmed");
  });

  it("I-E: the flag comes only from retire()'s return value; the gate has no other source", () => {
    const h = started(harness({ queueEverReady: true }));
    holdNormal(h, 2);
    const fake = h.queues[0];
    assert.ok(fake !== undefined);
    fake.everReady = false;
    h.gate.retireAll();
    assert.equal(h.gate.inspectRegistries().counters.terminalQueue, 2, "the gate followed retire()'s report");
    assert.equal(h.gate.inspectRegistries().queues.retiring[0]?.everReady, false);
  });

  it("I-S: the retirement step's effects are visible synchronously; the gate has no listener API", () => {
    const h = started(harness({ queueEverReady: false }));
    holdNormal(h, 1);
    h.gate.retireAll();
    // Asserted before any await.
    const registries = h.gate.inspectRegistries();
    assert.equal(registries.queues.active, undefined);
    assert.equal(registries.queues.retiring.length, 1);
    assert.equal(registries.counters.terminalQueue, 1);
    assert.equal(registries.outstanding.size, 0);
    assert.deepEqual(Object.keys(h.gate).sort(), [
      "getJob",
      "getJobCounts",
      "getJobState",
      "inspectRegistries",
      "probe",
      "publish",
      "retireAll",
      "snapshot",
      "start",
    ]);
  });

  it("I-R: after a retirement, a deep traversal of the registries finds no reference to the retired handle; records are plain data", async () => {
    const h = started(harness({ queueEverReady: true }));
    holdNormal(h, 1);
    h.advance(RECOVERY);
    await h.gate.probe();
    const retired = h.queues[0]?.handle;
    assert.ok(retired !== undefined);
    const registries = h.gate.inspectRegistries();
    assert.equal(reaches(registries, retired), false);
    for (const record of registries.queues.retiring) {
      assert.deepEqual(Object.keys(record).sort(), ["everReady", "id", "kind", "retiredAt", "unresolvedCount"]);
      assert.ok(Object.values(record).every((value) => typeof value !== "object" && typeof value !== "function"));
    }
  });

  it("I-K: three replacements without confirmed recovery, then a fourth required: stuck replacement-limit", async () => {
    const h = started(harness({ queueEverReady: false }));
    for (let n = 1; n <= 3; n++) {
      holdNormal(h, 1);
      h.advance(RECOVERY);
      await h.gate.probe();
      assert.equal(h.gate.inspectRegistries().counters.replacements, n);
      assertCeilings(h);
    }
    holdNormal(h, 1);
    h.advance(RECOVERY);
    await h.gate.probe();
    assert.equal(h.gate.snapshot().stuckReason, "replacement-limit");
    assert.equal(h.queues.length, 4, "no fifth open");
  });

  it("I-K: confirmed recovery after two replacements resets the counter; a probe with an aged active entry is not a confirmed recovery", async () => {
    const h = started(harness({ queueEverReady: false }));
    for (let n = 1; n <= 2; n++) {
      holdNormal(h, 1);
      h.advance(RECOVERY);
      await h.gate.probe();
    }
    assert.equal(h.gate.inspectRegistries().counters.replacements, 2);
    await h.gate.probe();
    assert.equal(h.gate.inspectRegistries().counters.replacements, 0, "a confirmed recovery resets the counter");
    assert.deepEqual(h.events[h.events.length - 1], { event: "recovery", action: "confirmed", generation: 3 });

    const aged = started(harness({ queueEverReady: false }));
    holdNormal(aged, 1);
    aged.advance(RECOVERY);
    await aged.gate.probe();
    assert.equal(aged.gate.inspectRegistries().counters.replacements, 1);
    holdNormal(aged, 1);
    aged.advance(RECOVERY);
    await aged.gate.probe();
    assert.equal(aged.gate.inspectRegistries().counters.replacements, 2, "a probe with an aged active entry is not a confirmed recovery");
    assert.ok(!aged.events.some((event) => event.event === "recovery" && event.action === "confirmed"));
  });

  it("I-K and S-7's order: a triggering probe increments without a reset; the next qualifying probe resets to 0 and emits confirmed", async () => {
    const h = started(harness({ queueEverReady: false }));
    holdNormal(h, 1);
    h.advance(RECOVERY);
    await h.gate.probe();
    assert.equal(h.gate.inspectRegistries().counters.replacements, 1, "0 becomes 1, although the new generation has no aged entry");
    assert.ok(!h.events.some((event) => event.event === "recovery" && event.action === "confirmed"));
    await h.gate.probe();
    assert.equal(h.gate.inspectRegistries().counters.replacements, 0);
    assert.deepEqual(h.events[h.events.length - 1], { event: "recovery", action: "confirmed", generation: 2 });
  });

  it("I-K and S-7's order: three back-to-back triggering probes give 1, 2, 3, then stuck, with no reset between them", async () => {
    const h = started(harness({ queueEverReady: false }));
    const seen: number[] = [];
    for (let n = 0; n < 4; n++) {
      holdNormal(h, 1);
      h.advance(RECOVERY);
      await h.gate.probe();
      if (h.gate.snapshot().state !== "stuck") seen.push(h.gate.inspectRegistries().counters.replacements);
    }
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(h.gate.snapshot().stuckReason, "replacement-limit");
    assert.ok(!h.events.some((event) => event.event === "recovery" && event.action === "confirmed"));
  });
});

describe("call gate: the probe's replacement triggers (S-7, S-8)", () => {
  it("a COMMAND_TIMEOUT failure replaces the probe connection; a fast failure (OFFLINE, ECONNREFUSED) does not", async () => {
    const h = started(harness({ probeMode: "hold" }));
    for (const code of ["OFFLINE", "ECONNREFUSED"]) {
      const fast = h.gate.probe();
      lastOp(h.probes[0]).reject(new DispatchRedisError(code));
      await fast;
      assert.equal(h.probes.length, 1, `${code} leaves the connection to the client's own reconnect`);
    }
    const slow = h.gate.probe();
    lastOp(h.probes[0]).reject(new DispatchRedisError("COMMAND_TIMEOUT"));
    await slow;
    assert.equal(h.probes.length, 2);
    assert.deepEqual(h.events, [{ event: "recovery", action: "replace-probe", generation: 2 }]);
  });

  it("an openProbe() throw during a replacement: stuck open-failed", async () => {
    const h = started(harness({ probeMode: "hold" }));
    const pending = h.gate.probe();
    h.state.openProbeError = new Error("cannot open");
    h.advance(DEADLINE);
    await pending;
    assert.equal(h.gate.snapshot().stuckReason, "open-failed");
  });

  it("a deadline timer is cleared when its call settles first", async () => {
    const h = started(harness());
    await h.gate.getJob(EVENT_ID);
    await h.gate.probe();
    assert.equal(h.pendingTimers(), 0);
  });
});
