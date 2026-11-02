import { Queue, Worker } from "bullmq";
import type { JobsOptions, QueueOptions, WorkerOptions } from "bullmq";
import {
  DISPATCH_JOB_NAME,
  DISPATCH_JOB_OPTIONS,
  DISPATCH_QUEUE_NAME,
  DISPATCH_REMOVE_ON_COMPLETE,
  DispatchQueueError,
  DispatchRedisError,
  JOB_HASH_FIELDS,
  PRODUCER_CONNECTION_PROFILE,
  WORKER_CONNECTION_PROFILE,
  checkConcurrency,
  checkConnectionSettings,
  checkEventId,
  checkJobData,
  checkJobOptions,
  checkWorkerOptions,
  classifyRedisError,
  isPongReply,
  parseJobHash,
} from "./policy.js";
import type {
  DispatchErrorObserver,
  DispatchJobCounts,
  DispatchJobData,
  DispatchJobRecord,
  DispatchJobState,
  DispatchJobView,
  DispatchProbeHandle,
  DispatchProcessor,
  DispatchQueueHandle,
  DispatchRetirement,
  DispatchSettings,
  DispatchWorkerHandle,
  DispatchWorkerSettings,
} from "./types.js";

// The only file in @irs/worker that imports bullmq (Task 012A record §8 A1;
// addendum §3.2 rules 1-4). It builds every option object the library
// receives, constructs the dispatch Queue and Worker, and returns handles
// that keep those objects in closures: no library or Redis-client object, and
// no raw error, ever leaves this module. Not part of the public entry; code
// outside this directory imports index.ts only.

/** The fields of a library job this module reads (a bullmq Job satisfies it). */
export interface RawJob {
  readonly id?: string | undefined;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly opts: { readonly removeOnFail?: unknown; readonly removeOnComplete?: unknown };
}

/**
 * The three members of the Queue's own connection this module uses (Task
 * 012B-3: FD-16, FD-19, FD-20; RC-7): the `ready` event (the lifetime
 * everReady flag), the forced close, and the client promise, typed as a plain
 * object and narrowed at run time by the two guards below. Never exported
 * from the public entry.
 */
export interface RawQueueConnection {
  on(event: "ready", listener: () => void): unknown;
  close(force: boolean): Promise<void>;
  readonly client: Promise<object>;
}

export interface RawQueue {
  add(name: string, data: DispatchJobData, options: JobsOptions): Promise<{ readonly id?: string | undefined }>;
  getJob(jobId: string): Promise<RawJob | undefined>;
  getJobState(jobId: string): Promise<string>;
  getJobCounts(): Promise<{ readonly [state: string]: number }>;
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): Promise<void>;
  getBackend(): RawQueueConnection;
  toKey(type: string): string;
}

export interface RawWorker {
  on(event: "error", listener: (error: Error) => void): unknown;
  waitUntilReady(): Promise<unknown>;
  close(): Promise<void>;
}

/** The two construction points. The Redis-free tests replace them with inert doubles. */
export interface BullmqFactories {
  readonly createQueue: (name: string, options: QueueOptions) => RawQueue;
  readonly createWorker: (name: string, processor: (job: RawJob) => Promise<void>, options: WorkerOptions) => RawWorker;
}

export const BULLMQ_FACTORIES: BullmqFactories = Object.freeze({
  // A block body with a local constant (RC-7): the construction is typed on
  // its own, then checked against RawQueue; no type assertion.
  createQueue: (name: string, options: QueueOptions) => {
    const queue = new Queue(name, options);
    return queue;
  },
  createWorker: (name: string, processor: (job: RawJob) => Promise<void>, options: WorkerOptions) =>
    new Worker(name, processor, options),
});

const JOB_STATES: readonly DispatchJobState[] = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
  "completed",
  "failed",
  "unknown",
];

function toJobState(state: string): DispatchJobState {
  const known = JOB_STATES.find((candidate) => candidate === state);
  if (known === undefined) {
    throw new DispatchQueueError("job-state", "the job state is not a known state");
  }
  return known;
}

/** A deep copy, frozen at the top level when it is an object. */
function frozenCopy(value: unknown): unknown {
  const copy: unknown = structuredClone(value);
  return typeof copy === "object" && copy !== null ? Object.freeze(copy) : copy;
}

function idOf(job: RawJob): string {
  if (typeof job.id !== "string") {
    throw new DispatchQueueError("job-id", "the job has no id");
  }
  return job.id;
}

function jobView(job: RawJob): DispatchJobView {
  return Object.freeze({ id: idOf(job), data: frozenCopy(job.data), attemptsMade: job.attemptsMade });
}

/**
 * id, data and the retention options from the library's job read; attemptsMade,
 * both times and both digests from the one HMGET (FD-17). Absent fields are
 * omitted.
 */
function jobRecord(job: RawJob, fields: ReturnType<typeof parseJobHash>): DispatchJobRecord {
  const record: {
    id: string;
    data: unknown;
    attemptsMade: number;
    removeOnFail: unknown;
    removeOnComplete: unknown;
    processedOn?: number;
    finishedOn?: number;
    returnValueSha256?: string;
    failedReasonSha256?: string;
  } = {
    id: idOf(job),
    data: frozenCopy(job.data),
    attemptsMade: fields.attemptsMade,
    removeOnFail: frozenCopy(job.opts.removeOnFail),
    removeOnComplete: frozenCopy(job.opts.removeOnComplete),
  };
  if (fields.processedOn !== undefined) record.processedOn = fields.processedOn;
  if (fields.finishedOn !== undefined) record.finishedOn = fields.finishedOn;
  if (fields.returnValueSha256 !== undefined) record.returnValueSha256 = fields.returnValueSha256;
  if (fields.failedReasonSha256 !== undefined) record.failedReasonSha256 = fields.failedReasonSha256;
  return Object.freeze(record);
}

function count(counts: { readonly [state: string]: number }, state: string): number {
  const value = counts[state];
  return typeof value === "number" ? value : 0;
}

function jobCounts(counts: { readonly [state: string]: number }): DispatchJobCounts {
  return Object.freeze({
    waiting: count(counts, "waiting"),
    active: count(counts, "active"),
    delayed: count(counts, "delayed"),
    prioritized: count(counts, "prioritized"),
    "waiting-children": count(counts, "waiting-children"),
    completed: count(counts, "completed"),
    failed: count(counts, "failed"),
  });
}

/** Runs a Redis operation; any failure other than this module's own refusals becomes a coded error. */
async function redisCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DispatchQueueError) throw error;
    throw new DispatchRedisError(classifyRedisError(error));
  }
}

// Without a listener, an 'error' event (for example a lost connection) would
// end the process. The failure itself reaches callers as a rejected call
// (DispatchRedisError); how it is reported is decided in 012B.
function ignoreErrorEvent(): void {}

/** A rejection already handled: the closing promise's outcome reaches close()'s caller, never an unhandled rejection. */
function ignoreRejection(): void {}

function connection(settings: DispatchSettings) {
  return { host: settings.host, port: settings.port, password: settings.password };
}

function dispatchJobOptions(eventId: string): JobsOptions {
  return {
    jobId: eventId,
    removeOnFail: DISPATCH_JOB_OPTIONS.removeOnFail,
    removeOnComplete: { ...DISPATCH_REMOVE_ON_COMPLETE },
  };
}

function queueOptions(settings: DispatchSettings): QueueOptions {
  const defaultJobOptions = {
    removeOnFail: DISPATCH_JOB_OPTIONS.removeOnFail,
    removeOnComplete: { ...DISPATCH_REMOVE_ON_COMPLETE },
  };
  checkJobOptions(defaultJobOptions);
  const options: QueueOptions = {
    connection: { ...connection(settings), ...PRODUCER_CONNECTION_PROFILE },
    defaultJobOptions,
  };
  if (settings.prefix !== undefined) options.prefix = settings.prefix;
  return options;
}

/**
 * The probe connection's options (FD-19): a new plain connection object built
 * from the settings' host, port and password (never a client), the producer
 * profile, and no command of the library's own: skipMetasUpdate stops the
 * metadata write and skipVersionCheck the version INFO. The prefix when one is
 * set (S-10).
 */
function probeOptions(settings: DispatchSettings): QueueOptions {
  const options: QueueOptions = {
    connection: { ...connection(settings), ...PRODUCER_CONNECTION_PROFILE },
    skipMetasUpdate: true,
    skipVersionCheck: true,
  };
  if (settings.prefix !== undefined) options.prefix = settings.prefix;
  return options;
}

function workerOptions(settings: DispatchWorkerSettings): WorkerOptions {
  // Worker-level removeOnFail is deliberately absent (record §8 A2): the
  // library then keeps failed jobs, and any value would evict other failed jobs.
  const options: WorkerOptions = {
    connection: { ...connection(settings), ...WORKER_CONNECTION_PROFILE },
    concurrency: settings.concurrency ?? 1,
    removeOnComplete: { ...DISPATCH_REMOVE_ON_COMPLETE },
  };
  if (settings.prefix !== undefined) options.prefix = settings.prefix;
  checkWorkerOptions(options);
  return options;
}

// ---- Task 012B-3: the pinned amendment (B2-7; FD-16, FD-17, FD-19, FD-20) ----
// The named functions below are the only places the connection, its client
// and its members are touched; the scan's member-site table pins each site.

/** The client's PING, as the runtime guard narrows it (founder decision PD-A: a named interface). */
interface PingCapable {
  ping(): Promise<unknown>;
}

/** The client's Buffer-returning HMGET, as the runtime guard narrows it (PD-A). */
interface HashReadCapable {
  hmgetBuffer(key: string, ...fields: string[]): Promise<unknown>;
}

/**
 * The lifetime everReady flag: set on the connection's first `ready`, never
 * cleared. Attached in the same synchronous sequence that constructs the
 * Queue, so it cannot miss the first `ready` (run 2 §3.1). The listener
 * captures only the cell and is never removed.
 */
function watchReady(queue: RawQueue): { value: boolean } {
  const cell = { value: false };
  queue.getBackend().on("ready", () => {
    cell.value = true;
  });
  return cell;
}

function isPingClient(value: object): value is PingCapable {
  return "ping" in value && typeof value.ping === "function";
}

function isHashClient(value: object): value is HashReadCapable {
  return "hmgetBuffer" in value && typeof value.hmgetBuffer === "function";
}

/** The purpose-specific PING (FD-16): resolves with nothing, only on the exact reply PONG. */
async function pingThrough(queue: RawQueue, active: () => boolean): Promise<void> {
  const client = await queue.getBackend().client;
  if (!active()) throw new DispatchQueueError("retired", "the handle is retired");
  if (!isPingClient(client)) throw new DispatchRedisError("UNCLASSIFIED");
  const reply = await client.ping();
  if (!isPongReply(reply)) throw new DispatchRedisError("UNCLASSIFIED");
}

/**
 * The one atomic read (FD-17): HMGET of exactly JOB_HASH_FIELDS on the key
 * derived from the job id. It never parses: the parse runs outside redisCall,
 * so that JOB_HASH_FORMAT is never reclassified.
 */
async function readJobHash(queue: RawQueue, jobId: string, active: () => boolean): Promise<unknown> {
  const client = await queue.getBackend().client;
  if (!active()) throw new DispatchQueueError("retired", "the handle is retired");
  if (!isHashClient(client)) throw new DispatchRedisError("UNCLASSIFIED");
  return client.hmgetBuffer(queue.toKey(jobId), ...JOB_HASH_FIELDS);
}

/**
 * The forced retirement (FD-15(a), FD-20): the forced close is always
 * initiated first, so no ordinary close can memoize a QUIT; the Queue's own
 * close() then reuses the connection's memoized forced promise. Both promises
 * get their rejection handler in this same synchronous body.
 */
function retireQueue(queue: RawQueue): Promise<void> {
  const forced = queue.getBackend().close(true);
  const closed = queue.close();
  forced.catch(ignoreRejection);
  closed.catch(ignoreRejection);
  return closed;
}

/** The error listener (B2-6): counts each event's classified code; never throws. */
function countingListener(onError?: DispatchErrorObserver): (error: Error) => void {
  if (onError === undefined) return ignoreErrorEvent;
  return (error: Error): void => {
    try {
      onError(classifyRedisError(error));
    } catch {
      // The observer's own failure is never allowed to reach the library.
    }
  };
}

/** Each queue handle's publication path, reachable only through publishJob. */
const publishers = new WeakMap<DispatchQueueHandle, (eventId: string, data: DispatchJobData) => Promise<string>>();

export function openDispatchQueueWith(
  factories: BullmqFactories,
  settings: DispatchSettings,
  onError?: DispatchErrorObserver,
): DispatchQueueHandle {
  checkConnectionSettings(settings);
  const queue = factories.createQueue(DISPATCH_QUEUE_NAME, queueOptions(settings));
  queue.on("error", countingListener(onError));
  const ready = watchReady(queue);

  // The per-handle retirement state (FD-20; RC-8).
  let retired = false;
  const active = (): boolean => !retired;
  const refuseIfRetired = (): void => {
    if (retired) throw new DispatchQueueError("retired", "the handle is retired");
  };
  let retirement: { readonly result: DispatchRetirement; readonly closing: Promise<void> } | undefined;
  const retireOnce = (): { readonly result: DispatchRetirement; readonly closing: Promise<void> } => {
    if (retirement === undefined) {
      const result = Object.freeze({ everReady: ready.value });
      retired = true;
      const closing = retireQueue(queue);
      retirement = { result, closing };
    }
    return retirement;
  };

  const handle: DispatchQueueHandle = Object.freeze({
    close: async (): Promise<void> => {
      const { closing } = retireOnce();
      await redisCall(() => closing);
    },
    getJobState: async (jobId: string): Promise<DispatchJobState> => {
      refuseIfRetired();
      checkEventId(jobId);
      return toJobState(await redisCall(() => queue.getJobState(jobId)));
    },
    getJob: async (jobId: string): Promise<DispatchJobRecord | undefined> => {
      refuseIfRetired();
      checkEventId(jobId);
      const job = await redisCall(() => queue.getJob(jobId));
      if (job === undefined) return undefined;
      // Retired while the first read was in flight: no HMGET is initiated.
      refuseIfRetired();
      const reply = await redisCall(() => readJobHash(queue, jobId, active));
      const fields = parseJobHash(reply);
      return jobRecord(job, fields);
    },
    getJobCounts: async (): Promise<DispatchJobCounts> => {
      refuseIfRetired();
      return jobCounts(await redisCall(() => queue.getJobCounts()));
    },
    retire: (): DispatchRetirement => retireOnce().result,
  });

  publishers.set(handle, async (eventId, data) => {
    refuseIfRetired();
    const options = dispatchJobOptions(eventId);
    checkJobOptions(options);
    const job = await redisCall(() => queue.add(DISPATCH_JOB_NAME, data, options));
    if (job.id !== eventId) {
      throw new DispatchQueueError("job-id", "the queue returned a different job id");
    }
    return eventId;
  });
  return handle;
}

/**
 * The separate, bounded probe connection (FD-19): a second Queue on the same
 * name, used for PING only, with the same forced retirement. Its handle is
 * exactly { close, ping, retire }.
 */
export function openDispatchProbeWith(
  factories: BullmqFactories,
  settings: DispatchSettings,
  onError?: DispatchErrorObserver,
): DispatchProbeHandle {
  checkConnectionSettings(settings);
  const queue = factories.createQueue(DISPATCH_QUEUE_NAME, probeOptions(settings));
  queue.on("error", countingListener(onError));
  const ready = watchReady(queue);

  let retired = false;
  const active = (): boolean => !retired;
  const refuseIfRetired = (): void => {
    if (retired) throw new DispatchQueueError("retired", "the handle is retired");
  };
  let retirement: { readonly result: DispatchRetirement; readonly closing: Promise<void> } | undefined;
  const retireOnce = (): { readonly result: DispatchRetirement; readonly closing: Promise<void> } => {
    if (retirement === undefined) {
      const result = Object.freeze({ everReady: ready.value });
      retired = true;
      const closing = retireQueue(queue);
      retirement = { result, closing };
    }
    return retirement;
  };

  return Object.freeze({
    close: async (): Promise<void> => {
      const { closing } = retireOnce();
      await redisCall(() => closing);
    },
    ping: async (): Promise<void> => {
      refuseIfRetired();
      await redisCall(() => pingThrough(queue, active));
    },
    retire: (): DispatchRetirement => retireOnce().result,
  });
}

export async function publishJob(handle: DispatchQueueHandle, eventId: string, data: DispatchJobData): Promise<string> {
  checkEventId(eventId);
  checkJobData(data);
  const publish = publishers.get(handle);
  if (publish === undefined) {
    throw new DispatchQueueError("handle", "not a handle returned by openDispatchQueue");
  }
  return publish(eventId, data);
}

export function startDispatchWorkerWith(
  factories: BullmqFactories,
  settings: DispatchWorkerSettings,
  processor: DispatchProcessor,
): DispatchWorkerHandle {
  checkConnectionSettings(settings);
  checkConcurrency(settings.concurrency);
  if (typeof processor !== "function") {
    throw new DispatchQueueError("processor", "the processor must be a function");
  }
  const wrappedProcessor = async (job: RawJob): Promise<void> => {
    await processor(jobView(job));
  };
  const worker = factories.createWorker(DISPATCH_QUEUE_NAME, wrappedProcessor, workerOptions(settings));
  worker.on("error", ignoreErrorEvent);

  return Object.freeze({
    close: async (): Promise<void> => {
      await redisCall(() => worker.close());
    },
    waitUntilReady: async (): Promise<void> => {
      await redisCall(() => worker.waitUntilReady());
    },
  });
}
