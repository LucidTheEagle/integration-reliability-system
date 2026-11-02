import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPATCH_JOB_OPTIONS, DISPATCH_QUEUE_NAME, DispatchQueueError, DispatchRedisError, publishDispatchJob } from "./index.js";
import type { DispatchJobView, DispatchProbeHandle, DispatchQueueHandle } from "./index.js";
import { openDispatchProbeWith, openDispatchQueueWith, startDispatchWorkerWith } from "./implementation.js";
import type { BullmqFactories, RawJob, RawQueue, RawQueueConnection, RawWorker } from "./implementation.js";
import { JOB_HASH_FIELDS, JOB_HASH_FORMAT, PRODUCER_CONNECTION_PROFILE, WORKER_CONNECTION_PROFILE } from "./policy.js";
import {
  PROBE_HANDLE_METHODS,
  QUEUE_HANDLE_METHODS,
  WORKER_HANDLE_METHODS,
  handleSurfaceProblems,
} from "../test-support/handle-surface.js";
import { LIBRARY, checkDeclarationSurface, scanSource, tokenize } from "../test-support/source-scan.js";

// The ENCAPSULATION RULE (012A-3 prompt step 2), Redis-free. The module
// builds no Redis client itself: it hands connection options to the two
// construction points in implementation.ts, so with those replaced by inert
// doubles nothing can connect. The doubles reach the module through
// openDispatchQueueWith / startDispatchWorkerWith, which the public entry
// does not export; the no-bypass test refuses any import of implementation.ts
// from outside this directory.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SETTINGS = { host: "127.0.0.1", port: 46379, password: "not-a-real-password", prefix: "irs-test-unit" };
const EVENT_ID = "0199f8a0-0000-7000-8000-000000000001";
const LEAKED_SECRET = "planted-command-argument";

interface Doubles {
  readonly factories: BullmqFactories;
  readonly queue: RawQueue;
  readonly worker: RawWorker;
  readonly job: RawJob;
  readonly calls: { name: string; args: readonly unknown[] }[];
  readonly processors: ((job: RawJob) => Promise<void>)[];
  // Task 012B-3: the connection and client doubles, and new recordings (never in `calls`).
  readonly connectionDouble: RawQueueConnection;
  readonly client: object;
  /** Library calls recorded by the connection double and by recorded() below. */
  readonly library: { name: string; args: readonly unknown[] }[];
  /** Calls of the client's two permitted members. */
  readonly clientCalls: { name: string; args: readonly unknown[] }[];
  /** Every member read on the client double, `then` included. */
  readonly clientReads: string[];
  readonly readyListeners: (() => void)[];
  /** The forced close's promise, once connection.close(true) has run (the library memoizes it). */
  readonly forced: () => Promise<void> | undefined;
}

/** Task 012B-3: options of the doubles. Absent: the defaults below. */
interface DoubleOptions {
  /** The client's members; only hmgetBuffer and ping are ever served. */
  readonly clientMembers?: { readonly hmgetBuffer?: unknown; readonly ping?: unknown };
  /** Replaces the connection's client promise (for example, a held one). */
  readonly clientPromise?: (client: object) => Promise<object>;
  readonly toKey?: (type: string) => string;
  /** Emits `ready` on process.nextTick after the listener is attached. */
  readonly readyOnNextTick?: boolean;
  /** The forced close's outcome. */
  readonly forcedClose?: () => Promise<void>;
}

/** The library's `null` return text's SHA-256 (FD-18 B-2; RC-4). */
const NULL_TEXT_DIGEST = "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";

/**
 * A client double: it serves only hmgetBuffer and ping (when given), answers
 * `then` with undefined (a promise resolution reads it from every awaited
 * object), and throws on any other member. Every read and every call is recorded.
 */
function clientDouble(
  members: { readonly hmgetBuffer?: unknown; readonly ping?: unknown },
  calls: { name: string; args: readonly unknown[] }[],
  reads: string[],
): object {
  return new Proxy(
    {},
    {
      has: (_target, key) => (key === "hmgetBuffer" || key === "ping") && Object.hasOwn(members, key),
      get: (_target, key) => {
        reads.push(String(key));
        if (key === "then") return undefined;
        if ((key === "hmgetBuffer" || key === "ping") && Object.hasOwn(members, key)) {
          const member: unknown = members[key];
          if (typeof member !== "function") return member;
          return (...args: unknown[]): unknown => {
            calls.push({ name: key, args });
            return member(...args);
          };
        }
        throw new Error("client double: this member is not permitted");
      },
    },
  );
}

function doubles(options: DoubleOptions = {}): Doubles {
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const processors: ((job: RawJob) => Promise<void>)[] = [];
  const library: { name: string; args: readonly unknown[] }[] = [];
  const clientCalls: { name: string; args: readonly unknown[] }[] = [];
  const clientReads: string[] = [];
  const readyListeners: (() => void)[] = [];
  let forcedPromise: Promise<void> | undefined;
  const client = clientDouble(
    options.clientMembers ?? {
      hmgetBuffer: async () => [Buffer.from("2"), null, null, null, null],
      ping: async () => "PONG",
    },
    clientCalls,
    clientReads,
  );
  const connectionDouble: RawQueueConnection = {
    on: (event: "ready", listener: () => void) => {
      library.push({ name: "connection.on", args: [event] });
      readyListeners.push(listener);
      if (options.readyOnNextTick === true) process.nextTick(listener);
      return undefined;
    },
    close: (force: boolean) => {
      library.push({ name: "connection.close", args: [force] });
      forcedPromise = options.forcedClose?.() ?? Promise.resolve();
      return forcedPromise;
    },
    get client(): Promise<object> {
      library.push({ name: "connection.client", args: [] });
      return options.clientPromise?.(client) ?? Promise.resolve(client);
    },
  };
  const job: RawJob = {
    id: EVENT_ID,
    data: { eventId: EVENT_ID, nested: { n: 1 } },
    attemptsMade: 2,
    opts: { removeOnFail: false, removeOnComplete: { age: 3600, count: 5000 } },
  };
  const queue: RawQueue = {
    add: async (...args) => {
      calls.push({ name: "add", args });
      return { id: EVENT_ID };
    },
    getJob: async () => job,
    getJobState: async () => "failed",
    getJobCounts: async () => ({ waiting: 1, failed: 2, paused: 9 }),
    on: () => undefined,
    close: async () => undefined,
    getBackend: () => connectionDouble,
    toKey: options.toKey ?? ((type: string) => `${SETTINGS.prefix}:${DISPATCH_QUEUE_NAME}:${type}`),
  };
  const worker: RawWorker = { on: () => undefined, waitUntilReady: async () => worker, close: async () => undefined };
  const factories: BullmqFactories = {
    createQueue: (...args: unknown[]) => {
      calls.push({ name: "createQueue", args });
      return queue;
    },
    createWorker: (...args: [string, (job: RawJob) => Promise<void>, ...unknown[]]) => {
      calls.push({ name: "createWorker", args });
      processors.push(args[1]);
      return worker;
    },
  };
  return {
    factories,
    queue,
    worker,
    job,
    calls,
    processors,
    connectionDouble,
    client,
    library,
    clientCalls,
    clientReads,
    readyListeners,
    forced: () => forcedPromise,
  };
}

function own(record: unknown, key: string): unknown {
  return typeof record === "object" && record !== null ? Object.getOwnPropertyDescriptor(record, key)?.value : undefined;
}

function keysOf(record: unknown): string[] {
  return typeof record === "object" && record !== null ? Object.keys(record).sort() : [];
}

describe("encapsulation: declaration surface", () => {
  it("the public declaration file and every file it re-exports from name neither package", () => {
    const scan = checkDeclarationSurface(join(HERE, "index.d.ts"));
    assert.deepEqual([...scan.files].sort(), ["index.d.ts", "policy.d.ts", "types.d.ts"]);
    assert.deepEqual(scan.violations, []);
  });

  it("control: the same check finds the library in implementation.d.ts, which the entry does not reach", () => {
    const scan = checkDeclarationSurface(join(HERE, "implementation.d.ts"));
    assert.ok(scan.violations.some((violation) => violation.rule === "declaration-package-reference"));
  });

  describe("planted-violation controls", () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "irs-worker-declarations-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("fails on a re-exported declaration file that names a library type", async () => {
      await writeFile(join(dir, "index.d.ts"), 'export * from "./inner.js";\n');
      await writeFile(join(dir, "inner.d.ts"), `import type { Job } from "${LIBRARY}";\nexport declare function f(): Job;\n`);
      const scan = checkDeclarationSurface(join(dir, "index.d.ts"));
      assert.deepEqual(scan.files, ["index.d.ts", "inner.d.ts"]);
      assert.ok(scan.violations.some((violation) => violation.rule === "declaration-package-reference" && violation.file === "inner.d.ts"));
    });

    it("fails on an inline import type of the Redis client", async () => {
      await writeFile(join(dir, "entry.d.ts"), 'export declare function f(): import("io' + 'redis").Redis;\n');
      const scan = checkDeclarationSurface(join(dir, "entry.d.ts"));
      assert.ok(scan.violations.length > 0);
    });

    it("fails on a reference directive and on an unresolved file", async () => {
      await writeFile(join(dir, "directive.d.ts"), `/// <reference types="${LIBRARY}" />\nexport * from "./missing.js";\n`);
      const rules = checkDeclarationSurface(join(dir, "directive.d.ts")).violations.map((violation) => violation.rule);
      assert.ok(rules.includes("declaration-reference-directive"));
      assert.ok(rules.includes("declaration-unresolved"));
    });
  });
});

describe("encapsulation: handle surface (inert doubles)", () => {
  it("the queue handle exposes exactly its designed methods and holds no raw object", () => {
    const d = doubles();
    const handle = openDispatchQueueWith(d.factories, SETTINGS);
    assert.deepEqual(handleSurfaceProblems(handle, QUEUE_HANDLE_METHODS, [d.queue, d.worker, d.job]), []);
    assert.ok(Object.isFrozen(handle));
    assert.equal(Object.getPrototypeOf(handle), Object.prototype);
  });

  it("the worker handle exposes exactly its designed methods and holds no raw object", async () => {
    const d = doubles();
    const handle = startDispatchWorkerWith(d.factories, SETTINGS, async () => undefined);
    assert.deepEqual(handleSurfaceProblems(handle, WORKER_HANDLE_METHODS, [d.queue, d.worker, d.job]), []);
    assert.ok(Object.isFrozen(handle));
    assert.equal(await handle.waitUntilReady(), undefined, "readiness never resolves to a raw object");
  });

  it("constructs with the fixed name, exactly two and three arguments, and the module's options", () => {
    const d = doubles();
    openDispatchQueueWith(d.factories, SETTINGS);
    startDispatchWorkerWith(d.factories, { ...SETTINGS, concurrency: 4 }, async () => undefined);
    const [queueCall, workerCall] = d.calls;
    assert.ok(queueCall !== undefined && workerCall !== undefined);
    assert.equal(queueCall.name, "createQueue");
    assert.equal(queueCall.args.length, 2);
    assert.equal(queueCall.args[0], DISPATCH_QUEUE_NAME);
    const queueOptions = queueCall.args[1];
    assert.deepEqual(own(queueOptions, "defaultJobOptions"), DISPATCH_JOB_OPTIONS);
    assert.deepEqual(own(queueOptions, "connection"), {
      host: SETTINGS.host,
      port: SETTINGS.port,
      password: SETTINGS.password,
      ...PRODUCER_CONNECTION_PROFILE,
    });
    assert.equal(own(queueOptions, "prefix"), SETTINGS.prefix);
    assert.deepEqual(keysOf(queueOptions), ["connection", "defaultJobOptions", "prefix"]);

    assert.equal(workerCall.name, "createWorker");
    assert.equal(workerCall.args.length, 3);
    assert.equal(workerCall.args[0], DISPATCH_QUEUE_NAME);
    const workerOptions = workerCall.args[2];
    assert.equal(typeof workerOptions === "object" && workerOptions !== null && Object.hasOwn(workerOptions, "removeOnFail"), false);
    assert.deepEqual(own(workerOptions, "removeOnComplete"), { age: 3600, count: 5000 });
    assert.deepEqual(own(workerOptions, "connection"), {
      host: SETTINGS.host,
      port: SETTINGS.port,
      password: SETTINGS.password,
      ...WORKER_CONNECTION_PROFILE,
    });
    assert.equal(own(workerOptions, "concurrency"), 4);
    assert.deepEqual(keysOf(workerOptions), ["concurrency", "connection", "prefix", "removeOnComplete"]);
  });

  it("without a prefix, leaves the library's default in place", () => {
    const d = doubles();
    openDispatchQueueWith(d.factories, { host: SETTINGS.host, port: SETTINGS.port, password: SETTINGS.password });
    assert.equal(Object.hasOwn(Object(d.calls[0]?.args[1]), "prefix"), false);
  });

  it("publishes with jobId = eventId and the fixed retention options, returning plain data", async () => {
    const d = doubles();
    const handle = openDispatchQueueWith(d.factories, SETTINGS);
    const id = await publishDispatchJob(handle, EVENT_ID, { eventId: EVENT_ID });
    assert.equal(id, EVENT_ID);
    const add = d.calls.find((call) => call.name === "add");
    assert.ok(add !== undefined);
    assert.equal(add.args.length, 3);
    assert.deepEqual(add.args[2], { jobId: EVENT_ID, removeOnFail: false, removeOnComplete: { age: 3600, count: 5000 } });
  });

  it("inspection returns frozen plain copies, never the library's objects", async () => {
    const d = doubles();
    const handle = openDispatchQueueWith(d.factories, SETTINGS);
    const record = await handle.getJob(EVENT_ID);
    assert.ok(record !== undefined);
    assert.notEqual(record, d.job);
    assert.ok(Object.isFrozen(record));
    assert.deepEqual(record, {
      id: EVENT_ID,
      data: { eventId: EVENT_ID, nested: { n: 1 } },
      attemptsMade: 2,
      removeOnFail: false,
      removeOnComplete: { age: 3600, count: 5000 },
    });
    assert.notEqual(record.data, d.job.data);
    assert.equal(await handle.getJobState(EVENT_ID), "failed");
    const counts = await handle.getJobCounts();
    assert.ok(Object.isFrozen(counts));
    assert.deepEqual(counts, { waiting: 1, active: 0, delayed: 0, prioritized: 0, "waiting-children": 0, completed: 0, failed: 2 });
  });

  it("the processor receives a frozen view (id, data, attemptsMade), never the library's job", async () => {
    const d = doubles();
    const seen: DispatchJobView[] = [];
    startDispatchWorkerWith(d.factories, SETTINGS, async (view) => {
      seen.push(view);
    });
    const processor = d.processors[0];
    assert.ok(processor !== undefined);
    await processor(d.job);
    const view = seen[0];
    assert.ok(view !== undefined);
    assert.notEqual(view, d.job);
    assert.ok(Object.isFrozen(view));
    assert.deepEqual(Reflect.ownKeys(view).sort(), ["attemptsMade", "data", "id"]);
    assert.deepEqual(view, { id: EVENT_ID, data: { eventId: EVENT_ID, nested: { n: 1 } }, attemptsMade: 2 });
    assert.notEqual(view.data, d.job.data);
  });

  it("a processor that throws fails the job: the error reaches the library unchanged", async () => {
    const d = doubles();
    const failure = new Error("deliberate");
    startDispatchWorkerWith(d.factories, SETTINGS, async () => {
      throw failure;
    });
    await assert.rejects(d.processors[0]?.(d.job) ?? Promise.resolve(), (error: unknown) => error === failure);
  });

  it("a failed Redis call rejects with a coded error that carries no message, command or cause", async () => {
    const d = doubles();
    const replyError = Object.assign(new Error(`ERR something about ${LEAKED_SECRET}`), {
      name: "ReplyError",
      command: { name: "evalsha", args: [LEAKED_SECRET] },
    });
    const failing: BullmqFactories = {
      ...d.factories,
      createQueue: () => ({ ...d.queue, getJobState: async () => Promise.reject(replyError) }),
    };
    const handle = openDispatchQueueWith(failing, SETTINGS);
    await assert.rejects(handle.getJobState(EVENT_ID), (error: unknown) => {
      assert.ok(error instanceof DispatchRedisError);
      assert.equal(error.code, "ERR");
      assert.ok(!error.message.includes(LEAKED_SECRET));
      assert.deepEqual(Reflect.ownKeys(error).sort(), ["code", "message", "name", "stack"]);
      assert.equal(error.cause, undefined);
      return true;
    });
  });

  it("the module never builds a Redis client itself: no module file references the client package", async () => {
    const source = fileURLToPath(new URL("../../src/dispatch-queue/", import.meta.url));
    const files = (await readdir(source)).filter((file) => file.endsWith(".ts"));
    assert.ok(files.includes("implementation.ts") && files.includes("index.ts"), "positive control: the module's files are read");
    let libraryImports = 0;
    for (const file of files) {
      const text = await readFile(join(source, file), "utf8");
      libraryImports += scanSource(`src/dispatch-queue/${file}`, text).libraryImports.length;
      const clientReferences = tokenize(text).filter(
        (token) => (token.kind === "string" || token.kind === "template") && /^ioredis(\/|$)/.test(token.value),
      );
      assert.deepEqual(clientReferences, [], `${file} references the Redis client package`);
    }
    assert.equal(libraryImports, 2, "positive control: the tokenizer sees the module's two library imports");
  });
});

describe("encapsulation: handle-surface planted-violation controls", () => {
  const close = async (): Promise<void> => undefined;
  const reads = {
    getJob: async () => undefined,
    getJobCounts: async () => undefined,
    getJobState: async () => undefined,
  };

  it("a handle that leaks a raw object fails", () => {
    const d = doubles();
    const leaking = Object.freeze({ close, ...reads, queue: d.queue });
    const problems = handleSurfaceProblems(leaking, QUEUE_HANDLE_METHODS, [d.queue]);
    assert.ok(problems.includes("member queue is not designed"));
    assert.ok(problems.includes("member queue holds a forbidden object"));
  });

  it("a raw object under a designed name, a bound method, an accessor or an extra method fails", () => {
    const d = doubles();
    assert.ok(handleSurfaceProblems({ ...reads, close: d.queue }, QUEUE_HANDLE_METHODS).includes("member close is not a method"));
    const bound = { ...reads, close: d.queue.close.bind(d.queue) };
    assert.ok(handleSurfaceProblems(bound, QUEUE_HANDLE_METHODS).includes("member close is a bound function"));
    const accessor = Object.defineProperty({ ...reads }, "close", { get: () => d.queue.close, enumerable: true });
    assert.ok(handleSurfaceProblems(accessor, QUEUE_HANDLE_METHODS).includes("member close is an accessor"));
    class WithAdd {
      close = close;
      getJob = reads.getJob;
      getJobCounts = reads.getJobCounts;
      getJobState = reads.getJobState;
      async add(): Promise<void> {}
    }
    assert.ok(handleSurfaceProblems(new WithAdd(), QUEUE_HANDLE_METHODS).includes("member add is not designed"));
    assert.ok(handleSurfaceProblems({ close }, QUEUE_HANDLE_METHODS).includes("designed method getJob is missing"));
  });
});

// ---- Task 012B-3: the pinned amendment (B2-7; FD-16, FD-17, FD-19, FD-20; RC-1, RC-8) ----

const MARKER = "planted-marker-7f3a";
const DISPATCH_KEY = `irs-test-unit:irs-event-dispatch:${EVENT_ID}`;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function ticks(count: number): Promise<void> {
  for (let n = 0; n < count; n++) await tick();
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Factories whose queue double records every read, publication and close in `library` (never in `calls`). */
function recorded(d: Doubles, overrides: Partial<RawQueue> = {}): BullmqFactories {
  const queue: RawQueue = {
    ...d.queue,
    add: async (name, data, options) => {
      d.library.push({ name: "queue.add", args: [name] });
      return d.queue.add(name, data, options);
    },
    getJob: async (jobId) => {
      d.library.push({ name: "queue.getJob", args: [jobId] });
      return d.queue.getJob(jobId);
    },
    getJobState: async (jobId) => {
      d.library.push({ name: "queue.getJobState", args: [jobId] });
      return d.queue.getJobState(jobId);
    },
    getJobCounts: async () => {
      d.library.push({ name: "queue.getJobCounts", args: [] });
      return d.queue.getJobCounts();
    },
    // The library's Queue.close() reuses the connection's memoized forced promise.
    close: () => {
      d.library.push({ name: "queue.close", args: [] });
      return d.forced() ?? Promise.resolve();
    },
    ...overrides,
  };
  return {
    ...d.factories,
    createQueue: (...args: Parameters<BullmqFactories["createQueue"]>) => {
      d.factories.createQueue(...args);
      return queue;
    },
  };
}

function openKind(kind: "queue" | "probe", factories: BullmqFactories): DispatchQueueHandle | DispatchProbeHandle {
  return kind === "queue" ? openDispatchQueueWith(factories, SETTINGS) : openDispatchProbeWith(factories, SETTINGS);
}

function isRetiredRefusal(error: unknown): boolean {
  assert.ok(error instanceof DispatchQueueError, "expected a DispatchQueueError");
  assert.equal(error.check, "retired");
  return true;
}

/** Every own value reachable from `value` (objects and arrays), for "never passed" checks. */
function reachable(value: unknown, seen: Set<unknown> = new Set()): unknown[] {
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const found: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const inner: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    found.push(inner, ...reachable(inner, seen));
  }
  return found;
}

describe("encapsulation (012B-3): the queue and probe handle surfaces (RC-1)", () => {
  it("the queue handle exposes exactly its designed methods, retire included, and holds no raw object", () => {
    const d = doubles();
    const handle = openDispatchQueueWith(d.factories, SETTINGS);
    assert.deepEqual(handleSurfaceProblems(handle, QUEUE_HANDLE_METHODS, [d.queue, d.connectionDouble, d.client, d.job]), []);
    assert.ok(Object.isFrozen(handle));
    assert.equal(Object.getPrototypeOf(handle), Object.prototype);
  });

  it("the probe handle exposes exactly close, ping and retire, and holds no raw object", () => {
    const d = doubles();
    const handle = openDispatchProbeWith(d.factories, SETTINGS);
    assert.deepEqual(handleSurfaceProblems(handle, PROBE_HANDLE_METHODS, [d.queue, d.connectionDouble, d.client, d.job]), []);
    assert.ok(Object.isFrozen(handle));
    assert.equal(Object.getPrototypeOf(handle), Object.prototype);
  });

  it("planted controls: a probe handle that leaks the queue double, or holds a bound method or an accessor, fails", () => {
    const d = doubles();
    const close = async (): Promise<void> => undefined;
    const ping = async (): Promise<void> => undefined;
    const retire = () => Object.freeze({ everReady: false });
    const leaking = Object.freeze({ close, ping, retire, queue: d.queue });
    const problems = handleSurfaceProblems(leaking, PROBE_HANDLE_METHODS, [d.queue]);
    assert.ok(problems.includes("member queue is not designed"));
    assert.ok(problems.includes("member queue holds a forbidden object"));
    const bound = { close, retire, ping: d.queue.close.bind(d.queue) };
    assert.ok(handleSurfaceProblems(bound, PROBE_HANDLE_METHODS).includes("member ping is a bound function"));
    const accessor = Object.defineProperty({ close, retire }, "ping", { get: () => ping, enumerable: true });
    assert.ok(handleSurfaceProblems(accessor, PROBE_HANDLE_METHODS).includes("member ping is an accessor"));
  });
});

describe("encapsulation (012B-3): the probe's construction (FD-19)", () => {
  it("constructs once, with the fixed name, exactly two arguments and only its four option keys", () => {
    const d = doubles();
    openDispatchProbeWith(d.factories, SETTINGS);
    assert.equal(d.calls.length, 1);
    const call = d.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.name, "createQueue");
    assert.equal(call.args.length, 2);
    assert.equal(call.args[0], DISPATCH_QUEUE_NAME);
    const options = call.args[1];
    assert.deepEqual(keysOf(options), ["connection", "prefix", "skipMetasUpdate", "skipVersionCheck"]);
    assert.equal(own(options, "skipMetasUpdate"), true);
    assert.equal(own(options, "skipVersionCheck"), true);
    assert.equal(own(options, "prefix"), SETTINGS.prefix);
    const connection = own(options, "connection");
    assert.deepEqual(connection, { host: SETTINGS.host, port: SETTINGS.port, password: SETTINGS.password, ...PRODUCER_CONNECTION_PROFILE });
    assert.equal(Object.getPrototypeOf(connection), Object.prototype);
  });

  it("without a prefix, the same three other keys (S-10)", () => {
    const d = doubles();
    openDispatchProbeWith(d.factories, { host: SETTINGS.host, port: SETTINGS.port, password: SETTINGS.password });
    assert.deepEqual(keysOf(d.calls[0]?.args[1]), ["connection", "skipMetasUpdate", "skipVersionCheck"]);
  });

  it("planted: settings carrying a client-like connection member still produce exactly the plain connection object", () => {
    const d = doubles();
    const fake = { marker: MARKER, ping: async () => "PONG" };
    const settings = { ...SETTINGS, connection: fake };
    openDispatchProbeWith(d.factories, settings);
    const options = d.calls[0]?.args[1];
    assert.deepEqual(own(options, "connection"), {
      host: SETTINGS.host,
      port: SETTINGS.port,
      password: SETTINGS.password,
      ...PRODUCER_CONNECTION_PROFILE,
    });
    assert.ok(!reachable(d.calls).includes(fake), "the fake client is never passed");
  });
});

describe("encapsulation (012B-3): the lifetime everReady flag (I-E)", () => {
  it("the ready listener is attached on the connection before opening returns, for both handles", () => {
    for (const kind of ["queue", "probe"] as const) {
      const d = doubles();
      openKind(kind, d.factories);
      assert.deepEqual(d.library, [{ name: "connection.on", args: ["ready"] }]);
      assert.equal(d.readyListeners.length, 1);
    }
  });

  it("a ready emitted on the next tick: retire() before it reports false; a fresh handle after it reports true", async () => {
    for (const kind of ["queue", "probe"] as const) {
      const early = openKind(kind, doubles({ readyOnNextTick: true }).factories);
      assert.deepEqual(early.retire(), { everReady: false });
      const fresh = openKind(kind, doubles({ readyOnNextTick: true }).factories);
      await tick();
      assert.deepEqual(fresh.retire(), { everReady: true });
      assert.deepEqual(early.retire(), { everReady: false }, "the first retirement's report is fixed");
    }
  });

  it("the flag never returns to false: a second ready changes nothing, and nothing clears it", async () => {
    const d = doubles();
    const handle = openDispatchQueueWith(d.factories, SETTINGS);
    const listener = d.readyListeners[0];
    assert.ok(listener !== undefined);
    listener();
    listener();
    await ticks(2);
    const first = handle.retire();
    assert.deepEqual(first, { everReady: true });
    await tick();
    assert.equal(handle.retire(), first);
  });
});

describe("encapsulation (012B-3): retire() and close() (FD-20; RC-8)", () => {
  it("retire() returns a frozen { everReady } and calls connection.close(true), then queue.close(), within the same call", () => {
    for (const kind of ["queue", "probe"] as const) {
      const d = doubles();
      const handle = openKind(kind, recorded(d));
      const before = d.library.length;
      const result = handle.retire();
      // Asserted before any await.
      assert.deepEqual(d.library.slice(before), [
        { name: "connection.close", args: [true] },
        { name: "queue.close", args: [] },
      ]);
      assert.ok(Object.isFrozen(result));
      assert.deepEqual(Reflect.ownKeys(result), ["everReady"]);
      assert.equal(typeof result.everReady, "boolean");
      const after = d.library.length;
      assert.equal(handle.retire(), result, "a second retire() returns the same object");
      assert.equal(d.library.length, after, "and makes no library call");
    }
  });

  it("close() with no earlier retire() produces the same order; a second close() adds no call", async () => {
    for (const kind of ["queue", "probe"] as const) {
      const d = doubles();
      const handle = openKind(kind, recorded(d));
      const before = d.library.length;
      await handle.close();
      assert.deepEqual(d.library.slice(before), [
        { name: "connection.close", args: [true] },
        { name: "queue.close", args: [] },
      ]);
      const after = d.library.length;
      await handle.close();
      assert.equal(d.library.length, after);
    }
  });

  it("operational methods after retirement reject with check `retired` and make no library call", async () => {
    const d = doubles();
    const handle = openDispatchQueueWith(recorded(d), SETTINGS);
    handle.retire();
    const before = d.library.length;
    await assert.rejects(handle.getJob(EVENT_ID), isRetiredRefusal);
    await assert.rejects(handle.getJobState(EVENT_ID), isRetiredRefusal);
    await assert.rejects(handle.getJobCounts(), isRetiredRefusal);
    await assert.rejects(publishDispatchJob(handle, EVENT_ID, { eventId: EVENT_ID }), isRetiredRefusal);
    assert.equal(d.library.length, before);
    assert.ok(!d.calls.some((call) => call.name === "add"));
    const p = doubles();
    const probe = openDispatchProbeWith(recorded(p), SETTINGS);
    probe.retire();
    const probeBefore = p.library.length;
    await assert.rejects(probe.ping(), isRetiredRefusal);
    assert.equal(p.library.length, probeBefore);
    assert.deepEqual(d.clientCalls, []);
    assert.deepEqual(p.clientCalls, []);
  });

  it("lifecycle methods after retirement: retire() is identical, close() resolves three times, with no further call", async () => {
    for (const kind of ["queue", "probe"] as const) {
      const d = doubles();
      const handle = openKind(kind, recorded(d));
      const result = handle.retire();
      const after = d.library.length;
      assert.equal(handle.retire(), result);
      await handle.close();
      await handle.close();
      await handle.close();
      assert.equal(handle.retire(), result);
      assert.equal(d.library.length, after);
    }
  });

  it("no follow-up command: getJob's first read held across retire() sends no HMGET", async () => {
    const d = doubles();
    const held = deferred<RawJob | undefined>();
    const handle = openDispatchQueueWith(recorded(d, { getJob: () => held.promise }), SETTINGS);
    const pending = handle.getJob(EVENT_ID);
    await ticks(2);
    handle.retire();
    held.resolve(d.job);
    await assert.rejects(pending, isRetiredRefusal);
    assert.deepEqual(d.clientCalls, []);
    assert.ok(!d.library.some((call) => call.name === "connection.client"), "the client is not even awaited");
  });

  it("no follow-up command: the client held across retire() sends no HMGET", async () => {
    const held = deferred<object>();
    const d = doubles({ clientPromise: () => held.promise });
    const handle = openDispatchQueueWith(d.factories, SETTINGS);
    const pending = handle.getJob(EVENT_ID);
    await ticks(3);
    assert.ok(d.library.some((call) => call.name === "connection.client"), "the read is waiting on the client");
    handle.retire();
    held.resolve(d.client);
    await assert.rejects(pending, isRetiredRefusal);
    assert.deepEqual(d.clientCalls, []);
  });

  it("no follow-up command (S-12, module level): ping() with the client held across a never-ready retire() sends no PING", async () => {
    const held = deferred<object>();
    const d = doubles({ clientPromise: () => held.promise });
    const probe = openDispatchProbeWith(d.factories, SETTINGS);
    const pending = probe.ping();
    await ticks(2);
    assert.ok(d.library.some((call) => call.name === "connection.client"), "the ping is waiting on the client");
    assert.deepEqual(probe.retire(), { everReady: false });
    held.resolve(d.client);
    await assert.rejects(pending, isRetiredRefusal);
    assert.deepEqual(d.clientCalls, [], "the client double records no ping call");
  });

  it("with the forced close rejecting: retire() does not throw, no unhandled rejection, close() rejects with a coded error", async () => {
    let unhandled = 0;
    const listener = (): void => {
      unhandled++;
    };
    process.on("unhandledRejection", listener);
    try {
      for (const kind of ["queue", "probe"] as const) {
        const d = doubles({ forcedClose: () => Promise.reject(new Error("Connection is closed.")) });
        const handle = openKind(kind, recorded(d));
        assert.doesNotThrow(() => handle.retire());
        await ticks(2);
        await assert.rejects(handle.close(), (error: unknown) => {
          assert.ok(error instanceof DispatchRedisError);
          assert.equal(error.code, "CONNECTION_CLOSED");
          return true;
        });
      }
      await ticks(3);
      assert.equal(unhandled, 0);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("encapsulation (012B-3): ping() (FD-16)", () => {
  it("resolves undefined on PONG, and returns no library object", async () => {
    const d = doubles();
    const probe = openDispatchProbeWith(d.factories, SETTINGS);
    assert.equal(await probe.ping(), undefined);
    assert.deepEqual(d.clientCalls, [{ name: "ping", args: [] }]);
  });

  it("rejects with UNCLASSIFIED on any other reply, a client without ping, and a non-function ping", async () => {
    const cases: { readonly hmgetBuffer?: unknown; readonly ping?: unknown }[] = [
      { ping: async () => "pong" },
      { ping: async () => "" },
      { ping: async () => Buffer.from("PONG") },
      {},
      { ping: "PONG" },
    ];
    for (const clientMembers of cases) {
      const probe = openDispatchProbeWith(doubles({ clientMembers }).factories, SETTINGS);
      await assert.rejects(probe.ping(), (error: unknown) => {
        assert.ok(error instanceof DispatchRedisError);
        assert.equal(error.code, "UNCLASSIFIED");
        return true;
      });
    }
  });

  it("a ReplyError-shaped rejection gives its classified code", async () => {
    const replyError = Object.assign(new Error("NOAUTH Authentication required."), { name: "ReplyError" });
    const probe = openDispatchProbeWith(doubles({ clientMembers: { ping: async () => Promise.reject(replyError) } }).factories, SETTINGS);
    await assert.rejects(probe.ping(), (error: unknown) => {
      assert.ok(error instanceof DispatchRedisError);
      assert.equal(error.code, "NOAUTH");
      return true;
    });
  });
});

describe("encapsulation (012B-3): getJob's one atomic read (FD-16, FD-17; the Part B10 review's controls)", () => {
  it("(i) reads exactly JOB_HASH_FIELDS, in order, on the key derived from the job id", async () => {
    const d = doubles();
    const handle = openDispatchQueueWith(d.factories, SETTINGS);
    await handle.getJob(EVENT_ID);
    assert.equal(d.clientCalls.length, 1);
    const call = d.clientCalls[0];
    assert.ok(call !== undefined);
    assert.equal(call.name, "hmgetBuffer");
    assert.equal(call.args[0], DISPATCH_KEY);
    assert.deepEqual(call.args.slice(1), [...JOB_HASH_FIELDS]);
  });

  it("(ii) planted: a double whose toKey returns another key makes the key assertion fail", async () => {
    const d = doubles({ toKey: (type) => `irs-test-unit:another-queue:${type}` });
    await openDispatchQueueWith(d.factories, SETTINGS).getJob(EVENT_ID);
    const key = d.clientCalls[0]?.args[0];
    assert.throws(() => assert.equal(key, DISPATCH_KEY));
  });

  it("(iii) the client double throws on any member other than hmgetBuffer and ping, and the module reads no other", async () => {
    const d = doubles();
    for (const member of ["hgetall", "call", "sendCommand", "get"]) {
      assert.throws(() => Reflect.get(d.client, member));
    }
    const reads = d.clientReads.length;
    await openDispatchQueueWith(d.factories, SETTINGS).getJob(EVENT_ID);
    const moduleReads = d.clientReads.slice(reads).filter((member) => member !== "then");
    assert.deepEqual(moduleReads, ["hmgetBuffer", "hmgetBuffer"]);
  });

  it("(iv) a finished reply gives its numbers, the 4-byte null digest, and no failure digest", async () => {
    const reply = [Buffer.from("1"), Buffer.from("1761234567890"), Buffer.from("1761234567999"), Buffer.from("null"), null];
    const d = doubles({ clientMembers: { hmgetBuffer: async () => reply } });
    const record = await openDispatchQueueWith(d.factories, SETTINGS).getJob(EVENT_ID);
    assert.ok(record !== undefined);
    assert.equal(record.attemptsMade, 1);
    assert.equal(record.processedOn, 1761234567890);
    assert.equal(record.finishedOn, 1761234567999);
    assert.equal(record.returnValueSha256, NULL_TEXT_DIGEST);
    assert.equal(record.returnValueSha256, createHash("sha256").update(Buffer.from("null")).digest("hex"));
    assert.equal(Object.hasOwn(record, "failedReasonSha256"), false);
    assert.deepEqual(Reflect.ownKeys(record).sort(), [
      "attemptsMade",
      "data",
      "finishedOn",
      "id",
      "processedOn",
      "removeOnComplete",
      "removeOnFail",
      "returnValueSha256",
    ]);
  });

  it("(v) an all-null reply gives exactly the five base keys, with attemptsMade 0", async () => {
    const d = doubles({ clientMembers: { hmgetBuffer: async () => [null, null, null, null, null] } });
    const record = await openDispatchQueueWith(d.factories, SETTINGS).getJob(EVENT_ID);
    assert.ok(record !== undefined);
    assert.deepEqual(Reflect.ownKeys(record).sort(), ["attemptsMade", "data", "id", "removeOnComplete", "removeOnFail"]);
    assert.equal(record.attemptsMade, 0);
  });

  it("(vi) a missing job makes no HMGET", async () => {
    const d = doubles();
    const handle = openDispatchQueueWith(recorded(d, { getJob: async () => undefined }), SETTINGS);
    assert.equal(await handle.getJob(EVENT_ID), undefined);
    assert.deepEqual(d.clientCalls, []);
  });
});

describe("encapsulation (012B-3): raw text never escapes (B2-7)", () => {
  it("the stored texts' marker appears in no record field", async () => {
    const reply = [
      Buffer.from("1"),
      Buffer.from("1761234567890"),
      Buffer.from("1761234567999"),
      Buffer.from(`returned ${MARKER}`),
      Buffer.from(`failed ${MARKER}`),
    ];
    const d = doubles({ clientMembers: { hmgetBuffer: async () => reply } });
    const record = await openDispatchQueueWith(d.factories, SETTINGS).getJob(EVENT_ID);
    assert.ok(record !== undefined);
    assert.ok(!JSON.stringify(record).includes(MARKER));
    for (const key of Reflect.ownKeys(record)) {
      const value: unknown = Object.getOwnPropertyDescriptor(record, key)?.value;
      assert.ok(!JSON.stringify(value ?? null).includes(MARKER), `${String(key)} carries no stored text`);
    }
  });

  it("every JOB_HASH_FORMAT refusal carries only the code, never the marker", async () => {
    const refused = [
      [Buffer.from(MARKER), null, null, null, null],
      [Buffer.from("1"), Buffer.from(MARKER), null, null, null],
      [Buffer.from("1"), null, Buffer.from(MARKER), null, null],
      [MARKER, null, null, null, null],
      [Buffer.from("1"), null, null, Buffer.from(MARKER)],
    ];
    for (const reply of refused) {
      const d = doubles({ clientMembers: { hmgetBuffer: async () => reply } });
      await assert.rejects(openDispatchQueueWith(d.factories, SETTINGS).getJob(EVENT_ID), (error: unknown) => {
        assert.ok(error instanceof DispatchRedisError);
        assert.equal(error.code, JOB_HASH_FORMAT);
        for (const text of [error.name, error.message, error.code]) assert.ok(!text.includes(MARKER));
        assert.deepEqual(Reflect.ownKeys(error).sort(), ["code", "message", "name", "stack"]);
        return true;
      });
    }
  });
});

// B.6: the module keeps no strong registry of its own (Rev 2, (E)).

/** Problems with implementation.ts's module-level state: token-wise, comments and strings excluded. */
function moduleStateProblems(text: string): string[] {
  const tokens = tokenize(text);
  const problems: string[] = [];
  let depth = 0;
  let weakMaps = 0;
  const topArrays: number[] = [];
  tokens.forEach((token, k) => {
    if (token.kind === "punctuator" && token.value === "{") depth++;
    if (token.kind === "punctuator" && token.value === "}") depth--;
    if (token.kind === "identifier" && token.value === "new") {
      const name = tokens[k + 1]?.value;
      if (name === "Map" || name === "Set") problems.push(`a ${name} construction`);
      if (name === "WeakMap") weakMaps++;
    }
    if (depth === 0 && token.kind === "identifier" && (token.value === "let" || token.value === "var")) {
      problems.push(`a top-level ${token.value}`);
    }
    if (depth === 0 && token.kind === "punctuator" && token.value === "[" && tokens[k - 1]?.value === "=") topArrays.push(k);
  });
  if (weakMaps !== 1) problems.push(`${weakMaps} WeakMap constructions`);
  if (topArrays.length !== 1) problems.push(`${topArrays.length} top-level arrays`);
  const start = topArrays[0];
  if (topArrays.length === 1 && start !== undefined) {
    const declaration = tokens.slice(Math.max(0, start - 8), start).map((token) => token.value);
    if (!declaration.includes("JOB_STATES")) problems.push("the top-level array is not JOB_STATES");
    for (let k = start + 1; k < tokens.length && tokens[k]?.value !== "]"; k++) {
      const token = tokens[k];
      if (token !== undefined && token.kind !== "string" && token.value !== ",") problems.push("JOB_STATES holds a non-string");
    }
  }
  return problems;
}

describe("encapsulation (012B-3): no module-level strong registry (B.6)", () => {
  const source = fileURLToPath(new URL("../../src/dispatch-queue/implementation.ts", import.meta.url));

  it("implementation.ts constructs no Map or Set, exactly one WeakMap, has no top-level let or var, and one string array", async () => {
    assert.deepEqual(moduleStateProblems(await readFile(source, "utf8")), []);
  });

  it("planted controls: a module-level Map and a top-level let each fail", async () => {
    const text = await readFile(source, "utf8");
    assert.ok(moduleStateProblems(`${text}\nconst live = new Map();\n`).includes("a Map construction"));
    assert.ok(moduleStateProblems(`${text}\nlet current = 0;\n`).includes("a top-level let"));
  });
});
