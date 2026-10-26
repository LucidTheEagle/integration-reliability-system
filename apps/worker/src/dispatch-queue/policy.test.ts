import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_JOB_OPTIONS,
  DISPATCH_QUEUE_NAME,
  DispatchQueueError,
  checkJobOptions,
  checkJobRemoveOnComplete,
  checkJobRemoveOnFail,
  checkWorkerOptions,
  checkWorkerRemoveOnComplete,
  checkWorkerRemoveOnFail,
  publishDispatchJob,
} from "./index.js";
import type { DispatchQueueCheck, DispatchQueueHandle } from "./index.js";
import { openDispatchQueueWith, startDispatchWorkerWith } from "./implementation.js";
import type { BullmqFactories, RawQueue, RawWorker } from "./implementation.js";

// Redis-free tests of the dispatch-queue policy (addendum §3.2 rule 3 and 6a;
// Task 012A record §8 A2). One test per rule; the module's own options must
// pass every rule. No connection is made.

function refusedBy(check: DispatchQueueCheck, action: () => unknown, hidden: readonly string[] = []): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DispatchQueueError, "expected a DispatchQueueError");
    assert.equal(error.check, check);
    for (const text of hidden) {
      assert.ok(!error.message.includes(text), "a refusal never echoes the value");
    }
    return true;
  });
}

async function rejectedBy(check: DispatchQueueCheck, action: () => Promise<unknown>, hidden: readonly string[] = []): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DispatchQueueError, "expected a DispatchQueueError");
    assert.equal(error.check, check);
    for (const text of hidden) {
      assert.ok(!error.message.includes(text), "a refusal never echoes the value");
    }
    return true;
  });
}

/** Inert doubles that record the options the module builds. Nothing connects. */
function recordingFactories(): { factories: BullmqFactories; queueOptions: object[]; workerOptions: object[] } {
  const queueOptions: object[] = [];
  const workerOptions: object[] = [];
  const queue: RawQueue = {
    add: async () => ({}),
    getJob: async () => undefined,
    getJobState: async () => "unknown",
    getJobCounts: async () => ({}),
    on: () => undefined,
    close: async () => undefined,
  };
  const worker: RawWorker = { on: () => undefined, waitUntilReady: async () => undefined, close: async () => undefined };
  return {
    queueOptions,
    workerOptions,
    factories: {
      createQueue: (_name: string, options: object) => {
        queueOptions.push(options);
        return queue;
      },
      createWorker: (_name: string, _processor: unknown, options: object) => {
        workerOptions.push(options);
        return worker;
      },
    },
  };
}

const SETTINGS = { host: "127.0.0.1", port: 46379, password: "not-a-real-password" };
const POLICY = { age: 3600, count: 5000 };

describe("dispatch policy: constants", () => {
  it("fixes the queue name and the job options", () => {
    assert.equal(DISPATCH_QUEUE_NAME, "irs-event-dispatch");
    assert.deepEqual(DISPATCH_JOB_OPTIONS, { removeOnFail: false, removeOnComplete: POLICY });
    assert.ok(Object.isFrozen(DISPATCH_JOB_OPTIONS) && Object.isFrozen(DISPATCH_JOB_OPTIONS.removeOnComplete));
  });
});

describe("dispatch policy: job-level removeOnFail", () => {
  it("accepts only false", () => {
    checkJobRemoveOnFail(false);
  });

  it("refuses true", () => {
    refusedBy("job-remove-on-fail", () => checkJobRemoveOnFail(true));
  });

  it("refuses 0", () => {
    refusedBy("job-remove-on-fail", () => checkJobRemoveOnFail(0));
  });

  it("refuses a positive number", () => {
    refusedBy("job-remove-on-fail", () => checkJobRemoveOnFail(10), ["10"]);
  });

  it("refuses a count object", () => {
    refusedBy("job-remove-on-fail", () => checkJobRemoveOnFail({ count: 100 }), ["100"]);
  });

  it("refuses an age object", () => {
    refusedBy("job-remove-on-fail", () => checkJobRemoveOnFail({ age: 86400 }), ["86400"]);
  });

  it("refuses an absent value", () => {
    refusedBy("job-remove-on-fail", () => checkJobRemoveOnFail(undefined));
    refusedBy("job-remove-on-fail", () => checkJobOptions({ removeOnComplete: POLICY }));
  });
});

describe("dispatch policy: job-level removeOnComplete", () => {
  it("accepts only { age: 3600, count: 5000 }", () => {
    checkJobRemoveOnComplete({ age: 3600, count: 5000 });
    checkJobRemoveOnComplete(DISPATCH_JOB_OPTIONS.removeOnComplete);
  });

  it("refuses any other value", () => {
    const others: unknown[] = [
      undefined,
      false,
      true,
      0,
      5000,
      { count: 5000 },
      { age: 3600 },
      { age: 3600, count: 4999 },
      { age: 3601, count: 5000 },
      { age: 3600, count: 5000, limit: 1 },
      { age: "3600", count: 5000 },
      [3600, 5000],
      Object.defineProperty({ count: 5000 }, "age", { get: () => 3600, enumerable: true }),
    ];
    for (const value of others) {
      refusedBy("job-remove-on-complete", () => checkJobRemoveOnComplete(value), ["4999", "3601"]);
    }
  });
});

describe("dispatch policy: worker-level removeOnFail", () => {
  it("accepts only an absent option", () => {
    checkWorkerRemoveOnFail({ removeOnComplete: POLICY });
  });

  it("refuses a count object", () => {
    refusedBy("worker-remove-on-fail", () => checkWorkerRemoveOnFail({ removeOnFail: { count: 1 } }));
  });

  it("refuses an age object", () => {
    refusedBy("worker-remove-on-fail", () => checkWorkerRemoveOnFail({ removeOnFail: { age: 1 } }));
  });

  it("refuses any other value, supplied through an untyped input", () => {
    for (const text of ['{"removeOnFail":false}', '{"removeOnFail":true}', '{"removeOnFail":0}', '{"removeOnFail":null}']) {
      const untyped: object = JSON.parse(text);
      refusedBy("worker-remove-on-fail", () => checkWorkerRemoveOnFail(untyped));
    }
    refusedBy("worker-remove-on-fail", () => checkWorkerRemoveOnFail({ removeOnFail: undefined }));
  });
});

describe("dispatch policy: worker-level removeOnComplete", () => {
  it("accepts only the KeepJobs object { age: 3600, count: 5000 }", () => {
    checkWorkerRemoveOnComplete({ age: 3600, count: 5000 });
  });

  it("refuses any other value", () => {
    const others: unknown[] = [undefined, true, false, 0, 5000, { count: 5000 }, { age: 3600 }, { age: 3600, count: 5001 }];
    for (const value of others) {
      refusedBy("worker-remove-on-complete", () => checkWorkerRemoveOnComplete(value), ["5001"]);
    }
  });
});

describe("dispatch policy: the module's own options", () => {
  it("pass every job-level rule, as queue default and on every published job", async () => {
    checkJobOptions(DISPATCH_JOB_OPTIONS);
    const { factories, queueOptions } = recordingFactories();
    const added: object[] = [];
    const recordingAdd: BullmqFactories = {
      ...factories,
      createQueue: (name, options) => {
        const queue = factories.createQueue(name, options);
        return {
          ...queue,
          add: async (_jobName, _data, jobOptions) => {
            added.push(jobOptions);
            return { id: jobOptions.jobId };
          },
        };
      },
    };
    const handle = openDispatchQueueWith(recordingAdd, SETTINGS);
    await publishDispatchJob(handle, "0199f8a0-0000-7000-8000-000000000001", { probe: true });
    const defaults = queueOptions[0];
    assert.ok(defaults !== undefined);
    checkJobOptions(Object.getOwnPropertyDescriptor(defaults, "defaultJobOptions")?.value);
    assert.equal(added.length, 1);
    const published = added[0];
    assert.ok(published !== undefined);
    checkJobOptions(published);
  });

  it("pass every worker-level rule", () => {
    const { factories, workerOptions } = recordingFactories();
    startDispatchWorkerWith(factories, SETTINGS, async () => undefined);
    const options = workerOptions[0];
    assert.ok(options !== undefined);
    checkWorkerOptions(options);
  });
});

describe("dispatch policy: event ids", () => {
  it("refuses a non-UUID eventId without echoing it, before any Redis call", async () => {
    const { factories } = recordingFactories();
    const handle = openDispatchQueueWith(factories, SETTINGS);
    const bad = [
      "",
      "not-a-uuid",
      "12345",
      "0199F8A0-0000-7000-8000-000000000001",
      "{0199f8a0-0000-7000-8000-000000000001}",
      "0199f8a0-0000-7000-8000-000000000001\n",
      "0199f8a0-0000-7000-8000-0000000000012",
      "secret-looking-value-0123456789abcdef",
    ];
    for (const eventId of bad) {
      await rejectedBy("event-id", () => publishDispatchJob(handle, eventId, {}), eventId === "" ? [] : [eventId.trim()]);
    }
    const untyped: string = JSON.parse("42");
    await rejectedBy("event-id", () => publishDispatchJob(handle, untyped, {}));
  });

  it("refuses a handle that openDispatchQueue did not return", async () => {
    const forged: DispatchQueueHandle = {
      close: async () => undefined,
      getJobState: async () => "unknown",
      getJob: async () => undefined,
      getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, prioritized: 0, "waiting-children": 0, completed: 0, failed: 0 }),
    };
    await rejectedBy("handle", () => publishDispatchJob(forged, "0199f8a0-0000-7000-8000-000000000001", {}));
  });
});

describe("dispatch policy: settings", () => {
  it("refuses malformed settings without echoing them", () => {
    const { factories } = recordingFactories();
    const cases: object[] = [
      { ...SETTINGS, host: "" },
      { ...SETTINGS, port: 0 },
      { ...SETTINGS, port: 65536 },
      { ...SETTINGS, password: "" },
      { ...SETTINGS, prefix: "" },
    ];
    for (const settings of cases) {
      const untyped: typeof SETTINGS = JSON.parse(JSON.stringify(settings));
      refusedBy("settings", () => openDispatchQueueWith(factories, untyped), [SETTINGS.password]);
    }
    refusedBy("settings", () => startDispatchWorkerWith(factories, { ...SETTINGS, concurrency: 0 }, async () => undefined));
  });
});
