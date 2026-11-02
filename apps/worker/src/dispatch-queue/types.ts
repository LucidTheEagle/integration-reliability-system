// Public types of the central dispatch-queue module (Task 012A record §8 A1;
// addendum §3.2, §3.4). Plain data and opaque handles only: no type here
// names, wraps or exposes a queue-library or Redis-client object.

export type DispatchJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly DispatchJsonValue[]
  | { readonly [key: string]: DispatchJsonValue };

/** The data of a dispatch job: a JSON object. */
export type DispatchJobData = { readonly [key: string]: DispatchJsonValue };

/** Connection settings, as plain data. The password comes from the caller's D6 loader. */
export interface DispatchSettings {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  /** Key prefix, for test isolation only. Absent: the library's own default. */
  readonly prefix?: string;
}

export interface DispatchWorkerSettings extends DispatchSettings {
  /** Jobs processed at once by this worker; default 1. */
  readonly concurrency?: number;
}

export type DispatchJobState =
  | "waiting"
  | "active"
  | "delayed"
  | "prioritized"
  | "waiting-children"
  | "completed"
  | "failed"
  | "unknown";

/** What a processor receives: a frozen copy, never the library's job object. */
export interface DispatchJobView {
  readonly id: string;
  readonly data: unknown;
  readonly attemptsMade: number;
}

/**
 * A job read back through the queue handle: the view plus its stored retention
 * options and its fingerprint (Task 012B-3; B2-7, FD-17).
 *
 * Sources: `id`, `data`, `removeOnFail` and `removeOnComplete` come from the
 * library's job read; `attemptsMade`, both times and both digests come from
 * the one HMGET of the job's hash. [I: the two reads can see different
 * moments; run 2 §5.3.] An absent field is absent: no own property, never a
 * property holding undefined. The stored texts themselves never leave the
 * module.
 */
export interface DispatchJobRecord extends DispatchJobView {
  readonly removeOnFail: unknown;
  readonly removeOnComplete: unknown;
  /** Epoch milliseconds the job was moved to active. */
  readonly processedOn?: number;
  /** Epoch milliseconds the job finished. */
  readonly finishedOn?: number;
  /** Lower-case hex SHA-256 of the stored return-value bytes. */
  readonly returnValueSha256?: string;
  /** Lower-case hex SHA-256 of the stored failure-reason bytes. */
  readonly failedReasonSha256?: string;
}

/** What retire() reports: only the generation's lifetime readiness (FD-20). */
export interface DispatchRetirement {
  readonly everReady: boolean;
}

/** Receives the classified code of each queue or probe connection error event (B2-6). */
export type DispatchErrorObserver = (code: string) => void;

export interface DispatchJobCounts {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly prioritized: number;
  readonly "waiting-children": number;
  readonly completed: number;
  readonly failed: number;
}

/**
 * The dispatch queue. Publication goes only through publishDispatchJob; the
 * handle itself offers close(), retire() and read-only inspection. close() is
 * the forced route: it retires the generation (a forced disconnect, never an
 * awaited QUIT) and awaits the one closing promise (FD-15(a), FD-20).
 */
export interface DispatchQueueHandle {
  close(): Promise<void>;
  getJobState(jobId: string): Promise<DispatchJobState>;
  getJob(jobId: string): Promise<DispatchJobRecord | undefined>;
  getJobCounts(): Promise<DispatchJobCounts>;
  /** Synchronous and idempotent: captures everReady, blocks further operations, initiates the forced close. */
  retire(): DispatchRetirement;
}

/** The separate, bounded probe connection (FD-19): PING only, the same forced retirement. */
export interface DispatchProbeHandle {
  close(): Promise<void>;
  ping(): Promise<void>;
  retire(): DispatchRetirement;
}

export interface DispatchWorkerHandle {
  close(): Promise<void>;
  /** Resolves once the worker's connections are ready. */
  waitUntilReady(): Promise<void>;
}

/** Returning completes the job; throwing fails it. */
export type DispatchProcessor = (job: DispatchJobView) => Promise<void>;
