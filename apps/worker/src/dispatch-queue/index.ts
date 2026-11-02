import { BULLMQ_FACTORIES, openDispatchProbeWith, openDispatchQueueWith, publishJob, startDispatchWorkerWith } from "./implementation.js";
import type {
  DispatchErrorObserver,
  DispatchJobData,
  DispatchProbeHandle,
  DispatchProcessor,
  DispatchQueueHandle,
  DispatchSettings,
  DispatchWorkerHandle,
  DispatchWorkerSettings,
} from "./types.js";

// Public entry of the central dispatch-queue module (Task 012A record §8 A1;
// addendum §3.2, §3.4). Code outside apps/worker/src/dispatch-queue/ imports
// this file only. Every export takes and returns plain data or an opaque
// handle.

export {
  DISPATCH_JOB_OPTIONS,
  DISPATCH_QUEUE_NAME,
  DispatchQueueError,
  DispatchRedisError,
  checkJobOptions,
  checkJobRemoveOnComplete,
  checkJobRemoveOnFail,
  checkWorkerOptions,
  checkWorkerRemoveOnComplete,
  checkWorkerRemoveOnFail,
} from "./policy.js";
export type { DispatchQueueCheck } from "./policy.js";
export type {
  DispatchErrorObserver,
  DispatchJobCounts,
  DispatchJobData,
  DispatchJobRecord,
  DispatchJobState,
  DispatchJobView,
  DispatchJsonValue,
  DispatchProbeHandle,
  DispatchProcessor,
  DispatchQueueHandle,
  DispatchRetirement,
  DispatchSettings,
  DispatchWorkerHandle,
  DispatchWorkerSettings,
} from "./types.js";

/**
 * Opens the dispatch queue (producer side) with the fixed name and default job
 * options. `onError`, if given, receives the classified code of each
 * connection error event (B2-6).
 */
export function openDispatchQueue(settings: DispatchSettings, onError?: DispatchErrorObserver): DispatchQueueHandle {
  return openDispatchQueueWith(BULLMQ_FACTORIES, settings, onError);
}

/** Opens the separate, bounded probe connection (FD-19): PING only. */
export function openDispatchProbe(settings: DispatchSettings, onError?: DispatchErrorObserver): DispatchProbeHandle {
  return openDispatchProbeWith(BULLMQ_FACTORIES, settings, onError);
}

/**
 * The only sanctioned publication path. The job id is the event id, which
 * must be a lower-case UUID; removeOnFail and removeOnComplete are set on the
 * job by this function and cannot be passed. Resolves to the job id.
 */
export function publishDispatchJob(handle: DispatchQueueHandle, eventId: string, data: DispatchJobData): Promise<string> {
  return publishJob(handle, eventId, data);
}

/** Starts a worker on the dispatch queue (Task 013 and the tests). */
export function startDispatchWorker(settings: DispatchWorkerSettings, processor: DispatchProcessor): DispatchWorkerHandle {
  return startDispatchWorkerWith(BULLMQ_FACTORIES, settings, processor);
}
