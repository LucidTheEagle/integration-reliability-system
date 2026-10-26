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

/** A job read back through the queue handle: the view plus its stored retention options. */
export interface DispatchJobRecord extends DispatchJobView {
  readonly removeOnFail: unknown;
  readonly removeOnComplete: unknown;
}

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
 * handle itself offers close() and read-only inspection.
 */
export interface DispatchQueueHandle {
  close(): Promise<void>;
  getJobState(jobId: string): Promise<DispatchJobState>;
  getJob(jobId: string): Promise<DispatchJobRecord | undefined>;
  getJobCounts(): Promise<DispatchJobCounts>;
}

export interface DispatchWorkerHandle {
  close(): Promise<void>;
  /** Resolves once the worker's connections are ready. */
  waitUntilReady(): Promise<void>;
}

/** Returning completes the job; throwing fails it. */
export type DispatchProcessor = (job: DispatchJobView) => Promise<void>;
