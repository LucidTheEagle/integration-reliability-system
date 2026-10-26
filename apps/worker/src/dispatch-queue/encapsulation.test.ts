import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPATCH_JOB_OPTIONS, DISPATCH_QUEUE_NAME, DispatchRedisError, publishDispatchJob } from "./index.js";
import type { DispatchJobView } from "./index.js";
import { openDispatchQueueWith, startDispatchWorkerWith } from "./implementation.js";
import type { BullmqFactories, RawJob, RawQueue, RawWorker } from "./implementation.js";
import { PRODUCER_CONNECTION_PROFILE, WORKER_CONNECTION_PROFILE } from "./policy.js";
import { QUEUE_HANDLE_METHODS, WORKER_HANDLE_METHODS, handleSurfaceProblems } from "../test-support/handle-surface.js";
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
}

function doubles(): Doubles {
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const processors: ((job: RawJob) => Promise<void>)[] = [];
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
  return { factories, queue, worker, job, calls, processors };
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
