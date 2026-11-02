import { DispatchQueueError, DispatchRedisError } from "./dispatch-queue/index.js";
import type {
  DispatchJobCounts,
  DispatchJobData,
  DispatchJobRecord,
  DispatchJobState,
  DispatchProbeHandle,
  DispatchQueueHandle,
} from "./dispatch-queue/index.js";
import { REDIS_CODE_PATTERN } from "./logger.js";
import { GATE_CEILINGS } from "./worker-constants.js";
import type { WorkerConstants } from "./worker-constants.js";

// The Redis call gate (Task 012B-3; B2-13 as the founder amended it; FD-15,
// FD-19, FD-21; run 2 §5.4; S-6 to S-8, S-12). It wraps the queue and probe
// handles; it never receives a library object and never subscribes to a
// library event, so no gate decision runs inside a library listener or a
// process.nextTick (I-S). Every value here is provisional under O-013.
//
// Accounting (B2-13, FD-15(b)): every operation counts in O from its start
// until it settles. A deadline answers the caller, never frees the slot.
// Retiring an ever-ready generation answers its callers `retired` but its
// entries keep counting until they settle. Only for a generation that never
// reached ready (a lifetime fact, from the module's retire()) are its entries
// moved to a terminal counter: a gate-level terminal accounting state
// following the forced cancellation of a never-ready generation, never a
// claim that the underlying promise settled.

export type GateOutcome<T> =
  | { readonly kind: "confirmed"; readonly value: T }
  | { readonly kind: "unconfirmed"; readonly cause: "deadline" | "retired" | "error"; readonly code?: string }
  | { readonly kind: "not-started"; readonly cause: "capacity" | "stuck" | "unavailable" | "in-flight" };

export type StuckReason = "queue-ceiling" | "probe-ceiling" | "replacement-limit" | "open-failed";

export type GateEvent =
  | { readonly event: "recovery"; readonly action: "replace-generation" | "replace-probe" | "confirmed"; readonly generation: number }
  | { readonly event: "stuck"; readonly reason: StuckReason };

export interface GateSnapshot {
  readonly state: "ok" | "degraded" | "stuck";
  readonly degradedCode?: string;
  readonly stuckReason?: StuckReason;
  readonly redis: {
    readonly outstanding: number;
    readonly terminal: number;
    readonly generation: number;
    readonly retiring: number;
    readonly probeConnections: number;
  };
}

export interface CallGateOptions {
  readonly openQueue: () => DispatchQueueHandle;
  readonly openProbe: () => DispatchProbeHandle;
  /** publishDispatchJob in production; injected because a fake handle is not the module's. */
  readonly publishWith: (handle: DispatchQueueHandle, eventId: string, data: DispatchJobData) => Promise<string>;
  /** A monotonic clock (ms). */
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (ref: unknown) => void;
  /** Plain-data recovery and stuck events, for the logger. */
  readonly onEvent: (event: GateEvent) => void;
  readonly constants: Pick<WorkerConstants, "redisDeadlineMs" | "recoveryPeriodMs" | "retireWindowMs">;
}

export interface CallGate {
  /** Opens each kind that has no active handle and no retiring record; true when both kinds are active. */
  start(): boolean;
  probe(): Promise<GateOutcome<void>>;
  getJob(jobId: string): Promise<GateOutcome<DispatchJobRecord | undefined>>;
  getJobState(jobId: string): Promise<GateOutcome<DispatchJobState>>;
  getJobCounts(): Promise<GateOutcome<DispatchJobCounts>>;
  publish(eventId: string, data: DispatchJobData): Promise<GateOutcome<string>>;
  /** Synchronous and idempotent: retires every active handle, discards a pending probe replacement, closes the gate. */
  retireAll(): void;
  snapshot(): GateSnapshot;
  /** The live registry objects, for the I-R test only. */
  inspectRegistries(): GateRegistries;
}

export type Kind = "queue" | "probe";

/** A plain retiring record: no handle (I-R). */
export interface RetiringRecord {
  readonly id: number;
  readonly kind: Kind;
  readonly retiredAt: number;
  readonly everReady: boolean;
  readonly unresolvedCount: number;
}

export type Answer<T> = { readonly outcome: GateOutcome<T> } | { readonly refusal: DispatchQueueError };

/**
 * The caller's answer. A method signature: each call's resolver is typed for
 * its own operation's value, which is exactly the value its operation
 * fulfils with, so no type assertion is needed.
 */
export interface Resolver {
  settle(answer: Answer<unknown>): void;
}

/** An outstanding operation: plain data, the caller's resolver and its deadline timer. */
export interface Entry {
  readonly generationId: number;
  readonly kind: "normal" | "probe";
  readonly startedAt: number;
  resolve?: Resolver | undefined;
  timer?: unknown;
}

export interface Registry<H> {
  active: { readonly id: number; readonly handle: H } | undefined;
  readonly retiring: RetiringRecord[];
}

export interface GateRegistries {
  readonly outstanding: ReadonlyMap<number, Entry>;
  readonly queues: Registry<DispatchQueueHandle>;
  readonly probes: Registry<DispatchProbeHandle>;
  readonly counters: { readonly terminalQueue: number; readonly terminalProbe: number; readonly replacements: number };
}

type Rejection = { readonly refusal: DispatchQueueError } | { readonly code: string };

/** The settlement and deadline sink: the only thing the per-call handlers capture besides two ids. */
interface Sink {
  fulfilled(operationId: number, generationId: number, value: unknown): void;
  rejected(operationId: number, generationId: number, rejection: Rejection): void;
  deadline(operationId: number, generationId: number): void;
}

/** A rejection is classified once: a local refusal passes through; a coded Redis error keeps its code; anything else is UNCLASSIFIED. */
function classifyRejection(error: unknown): Rejection {
  if (error instanceof DispatchQueueError) return { refusal: error };
  if (error instanceof DispatchRedisError) return { code: normalizedCode(error.code) };
  return { code: "UNCLASSIFIED" };
}

function normalizedCode(code: unknown): string {
  return typeof code === "string" && REDIS_CODE_PATTERN.test(code) ? code : "UNCLASSIFIED";
}

/** The two settlement handlers of one call, built from the sink and the two ids only. */
function settlementHandlers(
  sink: Sink,
  generationId: number,
  operationId: number,
): readonly [(value: unknown) => void, (error: unknown) => void] {
  return [
    (value: unknown): void => sink.fulfilled(operationId, generationId, value),
    (error: unknown): void => sink.rejected(operationId, generationId, classifyRejection(error)),
  ];
}

/** The deadline callback of one call, built from the sink and the two ids only. */
function deadlineHandler(sink: Sink, generationId: number, operationId: number): () => void {
  return (): void => sink.deadline(operationId, generationId);
}

type LatestProbe = { readonly kind: "confirmed" } | { readonly kind: "deadline" } | { readonly kind: "error"; readonly code: string };

export function createCallGate(options: CallGateOptions): CallGate {
  const { now, setTimer, clearTimer, onEvent, constants } = options;
  const outstanding = new Map<number, Entry>();
  const queues: Registry<DispatchQueueHandle> = { active: undefined, retiring: [] };
  const probes: Registry<DispatchProbeHandle> = { active: undefined, retiring: [] };
  const counters = { terminalQueue: 0, terminalProbe: 0, replacements: 0 };
  let nextQueueId = 0;
  let nextProbeId = 0;
  let nextOperationId = 0;
  let closed = false;
  let stuck: StuckReason | undefined;
  let pendingProbeReplacement = false;
  let latestProbe: LatestProbe | undefined;

  const entryKindOf = (kind: Kind): "normal" | "probe" => (kind === "queue" ? "normal" : "probe");
  const isActive = (kind: "normal" | "probe", generationId: number): boolean =>
    (kind === "normal" ? queues.active?.id : probes.active?.id) === generationId;
  const entriesOf = (kind: "normal" | "probe", generationId: number): [number, Entry][] =>
    [...outstanding.entries()].filter(([, entry]) => entry.kind === kind && entry.generationId === generationId);
  const normalCount = (): number => [...outstanding.values()].filter((entry) => entry.kind === "normal").length;
  const probeInFlight = (): boolean => [...outstanding.values()].some((entry) => entry.kind === "probe");

  const answer = (entry: Entry, result: Answer<unknown>): void => {
    const resolver = entry.resolve;
    entry.resolve = undefined;
    if (entry.timer !== undefined) {
      clearTimer(entry.timer);
      entry.timer = undefined;
    }
    if (resolver !== undefined) resolver.settle(result);
  };

  const sink: Sink = {
    fulfilled: (operationId, generationId, value) => {
      const entry = outstanding.get(operationId);
      if (entry === undefined) return; // terminal-accounted: nothing to do
      outstanding.delete(operationId);
      if (entry.resolve === undefined) {
        // Answered already (deadline or retirement): a late success is never confirmed.
        answer(entry, { outcome: { kind: "unconfirmed", cause: "deadline" } });
        return;
      }
      if (isActive(entry.kind, generationId)) answer(entry, { outcome: { kind: "confirmed", value } });
      else answer(entry, { outcome: { kind: "unconfirmed", cause: "retired" } });
    },
    rejected: (operationId, _generationId, rejection) => {
      const entry = outstanding.get(operationId);
      if (entry === undefined) return;
      outstanding.delete(operationId);
      if ("refusal" in rejection) answer(entry, { refusal: rejection.refusal });
      else answer(entry, { outcome: { kind: "unconfirmed", cause: "error", code: rejection.code } });
    },
    deadline: (operationId) => {
      const entry = outstanding.get(operationId);
      if (entry === undefined) return;
      entry.timer = undefined;
      // The caller is answered; the entry stays in O until the operation settles.
      answer(entry, { outcome: { kind: "unconfirmed", cause: "deadline" } });
    },
  };

  const enterStuck = (reason: StuckReason): void => {
    if (stuck !== undefined) return;
    stuck = reason;
    onEvent({ event: "stuck", reason });
  };

  /** The retirement step (FD-15; I-S): one synchronous function. */
  const retirementStep = (kind: Kind): void => {
    const registry: Registry<DispatchQueueHandle> | Registry<DispatchProbeHandle> = kind === "queue" ? queues : probes;
    const active = registry.active;
    if (active === undefined) return;
    // 1. The lifetime flag, from the module's retire() only (I-E).
    const { everReady } = active.handle.retire();
    const entryKind = entryKindOf(kind);
    const entries = entriesOf(entryKind, active.id);
    // 2. Every pending caller of the generation is answered `retired`; timers cleared.
    for (const [, entry] of entries) answer(entry, { outcome: { kind: "unconfirmed", cause: "retired" } });
    // 3. Never ready: gate-level terminal accounting (FD-15(b)).
    if (!everReady) {
      for (const [operationId] of entries) outstanding.delete(operationId);
      if (kind === "queue") counters.terminalQueue += entries.length;
      else counters.terminalProbe += entries.length;
    }
    // 4. Ever ready: the entries keep counting until they settle.
    // 5. The handle is dropped (I-R); a plain record is kept.
    registry.active = undefined;
    registry.retiring.push(
      Object.freeze({ id: active.id, kind, retiredAt: now(), everReady, unresolvedCount: everReady ? entries.length : 0 }),
    );
  };

  const openQueueGeneration = (): void => {
    queues.active = { id: ++nextQueueId, handle: options.openQueue() };
  };
  const openProbeConnection = (): void => {
    probes.active = { id: ++nextProbeId, handle: options.openProbe() };
  };

  /** Probe replacement now: retire the active probe connection, open a new one. */
  const replaceProbeNow = (): void => {
    retirementStep("probe");
    try {
      openProbeConnection();
    } catch {
      enterStuck("open-failed");
      return;
    }
    onEvent({ event: "recovery", action: "replace-probe", generation: probes.active?.id ?? 0 });
  };

  /** Probe replacement under I-P (S-8): deferred while a probe connection is retiring. */
  const replaceProbe = (): void => {
    if (closed || stuck !== undefined) return;
    if (probes.retiring.length > 0) {
      pendingProbeReplacement = true;
      return;
    }
    replaceProbeNow();
  };

  const sweepKind = (registry: { readonly retiring: RetiringRecord[] }, entryKind: "normal" | "probe"): void => {
    for (let index = registry.retiring.length - 1; index >= 0; index--) {
      const record = registry.retiring[index];
      if (record === undefined) continue;
      const expired = now() - record.retiredAt >= constants.retireWindowMs;
      if (expired && entriesOf(entryKind, record.id).length === 0) registry.retiring.splice(index, 1);
    }
  };

  /** At every gate entry point: retiring records whose window has passed and that hold no entry are removed. */
  const sweep = (): void => {
    sweepKind(queues, "normal");
    sweepKind(probes, "probe");
    if (!pendingProbeReplacement || closed || stuck !== undefined) return;
    if (probes.retiring.length === 0) {
      pendingProbeReplacement = false;
      replaceProbeNow();
      return;
    }
    const pastWindowUnresolved = probes.retiring.some(
      (record) => now() - record.retiredAt >= constants.retireWindowMs && entriesOf("probe", record.id).length > 0,
    );
    if (pastWindowUnresolved) enterStuck("probe-ceiling");
  };

  /** Starts one operation on the active generation of its kind; the caller's promise answers by the rules above. */
  const begin = <T>(kind: "normal" | "probe", generationId: number, underlying: Promise<T>): Promise<GateOutcome<T>> =>
    new Promise<GateOutcome<T>>((resolve, reject) => {
      const operationId = ++nextOperationId;
      const resolver: Resolver = {
        settle: (result: Answer<T>): void => {
          if ("refusal" in result) reject(result.refusal);
          else resolve(result.outcome);
        },
      };
      const entry: Entry = { generationId, kind, startedAt: now(), resolve: resolver };
      outstanding.set(operationId, entry);
      entry.timer = setTimer(deadlineHandler(sink, generationId, operationId), constants.redisDeadlineMs);
      const [onFulfilled, onRejected] = settlementHandlers(sink, generationId, operationId);
      underlying.then(onFulfilled, onRejected);
    });

  const normal = <T>(run: (handle: DispatchQueueHandle) => Promise<T>): Promise<GateOutcome<T>> => {
    sweep();
    if (closed) return Promise.resolve({ kind: "not-started", cause: "unavailable" });
    if (stuck !== undefined) return Promise.resolve({ kind: "not-started", cause: "stuck" });
    const active = queues.active;
    if (active === undefined) return Promise.resolve({ kind: "not-started", cause: "unavailable" });
    if (normalCount() >= GATE_CEILINGS.normalOperations) return Promise.resolve({ kind: "not-started", cause: "capacity" });
    return begin("normal", active.id, run(active.handle));
  };

  /** S-7: replacement and confirmed recovery, against one pre-transition snapshot. */
  const afterConfirmedProbe = (): void => {
    const activeQueue = queues.active;
    const pre = {
      generation: activeQueue?.id,
      oldestAge: activeQueue === undefined
        ? -1
        : Math.max(-1, ...entriesOf("normal", activeQueue.id).map(([, entry]) => now() - entry.startedAt)),
      normal: normalCount(),
      replacements: counters.replacements,
    };
    const replacementRequired = pre.generation !== undefined && pre.oldestAge >= constants.recoveryPeriodMs;
    if (replacementRequired) {
      if (pre.replacements >= GATE_CEILINGS.replacementsWithoutRecovery) {
        enterStuck("replacement-limit");
        return;
      }
      if (queues.retiring.length > 0) {
        enterStuck("queue-ceiling");
        return;
      }
      retirementStep("queue");
      try {
        openQueueGeneration();
      } catch {
        enterStuck("open-failed");
        return;
      }
      counters.replacements = pre.replacements + 1;
      onEvent({ event: "recovery", action: "replace-generation", generation: queues.active?.id ?? 0 });
      return;
    }
    // Confirmed recovery: no aged active-generation entry (above) and fewer than 15 normal entries.
    if (pre.normal < GATE_CEILINGS.normalOperations) {
      if (pre.replacements > 0) onEvent({ event: "recovery", action: "confirmed", generation: pre.generation ?? 0 });
      counters.replacements = 0;
    }
  };

  const gate: CallGate = {
    start: (): boolean => {
      if (closed || stuck !== undefined) return false;
      sweep();
      let openedQueue = false;
      if (queues.active === undefined && queues.retiring.length === 0) {
        openQueueGeneration();
        openedQueue = true;
      }
      if (probes.active === undefined && probes.retiring.length === 0) {
        try {
          openProbeConnection();
        } catch (error) {
          // Partial-start rollback: the handle opened in this call is retired before the throw propagates.
          if (openedQueue) retirementStep("queue");
          throw error;
        }
      }
      return queues.active !== undefined && probes.active !== undefined;
    },

    probe: async (): Promise<GateOutcome<void>> => {
      sweep();
      if (closed) return { kind: "not-started", cause: "unavailable" };
      if (stuck !== undefined) return { kind: "not-started", cause: "stuck" };
      // Single-flight (FD-19 as S-12 reads it beside FD-15(b)): every probe entry in O blocks a new probe.
      if (probeInFlight()) return { kind: "not-started", cause: "in-flight" };
      if (pendingProbeReplacement) return { kind: "not-started", cause: "unavailable" };
      const active = probes.active;
      if (active === undefined) return { kind: "not-started", cause: "unavailable" };
      const outcome = await begin("probe", active.id, active.handle.ping());
      if (outcome.kind === "confirmed") {
        latestProbe = { kind: "confirmed" };
        afterConfirmedProbe();
      } else if (outcome.kind === "unconfirmed" && outcome.cause === "deadline") {
        latestProbe = { kind: "deadline" };
        replaceProbe();
      } else if (outcome.kind === "unconfirmed" && outcome.cause === "error") {
        const code = outcome.code ?? "UNCLASSIFIED";
        latestProbe = { kind: "error", code };
        // Replaced only on its deadline or a COMMAND_TIMEOUT, never on a fast failure.
        if (code === "COMMAND_TIMEOUT") replaceProbe();
      }
      return outcome;
    },

    getJob: (jobId) => normal((handle) => handle.getJob(jobId)),
    getJobState: (jobId) => normal((handle) => handle.getJobState(jobId)),
    getJobCounts: () => normal((handle) => handle.getJobCounts()),
    publish: (eventId, data) => normal((handle) => options.publishWith(handle, eventId, data)),

    retireAll: (): void => {
      if (closed) return;
      closed = true;
      pendingProbeReplacement = false;
      retirementStep("queue");
      retirementStep("probe");
    },

    snapshot: (): GateSnapshot => {
      sweep();
      const redis = Object.freeze({
        outstanding: outstanding.size,
        terminal: counters.terminalQueue + counters.terminalProbe,
        generation: queues.active?.id ?? 0,
        retiring: queues.retiring.length,
        probeConnections: (probes.active === undefined ? 0 : 1) + probes.retiring.length,
      });
      if (stuck !== undefined) return Object.freeze({ state: "stuck", stuckReason: stuck, redis });
      const degraded = (degradedCode: string): GateSnapshot => Object.freeze({ state: "degraded", degradedCode, redis });
      if (
        closed ||
        queues.active === undefined ||
        probes.active === undefined ||
        pendingProbeReplacement ||
        latestProbe === undefined
      ) {
        return degraded("PROBE_UNAVAILABLE");
      }
      if (latestProbe.kind === "deadline") return degraded("PROBE_DEADLINE");
      if (latestProbe.kind === "error") return degraded(normalizedCode(latestProbe.code));
      if (normalCount() >= GATE_CEILINGS.normalOperations) return degraded("QUEUE_CAPACITY");
      return Object.freeze({ state: "ok", redis });
    },

    inspectRegistries: (): GateRegistries => ({ outstanding, queues, probes, counters }),
  };
  return Object.freeze(gate);
}
