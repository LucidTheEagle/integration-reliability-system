import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RATE_LIMIT_POLICIES,
  createBucketTable,
  createRateLimiter,
  mergeSummaries,
} from "./rate-limit.js";
import type {
  BucketTable,
  Counters,
  Layer,
  LayerCounters,
  PeerKey,
  RateLimitPolicies,
  RateLimitSummary,
  RateLimiter,
  TableConsume,
  TablePeek,
  TablePolicy,
} from "./rate-limit.js";
import { INTEGRATION_ID, ManualClock } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers

type CounterPath =
  | `${Layer}.${keyof LayerCounters}`
  | "abortedBeforeResponse"
  | "limiterFaults"
  | "logLinesSuppressed";

/** All-zero counters except the listed paths. */
function counters(changes: Partial<Record<CounterPath, number>> = {}): Counters {
  const layer = (name: Layer): LayerCounters => ({
    limited: changes[`${name}.limited`] ?? 0,
    limitedPrecheck: changes[`${name}.limitedPrecheck`] ?? 0,
    limitedConverted: changes[`${name}.limitedConverted`] ?? 0,
    limitedViaOverflow: changes[`${name}.limitedViaOverflow`] ?? 0,
    overflowAdmissions: changes[`${name}.overflowAdmissions`] ?? 0,
    individualRejections: changes[`${name}.individualRejections`] ?? 0,
  });
  return {
    layers: { L1: layer("L1"), L2: layer("L2"), L3: layer("L3") },
    abortedBeforeResponse: changes.abortedBeforeResponse ?? 0,
    limiterFaults: changes.limiterFaults ?? 0,
    logLinesSuppressed: changes.logLinesSuppressed ?? 0,
  };
}

function combine(a: Counters, b: Counters, sign: 1 | -1): Counters {
  const layer = (x: LayerCounters, y: LayerCounters): LayerCounters => ({
    limited: x.limited + sign * y.limited,
    limitedPrecheck: x.limitedPrecheck + sign * y.limitedPrecheck,
    limitedConverted: x.limitedConverted + sign * y.limitedConverted,
    limitedViaOverflow: x.limitedViaOverflow + sign * y.limitedViaOverflow,
    overflowAdmissions: x.overflowAdmissions + sign * y.overflowAdmissions,
    individualRejections: x.individualRejections + sign * y.individualRejections,
  });
  return {
    layers: {
      L1: layer(a.layers.L1, b.layers.L1),
      L2: layer(a.layers.L2, b.layers.L2),
      L3: layer(a.layers.L3, b.layers.L3),
    },
    abortedBeforeResponse: a.abortedBeforeResponse + sign * b.abortedBeforeResponse,
    limiterFaults: a.limiterFaults + sign * b.limiterFaults,
    logLinesSuppressed: a.logLinesSuppressed + sign * b.logLinesSuppressed,
  };
}

/** Tables whose buckets hold one token and refill once per 1,000 s. */
const SLOW_TABLE: TablePolicy = {
  bucket: { capacity: 1, refillPerSecond: 0.001 },
  overflow: { capacity: 1, refillPerSecond: 0.001 },
  maxKeys: 100,
};

function limiterWith(policies: Partial<RateLimitPolicies> = {}) {
  const clock = new ManualClock();
  const pair = createRateLimiter({
    policies,
    monotonicNow: clock.now,
    wallNow: clock.wall,
  });
  return { ...pair, clock };
}

/** Seeded linear congruential generator in [0, 1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function assertInvariants(c: Counters, label: string): void {
  const { L1, L2, L3 } = c.layers;
  assert.equal(L2.limited, L2.limitedPrecheck + L2.limitedConverted, label);
  for (const other of [L1, L3]) {
    assert.equal(other.limitedPrecheck, 0, label);
    assert.equal(other.limitedConverted, 0, label);
    assert.equal(other.individualRejections, 0, label);
  }
  for (const layer of [L1, L2, L3]) {
    assert.ok(layer.limitedViaOverflow <= layer.limited, label);
  }
}

// ---------------------------------------------------------------------------
// T13 — bounded tables and peer keys

const TABLE_POLICY: TablePolicy = {
  bucket: { capacity: 3, refillPerSecond: 1 },
  overflow: { capacity: 2, refillPerSecond: 0.5 },
  maxKeys: 4,
};

function newTable(pruneScanLimit = 64, policy: TablePolicy = TABLE_POLICY): BucketTable {
  return createBucketTable({ policy, pruneScanLimit, logSuppressionMs: 60_000 });
}

describe("T13: bounded tables", () => {
  it("never holds more than maxKeys entries", () => {
    const table = newTable();
    for (let i = 0; i < 100; i += 1) {
      table.tryConsume(`k${i}`, i * 10);
      assert.ok(table.size <= 4);
    }
    assert.equal(table.size, 4);
  });

  it("prunes only entries that are full and not recently logged", () => {
    const table = newTable();
    table.tryConsume("k0", 0);
    for (const key of ["k1", "k2", "k3"]) {
      for (let i = 0; i < 3; i += 1) table.tryConsume(key, 0);
    }
    // At t=0 nothing is full: a new key goes to overflow, nothing is pruned.
    const atZero = table.tryConsume("n0", 0);
    assert.equal(atZero.location, "OVERFLOW");
    assert.deepEqual(table.snapshot().keys, ["k0", "k1", "k2", "k3"]);

    // At t=1000 only k0 has refilled to capacity (2 + 1 = 3).
    const result = table.tryConsume("n1", 1_000);
    assert.equal(result.location, "NEW_AFTER_PRUNE");
    assert.deepEqual(table.snapshot().keys, ["k1", "k2", "k3", "n1"]);
    for (const key of ["k1", "k2", "k3"]) {
      assert.equal(table.entry(key)?.tokens, 0, `${key} kept its state`);
    }
  });

  it("does not prune a full entry that logged within the suppression window", () => {
    const table = newTable();
    const k0 = table.tryConsume("k0", 0);
    for (const key of ["k1", "k2", "k3"]) {
      for (let i = 0; i < 3; i += 1) table.tryConsume(key, 0);
    }
    k0.entry.lastLoggedAtMs = 500;
    assert.equal(table.tryConsume("n1", 1_000).location, "OVERFLOW");
    assert.ok(table.entry("k0") !== undefined);
    // Once the window has passed (and everything has refilled), k0 is the
    // oldest prunable entry.
    assert.equal(table.tryConsume("n2", 60_500).location, "NEW_AFTER_PRUNE");
    assert.equal(table.entry("k0"), undefined);
  });

  it("never resets a live bucket under churn of new keys", () => {
    const table = newTable();
    for (let i = 0; i < 3; i += 1) table.tryConsume("live", 0);
    for (let i = 0; i < 50; i += 1) table.tryConsume(`churn${i}`, 0);
    assert.equal(table.entry("live")?.tokens, 0);
    assert.equal(table.tryConsume("live", 0).granted, false);
    assert.ok(table.size <= 4);
  });

  it("routes new keys to the overflow bucket and its policy at saturation", () => {
    const table = newTable();
    for (const key of ["k0", "k1", "k2", "k3"]) table.tryConsume(key, 0);
    const a = table.tryConsume("a", 0);
    const b = table.tryConsume("b", 0);
    const c = table.tryConsume("c", 0);
    assert.deepEqual(
      [a.location, b.location, c.location],
      ["OVERFLOW", "OVERFLOW", "OVERFLOW"],
    );
    assert.deepEqual([a.granted, b.granted, c.granted], [true, true, false]);
    // Overflow policy: 0.5 tokens per second -> 2 s for one token.
    assert.equal(c.retryAfterSeconds, 2);
    assert.equal(table.snapshot().overflow.tokens, 0);
    assert.equal(table.size, 4);
  });

  for (const layer of ["L1", "L2", "L3"] as const) {
    it(`bounds the ${layer} limiter table and counts overflow admissions`, () => {
      const small: TablePolicy = { ...DEFAULT_RATE_LIMIT_POLICIES[layer], maxKeys: 3 };
      const { limiter, evidence } = limiterWith({ [layer]: small });
      for (let i = 0; i < 10; i += 1) {
        const peer = limiter.peerKey(`10.0.0.${i}`);
        if (layer === "L1") limiter.consumeRequest(peer);
        if (layer === "L2") limiter.consumeRejectionAllowance(peer);
        if (layer === "L3") limiter.consumeVerified(`integration-${i}`, peer);
      }
      const summary = evidence.drain();
      assert.deepEqual(summary.gauges[layer], { tableSize: 3, tableCapacity: 3 });
      assert.equal(summary.delta.layers[layer].overflowAdmissions, 7);
    });
  }

  it("makes L3 integrations routed to overflow share one budget", () => {
    const { limiter, evidence } = limiterWith({
      L3: {
        bucket: { capacity: 5, refillPerSecond: 1 },
        overflow: { capacity: 2, refillPerSecond: 1 },
        maxKeys: 1,
      },
    });
    const peer = limiter.peerKey("10.0.0.1");
    assert.equal(limiter.consumeVerified("int-a", peer).allowed, true);
    assert.equal(limiter.consumeVerified("int-b", peer).allowed, true);
    assert.equal(limiter.consumeVerified("int-c", peer).allowed, true);
    const denied = limiter.consumeVerified("int-b", peer);
    assert.equal(denied.allowed, false);
    assert.equal(denied.allowed === false && denied.layer, "L3");
    // int-a keeps its own bucket.
    assert.equal(limiter.consumeVerified("int-a", peer).allowed, true);
    const summary = evidence.drain();
    assert.equal(summary.delta.layers.L3.limitedViaOverflow, 1);
    assert.equal(summary.gauges.L3.tableSize, 1);
  });
});

describe("T13: peer keys", () => {
  const { limiter } = createRateLimiter();
  const key = (address: string | undefined): string => limiter.peerKey(address);

  it("keeps IPv4 and maps IPv4-mapped IPv6 to IPv4", () => {
    assert.equal(key("203.0.113.9"), "203.0.113.9");
    assert.equal(key("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(key("::FFFF:203.0.113.9"), "203.0.113.9");
    assert.equal(key("::ffff:cb00:7109"), "203.0.113.9");
  });

  it("groups IPv6 addresses by /64", () => {
    assert.equal(key("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
    assert.equal(key("2001:0DB8:0001:0002::1"), "2001:db8:1:2::/64");
    assert.equal(key("2001:db8:1:2:ffff::9"), "2001:db8:1:2::/64");
    assert.notEqual(key("2001:db8:1:3::1"), key("2001:db8:1:2::1"));
    assert.equal(key("::1"), "0:0:0:0::/64");
    assert.equal(key("::"), "0:0:0:0::/64");
    assert.equal(key("64:ff9b::192.0.2.33"), "64:ff9b:0:0::/64");
  });

  it("strips IPv6 zone identifiers", () => {
    assert.equal(key("fe80::1%eth0"), "fe80:0:0:0::/64");
    assert.equal(key("fe80::2%7"), "fe80:0:0:0::/64");
  });

  it("maps a missing or non-IP address to unknown", () => {
    for (const address of [undefined, "", "not-an-ip", "1.2.3.4.5", "localhost", "[::1]"]) {
      assert.equal(key(address), "unknown", String(address));
    }
  });
});

// ---------------------------------------------------------------------------
// T13b / T13c — peek purity and peek/tryConsume equivalence

describe("T13b: saturation precheck (unit)", () => {
  it("peeks the overflow bucket for an unknown key under saturation and mutates nothing", () => {
    const table = newTable();
    for (const key of ["k0", "k1", "k2", "k3"]) table.tryConsume(key, 0);
    table.tryConsume("o1", 0);
    table.tryConsume("o2", 0);
    const logged = table.tryConsume("k1", 0);
    logged.entry.lastLoggedAtMs = 0;

    const before = table.snapshot();
    const peek = table.peek("unknown-key", 0);
    assert.deepEqual(peek, { allowed: false, retryAfterSeconds: 2, location: "OVERFLOW" });
    assert.deepEqual(table.snapshot(), before);
  });

  it("uses the overflow bucket for a limiter precheck under L2 saturation", () => {
    const { limiter, evidence } = limiterWith({
      L2: {
        bucket: { capacity: 20, refillPerSecond: 1 / 30 },
        overflow: { capacity: 1, refillPerSecond: 1 / 60 },
        maxKeys: 1,
      },
    });
    limiter.consumeRejectionAllowance(limiter.peerKey("10.0.0.1"));
    limiter.consumeRejectionAllowance(limiter.peerKey("10.0.0.2"));
    const base = evidence.drain();
    const peek = limiter.peekRejectionAllowance(limiter.peerKey("10.0.0.3"));
    assert.deepEqual(peek, { allowed: false, retryAfterSeconds: 60, bucket: "OVERFLOW" });
    const after = evidence.drain();
    assert.deepEqual(after.delta, counters());
    assert.deepEqual(after.gauges, base.gauges);
  });
});

function agree(peek: TablePeek, consume: TableConsume, label: string): void {
  assert.equal(peek.location, consume.location, label);
  assert.equal(peek.allowed, consume.granted, label);
  if (!peek.allowed) {
    assert.equal(peek.retryAfterSeconds, consume.retryAfterSeconds, label);
  }
}

describe("T13c: peek / tryConsume equivalence", () => {
  const policy: TablePolicy = {
    bucket: { capacity: 3, refillPerSecond: 1 },
    overflow: { capacity: 2, refillPerSecond: 0.5 },
    maxKeys: 3,
  };
  type Op = readonly [key: string, t: number, logged?: boolean];
  function replay(ops: readonly Op[], scan = 2): BucketTable {
    const table = newTable(scan, policy);
    for (const [key, t, logged] of ops) {
      const result = table.tryConsume(key, t);
      if (logged === true) result.entry.lastLoggedAtMs = t;
    }
    return table;
  }
  const times = (key: string, n: number, t: number): Op[] =>
    Array.from({ length: n }, () => [key, t] as const);

  const scenarios: Array<{ name: string; ops: Op[]; key: string; t: number; expect: string }> = [
    { name: "existing, allowed", ops: [["a", 0]], key: "a", t: 0, expect: "EXISTING" },
    { name: "existing, denied", ops: times("a", 3, 0), key: "a", t: 0, expect: "EXISTING" },
    { name: "existing, fractional refill", ops: times("a", 3, 0), key: "a", t: 400, expect: "EXISTING" },
    { name: "existing, clock behind the entry", ops: times("a", 3, 1_000), key: "a", t: 500, expect: "EXISTING" },
    { name: "new", ops: [], key: "a", t: 0, expect: "NEW" },
    { name: "new after prune", ops: [["a", 0], ["b", 0], ["c", 0]], key: "d", t: 1_000, expect: "NEW_AFTER_PRUNE" },
    {
      name: "overflow, allowed",
      ops: [...times("a", 3, 0), ...times("b", 3, 0), ...times("c", 3, 0)],
      key: "d",
      t: 0,
      expect: "OVERFLOW",
    },
    {
      name: "overflow, denied",
      ops: [...times("a", 3, 0), ...times("b", 3, 0), ...times("c", 3, 0), ["x", 0], ["y", 0]],
      key: "d",
      t: 0,
      expect: "OVERFLOW",
    },
    {
      name: "prunable entry beyond the scan limit",
      // At t=2000 only a is full, but it is third in order with a scan limit of 2.
      ops: [["a", 0], ...times("b", 3, 0), ...times("c", 3, 0), ["a", 0]],
      key: "d",
      t: 2_000,
      expect: "OVERFLOW",
    },
    {
      name: "full entry logged recently",
      ops: [["a", 0, true], ...times("b", 3, 0), ...times("c", 3, 0)],
      key: "d",
      t: 1_000,
      expect: "OVERFLOW",
    },
  ];

  for (const scenario of scenarios) {
    it(`agrees for: ${scenario.name}`, () => {
      const a = replay(scenario.ops);
      const b = replay(scenario.ops);
      const before = a.snapshot();
      const peek = a.peek(scenario.key, scenario.t);
      const consume = b.tryConsume(scenario.key, scenario.t);
      assert.equal(peek.location, scenario.expect);
      agree(peek, consume, scenario.name);
      assert.deepEqual(a.snapshot(), before, "peek wrote nothing");
      if (peek.location === "NEW_AFTER_PRUNE") {
        const location = a.locate(scenario.key, scenario.t);
        assert.equal(location.kind, "NEW_AFTER_PRUNE");
        if (location.kind === "NEW_AFTER_PRUNE") {
          assert.ok(a.entry(location.prunableKey) !== undefined, "candidate still present");
        }
      }
    });
  }

  it("agrees on randomized states at fixed t (seeded)", () => {
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
    const seen = new Set<string>();
    for (const seed of [1, 7, 42]) {
      const random = lcg(seed);
      const history: Op[] = [];
      let t = 0;
      for (let step = 0; step < 150; step += 1) {
        if (random() < 0.3) t += Math.floor(random() * 2_500);
        const key = keys[Math.floor(random() * keys.length)] as string;
        const a = replay(history);
        const b = replay(history);
        const before = a.snapshot();
        const peek = a.peek(key, t);
        const consume = b.tryConsume(key, t);
        agree(peek, consume, `seed ${seed} step ${step}`);
        assert.deepEqual(a.snapshot(), before);
        seen.add(`${peek.location}:${String(peek.allowed)}`);
        history.push([key, t, random() < 0.2]);
      }
    }
    for (const outcome of ["EXISTING:true", "EXISTING:false", "NEW:true", "OVERFLOW:true"]) {
      assert.ok(seen.has(outcome), `randomized states covered ${outcome}`);
    }
  });
});

// ---------------------------------------------------------------------------
// T14 — summaries

const SLOW: Partial<RateLimitPolicies> = { L1: SLOW_TABLE, L2: SLOW_TABLE, L3: SLOW_TABLE };

/** One L1 denial for `address` (the first consume takes the only token). */
function denyL1(limiter: RateLimiter, address: string) {
  const peer = limiter.peerKey(address);
  limiter.consumeRequest(peer);
  return limiter.consumeRequest(peer);
}

describe("T14: summaries", () => {
  it("numbers drains from 1, and empty drains still consume a sequence", () => {
    const { evidence } = limiterWith();
    const first = evidence.drain();
    const second = evidence.drain();
    assert.equal(first.schemaVersion, 1);
    assert.deepEqual([first.firstSequence, first.lastSequence], [1, 1]);
    assert.deepEqual([second.firstSequence, second.lastSequence], [2, 2]);
    assert.deepEqual(second.delta, counters());
    assert.equal(first.limiterInstanceId, evidence.limiterInstanceId);
    assert.equal(first.instanceStartedAt, evidence.instanceStartedAt);
  });

  it("resets delta on drain, and the sum of deltas equals cumulative", () => {
    const { limiter, evidence } = limiterWith(SLOW);
    const summaries: RateLimitSummary[] = [];
    denyL1(limiter, "10.0.0.1");
    summaries.push(evidence.drain());
    denyL1(limiter, "10.0.0.2");
    limiter.recordFault();
    summaries.push(evidence.drain());
    summaries.push(evidence.drain());
    assert.deepEqual(summaries[0]?.delta, counters({ "L1.limited": 1 }));
    assert.deepEqual(summaries[1]?.delta, counters({ "L1.limited": 1, limiterFaults: 1 }));
    assert.deepEqual(summaries[2]?.delta, counters());
    let total = counters();
    for (const summary of summaries) {
      total = combine(total, summary.delta, 1);
      assert.deepEqual(summary.cumulative, total);
    }
  });

  it("merges contiguous summaries: deltas summed, cumulative and gauges from b", () => {
    const { limiter, evidence, clock } = limiterWith(SLOW);
    denyL1(limiter, "10.0.0.1");
    denyL1(limiter, "10.0.0.2");
    clock.advance(1_000);
    const a = evidence.drain();
    denyL1(limiter, "10.0.0.3");
    limiter.recordAbortedBeforeResponse();
    clock.advance(500);
    const b = evidence.drain();
    const merged = mergeSummaries(a, b);
    assert.ok(merged.ok);
    const s = merged.summary;
    assert.equal(s.firstSequence, 1);
    assert.equal(s.lastSequence, 2);
    assert.equal(s.intervalStartedAt, a.intervalStartedAt);
    assert.equal(s.intervalEndedAt, b.intervalEndedAt);
    assert.equal(s.intervalMs, 1_500);
    assert.equal(s.intervalMs, a.intervalMs + b.intervalMs);
    assert.deepEqual(s.delta, combine(a.delta, b.delta, 1));
    assert.deepEqual(s.delta, counters({ "L1.limited": 3, abortedBeforeResponse: 1 }));
    assert.deepEqual(s.cumulative, b.cumulative);
    assert.deepEqual(s.gauges, b.gauges);
    assert.deepEqual(s.distinctKeys.L1, { count: 2, saturated: false, lowerBound: true });
    assert.ok(Object.isFrozen(merged));
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.delta.layers.L1));
    assert.ok(Object.isFrozen(s.distinctKeys.L1));
  });

  it("refuses to merge across instances or gaps, and checks the instance first", () => {
    const one = limiterWith();
    const two = limiterWith();
    const a1 = one.evidence.drain();
    const a2 = one.evidence.drain();
    const a3 = one.evidence.drain();
    two.evidence.drain();
    const b2 = two.evidence.drain();
    assert.deepEqual(mergeSummaries(a1, b2), { ok: false, reason: "INSTANCE_MISMATCH" });
    assert.deepEqual(mergeSummaries(a1, a3), { ok: false, reason: "NOT_CONTIGUOUS" });
    assert.deepEqual(mergeSummaries(a2, a1), { ok: false, reason: "NOT_CONTIGUOUS" });
    assert.deepEqual(mergeSummaries(a2, b2), { ok: false, reason: "INSTANCE_MISMATCH" });
    assert.ok(mergeSummaries(a1, a2).ok);
  });

  it("caps distinct keys and applies the saturation and lower-bound rules", () => {
    const { limiter, evidence } = limiterWith({ ...SLOW, distinctKeysCap: 3 });
    for (let i = 0; i < 5; i += 1) denyL1(limiter, `10.0.1.${i}`);
    const saturated = evidence.drain();
    assert.deepEqual(saturated.distinctKeys.L1, { count: 3, saturated: true, lowerBound: true });
    assert.equal(saturated.delta.layers.L1.limited, 5);
    for (let i = 0; i < 2; i += 1) denyL1(limiter, `10.0.2.${i}`);
    const partial = evidence.drain();
    assert.deepEqual(partial.distinctKeys.L1, { count: 2, saturated: false, lowerBound: false });
    assert.deepEqual(partial.distinctKeys.L2, { count: 0, saturated: false, lowerBound: false });
    const merged = mergeSummaries(saturated, partial);
    assert.ok(merged.ok);
    assert.deepEqual(merged.summary.distinctKeys.L1, { count: 3, saturated: true, lowerBound: true });
    const quiet = mergeSummaries(partial, evidence.drain());
    assert.ok(quiet.ok);
    assert.deepEqual(quiet.summary.distinctKeys.L1, { count: 2, saturated: false, lowerBound: true });
  });

  it("never puts peer keys, integration IDs or fingerprints in a summary", () => {
    const { limiter, evidence } = limiterWith(SLOW);
    const fingerprints: string[] = [];
    for (const address of ["203.0.113.77", "::ffff:198.51.100.23", "2001:db8:aa:bb::5"]) {
      const denial = denyL1(limiter, address);
      if (!denial.allowed && denial.log !== null) fingerprints.push(denial.log.peer);
      const peer = limiter.peerKey(address);
      limiter.consumeVerified(INTEGRATION_ID, peer);
      limiter.consumeVerified(INTEGRATION_ID, peer);
    }
    const text = JSON.stringify(evidence.drain());
    for (const secret of [
      "203.0.113.77",
      "198.51.100.23",
      "2001:db8:aa:bb",
      INTEGRATION_ID,
      ...fingerprints,
    ]) {
      assert.ok(!text.includes(secret), `summary leaked ${secret}`);
    }
    assert.equal(fingerprints.length, 3);
  });
});

// ---------------------------------------------------------------------------
// T14c — accounting map

const ONE_KEY: TablePolicy = { ...SLOW_TABLE, maxKeys: 1 };
const ACCOUNTING: Partial<RateLimitPolicies> = { L1: ONE_KEY, L2: ONE_KEY, L3: ONE_KEY };

describe("T14c: accounting map", () => {
  type Row = {
    readonly name: string;
    readonly setup?: (limiter: RateLimiter, p: (n: number) => PeerKey) => void;
    readonly act: (limiter: RateLimiter, p: (n: number) => PeerKey) => void;
    readonly expect: Partial<Record<CounterPath, number>>;
    readonly distinct?: Layer;
  };
  const precheck = (limiter: RateLimiter, peer: PeerKey): void => {
    const peek = limiter.peekRejectionAllowance(peer);
    assert.equal(peek.allowed, false);
    if (!peek.allowed) limiter.recordPrecheckDenied(peer, peek);
  };
  const rows: Row[] = [
    { name: "consumeRequest grant", act: (l, p) => l.consumeRequest(p(1)), expect: {} },
    {
      name: "consumeRequest deny",
      setup: (l, p) => l.consumeRequest(p(1)),
      act: (l, p) => l.consumeRequest(p(1)),
      expect: { "L1.limited": 1 },
      distinct: "L1",
    },
    {
      name: "consumeRequest routed to overflow (grant)",
      setup: (l, p) => l.consumeRequest(p(1)),
      act: (l, p) => l.consumeRequest(p(2)),
      expect: { "L1.overflowAdmissions": 1 },
    },
    {
      name: "consumeRequest deny via overflow",
      setup: (l, p) => {
        l.consumeRequest(p(1));
        l.consumeRequest(p(2));
      },
      act: (l, p) => l.consumeRequest(p(3)),
      expect: { "L1.limited": 1, "L1.limitedViaOverflow": 1, "L1.overflowAdmissions": 1 },
      distinct: "L1",
    },
    {
      name: "recordPrecheckDenied (existing bucket)",
      setup: (l, p) => l.consumeRejectionAllowance(p(1)),
      act: (l, p) => precheck(l, p(1)),
      expect: { "L2.limited": 1, "L2.limitedPrecheck": 1 },
      distinct: "L2",
    },
    {
      name: "recordPrecheckDenied (overflow bucket)",
      setup: (l, p) => {
        l.consumeRejectionAllowance(p(1));
        l.consumeRejectionAllowance(p(2));
      },
      act: (l, p) => precheck(l, p(3)),
      expect: { "L2.limited": 1, "L2.limitedPrecheck": 1, "L2.limitedViaOverflow": 1 },
      distinct: "L2",
    },
    {
      name: "consumeRejectionAllowance deny",
      setup: (l, p) => l.consumeRejectionAllowance(p(1)),
      act: (l, p) => l.consumeRejectionAllowance(p(1)),
      expect: { "L2.limited": 1, "L2.limitedConverted": 1 },
      distinct: "L2",
    },
    {
      name: "consumeRejectionAllowance grant",
      act: (l, p) => l.consumeRejectionAllowance(p(1)),
      expect: { "L2.individualRejections": 1 },
    },
    {
      name: "consumeRejectionAllowance routed to overflow (grant)",
      setup: (l, p) => l.consumeRejectionAllowance(p(1)),
      act: (l, p) => l.consumeRejectionAllowance(p(2)),
      expect: { "L2.overflowAdmissions": 1, "L2.individualRejections": 1 },
    },
    {
      name: "consumeRejectionAllowance deny via overflow",
      setup: (l, p) => {
        l.consumeRejectionAllowance(p(1));
        l.consumeRejectionAllowance(p(2));
      },
      act: (l, p) => l.consumeRejectionAllowance(p(3)),
      expect: {
        "L2.limited": 1,
        "L2.limitedConverted": 1,
        "L2.limitedViaOverflow": 1,
        "L2.overflowAdmissions": 1,
      },
      distinct: "L2",
    },
    { name: "consumeVerified grant", act: (l, p) => l.consumeVerified("int-1", p(1)), expect: {} },
    {
      name: "consumeVerified deny",
      setup: (l, p) => l.consumeVerified("int-1", p(1)),
      act: (l, p) => l.consumeVerified("int-1", p(1)),
      expect: { "L3.limited": 1 },
      distinct: "L3",
    },
    {
      name: "consumeVerified routed to overflow (grant)",
      setup: (l, p) => l.consumeVerified("int-1", p(1)),
      act: (l, p) => l.consumeVerified("int-2", p(1)),
      expect: { "L3.overflowAdmissions": 1 },
    },
    {
      name: "consumeVerified deny via overflow",
      setup: (l, p) => {
        l.consumeVerified("int-1", p(1));
        l.consumeVerified("int-2", p(1));
      },
      act: (l, p) => l.consumeVerified("int-3", p(1)),
      expect: { "L3.limited": 1, "L3.limitedViaOverflow": 1, "L3.overflowAdmissions": 1 },
      distinct: "L3",
    },
    {
      name: "denial whose log line is suppressed",
      setup: (l, p) => {
        l.consumeRequest(p(1));
        l.consumeRequest(p(1));
      },
      act: (l, p) => l.consumeRequest(p(1)),
      expect: { "L1.limited": 1, logLinesSuppressed: 1 },
      distinct: "L1",
    },
    {
      name: "recordAbortedBeforeResponse",
      act: (l) => l.recordAbortedBeforeResponse(),
      expect: { abortedBeforeResponse: 1 },
    },
    { name: "recordFault", act: (l) => l.recordFault(), expect: { limiterFaults: 1 } },
    {
      name: "peekRejectionAllowance (pure)",
      setup: (l, p) => {
        l.consumeRejectionAllowance(p(1));
        l.consumeRejectionAllowance(p(2));
      },
      act: (l, p) => {
        l.peekRejectionAllowance(p(1));
        l.peekRejectionAllowance(p(3));
      },
      expect: {},
    },
  ];

  for (const row of rows) {
    it(`${row.name} changes exactly its listed counters`, () => {
      const { limiter, evidence } = limiterWith(ACCOUNTING);
      const p = (n: number): PeerKey => limiter.peerKey(`10.0.0.${n}`);
      row.setup?.(limiter, p);
      const base = evidence.drain();
      row.act(limiter, p);
      const summary = evidence.drain();
      assert.deepEqual(summary.delta, counters(row.expect), "delta");
      assert.deepEqual(
        combine(summary.cumulative, base.cumulative, -1),
        counters(row.expect),
        "cumulative",
      );
      for (const layer of ["L1", "L2", "L3"] as const) {
        assert.equal(summary.distinctKeys[layer].count, row.distinct === layer ? 1 : 0, layer);
      }
    });
  }

  it("peekRejectionAllowance never inserts, prunes or reorders", () => {
    const { limiter, evidence } = limiterWith();
    const before = evidence.drain();
    for (let i = 0; i < 20; i += 1) limiter.peekRejectionAllowance(limiter.peerKey(`10.0.3.${i}`));
    const after = evidence.drain();
    assert.equal(before.gauges.L2.tableSize, 0);
    assert.equal(after.gauges.L2.tableSize, 0);
    assert.deepEqual(after.delta, counters());
  });

  it("holds the counter invariants for delta and cumulative over a random mix", () => {
    const { limiter, evidence, clock } = limiterWith({
      L1: { bucket: { capacity: 2, refillPerSecond: 1 }, overflow: { capacity: 1, refillPerSecond: 0.5 }, maxKeys: 3 },
      L2: { bucket: { capacity: 2, refillPerSecond: 0.5 }, overflow: { capacity: 1, refillPerSecond: 0.25 }, maxKeys: 3 },
      L3: { bucket: { capacity: 2, refillPerSecond: 1 }, overflow: { capacity: 1, refillPerSecond: 1 }, maxKeys: 2 },
      distinctKeysCap: 4,
    });
    const random = lcg(99);
    for (let step = 0; step < 600; step += 1) {
      const peer = limiter.peerKey(`10.0.4.${Math.floor(random() * 8)}`);
      const choice = random();
      if (choice < 0.3) limiter.consumeRequest(peer);
      else if (choice < 0.55) limiter.consumeRejectionAllowance(peer);
      else if (choice < 0.75) {
        const peek = limiter.peekRejectionAllowance(peer);
        if (!peek.allowed) limiter.recordPrecheckDenied(peer, peek);
      } else limiter.consumeVerified(`int-${Math.floor(random() * 5)}`, peer);
      if (random() < 0.2) clock.advance(Math.floor(random() * 3_000));
      if (step % 50 === 49) {
        const summary = evidence.drain();
        assertInvariants(summary.delta, `delta at ${step}`);
        assertInvariants(summary.cumulative, `cumulative at ${step}`);
        for (const layer of ["L1", "L2", "L3"] as const) {
          assert.ok(summary.distinctKeys[layer].count <= 4);
        }
      }
    }
  });

  it("separates the request-path and evidence capabilities", () => {
    const { limiter, evidence } = createRateLimiter();
    const typeOnly = (): void => {
      // @ts-expect-error RateLimiter exposes no drain()
      void limiter.drain;
      // @ts-expect-error RateLimitEvidence exposes no request-path operation
      void evidence.consumeRequest;
    };
    void typeOnly;
    assert.equal("drain" in limiter, false);
    assert.equal("consumeRequest" in evidence, false);
    assert.ok(Object.isFrozen(limiter));
    assert.ok(Object.isFrozen(evidence));
  });
});

// ---------------------------------------------------------------------------
// T14d — failure-atomic drain (Task 011A AD-14)

describe("T14d: failure-atomic drain", () => {
  const variants = ["wallNow throws", "monotonicNow throws", "wallNow returns an Invalid Date"] as const;
  for (const variant of variants) {
    it(`a failed drain consumes no sequence and resets nothing (${variant})`, () => {
      const clock = new ManualClock();
      let failMonotonic = false;
      let failWall = false;
      let invalidWall = false;
      const { limiter, evidence } = createRateLimiter({
        policies: SLOW,
        monotonicNow: () => {
          if (failMonotonic) {
            failMonotonic = false;
            throw new Error("monotonic clock failure");
          }
          return clock.now();
        },
        wallNow: () => {
          if (failWall) {
            failWall = false;
            throw new Error("wall clock failure");
          }
          if (invalidWall) {
            invalidWall = false;
            return new Date(Number.NaN);
          }
          return clock.wall();
        },
      });
      const a = limiter.peerKey("10.0.5.1");
      const b = limiter.peerKey("10.0.5.2");

      denyL1(limiter, "10.0.5.9");
      clock.advance(100);
      const previous = evidence.drain();
      assert.equal(previous.lastSequence, 1);

      clock.advance(1_000);
      // L1: one denial for a.
      limiter.consumeRequest(a);
      limiter.consumeRequest(a);
      // L2: grant, converted denial, then a precheck denial for b.
      limiter.consumeRejectionAllowance(b);
      limiter.consumeRejectionAllowance(b);
      const peek = limiter.peekRejectionAllowance(b);
      assert.equal(peek.allowed, false);
      if (!peek.allowed) limiter.recordPrecheckDenied(b, peek);
      // L3: one denial.
      limiter.consumeVerified("int-1", a);
      limiter.consumeVerified("int-1", a);
      limiter.recordAbortedBeforeResponse();
      limiter.recordFault();
      const expected = counters({
        "L1.limited": 1,
        "L2.limited": 2,
        "L2.limitedConverted": 1,
        "L2.limitedPrecheck": 1,
        "L2.individualRejections": 1,
        "L3.limited": 1,
        abortedBeforeResponse: 1,
        limiterFaults: 1,
        // The precheck denial for b falls in b's L2 suppression window.
        logLinesSuppressed: 1,
      });

      clock.advance(500);
      if (variant === "wallNow throws") failWall = true;
      if (variant === "monotonicNow throws") failMonotonic = true;
      if (variant === "wallNow returns an Invalid Date") invalidWall = true;
      assert.throws(() => evidence.drain());

      clock.advance(250);
      const next = evidence.drain();
      assert.equal(next.firstSequence, 2);
      assert.equal(next.lastSequence, 2);
      assert.deepEqual(next.delta, expected);
      assert.deepEqual(next.distinctKeys, {
        L1: { count: 1, saturated: false, lowerBound: false },
        L2: { count: 1, saturated: false, lowerBound: false },
        L3: { count: 1, saturated: false, lowerBound: false },
      });
      assert.equal(next.intervalStartedAt, previous.intervalEndedAt);
      assert.equal(next.intervalMs, 1_750);
      assert.deepEqual(next.cumulative, combine(previous.cumulative, next.delta, 1));
      assert.ok(mergeSummaries(previous, next).ok);
    });
  }
});

// ---------------------------------------------------------------------------
// T15 — log suppression and fingerprints (unit)

describe("T15: log suppression and fingerprints", () => {
  it("suppresses repeat lines per (layer, entry) for 60 s", () => {
    const { limiter, evidence, clock } = limiterWith(SLOW);
    const a = limiter.peerKey("10.0.6.1");
    limiter.consumeRequest(a);
    const first = limiter.consumeRequest(a);
    assert.ok(!first.allowed && first.log !== null);
    clock.advance(59_999);
    const second = limiter.consumeRequest(a);
    assert.ok(!second.allowed && second.log === null);
    clock.advance(1);
    const third = limiter.consumeRequest(a);
    assert.ok(!third.allowed && third.log !== null);
    assert.equal(third.log.peer, first.log.peer);

    // Another layer for the same peer, and another peer, are separate entries.
    limiter.consumeRejectionAllowance(a);
    const otherLayer = limiter.consumeRejectionAllowance(a);
    assert.ok(!otherLayer.allowed && otherLayer.log !== null);
    const b = limiter.peerKey("10.0.6.2");
    limiter.consumeRequest(b);
    const otherPeer = limiter.consumeRequest(b);
    assert.ok(!otherPeer.allowed && otherPeer.log !== null);
    assert.equal(evidence.drain().delta.logLinesSuppressed, 1);
  });

  it("caps lines globally at 20, refilling one line per 5 s", () => {
    const { limiter, evidence, clock } = limiterWith(SLOW);
    let index = 0;
    const freshDenial = () => denyL1(limiter, `10.1.${Math.floor(index / 250)}.${index++ % 250}`);
    const logged = Array.from({ length: 25 }, () => freshDenial()).filter(
      (d) => !d.allowed && d.log !== null,
    );
    assert.equal(logged.length, 20);
    clock.advance(2_500);
    assert.equal((freshDenial() as { log: unknown }).log, null);
    clock.advance(2_500);
    assert.notEqual((freshDenial() as { log: unknown }).log, null);
    assert.equal((freshDenial() as { log: unknown }).log, null);
    const summary = evidence.drain();
    assert.equal(summary.delta.layers.L1.limited, 28);
    assert.equal(summary.delta.logLinesSuppressed, 7);
  });

  it("fingerprints: 16 hex, stable per peer, distinct across peers and instances", () => {
    const one = limiterWith(SLOW);
    const two = limiterWith(SLOW);
    const peerA = (d: ReturnType<typeof denyL1>): string => {
      assert.ok(!d.allowed && d.log !== null);
      return d.log.peer;
    };
    const a1 = peerA(denyL1(one.limiter, "10.0.7.1"));
    one.clock.advance(60_000);
    const a1Again = peerA(one.limiter.consumeRequest(one.limiter.peerKey("10.0.7.1")));
    const b1 = peerA(denyL1(one.limiter, "10.0.7.2"));
    const a2 = peerA(denyL1(two.limiter, "10.0.7.1"));
    for (const value of [a1, b1, a2]) assert.match(value, /^[0-9a-f]{16}$/);
    assert.equal(a1, a1Again);
    assert.notEqual(a1, b1);
    assert.notEqual(a1, a2);
    // The same peer through its IPv4-mapped form shares the fingerprint.
    one.clock.advance(60_000);
    assert.equal(peerA(one.limiter.consumeRequest(one.limiter.peerKey("::ffff:10.0.7.1"))), a1);
  });
});

// ---------------------------------------------------------------------------
// Policies

describe("policies", () => {
  it("uses the provisional Section 5.2 defaults", () => {
    const p = DEFAULT_RATE_LIMIT_POLICIES;
    assert.deepEqual(p.L1, {
      bucket: { capacity: 50, refillPerSecond: 20 },
      overflow: { capacity: 20, refillPerSecond: 2 },
      maxKeys: 10_000,
    });
    assert.deepEqual(p.L2, {
      bucket: { capacity: 20, refillPerSecond: 1 / 30 },
      overflow: { capacity: 20, refillPerSecond: 1 / 30 },
      maxKeys: 10_000,
    });
    assert.deepEqual(p.L3, {
      bucket: { capacity: 1_000, refillPerSecond: 100 },
      overflow: { capacity: 1_000, refillPerSecond: 100 },
      maxKeys: 1_024,
    });
    assert.equal(p.pruneScanLimit, 64);
    assert.equal(p.distinctKeysCap, 1_024);
    assert.equal(p.logSuppressionMs, 60_000);
    assert.deepEqual(p.globalLog, { capacity: 20, refillPerSecond: 0.2 });
  });

  it("rejects each invalid policy at creation, naming only the field", () => {
    const D = DEFAULT_RATE_LIMIT_POLICIES;
    const bucket = (capacity: number, refillPerSecond: number) => ({ capacity, refillPerSecond });
    const cases: Array<[string, Partial<RateLimitPolicies>]> = [
      ["L1.bucket.capacity", { L1: { ...D.L1, bucket: bucket(0, 20) } }],
      ["L1.bucket.capacity", { L1: { ...D.L1, bucket: bucket(Number.NaN, 20) } }],
      ["L1.bucket.capacity", { L1: { ...D.L1, bucket: bucket(Number.POSITIVE_INFINITY, 20) } }],
      ["L1.bucket.refillPerSecond", { L1: { ...D.L1, bucket: bucket(50, 0) } }],
      ["L1.bucket.refillPerSecond", { L1: { ...D.L1, bucket: bucket(50, -1) } }],
      ["L1.bucket.refillPerSecond", { L1: { ...D.L1, bucket: bucket(50, Number.POSITIVE_INFINITY) } }],
      ["L2.overflow.capacity", { L2: { ...D.L2, overflow: bucket(0.5, 1 / 30) } }],
      ["L2.overflow.capacity", { L2: { ...D.L2, overflow: bucket(21, 1 / 30) } }],
      ["L2.overflow.refillPerSecond", { L2: { ...D.L2, overflow: bucket(20, 1) } }],
      ["L3.maxKeys", { L3: { ...D.L3, maxKeys: 0 } }],
      ["L3.maxKeys", { L3: { ...D.L3, maxKeys: Number.NaN } }],
      ["L3", { L3: undefined as unknown as TablePolicy }],
      ["pruneScanLimit", { pruneScanLimit: Number.NaN }],
      ["distinctKeysCap", { distinctKeysCap: Number.POSITIVE_INFINITY }],
      ["logSuppressionMs", { logSuppressionMs: Number.NaN }],
      ["globalLog.capacity", { globalLog: bucket(0, 0.2) }],
      ["globalLog.refillPerSecond", { globalLog: bucket(20, 0) }],
    ];
    for (const [field, policies] of cases) {
      assert.throws(
        () => createRateLimiter({ policies }),
        (error: unknown) =>
          error instanceof RangeError &&
          error.message === `invalid rate-limit policy: ${field}`,
        field,
      );
    }
  });

  it("merges a partial override shallowly over the defaults", () => {
    const { limiter } = limiterWith({ L1: SLOW_TABLE });
    const peer = limiter.peerKey("10.0.8.1");
    assert.equal(limiter.consumeRequest(peer).allowed, true);
    assert.equal(limiter.consumeRequest(peer).allowed, false);
    // L2 keeps its default capacity of 20.
    for (let i = 0; i < 20; i += 1) {
      assert.equal(limiter.consumeRejectionAllowance(peer).allowed, true);
    }
    assert.equal(limiter.consumeRejectionAllowance(peer).allowed, false);
  });
});
