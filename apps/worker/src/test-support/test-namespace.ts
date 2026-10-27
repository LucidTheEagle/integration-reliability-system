import { randomUUID } from "node:crypto";
import type { InheritedEnv, RedisTestTarget } from "./redis-guard.js";
import { SENTINEL_KEY, TEST_NAMESPACE_STEM } from "./redis-registry.js";

// Test key namespaces and their cleanup (D-F2 rule 1; 012B record Part A2
// DF-1, DF-2). A test obtains a namespace only by issuance, which registers
// that namespace's cleanup on the issuing test's own after-hook. Nothing here
// cleans up on request, and nothing takes a prefix or a handle for deletion:
// the cleanup is a closure bound at issuance to one namespace and one test
// context. This module holds no Redis client. The guarded store it cleans
// through is opened by redis-guard.ts, the only module that holds one, which
// also binds the issuer every test uses (issueTestNamespace).
//
// Failures name a step and counts, never a key, a prefix or a value.

/** An issued namespace: an opaque, frozen handle whose only member is its prefix. */
export interface TestNamespace {
  readonly prefix: string;
}

/** The part of node:test's TestContext that issuance needs. */
export interface TestContextLike {
  after(hook: (context: unknown) => Promise<void>): void;
}

export type NamespaceCheck = "test-context" | "label" | "prefix-format" | "not-issued" | "wrong-context";

export class NamespaceRefusal extends Error {
  override readonly name = "NamespaceRefusal";
  constructor(
    readonly check: NamespaceCheck,
    detail: string,
  ) {
    super(`test namespace refused (${check}): ${detail}`);
  }
}

export type CleanupStep = "endpoint" | "sentinel" | "scan" | "candidate" | "deletion" | "post-check" | "close";

/** A cleanup failure. `causes` keeps the underlying errors; none is swallowed. */
export class NamespaceCleanupFailure extends Error {
  override readonly name = "NamespaceCleanupFailure";
  constructor(
    readonly step: CleanupStep,
    detail: string,
    readonly causes: readonly unknown[] = [],
  ) {
    super(`test namespace cleanup failed (${step}): ${detail}`);
  }
}

/** A SCAN iteration that did not complete; never treated as "done". */
export class ScanIncomplete extends Error {
  override readonly name = "ScanIncomplete";
  constructor(detail: string) {
    super(`SCAN did not complete: ${detail}`);
  }
}

const LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PREFIX_PATTERN = new RegExp(`^${TEST_NAMESPACE_STEM}[a-z0-9]+(?:-[a-z0-9]+)*-${UUID_PATTERN}$`);

/**
 * The registry's exact namespace format: `irs-test-`, a label of lower-case
 * letters, digits and single hyphens, `-`, then a crypto.randomUUID() value.
 * Checked at issuance and again by every cleanup. Validation only.
 */
export function checkNamespacePrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix)) {
    throw new NamespaceRefusal("prefix-format", "not in the registry's namespace format");
  }
}

/** SCAN steps after which an iteration is treated as not completed. */
export const MAX_SCAN_STEPS = 100_000;

function scanReply(reply: unknown): [string, string[]] {
  if (!Array.isArray(reply) || reply.length !== 2) throw new ScanIncomplete("a reply is not a cursor and a batch");
  const [cursor, batch] = reply as unknown[];
  if (typeof cursor !== "string" || !/^[0-9]+$/.test(cursor)) throw new ScanIncomplete("a reply has no valid cursor");
  if (!Array.isArray(batch) || !batch.every((key) => typeof key === "string")) {
    throw new ScanIncomplete("a reply has no valid batch");
  }
  return [cursor, batch as string[]];
}

/**
 * A complete SCAN iteration (Redis SCAN guarantees): from cursor "0" until
 * the returned cursor is "0" again, continuing through empty batches;
 * duplicates are returned once. A failed step or a malformed reply is an
 * error, never "done". Read-only: `step` performs one SCAN call.
 */
export async function scanAll(step: (cursor: string) => Promise<unknown>): Promise<string[]> {
  const keys = new Set<string>();
  let cursor = "0";
  let steps = 0;
  do {
    if (steps === MAX_SCAN_STEPS) throw new ScanIncomplete("too many steps");
    steps++;
    const [next, batch] = scanReply(await step(cursor));
    for (const key of batch) keys.add(key);
    cursor = next;
  } while (cursor !== "0");
  return [...keys];
}

/** The cleanup's view of one guarded connection, bound to one namespace prefix. */
export interface NamespaceStore {
  /** GET of the sentinel key in the main test database. */
  readSentinel(): Promise<string | null>;
  /** One SCAN step, MATCH exactly `<prefix>:*`. */
  scan(cursor: string): Promise<unknown>;
  /** UNLINK of the named keys only. */
  unlink(keys: readonly string[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface NamespaceDependencies {
  readonly target: RedisTestTarget;
  readonly env: InheritedEnv;
  /** The guard's pre-connect checks. */
  validateTarget(target: RedisTestTarget, env: InheritedEnv): void;
  /** The guard's check of a sentinel GET reply. */
  checkSentinel(value: string | null): void;
  /** Opens a guarded connection (pre-connect checks, connection, sentinel) bound to one prefix. */
  openStore(target: RedisTestTarget, env: InheritedEnv, prefix: string): Promise<NamespaceStore>;
  /** UUID source; crypto.randomUUID unless a unit test replaces it. */
  readonly newId?: () => string;
}

export interface NamespaceIssuer {
  /** Issues a new namespace to `context`, and registers its cleanup on `context.after`. */
  issue(context: TestContextLike, label: string): TestNamespace;
  /** The prefix of a handle this issuer issued whose cleanup has not started; any other is refused. */
  activePrefix(handle: TestNamespace): string;
  /** The prefix of any handle this issuer issued, cleaned up or not (for read-only checks). */
  issuedPrefix(handle: TestNamespace): string;
}

interface Entry {
  readonly prefix: string;
  readonly context: TestContextLike;
}

/** Keys UNLINKed per call. */
const UNLINK_BATCH = 500;

function failure(step: CleanupStep, detail: string, error: unknown): NamespaceCleanupFailure {
  return error instanceof NamespaceCleanupFailure ? error : new NamespaceCleanupFailure(step, detail, [error]);
}

/** Every candidate must lie inside the namespace, and none may be the sentinel; otherwise nothing is deleted. */
function ownedKeys(candidates: readonly string[], prefix: string): readonly string[] {
  const own = `${prefix}:`;
  for (const key of candidates) {
    if (key === SENTINEL_KEY) throw new NamespaceCleanupFailure("candidate", "the sentinel key was a candidate");
    if (!key.startsWith(own)) throw new NamespaceCleanupFailure("candidate", "a candidate key is outside the namespace");
  }
  return candidates;
}

/** Deletion by explicit key name; the first failure stops any further deletion. */
async function unlinkOwnedKeys(store: NamespaceStore, keys: readonly string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += UNLINK_BATCH) {
    try {
      await store.unlink(keys.slice(start, start + UNLINK_BATCH));
    } catch (error) {
      throw failure("deletion", `deletion failed after ${start} of ${keys.length} key(s)`, error);
    }
  }
}

async function cleanUp(entry: Entry, active: Map<string, Entry>, dependencies: NamespaceDependencies): Promise<void> {
  // Second line of defence: the format, and issuance by this issuer, not yet
  // cleaned up. A namespace is cleaned at most once, whatever the outcome.
  checkNamespacePrefix(entry.prefix);
  if (active.get(entry.prefix) !== entry) {
    throw new NamespaceRefusal("not-issued", "not an active namespace of this issuer");
  }
  active.delete(entry.prefix);

  try {
    dependencies.validateTarget(dependencies.target, dependencies.env);
  } catch (error) {
    throw failure("endpoint", "the guard refused the endpoint before connecting", error);
  }
  let store: NamespaceStore;
  try {
    store = await dependencies.openStore(dependencies.target, dependencies.env, entry.prefix);
  } catch (error) {
    throw failure("endpoint", "the guarded connection was refused or failed", error);
  }

  let primary: unknown;
  try {
    try {
      dependencies.checkSentinel(await store.readSentinel());
    } catch (error) {
      throw failure("sentinel", "the sentinel was not verified", error);
    }
    let candidates: readonly string[];
    try {
      candidates = await scanAll((cursor) => store.scan(cursor));
    } catch (error) {
      throw failure("scan", "the SCAN of the namespace did not complete", error);
    }
    await unlinkOwnedKeys(store, ownedKeys(candidates, entry.prefix));
    let remaining: readonly string[];
    try {
      remaining = await scanAll((cursor) => store.scan(cursor));
    } catch (error) {
      throw failure("post-check", "the SCAN after deletion did not complete", error);
    }
    if (remaining.length > 0) {
      throw new NamespaceCleanupFailure("post-check", `${remaining.length} key(s) remain after deletion`);
    }
  } catch (error) {
    primary = error;
  }
  try {
    await store.close();
  } catch (error) {
    throw new NamespaceCleanupFailure(
      "close",
      primary === undefined ? "the connection did not close" : "the connection did not close after an earlier failure",
      primary === undefined ? [error] : [primary, error],
    );
  }
  if (primary !== undefined) throw primary;
}

/**
 * Builds an issuer over `dependencies`. The issuer every Redis test uses is
 * bound in redis-guard.ts to the registered target and the guarded store; a
 * unit test may build one over an in-memory store. Either way, a namespace is
 * cleaned only by the after-hook registered when it was issued.
 */
export function createNamespaceIssuer(dependencies: NamespaceDependencies): NamespaceIssuer {
  const active = new Map<string, Entry>();
  const issued = new WeakMap<object, Entry>();
  const newId = dependencies.newId ?? randomUUID;

  const entryOf = (handle: unknown): Entry => {
    const entry = typeof handle === "object" && handle !== null ? issued.get(handle) : undefined;
    if (entry === undefined) throw new NamespaceRefusal("not-issued", "the handle was not issued by this issuer");
    return entry;
  };

  const issue = (context: TestContextLike, label: string): TestNamespace => {
    if (typeof context !== "object" || context === null || typeof context.after !== "function") {
      throw new NamespaceRefusal("test-context", "a test context with an after-hook is required");
    }
    if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
      throw new NamespaceRefusal("label", "lower-case letters, digits and single hyphens only");
    }
    const prefix = `${TEST_NAMESPACE_STEM}${label}-${newId()}`;
    checkNamespacePrefix(prefix);
    if (active.has(prefix)) throw new NamespaceRefusal("prefix-format", "the namespace was already issued");

    const entry: Entry = { prefix, context };
    const handle: TestNamespace = Object.freeze(
      Object.defineProperty(Object.create(null) as TestNamespace, "prefix", { value: prefix, enumerable: true }),
    );
    active.set(prefix, entry);
    issued.set(handle, entry);
    try {
      context.after(async (invoker: unknown) => {
        // node:test runs a test's after-hook with that test's own context.
        if (invoker !== entry.context) {
          throw new NamespaceRefusal("wrong-context", "the cleanup ran outside its own test's after-hook");
        }
        await cleanUp(entry, active, dependencies);
      });
    } catch (error) {
      active.delete(prefix);
      throw error;
    }
    return handle;
  };

  const activePrefix = (handle: TestNamespace): string => {
    const entry = entryOf(handle);
    if (active.get(entry.prefix) !== entry) throw new NamespaceRefusal("not-issued", "the namespace is already cleaned up");
    return entry.prefix;
  };

  const issuedPrefix = (handle: TestNamespace): string => entryOf(handle).prefix;

  return Object.freeze({ issue, activePrefix, issuedPrefix });
}
