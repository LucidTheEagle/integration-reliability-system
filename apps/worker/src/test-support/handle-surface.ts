// The handle-surface check of the ENCAPSULATION RULE (012A-3 prompt step 2
// and 3c): a handle exposes exactly its designed methods, on the object and
// its prototype chain up to Object.prototype, and no member holds or is a
// library or Redis-client object. Problems name a member, never a value.

export const QUEUE_HANDLE_METHODS: readonly string[] = Object.freeze(["close", "getJob", "getJobCounts", "getJobState"]);
export const WORKER_HANDLE_METHODS: readonly string[] = Object.freeze(["close", "waitUntilReady"]);

/** Class names of the library's and the Redis client's objects. */
const RAW_CLASS_NAMES = new Set([
  "Queue",
  "Worker",
  "Job",
  "QueueBase",
  "QueueGetters",
  "QueueEvents",
  "FlowProducer",
  "RedisConnection",
  "RedisQueueBackend",
  "Redis",
  "Cluster",
]);

function isClass(value: Function): boolean {
  return /^class\b/.test(Function.prototype.toString.call(value));
}

/**
 * Every problem with the handle's surface; an empty list means it passes.
 * `forbidden` lists objects that must not be any member's value.
 */
export function handleSurfaceProblems(
  handle: object,
  designed: readonly string[],
  forbidden: readonly unknown[] = [],
): string[] {
  const problems: string[] = [];
  const found = new Set<string>();
  let current: object | null = handle;
  for (let depth = 0; current !== null && current !== Object.prototype; depth++) {
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === "symbol") {
        problems.push(`a symbol-keyed member at depth ${depth}`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined) continue;
      const value: unknown = descriptor.value;
      if (depth > 0 && key === "constructor") {
        if (typeof value === "function" && RAW_CLASS_NAMES.has(value.name)) problems.push("the prototype is a library class");
        continue;
      }
      if (!designed.includes(key)) problems.push(`member ${key} is not designed`);
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        problems.push(`member ${key} is an accessor`);
        continue;
      }
      if (forbidden.includes(value)) problems.push(`member ${key} holds a forbidden object`);
      if (typeof value !== "function") {
        problems.push(`member ${key} is not a method`);
        continue;
      }
      if (RAW_CLASS_NAMES.has(value.name) || isClass(value)) problems.push(`member ${key} is a class`);
      if (value.name.startsWith("bound ")) problems.push(`member ${key} is a bound function`);
      found.add(key);
    }
    current = Object.getPrototypeOf(current);
  }
  for (const name of designed) {
    if (!found.has(name)) problems.push(`designed method ${name} is missing`);
  }
  return problems;
}
