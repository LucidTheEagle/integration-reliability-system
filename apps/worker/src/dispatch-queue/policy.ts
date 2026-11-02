// The dispatch-queue policy (addendum §3.2 rules 1-3, §3.3 connection
// settings, §3.4; Task 012A record §8 A1, A2): the fixed queue name, the
// retention options, the connection profiles and the rules that refuse any
// conflicting value. Plain data only. A refusal names the failed check and
// never echoes the value.

import { createHash } from "node:crypto";

export const DISPATCH_QUEUE_NAME = "irs-event-dispatch";

/** The name every dispatch job is added under. */
export const DISPATCH_JOB_NAME = "dispatch";

/** Completed-job retention (addendum §3.4; provisional under O-013). */
export const DISPATCH_REMOVE_ON_COMPLETE = Object.freeze({ age: 3600, count: 5000 });

/** The queue's default job options; publishDispatchJob also sets both on every job. */
export const DISPATCH_JOB_OPTIONS = Object.freeze({
  removeOnFail: false,
  removeOnComplete: DISPATCH_REMOVE_ON_COMPLETE,
});

/**
 * Producer (Queue) connection: addendum §3.3's provisional settings (O-013).
 * retryStrategy is left unset, so the library's default applies.
 */
export const PRODUCER_CONNECTION_PROFILE = Object.freeze({
  enableOfflineQueue: false,
  commandTimeout: 2000,
  connectTimeout: 2000,
  maxRetriesPerRequest: 0,
});

/**
 * Worker connection: maxRetriesPerRequest null, which the library requires of
 * a blocking connection. commandTimeout is not set: it would also bound the
 * worker's blocking fetch, which waits up to 5 s when the queue is empty.
 * The other §3.3 settings are kept.
 */
export const WORKER_CONNECTION_PROFILE = Object.freeze({
  enableOfflineQueue: false,
  connectTimeout: 2000,
  maxRetriesPerRequest: null,
});

export type DispatchQueueCheck =
  | "event-id"
  | "job-data"
  | "settings"
  | "processor"
  | "handle"
  | "job-id"
  | "job-state"
  | "job-remove-on-fail"
  | "job-remove-on-complete"
  | "worker-remove-on-fail"
  | "worker-remove-on-complete"
  | "retired";

export class DispatchQueueError extends Error {
  override readonly name = "DispatchQueueError";
  constructor(
    readonly check: DispatchQueueCheck,
    detail: string,
  ) {
    super(`dispatch queue refused (${check}): ${detail}`);
  }
}

/** A failed Redis operation, carrying only a classified code (never a message). */
export class DispatchRedisError extends Error {
  override readonly name = "DispatchRedisError";
  constructor(readonly code: string) {
    super(`dispatch queue Redis operation failed (${code})`);
  }
}

/**
 * The specific code of a Redis or client error: the first word of a Redis
 * error reply, a Node system error code, or a fixed code for the client's own
 * known errors. Anything else is UNCLASSIFIED.
 */
export function classifyRedisError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ReplyError") {
      const word = error.message.split(" ", 1)[0] ?? "";
      return /^[A-Z][A-Z_-]*$/.test(word) ? word : "UNCLASSIFIED";
    }
    if (error.name === "MaxRetriesPerRequestError") return "MAX_RETRIES_PER_REQUEST";
    if (error.name === "ConnectionClosedError" || error.message === "Connection is closed.") return "CONNECTION_CLOSED";
    if (error.message === "Command timed out") return "COMMAND_TIMEOUT";
    if (error.message === "Stream isn't writeable and enableOfflineQueue options is false") return "OFFLINE";
  }
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^E[A-Z_]+$/.test(code) ? code : "UNCLASSIFIED";
}

/** Canonical lower-case UUID text, so that one event can never map to two job ids. */
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function checkEventId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value)) {
    throw new DispatchQueueError("event-id", "the event id must be a lower-case UUID");
  }
}

function ownValue(record: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exactly { age: 3600, count: 5000 }: two own data properties, nothing else. */
function isRetentionPolicy(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Reflect.ownKeys(value).length === 2 &&
    ownValue(value, "age") === DISPATCH_REMOVE_ON_COMPLETE.age &&
    ownValue(value, "count") === DISPATCH_REMOVE_ON_COMPLETE.count
  );
}

/** Job level: only false. true, any number (including 0) and any object are refused. */
export function checkJobRemoveOnFail(value: unknown): void {
  if (value !== false) {
    throw new DispatchQueueError("job-remove-on-fail", "a dispatch job must set removeOnFail to false");
  }
}

/** Job level: only { age: 3600, count: 5000 }. */
export function checkJobRemoveOnComplete(value: unknown): void {
  if (!isRetentionPolicy(value)) {
    throw new DispatchQueueError("job-remove-on-complete", "a dispatch job must set removeOnComplete to the policy");
  }
}

/** Worker level: removeOnFail must be absent; any value, even undefined, is refused. */
export function checkWorkerRemoveOnFail(options: object): void {
  if (Object.hasOwn(options, "removeOnFail")) {
    throw new DispatchQueueError("worker-remove-on-fail", "a dispatch worker must not set removeOnFail");
  }
}

/** Worker level: only the KeepJobs object { age: 3600, count: 5000 }. */
export function checkWorkerRemoveOnComplete(value: unknown): void {
  if (!isRetentionPolicy(value)) {
    throw new DispatchQueueError("worker-remove-on-complete", "a dispatch worker must set removeOnComplete to the policy");
  }
}

/** Both job-level rules, applied to a job-options record. */
export function checkJobOptions(options: object): void {
  checkJobRemoveOnFail(ownValue(options, "removeOnFail"));
  checkJobRemoveOnComplete(ownValue(options, "removeOnComplete"));
}

/** Both worker-level rules, applied to a worker-options record. */
export function checkWorkerOptions(options: object): void {
  checkWorkerRemoveOnFail(options);
  checkWorkerRemoveOnComplete(ownValue(options, "removeOnComplete"));
}

function settingsRefusal(field: string): DispatchQueueError {
  return new DispatchQueueError("settings", `${field} is malformed`);
}

/** Shape checks of the plain-data settings; values are never echoed. */
export function checkConnectionSettings(settings: object): void {
  const host = ownValue(settings, "host");
  const port = ownValue(settings, "port");
  const password = ownValue(settings, "password");
  const prefix = ownValue(settings, "prefix");
  if (typeof host !== "string" || host === "") throw settingsRefusal("host");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw settingsRefusal("port");
  if (typeof password !== "string" || password === "") throw settingsRefusal("password");
  if (prefix !== undefined && (typeof prefix !== "string" || prefix === "")) throw settingsRefusal("prefix");
}

export function checkConcurrency(value: unknown): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
    throw settingsRefusal("concurrency");
  }
}

export function checkJobData(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new DispatchQueueError("job-data", "the job data must be a plain object");
  }
}

// ---- the job fingerprint read (Task 012B-3: FD-16, FD-17, FD-18 B-2, FD-20; PD-4) ----

/**
 * The job-hash fields the one atomic read takes, in this order (PD-4). The
 * key is derived from the job id inside the module; no caller supplies a key
 * or a field list.
 */
export const JOB_HASH_FIELDS = Object.freeze(["atm", "processedOn", "finishedOn", "returnvalue", "failedReason"] as const);

/** The fixed code of a refused job-hash reply (FD-20). */
export const JOB_HASH_FORMAT = "JOB_HASH_FORMAT";

/** True only for the exact string PONG. */
export function isPongReply(value: unknown): boolean {
  return value === "PONG";
}

function jobHashFormat(): DispatchRedisError {
  return new DispatchRedisError(JOB_HASH_FORMAT);
}

/**
 * A stored decimal number: 1 to 16 ASCII digits in canonical form ("0", or no
 * leading zero), then a non-negative safe integer. Never JSON.parse, parseInt
 * or Number alone. A nil field is absent.
 */
function storedNumber(value: Buffer | null): number | undefined {
  if (value === null) return undefined;
  if (value.length < 1 || value.length > 16) throw jobHashFormat();
  for (const byte of value) {
    if (byte < 0x30 || byte > 0x39) throw jobHashFormat();
  }
  if (value.length > 1 && value[0] === 0x30) throw jobHashFormat();
  const parsed = Number(value.toString("latin1"));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw jobHashFormat();
  return parsed;
}

/** SHA-256 of the exact stored bytes, lower-case hex, with no decoding. A nil field is absent. */
function storedDigest(value: Buffer | null): string | undefined {
  return value === null ? undefined : createHash("sha256").update(value).digest("hex");
}

/**
 * Parses the reply of HMGET <job key> atm processedOn finishedOn returnvalue
 * failedReason (run 2 §3.5): an array of exactly five elements, each a Buffer
 * or null. Absent fields are omitted (no property holding undefined); an
 * absent atm means attemptsMade 0 (the library's own convention). The stored
 * texts are hashed byte for byte: a completion with no return value stores the
 * 4 bytes `null`, which are hashed (FD-18 B-2); failedReason is hashed
 * whichever writer stored it (F-FAILEDREASON-2W). Any other shape or form is
 * refused with JOB_HASH_FORMAT, which carries no byte, text or number of the
 * reply.
 */
export function parseJobHash(reply: unknown): {
  attemptsMade: number;
  processedOn?: number;
  finishedOn?: number;
  returnValueSha256?: string;
  failedReasonSha256?: string;
} {
  if (!Array.isArray(reply) || reply.length !== JOB_HASH_FIELDS.length) throw jobHashFormat();
  const elements: unknown[] = reply;
  const values: (Buffer | null)[] = [];
  for (const element of elements) {
    if (element === null) values.push(null);
    else if (Buffer.isBuffer(element)) values.push(element);
    else throw jobHashFormat();
  }
  const field = (index: number): Buffer | null => values[index] ?? null;
  const attempts = storedNumber(field(0));
  const processedOn = storedNumber(field(1));
  const finishedOn = storedNumber(field(2));
  const returnValueSha256 = storedDigest(field(3));
  const failedReasonSha256 = storedDigest(field(4));
  const fields: {
    attemptsMade: number;
    processedOn?: number;
    finishedOn?: number;
    returnValueSha256?: string;
    failedReasonSha256?: string;
  } = { attemptsMade: attempts ?? 0 };
  if (processedOn !== undefined) fields.processedOn = processedOn;
  if (finishedOn !== undefined) fields.finishedOn = finishedOn;
  if (returnValueSha256 !== undefined) fields.returnValueSha256 = returnValueSha256;
  if (failedReasonSha256 !== undefined) fields.failedReasonSha256 = failedReasonSha256;
  return Object.freeze(fields);
}
