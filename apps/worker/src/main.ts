import { loadWorkerConfig } from "@irs/config";
import { classifyDatabaseError, createDatabase, disconnectWithin, verifySchemaReadiness } from "@irs/db";
import { assertEventStateTransition } from "@irs/domain";
import { requireAuditIdGenerator } from "./audit-id.js";
import { openDispatchProbe, openDispatchQueue, publishDispatchJob } from "./dispatch-queue/index.js";
import { runWorker } from "./lifecycle.js";
import { loadRedisPassword } from "./redis-password.js";
import { REPOSITORY_ROOT } from "./repository-root.js";

// The worker process entry (Task 012B-3; B2-1, B2-5). Composition only: the
// real dependencies passed to runWorker. No test imports or runs this file;
// the lifecycle is tested in-process with injected dependencies. There is
// deliberately no unhandledRejection or uncaughtException handler: Node's
// default fail-closed termination applies to a defect. Running it against
// irs_dev is deferred to the Task 012 close (B1-9).

/** Live timers by opaque key, so that the injected clearTimer needs no type assertion. */
const timers = new Map<object, NodeJS.Timeout>();

const exitCode = runWorker({
  env: process.env,
  repositoryRoot: REPOSITORY_ROOT,
  loadWorkerConfig,
  loadRedisPassword,
  requireAuditIdGenerator: () => requireAuditIdGenerator(),
  assertEventStateTransition,
  createDatabase,
  verifySchemaReadiness,
  disconnectWithin,
  classifyDatabaseError,
  openQueue: openDispatchQueue,
  openProbe: openDispatchProbe,
  publishWith: publishDispatchJob,
  write: (line) => {
    process.stdout.write(line);
  },
  now: () => performance.now(),
  setTimer: (callback, ms) => {
    const key = {};
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        callback();
      }, ms),
    );
    return key;
  },
  clearTimer: (ref) => {
    if (typeof ref !== "object" || ref === null) return;
    const timer = timers.get(ref);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(ref);
  },
  random: () => Math.random(),
  onSignal: (handler) => {
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  },
});

void exitCode.then((code) => {
  // The exit happens after the last line is flushed.
  process.stdout.write("", () => {
    process.exit(code);
  });
});
