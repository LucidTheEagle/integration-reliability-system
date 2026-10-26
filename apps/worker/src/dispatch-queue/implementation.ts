import { Queue, Worker } from "bullmq";
import type { JobsOptions, QueueOptions, WorkerOptions } from "bullmq";
import {
  DISPATCH_JOB_NAME,
  DISPATCH_JOB_OPTIONS,
  DISPATCH_QUEUE_NAME,
  DISPATCH_REMOVE_ON_COMPLETE,
  DispatchQueueError,
  DispatchRedisError,
  PRODUCER_CONNECTION_PROFILE,
  WORKER_CONNECTION_PROFILE,
  checkConcurrency,
  checkConnectionSettings,
  checkEventId,
  checkJobData,
  checkJobOptions,
  checkWorkerOptions,
  classifyRedisError,
} from "./policy.js";
import type {
  DispatchJobCounts,
  DispatchJobData,
  DispatchJobRecord,
  DispatchJobState,
  DispatchJobView,
  DispatchProcessor,
  DispatchQueueHandle,
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

export interface RawQueue {
  add(name: string, data: DispatchJobData, options: JobsOptions): Promise<{ readonly id?: string | undefined }>;
  getJob(jobId: string): Promise<RawJob | undefined>;
  getJobState(jobId: string): Promise<string>;
  getJobCounts(): Promise<{ readonly [state: string]: number }>;
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): Promise<void>;
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
  createQueue: (name: string, options: QueueOptions) => new Queue(name, options),
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

function jobRecord(job: RawJob): DispatchJobRecord {
  return Object.freeze({
    id: idOf(job),
    data: frozenCopy(job.data),
    attemptsMade: job.attemptsMade,
    removeOnFail: frozenCopy(job.opts.removeOnFail),
    removeOnComplete: frozenCopy(job.opts.removeOnComplete),
  });
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

/** Each queue handle's publication path, reachable only through publishJob. */
const publishers = new WeakMap<DispatchQueueHandle, (eventId: string, data: DispatchJobData) => Promise<string>>();

export function openDispatchQueueWith(factories: BullmqFactories, settings: DispatchSettings): DispatchQueueHandle {
  checkConnectionSettings(settings);
  const queue = factories.createQueue(DISPATCH_QUEUE_NAME, queueOptions(settings));
  queue.on("error", ignoreErrorEvent);

  const handle: DispatchQueueHandle = Object.freeze({
    close: async (): Promise<void> => {
      await redisCall(() => queue.close());
    },
    getJobState: async (jobId: string): Promise<DispatchJobState> => {
      checkEventId(jobId);
      return toJobState(await redisCall(() => queue.getJobState(jobId)));
    },
    getJob: async (jobId: string): Promise<DispatchJobRecord | undefined> => {
      checkEventId(jobId);
      const job = await redisCall(() => queue.getJob(jobId));
      return job === undefined ? undefined : jobRecord(job);
    },
    getJobCounts: async (): Promise<DispatchJobCounts> => jobCounts(await redisCall(() => queue.getJobCounts())),
  });

  publishers.set(handle, async (eventId, data) => {
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
