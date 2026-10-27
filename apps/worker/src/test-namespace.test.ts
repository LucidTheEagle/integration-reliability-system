import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { REPOSITORY_ROOT } from "./repository-root.js";
import {
  REGISTERED_TARGET,
  RedisGuardRefusal,
  checkSentinelValue,
  guardedDispatchSettings,
  namespaceKeyCount,
  validateRedisTarget,
} from "./test-support/redis-guard.js";
import type { InheritedEnv, RedisTestTarget } from "./test-support/redis-guard.js";
import { SENTINEL_KEY, SENTINEL_MARKER, TEST_NAMESPACE_STEM } from "./test-support/redis-registry.js";
import {
  MAX_SCAN_STEPS,
  NamespaceCleanupFailure,
  NamespaceRefusal,
  ScanIncomplete,
  checkNamespacePrefix,
  createNamespaceIssuer,
  scanAll,
} from "./test-support/test-namespace.js";
import type { NamespaceCheck, NamespaceStore, TestNamespace } from "./test-support/test-namespace.js";

// Test namespaces and their cleanup (D-F2 rule 1; 012B record Part A2), with
// no Redis: each issuer here is built over an in-memory store, with the real
// guard checks (validateRedisTarget, checkSentinelValue). The issuer the Redis
// tests use is bound in redis-guard.ts to the guarded store; its refusals
// before any connection are checked at the end.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALID_UUID = "6f1c2a4e-8b3d-4c5e-9f60-718293a4b5c6";

/** An in-memory test Redis: keys, the sentinel, and a record of every store call. */
interface Fake {
  readonly keys: Set<string>;
  sentinel: string | null;
  readonly events: string[];
  /** Every key passed for deletion, in order. */
  readonly deleted: string[];
  deletionCalls: number;
  scanCalls: number;
  opened: number;
  closed: number;
}

interface HarnessOptions {
  readonly target?: RedisTestTarget;
  readonly env?: InheritedEnv;
  /** A scripted reply for SCAN call `n` (0-based, across the store); undefined: the fake's own. */
  readonly scanReply?: (n: number, prefix: string, fake: Fake) => unknown;
  /** Makes deletion call `n` (0-based) fail. */
  readonly deletionFails?: (n: number) => boolean;
  /** Deletion "succeeds" but removes nothing. */
  readonly deletionIgnored?: boolean;
  readonly openFails?: () => Error;
  readonly closeFails?: () => Error;
  readonly newId?: () => string;
}

function harness(options: HarnessOptions = {}) {
  const fake: Fake = {
    keys: new Set<string>(),
    sentinel: SENTINEL_MARKER,
    events: [],
    deleted: [],
    deletionCalls: 0,
    scanCalls: 0,
    opened: 0,
    closed: 0,
  };
  const openStore = async (_target: RedisTestTarget, _env: InheritedEnv, prefix: string): Promise<NamespaceStore> => {
    fake.events.push("open");
    if (options.openFails !== undefined) throw options.openFails();
    fake.opened++;
    return {
      readSentinel: async () => {
        fake.events.push("sentinel");
        return fake.sentinel;
      },
      scan: async (cursor: string) => {
        const n = fake.scanCalls++;
        fake.events.push("scan");
        const scripted = options.scanReply?.(n, prefix, fake);
        if (scripted !== undefined) return scripted;
        assert.equal(cursor, "0", "the fake answers in a single step");
        return ["0", [...fake.keys].filter((key) => key.startsWith(`${prefix}:`))];
      },
      unlink: async (keys: readonly string[]) => {
        const n = fake.deletionCalls++;
        fake.events.push(`deletion:${keys.length}`);
        if (options.deletionFails?.(n) === true) throw new Error("injected deletion failure");
        fake.deleted.push(...keys);
        if (options.deletionIgnored !== true) for (const key of keys) fake.keys.delete(key);
        return keys.length;
      },
      close: async () => {
        fake.events.push("close");
        fake.closed++;
        if (options.closeFails !== undefined) throw options.closeFails();
      },
    };
  };
  const issuer = createNamespaceIssuer({
    target: options.target ?? REGISTERED_TARGET,
    env: options.env ?? {},
    validateTarget: validateRedisTarget,
    checkSentinel: checkSentinelValue,
    openStore,
    newId: options.newId,
  });
  return { fake, issuer };
}

/** A test context double: records after-hooks; runAfter runs them as node:test does, with the context itself. */
class FakeContext {
  readonly hooks: ((context: unknown) => Promise<void>)[] = [];
  after(hook: (context: unknown) => Promise<void>): void {
    this.hooks.push(hook);
  }
  async runAfter(): Promise<void> {
    for (const hook of this.hooks) await hook(this);
  }
}

function seed(fake: Fake, prefix: string, count: number): void {
  for (let n = 0; n < count; n++) fake.keys.add(`${prefix}:irs-dispatch-test:${n}`);
}

async function failsAt(step: NamespaceCleanupFailure["step"], action: Promise<unknown>): Promise<NamespaceCleanupFailure> {
  let caught: unknown;
  await assert.rejects(action, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof NamespaceCleanupFailure, `expected a NamespaceCleanupFailure, got ${String(caught)}`);
  assert.equal(caught.step, step);
  return caught;
}

function refusedBy(check: NamespaceCheck, action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof NamespaceRefusal && error.check === check);
}

describe("test namespaces: issuance", () => {
  it("issues irs-test-<label>-<uuid v4>, a new one each time", () => {
    const { issuer } = harness();
    const context = new FakeContext();
    const first = issuer.issue(context, "dispatch-smoke");
    const second = issuer.issue(context, "dispatch-smoke");
    for (const handle of [first, second]) {
      assert.ok(handle.prefix.startsWith(`${TEST_NAMESPACE_STEM}dispatch-smoke-`));
      assert.match(handle.prefix.slice(`${TEST_NAMESPACE_STEM}dispatch-smoke-`.length), UUID_V4);
      checkNamespacePrefix(handle.prefix);
    }
    assert.notEqual(first.prefix, second.prefix);
  });

  it("registers exactly one cleanup, on the issuing context's after-hook, per namespace", () => {
    const { issuer } = harness();
    const a = new FakeContext();
    const b = new FakeContext();
    issuer.issue(a, "one");
    issuer.issue(a, "two");
    issuer.issue(b, "three");
    assert.equal(a.hooks.length, 2);
    assert.equal(b.hooks.length, 1);
  });

  it("refuses a label that is not lower-case letters, digits and single hyphens, and issues nothing", () => {
    const { issuer } = harness();
    const context = new FakeContext();
    for (const label of ["", "Upper", "a--b", "-a", "a-", "a_b", "a*", "a:b", " a", "a b", "é"]) {
      refusedBy("label", () => issuer.issue(context, label));
    }
    refusedBy("label", () => issuer.issue(context, undefined as unknown as string));
    assert.equal(context.hooks.length, 0);
  });

  it("refuses anything that is not a test context with an after-hook", () => {
    const { issuer } = harness();
    for (const context of [null, undefined, {}, { after: 1 }, "t"]) {
      refusedBy("test-context", () => issuer.issue(context as unknown as FakeContext, "label"));
    }
  });

  it("refuses an identifier source that does not give a UUID v4, and registers nothing", () => {
    for (const id of ["", "not-a-uuid", "*", "0199f8a0-0000-7000-8000-000000000001", `${VALID_UUID}:x`]) {
      const { issuer } = harness({ newId: () => id });
      const context = new FakeContext();
      refusedBy("prefix-format", () => issuer.issue(context, "label"));
      assert.equal(context.hooks.length, 0);
    }
  });
});

describe("test namespaces: the handle", () => {
  it("is opaque and frozen: no prototype, exactly one member, the read-only prefix", () => {
    const { issuer } = harness();
    const handle = issuer.issue(new FakeContext(), "handle");
    assert.ok(Object.isFrozen(handle));
    assert.equal(Object.getPrototypeOf(handle), null);
    assert.deepEqual(Reflect.ownKeys(handle), ["prefix"]);
    const descriptor = Object.getOwnPropertyDescriptor(handle, "prefix");
    assert.equal(descriptor?.writable, false);
    assert.equal(descriptor?.configurable, false);
    assert.equal(descriptor?.get, undefined);
  });

  it("its prefix cannot be reassigned, redefined or deleted, and nothing can be added", () => {
    const { issuer } = harness();
    const handle = issuer.issue(new FakeContext(), "handle");
    const original = handle.prefix;
    assert.throws(() => {
      (handle as { prefix: string }).prefix = `${TEST_NAMESPACE_STEM}other-${VALID_UUID}`;
    }, TypeError);
    assert.throws(() => Object.defineProperty(handle, "prefix", { value: "x" }), TypeError);
    assert.throws(() => Reflect.deleteProperty(handle, "prefix") || assert.fail("delete refused"));
    assert.throws(() => Object.defineProperty(handle, "cleanup", { value: () => undefined }), TypeError);
    assert.equal(handle.prefix, original);
    assert.equal(issuer.activePrefix(handle), original);
  });

  it("the issuer exposes only issuance and two prefix lookups, none of which deletes", () => {
    const { issuer } = harness();
    assert.ok(Object.isFrozen(issuer));
    assert.deepEqual(Reflect.ownKeys(issuer).sort(), ["activePrefix", "issue", "issuedPrefix"]);
  });

  it("a handle not issued by this issuer is refused, even with a valid prefix", () => {
    const { issuer } = harness();
    const other = harness().issuer.issue(new FakeContext(), "other");
    const forged = Object.freeze({ prefix: `${TEST_NAMESPACE_STEM}forged-${VALID_UUID}` });
    for (const handle of [forged, other, Object.freeze({ ...other }), null, "x"]) {
      refusedBy("not-issued", () => issuer.activePrefix(handle as TestNamespace));
      refusedBy("not-issued", () => issuer.issuedPrefix(handle as TestNamespace));
    }
  });
});

describe("test namespaces: the prefix format (cleanup's second line of defence)", () => {
  it("accepts the registry's exact format", () => {
    checkNamespacePrefix(`${TEST_NAMESPACE_STEM}dispatch-smoke-${VALID_UUID}`);
    checkNamespacePrefix(`${TEST_NAMESPACE_STEM}a1-b2-${VALID_UUID}`);
  });

  it("refuses malformed, empty, glob-character and bare-stem prefixes", () => {
    for (const prefix of [
      "",
      TEST_NAMESPACE_STEM,
      `${TEST_NAMESPACE_STEM}-${VALID_UUID}`,
      `${TEST_NAMESPACE_STEM}label`,
      `${TEST_NAMESPACE_STEM}label-123`,
      `${TEST_NAMESPACE_STEM}Label-${VALID_UUID}`,
      `${TEST_NAMESPACE_STEM}a--b-${VALID_UUID}`,
      `${TEST_NAMESPACE_STEM}label-${VALID_UUID.toUpperCase()}`,
      `${TEST_NAMESPACE_STEM}label-${VALID_UUID}:`,
      `${TEST_NAMESPACE_STEM}*`,
      `${TEST_NAMESPACE_STEM}label-${VALID_UUID}*`,
      `${TEST_NAMESPACE_STEM}lab?l-${VALID_UUID}`,
      `${TEST_NAMESPACE_STEM}[a]-${VALID_UUID}`,
      `${TEST_NAMESPACE_STEM}a\\-${VALID_UUID}`,
      `irs:test:sentinel`,
      `bull-${VALID_UUID}`,
      ` ${TEST_NAMESPACE_STEM}label-${VALID_UUID}`,
    ]) {
      refusedBy("prefix-format", () => checkNamespacePrefix(prefix));
    }
    refusedBy("prefix-format", () => checkNamespacePrefix(undefined));
  });

  it("a format-valid namespace that is not active is refused by its cleanup, which then opens nothing", async () => {
    const { fake, issuer } = harness();
    const context = new FakeContext();
    const handle = issuer.issue(context, "twice");
    seed(fake, handle.prefix, 3);
    await context.runAfter();
    assert.equal(fake.opened, 1);
    await assert.rejects(context.runAfter(), (error: unknown) => error instanceof NamespaceRefusal && error.check === "not-issued");
    assert.equal(fake.opened, 1, "the second run opened no store");
    refusedBy("not-issued", () => issuer.activePrefix(handle));
    assert.equal(issuer.issuedPrefix(handle), handle.prefix, "still known for read-only checks");
  });
});

describe("test namespaces: cleanup is bound to the test it was issued to", () => {
  it("runs only when invoked with its own test context", async () => {
    const { fake, issuer } = harness();
    const context = new FakeContext();
    const handle = issuer.issue(context, "bound");
    seed(fake, handle.prefix, 2);
    const [hook] = context.hooks;
    assert.ok(hook !== undefined);
    await assert.rejects(hook(new FakeContext()), (error: unknown) => error instanceof NamespaceRefusal && error.check === "wrong-context");
    await assert.rejects(hook(undefined), (error: unknown) => error instanceof NamespaceRefusal && error.check === "wrong-context");
    assert.equal(fake.opened, 0);
    assert.equal(issuer.activePrefix(handle), handle.prefix, "still active, keys untouched");
    assert.equal(fake.keys.size, 2);
    await hook(context);
    assert.equal(fake.keys.size, 0);
  });

  it("with node:test: each test's after-hook runs after its body and cleans only its own namespace", async (t) => {
    const { fake, issuer } = harness();
    let outer: TestNamespace | undefined;
    let inner: TestNamespace | undefined;
    await t.test("P", async (p) => {
      outer = issuer.issue(p, "outer");
      seed(fake, outer.prefix, 3);
      await p.test("A", async (a) => {
        inner = issuer.issue(a, "inner");
        seed(fake, inner.prefix, 4);
        fake.events.push("A body end");
      });
      // A and its after-hook have finished; P's namespace is untouched.
      assert.ok(inner !== undefined);
      assert.equal([...fake.keys].filter((key) => key.startsWith(`${inner?.prefix}:`)).length, 0);
      assert.equal([...fake.keys].filter((key) => key.startsWith(`${outer?.prefix}:`)).length, 3);
      assert.ok(fake.deleted.every((key) => key.startsWith(`${inner?.prefix}:`)));
      fake.events.push("P body end");
    });
    assert.equal(fake.keys.size, 0, "P's own after-hook cleaned P's namespace after its body");
    assert.deepEqual(fake.events.slice(0, 2), ["A body end", "open"]);
    assert.ok(fake.events.indexOf("P body end") < fake.events.lastIndexOf("open"));
  });

  it("with node:test: the after-hook also runs when the test fails (R6.3)", async (t) => {
    const { fake, issuer } = harness();
    let prefix = "";
    await t.test("fails deliberately (todo: a control)", { todo: "deliberate failure, to show the hook still runs" }, async (s) => {
      prefix = issuer.issue(s, "fails").prefix;
      seed(fake, prefix, 2);
      fake.events.push("body");
      throw new Error("deliberate failure (control)");
    });
    assert.equal(fake.keys.size, 0);
    assert.deepEqual(fake.events, ["body", "open", "sentinel", "scan", "deletion:2", "scan", "close"]);
    assert.ok(prefix.startsWith(TEST_NAMESPACE_STEM));
  });
});

describe("test namespaces: cleanup deletes only its own keys", () => {
  it("removes every key of its namespace; another namespace's keys and the sentinel are untouched", async () => {
    const { fake, issuer } = harness();
    const a = new FakeContext();
    const b = new FakeContext();
    const mine = issuer.issue(a, "mine");
    const theirs = issuer.issue(b, "theirs");
    seed(fake, mine.prefix, 7);
    seed(fake, theirs.prefix, 5);
    fake.keys.add(SENTINEL_KEY);
    await a.runAfter();
    assert.deepEqual([...fake.keys].filter((key) => key.startsWith(`${mine.prefix}:`)), []);
    assert.equal([...fake.keys].filter((key) => key.startsWith(`${theirs.prefix}:`)).length, 5);
    assert.ok(fake.keys.has(SENTINEL_KEY));
    assert.equal(fake.sentinel, SENTINEL_MARKER);
    assert.equal(fake.deleted.length, 7);
    assert.ok(fake.deleted.every((key) => key.startsWith(`${mine.prefix}:`)));
    assert.equal(issuer.activePrefix(theirs), theirs.prefix);
  });

  it("an empty namespace deletes nothing and passes its post-check", async () => {
    const { fake, issuer } = harness();
    const context = new FakeContext();
    issuer.issue(context, "empty");
    await context.runAfter();
    assert.equal(fake.deletionCalls, 0);
    assert.deepEqual(fake.events, ["open", "sentinel", "scan", "scan", "close"]);
  });

  it("deletes in batches of explicit key names, then runs a complete second SCAN", async () => {
    const { fake, issuer } = harness();
    const context = new FakeContext();
    const handle = issuer.issue(context, "batches");
    seed(fake, handle.prefix, 1_201);
    await context.runAfter();
    assert.deepEqual(fake.events, ["open", "sentinel", "scan", "deletion:500", "deletion:500", "deletion:201", "scan", "close"]);
    assert.equal(new Set(fake.deleted).size, 1_201);
  });
});

describe("test namespaces: never the sentinel, never outside the namespace", () => {
  it("a candidate list manipulated to include the sentinel fails, and nothing is deleted", async () => {
    const { fake, issuer } = harness({
      scanReply: (n, prefix) => (n === 0 ? ["0", [`${prefix}:a`, SENTINEL_KEY, `${prefix}:b`]] : undefined),
    });
    const context = new FakeContext();
    const handle = issuer.issue(context, "sentinel");
    seed(fake, handle.prefix, 2);
    fake.keys.add(SENTINEL_KEY);
    await failsAt("candidate", context.runAfter());
    assert.equal(fake.deletionCalls, 0);
    assert.ok(fake.keys.has(SENTINEL_KEY));
    assert.equal(fake.closed, 1);
  });

  it("a candidate outside the namespace fails, and nothing is deleted", async () => {
    const cases = (prefix: string) => [
      `${TEST_NAMESPACE_STEM}other-${VALID_UUID}:x`,
      prefix,
      `${prefix}x:y`,
      `x${prefix}:y`,
      `${prefix.slice(0, -1)}:y`,
    ];
    for (let c = 0; c < 5; c++) {
      const { fake, issuer } = harness({
        scanReply: (n, prefix) => (n === 0 ? ["0", [`${prefix}:a`, cases(prefix)[c]]] : undefined),
      });
      const context = new FakeContext();
      seed(fake, issuer.issue(context, "outside").prefix, 1);
      await failsAt("candidate", context.runAfter());
      assert.equal(fake.deletionCalls, 0, `case ${c}: nothing deleted`);
      assert.equal(fake.closed, 1);
    }
  });
});

describe("test namespaces: SCAN semantics", () => {
  it("continues through empty batches with a non-zero cursor to cursor 0, and deletes duplicates once", async () => {
    const replies = (prefix: string): unknown[] => [
      ["17", []],
      ["5", [`${prefix}:1`, `${prefix}:2`]],
      ["9", []],
      ["0", [`${prefix}:2`, `${prefix}:3`, `${prefix}:1`]],
    ];
    const { fake, issuer } = harness({
      scanReply: (n, prefix) => (n < 4 ? replies(prefix)[n] : undefined),
    });
    const context = new FakeContext();
    const handle = issuer.issue(context, "scan");
    for (const n of ["1", "2", "3"]) fake.keys.add(`${handle.prefix}:${n}`);
    await context.runAfter();
    assert.equal(fake.scanCalls, 5, "four steps to cursor 0, then the post-check");
    assert.deepEqual([...fake.deleted].sort(), [`${handle.prefix}:1`, `${handle.prefix}:2`, `${handle.prefix}:3`]);
    assert.equal(fake.keys.size, 0);
  });

  it("scanAll passes each returned cursor on, and stops only at cursor 0", async () => {
    const seen: string[] = [];
    const steps: unknown[] = [["3", []], ["8", ["k1"]], ["0", ["k1", "k2"]]];
    const keys = await scanAll(async (cursor) => {
      seen.push(cursor);
      return steps[seen.length - 1];
    });
    assert.deepEqual(seen, ["0", "3", "8"]);
    assert.deepEqual(keys, ["k1", "k2"]);
  });

  it("a SCAN error before cursor 0 fails the cleanup; nothing is deleted", async () => {
    const { fake, issuer } = harness({
      scanReply: (n, prefix) => {
        if (n === 0) return ["4", [`${prefix}:1`]];
        if (n === 1) throw new Error("injected SCAN failure");
        return undefined;
      },
    });
    const context = new FakeContext();
    seed(fake, issuer.issue(context, "scan-error").prefix, 1);
    const error = await failsAt("scan", context.runAfter());
    assert.equal(fake.deletionCalls, 0);
    assert.equal(fake.closed, 1);
    assert.equal(error.causes.length, 1);
  });

  it("a malformed SCAN reply is an error, never \"done\"", async () => {
    for (const reply of [null, [], ["0"], [0, []], ["x", []], ["0", "k"], ["0", [1]], ["-1", []]]) {
      await assert.rejects(scanAll(async () => reply), ScanIncomplete);
    }
    const { fake, issuer } = harness({ scanReply: (n) => (n === 0 ? ["0", null] : undefined) });
    const context = new FakeContext();
    seed(fake, issuer.issue(context, "malformed").prefix, 1);
    await failsAt("scan", context.runAfter());
    assert.equal(fake.deletionCalls, 0);
  });

  it("an iteration that never returns to cursor 0 is not completed", async () => {
    let steps = 0;
    await assert.rejects(
      scanAll(async () => {
        steps++;
        return ["1", []];
      }),
      ScanIncomplete,
    );
    assert.equal(steps, MAX_SCAN_STEPS);
  });
});

describe("test namespaces: fails rather than proceeding", () => {
  it("a deletion error stops any further deletion", async () => {
    const { fake, issuer } = harness({ deletionFails: (n) => n === 0 });
    const context = new FakeContext();
    seed(fake, issuer.issue(context, "deletion-error").prefix, 1_000);
    await failsAt("deletion", context.runAfter());
    assert.equal(fake.deletionCalls, 1, "no further deletion after the failure");
    assert.equal(fake.scanCalls, 1, "no post-check after the failure");
    assert.equal(fake.closed, 1);
  });

  it("a deletion error in a later batch stops there", async () => {
    const { fake, issuer } = harness({ deletionFails: (n) => n === 1 });
    const context = new FakeContext();
    seed(fake, issuer.issue(context, "later-error").prefix, 1_200);
    await failsAt("deletion", context.runAfter());
    assert.equal(fake.deletionCalls, 2);
    assert.equal(fake.deleted.length, 500);
  });

  it("keys remaining after deletion fail the post-check", async () => {
    const { fake, issuer } = harness({ deletionIgnored: true });
    const context = new FakeContext();
    seed(fake, issuer.issue(context, "remain").prefix, 3);
    const error = await failsAt("post-check", context.runAfter());
    assert.match(error.message, /3 key\(s\) remain/);
    assert.equal(fake.closed, 1);
  });

  it("a post-check SCAN error fails the cleanup", async () => {
    const { fake, issuer } = harness({
      scanReply: (n) => {
        if (n === 1) throw new Error("injected post-check failure");
        return undefined;
      },
    });
    const context = new FakeContext();
    seed(fake, issuer.issue(context, "post-error").prefix, 2);
    await failsAt("post-check", context.runAfter());
    assert.equal(fake.closed, 1);
  });

  it("the connection is closed in every path; a close failure is reported, never swallowed", async () => {
    const closeAlone = harness({ closeFails: () => new Error("injected close failure") });
    const first = new FakeContext();
    closeAlone.issuer.issue(first, "close");
    const alone = await failsAt("close", first.runAfter());
    assert.equal(alone.causes.length, 1);

    const both = harness({ deletionIgnored: true, closeFails: () => new Error("injected close failure") });
    const second = new FakeContext();
    seed(both.fake, both.issuer.issue(second, "close-both").prefix, 1);
    const error = await failsAt("close", second.runAfter());
    assert.equal(error.causes.length, 2);
    assert.ok(error.causes[0] instanceof NamespaceCleanupFailure && error.causes[0].step === "post-check");
  });
});

describe("test namespaces: refuses the wrong endpoint before any deletion (through the guard)", () => {
  const cases: [string, HarnessOptions, string][] = [
    ["a wrong host", { target: { ...REGISTERED_TARGET, host: "localhost" } }, "host"],
    ["a wrong port", { target: { ...REGISTERED_TARGET, port: 46380 } }, "port"],
    ["the development port", { target: { ...REGISTERED_TARGET, port: 6379 } }, "port"],
    ["the development password file", { target: { ...REGISTERED_TARGET, passwordFile: "secrets/redis_password" } }, "password-source"],
    [
      "the development password file, by absolute path",
      { target: { ...REGISTERED_TARGET, passwordFile: join(REPOSITORY_ROOT, "secrets", "redis_password") } },
      "password-source",
    ],
    ["an inherited REDIS_PORT of 6379", { env: { REDIS_PORT: "6379" } }, "inherited-endpoint"],
  ];
  for (const [what, options, check] of cases) {
    it(`refuses ${what}, opening no connection`, async () => {
      const { fake, issuer } = harness(options);
      const context = new FakeContext();
      seed(fake, issuer.issue(context, "endpoint").prefix, 2);
      const error = await failsAt("endpoint", context.runAfter());
      const [cause] = error.causes;
      assert.ok(cause instanceof RedisGuardRefusal);
      assert.equal(cause.check, check);
      assert.deepEqual(fake.events, [], "no store was opened");
      assert.equal(fake.keys.size, 2);
    });
  }

  for (const [what, sentinel, check] of [
    ["a missing sentinel", null, "sentinel-missing"],
    ["a wrong sentinel", "not-the-marker", "sentinel-mismatch"],
  ] as const) {
    it(`refuses ${what} before any SCAN or deletion`, async () => {
      const { fake, issuer } = harness();
      fake.sentinel = sentinel;
      const context = new FakeContext();
      seed(fake, issuer.issue(context, "sentinel").prefix, 2);
      const error = await failsAt("sentinel", context.runAfter());
      assert.ok(error.causes[0] instanceof RedisGuardRefusal && error.causes[0].check === check);
      assert.deepEqual(fake.events, ["open", "sentinel", "close"]);
      assert.equal(fake.keys.size, 2);
    });
  }

  it("a store that cannot be opened (for example, the guard refusing the sentinel) fails before any deletion", async () => {
    const { fake, issuer } = harness({ openFails: () => new RedisGuardRefusal("sentinel-missing", "the sentinel key is absent") });
    const context = new FakeContext();
    seed(fake, issuer.issue(context, "open").prefix, 2);
    await failsAt("endpoint", context.runAfter());
    assert.deepEqual(fake.events, ["open"]);
    assert.equal(fake.keys.size, 2);
  });
});

describe("test namespaces: the issuer the Redis tests use (redis-guard.ts)", () => {
  it("refuses a handle it did not issue, before any connection", async () => {
    const foreign = harness().issuer.issue(new FakeContext(), "foreign");
    const forged = Object.freeze({ prefix: `${TEST_NAMESPACE_STEM}forged-${VALID_UUID}` });
    for (const handle of [foreign, forged]) {
      await assert.rejects(guardedDispatchSettings(handle), (error: unknown) => error instanceof NamespaceRefusal && error.check === "not-issued");
      await assert.rejects(namespaceKeyCount(handle), (error: unknown) => error instanceof NamespaceRefusal && error.check === "not-issued");
    }
  });
});
