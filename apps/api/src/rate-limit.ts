/**
 * Process-local, token-bucket rate limiter for the webhook endpoint
 * (Task 011B, design Revision 4.2).
 *
 * Three layers, each a bounded table of buckets plus one shared overflow
 * bucket used when the table is saturated:
 *
 * - L1: requests per normalized socket peer.
 * - L2: individually delivered rejections (400/401/404/413/415) per peer.
 * - L3: verified deliveries per `Integration.id`.
 *
 * There is no module-level mutable state: every table, counter and key
 * lives in the `createRateLimiter` closure. Raw peer keys and integration
 * IDs never leave it; logs receive only a keyed, per-instance fingerprint
 * and evidence receives only counts.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export type Layer = "L1" | "L2" | "L3";
declare const peerKeyBrand: unique symbol;
/** Normalized peer key; never logged, never exported in evidence. */
export type PeerKey = string & { readonly [peerKeyBrand]: true };

export interface BucketPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}
export interface TablePolicy {
  readonly bucket: BucketPolicy;
  readonly overflow: BucketPolicy;
  readonly maxKeys: number;
}
export interface RateLimitPolicies {
  readonly L1: TablePolicy;
  readonly L2: TablePolicy;
  readonly L3: TablePolicy;
  /** Entries scanned for a prunable one when a table is full. */
  readonly pruneScanLimit: number;
  /** Distinct denied keys counted per layer per drain interval. */
  readonly distinctKeysCap: number;
  /** Per (layer, effective entry) log suppression window. */
  readonly logSuppressionMs: number;
  /** Global bound on rate-limit warning lines. */
  readonly globalLog: BucketPolicy;
}

export interface Denial {
  readonly allowed: false;
  readonly layer: Layer;
  /** Integer >= 1. */
  readonly retryAfterSeconds: number;
  /** 16-hex fingerprint if this denial may be logged; null if suppressed. */
  readonly log: { readonly peer: string } | null;
}
export type Decision = { readonly allowed: true } | Denial;
export type PeekResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly retryAfterSeconds: number;
      readonly bucket: "EXISTING" | "OVERFLOW";
    };

/** Request-path capability. Given to buildServer only. Exposes no drain(). */
export interface RateLimiter {
  /** Pure normalization; undefined -> "unknown". */
  peerKey(remoteAddress: string | undefined): PeerKey;
  /** L1; accounts internally. */
  consumeRequest(peer: PeerKey): Decision;
  /** L2 precheck. Pure: no token, order, pruning, counter or log-state change. */
  peekRejectionAllowance(peer: PeerKey): PeekResult;
  /** Explicit accounting and log decision for a precheck 429. */
  recordPrecheckDenied(
    peer: PeerKey,
    peek: PeekResult & { allowed: false },
  ): Denial;
  /** L2 at rejectWith; accounts internally. */
  consumeRejectionAllowance(peer: PeerKey): Decision;
  /** L3; accounts internally. The peer is used only for the log fingerprint. */
  consumeVerified(integrationId: string, peer: PeerKey): Decision;
  recordAbortedBeforeResponse(): void;
  /** Callers swallow this method's own failure. */
  recordFault(): void;
}

/** Evidence capability. Given to exactly one Task 011A consumer. */
export interface RateLimitEvidence {
  /** Random UUID per createRateLimiter() call. */
  readonly limiterInstanceId: string;
  /** ISO timestamp, wallNow() at creation. */
  readonly instanceStartedAt: string;
  drain(): RateLimitSummary;
}

/** Per-layer event counters. Used for both `delta` and `cumulative`. */
export interface LayerCounters {
  /** Denial decisions by this layer. */
  readonly limited: number;
  /** L2 only: denials recorded by recordPrecheckDenied (subset of limited). */
  readonly limitedPrecheck: number;
  /** L2 only: consumeRejectionAllowance denials (subset of limited). */
  readonly limitedConverted: number;
  /** Denials whose effective bucket was the overflow bucket (subset of limited). */
  readonly limitedViaOverflow: number;
  /** Consume calls routed to overflow because the table was saturated. */
  readonly overflowAdmissions: number;
  /** L2 only: consumeRejectionAllowance grants (B1-eligible requests). */
  readonly individualRejections: number;
}
export interface Counters {
  readonly layers: Readonly<Record<Layer, LayerCounters>>;
  readonly abortedBeforeResponse: number;
  /** recordFault calls that themselves succeeded. */
  readonly limiterFaults: number;
  /** Denials whose log line was suppressed (per-entry or global). */
  readonly logLinesSuppressed: number;
}
/** Per layer; delta only. */
export interface DistinctKeys {
  readonly count: number;
  readonly saturated: boolean;
  readonly lowerBound: boolean;
}
export interface TableGauge {
  readonly tableSize: number;
  readonly tableCapacity: number;
}
export interface RateLimitSummary {
  readonly schemaVersion: 1;
  readonly limiterInstanceId: string;
  readonly instanceStartedAt: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly intervalStartedAt: string;
  readonly intervalEndedAt: string;
  readonly intervalMs: number;
  /** Activity in the covered range; summed on merge. */
  readonly delta: Counters;
  readonly distinctKeys: Readonly<Record<Layer, DistinctKeys>>;
  /** Totals since instance start, as of lastSequence; carried forward on merge. */
  readonly cumulative: Counters;
  /** As of lastSequence; carried forward on merge. */
  readonly gauges: Readonly<Record<Layer, TableGauge>>;
}
export type MergeResult =
  | { readonly ok: true; readonly summary: RateLimitSummary }
  | { readonly ok: false; readonly reason: "INSTANCE_MISMATCH" | "NOT_CONTIGUOUS" };

/** Provisional development defaults (design Revision 4.2, Section 5.2). */
export const DEFAULT_RATE_LIMIT_POLICIES: RateLimitPolicies = Object.freeze({
  L1: Object.freeze({
    bucket: Object.freeze({ capacity: 50, refillPerSecond: 20 }),
    overflow: Object.freeze({ capacity: 20, refillPerSecond: 2 }),
    maxKeys: 10_000,
  }),
  L2: Object.freeze({
    bucket: Object.freeze({ capacity: 20, refillPerSecond: 1 / 30 }),
    overflow: Object.freeze({ capacity: 20, refillPerSecond: 1 / 30 }),
    maxKeys: 10_000,
  }),
  L3: Object.freeze({
    bucket: Object.freeze({ capacity: 1_000, refillPerSecond: 100 }),
    overflow: Object.freeze({ capacity: 1_000, refillPerSecond: 100 }),
    maxKeys: 1_024,
  }),
  pruneScanLimit: 64,
  distinctKeysCap: 1_024,
  logSuppressionMs: 60_000,
  globalLog: Object.freeze({ capacity: 20, refillPerSecond: 0.2 }),
});

const LAYERS: readonly Layer[] = ["L1", "L2", "L3"];

// ---------------------------------------------------------------------------
// Bucket tables

/** @internal — test seam, not public API */
export interface BucketEntry {
  tokens: number;
  updatedAtMs: number;
  lastLoggedAtMs: number | null;
}

/** @internal — test seam, not public API */
export type LocationKind = "EXISTING" | "NEW" | "NEW_AFTER_PRUNE" | "OVERFLOW";

/** @internal — test seam, not public API */
export type Location =
  | { readonly kind: "EXISTING"; readonly entry: BucketEntry }
  | { readonly kind: "NEW" }
  | { readonly kind: "NEW_AFTER_PRUNE"; readonly prunableKey: string }
  | { readonly kind: "OVERFLOW"; readonly entry: BucketEntry };

/** @internal — test seam, not public API */
export type TablePeek =
  | { readonly allowed: true; readonly location: LocationKind }
  | {
      readonly allowed: false;
      readonly retryAfterSeconds: number;
      readonly location: "EXISTING" | "OVERFLOW";
    };

/** @internal — test seam, not public API */
export interface TableConsume {
  readonly granted: boolean;
  /** 0 when granted. */
  readonly retryAfterSeconds: number;
  readonly location: LocationKind;
  /** The effective entry (the key's own entry, or the overflow entry). */
  readonly entry: BucketEntry;
}

/** @internal — test seam, not public API */
export interface TableSnapshot {
  readonly size: number;
  /** Keys oldest first. */
  readonly keys: readonly string[];
  readonly entries: ReadonlyArray<readonly [string, Readonly<BucketEntry>]>;
  readonly overflow: Readonly<BucketEntry>;
}

/** @internal — test seam, not public API */
export interface BucketTable {
  readonly policy: TablePolicy;
  readonly size: number;
  locate(key: string, t: number): Location;
  peek(key: string, t: number): TablePeek;
  tryConsume(key: string, t: number): TableConsume;
  /** Copy of a key's own entry, if present. */
  entry(key: string): Readonly<BucketEntry> | undefined;
  snapshot(): TableSnapshot;
}

function virtualTokens(entry: BucketEntry, t: number, bucket: BucketPolicy): number {
  const elapsedMs = Math.max(0, t - entry.updatedAtMs);
  return Math.min(
    bucket.capacity,
    entry.tokens + (elapsedMs * bucket.refillPerSecond) / 1000,
  );
}

function retryAfterSeconds(tokens: number, bucket: BucketPolicy): number {
  return Math.max(1, Math.ceil((1 - tokens) / bucket.refillPerSecond));
}

function copyEntry(entry: BucketEntry): Readonly<BucketEntry> {
  return Object.freeze({ ...entry });
}

/** @internal — test seam, not public API */
export function createBucketTable(options: {
  readonly policy: TablePolicy;
  readonly pruneScanLimit: number;
  readonly logSuppressionMs: number;
}): BucketTable {
  const { policy, pruneScanLimit, logSuppressionMs } = options;
  /** Insertion-ordered, oldest first. */
  const entries = new Map<string, BucketEntry>();
  // Starts full: an update time of -Infinity refills to capacity at any t.
  const overflow: BucketEntry = {
    tokens: policy.overflow.capacity,
    updatedAtMs: Number.NEGATIVE_INFINITY,
    lastLoggedAtMs: null,
  };

  function isPrunable(entry: BucketEntry, t: number): boolean {
    return (
      virtualTokens(entry, t, policy.bucket) >= policy.bucket.capacity &&
      (entry.lastLoggedAtMs === null ||
        t - entry.lastLoggedAtMs >= logSuppressionMs)
    );
  }

  /** Pure; shared by peek and tryConsume. */
  function locate(key: string, t: number): Location {
    const existing = entries.get(key);
    if (existing !== undefined) return { kind: "EXISTING", entry: existing };
    if (entries.size < policy.maxKeys) return { kind: "NEW" };
    let scanned = 0;
    for (const [candidateKey, candidate] of entries) {
      if (scanned >= pruneScanLimit) break;
      scanned += 1;
      if (isPrunable(candidate, t)) {
        return { kind: "NEW_AFTER_PRUNE", prunableKey: candidateKey };
      }
    }
    return { kind: "OVERFLOW", entry: overflow };
  }

  function peek(key: string, t: number): TablePeek {
    const location = locate(key, t);
    if (location.kind === "NEW" || location.kind === "NEW_AFTER_PRUNE") {
      // A new key starts with a full bucket (capacity >= 1).
      return { allowed: true, location: location.kind };
    }
    const bucket = location.kind === "OVERFLOW" ? policy.overflow : policy.bucket;
    const tokens = virtualTokens(location.entry, t, bucket);
    if (tokens >= 1) return { allowed: true, location: location.kind };
    return {
      allowed: false,
      retryAfterSeconds: retryAfterSeconds(tokens, bucket),
      location: location.kind,
    };
  }

  function tryConsume(key: string, t: number): TableConsume {
    const location = locate(key, t);
    let entry: BucketEntry;
    let bucket = policy.bucket;
    switch (location.kind) {
      case "NEW_AFTER_PRUNE":
        entries.delete(location.prunableKey);
        entry = { tokens: policy.bucket.capacity, updatedAtMs: t, lastLoggedAtMs: null };
        entries.set(key, entry);
        break;
      case "NEW":
        entry = { tokens: policy.bucket.capacity, updatedAtMs: t, lastLoggedAtMs: null };
        entries.set(key, entry);
        break;
      case "EXISTING":
        entry = location.entry;
        break;
      case "OVERFLOW":
        entry = location.entry;
        bucket = policy.overflow;
        break;
    }
    const refillAt = Math.max(t, entry.updatedAtMs);
    entry.tokens = virtualTokens(entry, refillAt, bucket);
    entry.updatedAtMs = refillAt;
    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      if (location.kind !== "OVERFLOW") {
        // Move to newest so that pruning scans the oldest entries first.
        entries.delete(key);
        entries.set(key, entry);
      }
      return { granted: true, retryAfterSeconds: 0, location: location.kind, entry };
    }
    return {
      granted: false,
      retryAfterSeconds: retryAfterSeconds(entry.tokens, bucket),
      location: location.kind,
      entry,
    };
  }

  return {
    policy,
    get size() {
      return entries.size;
    },
    locate,
    peek,
    tryConsume,
    entry(key) {
      const found = entries.get(key);
      return found === undefined ? undefined : copyEntry(found);
    },
    snapshot() {
      const copied = [...entries].map(
        ([key, value]) => [key, copyEntry(value)] as const,
      );
      return Object.freeze({
        size: entries.size,
        keys: Object.freeze(copied.map(([key]) => key)),
        entries: Object.freeze(copied),
        overflow: copyEntry(overflow),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Peer keys

/**
 * Expands a valid IPv6 address (no zone) into its eight 16-bit groups,
 * including a trailing embedded dotted quad.
 */
function ipv6Groups(address: string): number[] {
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const octets = last.split(".").map(Number) as [number, number, number, number];
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const [head = "", tail] = text.split("::");
  const headParts = head === "" ? [] : head.split(":");
  let parts: string[];
  if (tail === undefined) {
    parts = headParts;
  } else {
    const tailParts = tail === "" ? [] : tail.split(":");
    const fill = 8 - headParts.length - tailParts.length;
    parts = [...headParts, ...new Array<string>(fill).fill("0"), ...tailParts];
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

/**
 * Socket-address normalization: IPv4 unchanged; IPv4-mapped IPv6 to IPv4;
 * other IPv6 grouped by /64 (zone stripped); anything else "unknown".
 */
function normalizePeer(remoteAddress: string | undefined): PeerKey {
  if (remoteAddress === undefined) return "unknown" as PeerKey;
  if (isIP(remoteAddress) === 4) return remoteAddress as PeerKey;
  const zone = remoteAddress.indexOf("%");
  const address = zone === -1 ? remoteAddress : remoteAddress.slice(0, zone);
  if (isIP(address) !== 6) return "unknown" as PeerKey;
  const groups = ipv6Groups(address);
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6] as number;
    const low = groups[7] as number;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".") as PeerKey;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64` as PeerKey;
}

// ---------------------------------------------------------------------------
// Policies

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateBucket(value: unknown, path: string): BucketPolicy {
  if (!isPlainObject(value)) throw new RangeError(`invalid rate-limit policy: ${path}`);
  const { capacity, refillPerSecond } = value;
  if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity < 1) {
    throw new RangeError(`invalid rate-limit policy: ${path}.capacity`);
  }
  if (
    typeof refillPerSecond !== "number" ||
    !Number.isFinite(refillPerSecond) ||
    refillPerSecond <= 0
  ) {
    throw new RangeError(`invalid rate-limit policy: ${path}.refillPerSecond`);
  }
  return { capacity, refillPerSecond };
}

function validateFinite(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`invalid rate-limit policy: ${path}`);
  }
}

/** Throws a RangeError naming only the offending field (never its value). */
function validatePolicies(policies: RateLimitPolicies): void {
  for (const layer of LAYERS) {
    const table: unknown = policies[layer];
    if (!isPlainObject(table)) throw new RangeError(`invalid rate-limit policy: ${layer}`);
    const bucket = validateBucket(table.bucket, `${layer}.bucket`);
    const overflow = validateBucket(table.overflow, `${layer}.overflow`);
    const { maxKeys } = table;
    if (typeof maxKeys !== "number" || !Number.isFinite(maxKeys) || maxKeys < 1) {
      throw new RangeError(`invalid rate-limit policy: ${layer}.maxKeys`);
    }
    if (overflow.capacity > bucket.capacity) {
      throw new RangeError(`invalid rate-limit policy: ${layer}.overflow.capacity`);
    }
    if (overflow.refillPerSecond > bucket.refillPerSecond) {
      throw new RangeError(`invalid rate-limit policy: ${layer}.overflow.refillPerSecond`);
    }
  }
  validateFinite(policies.pruneScanLimit, "pruneScanLimit");
  validateFinite(policies.distinctKeysCap, "distinctKeysCap");
  validateFinite(policies.logSuppressionMs, "logSuppressionMs");
  validateBucket(policies.globalLog, "globalLog");
}

// ---------------------------------------------------------------------------
// Counters

interface MutableLayerCounters {
  limited: number;
  limitedPrecheck: number;
  limitedConverted: number;
  limitedViaOverflow: number;
  overflowAdmissions: number;
  individualRejections: number;
}
interface MutableCounters {
  layers: Record<Layer, MutableLayerCounters>;
  abortedBeforeResponse: number;
  limiterFaults: number;
  logLinesSuppressed: number;
}

function zeroLayer(): MutableLayerCounters {
  return {
    limited: 0,
    limitedPrecheck: 0,
    limitedConverted: 0,
    limitedViaOverflow: 0,
    overflowAdmissions: 0,
    individualRejections: 0,
  };
}

function zeroCounters(): MutableCounters {
  return {
    layers: { L1: zeroLayer(), L2: zeroLayer(), L3: zeroLayer() },
    abortedBeforeResponse: 0,
    limiterFaults: 0,
    logLinesSuppressed: 0,
  };
}

function frozenCounters(source: Counters): Counters {
  const layer = (c: LayerCounters): LayerCounters =>
    Object.freeze({
      limited: c.limited,
      limitedPrecheck: c.limitedPrecheck,
      limitedConverted: c.limitedConverted,
      limitedViaOverflow: c.limitedViaOverflow,
      overflowAdmissions: c.overflowAdmissions,
      individualRejections: c.individualRejections,
    });
  return Object.freeze({
    layers: Object.freeze({
      L1: layer(source.layers.L1),
      L2: layer(source.layers.L2),
      L3: layer(source.layers.L3),
    }),
    abortedBeforeResponse: source.abortedBeforeResponse,
    limiterFaults: source.limiterFaults,
    logLinesSuppressed: source.logLinesSuppressed,
  });
}

function sumCounters(a: Counters, b: Counters): Counters {
  const layer = (x: LayerCounters, y: LayerCounters): LayerCounters => ({
    limited: x.limited + y.limited,
    limitedPrecheck: x.limitedPrecheck + y.limitedPrecheck,
    limitedConverted: x.limitedConverted + y.limitedConverted,
    limitedViaOverflow: x.limitedViaOverflow + y.limitedViaOverflow,
    overflowAdmissions: x.overflowAdmissions + y.overflowAdmissions,
    individualRejections: x.individualRejections + y.individualRejections,
  });
  return frozenCounters({
    layers: {
      L1: layer(a.layers.L1, b.layers.L1),
      L2: layer(a.layers.L2, b.layers.L2),
      L3: layer(a.layers.L3, b.layers.L3),
    },
    abortedBeforeResponse: a.abortedBeforeResponse + b.abortedBeforeResponse,
    limiterFaults: a.limiterFaults + b.limiterFaults,
    logLinesSuppressed: a.logLinesSuppressed + b.logLinesSuppressed,
  });
}

// ---------------------------------------------------------------------------
// Limiter

interface Ledger {
  /** Last drained sequence (0 before the first drain). */
  readonly sequence: number;
  readonly intervalStartMono: number;
  readonly intervalStartWall: string;
  readonly delta: MutableCounters;
  readonly distinct: Record<Layer, Set<string>>;
}

const ALLOWED = Object.freeze({ allowed: true as const });

export function createRateLimiter(
  options: {
    policies?: Partial<RateLimitPolicies>;
    /** Default performance.now. */
    monotonicNow?: () => number;
    /** Default () => new Date(). */
    wallNow?: () => Date;
  } = {},
): { readonly limiter: RateLimiter; readonly evidence: RateLimitEvidence } {
  const policies: RateLimitPolicies = {
    ...DEFAULT_RATE_LIMIT_POLICIES,
    ...options.policies,
  };
  validatePolicies(policies);
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => new Date());

  const processKey = randomBytes(32);
  const limiterInstanceId = randomUUID();
  const instanceStartedAt = wallNow().toISOString();

  const table = (layer: Layer): BucketTable =>
    createBucketTable({
      policy: policies[layer],
      pruneScanLimit: policies.pruneScanLimit,
      logSuppressionMs: policies.logSuppressionMs,
    });
  const tables: Record<Layer, BucketTable> = {
    L1: table("L1"),
    L2: table("L2"),
    L3: table("L3"),
  };

  const globalLog: BucketEntry = {
    tokens: policies.globalLog.capacity,
    updatedAtMs: Number.NEGATIVE_INFINITY,
    lastLoggedAtMs: null,
  };

  const cumulative = zeroCounters();
  let ledger: Ledger = {
    sequence: 0,
    intervalStartMono: monotonicNow(),
    intervalStartWall: instanceStartedAt,
    delta: zeroCounters(),
    distinct: { L1: new Set(), L2: new Set(), L3: new Set() },
  };

  /** Applies one update to delta and cumulative together. */
  function count(update: (counters: MutableCounters) => void): void {
    update(ledger.delta);
    update(cumulative);
  }

  function noteDistinct(layer: Layer, key: string): void {
    const keys = ledger.distinct[layer];
    if (keys.size < policies.distinctKeysCap) keys.add(key);
  }

  function fingerprint(source: string): string {
    return createHmac("sha256", processKey).update(source).digest("hex").slice(0, 16);
  }

  /**
   * The only place that decides whether a denial may be logged: per
   * effective entry (suppression window), then the global log bucket.
   */
  function logPermit(
    entry: BucketEntry | undefined,
    t: number,
    fingerprintSource: string,
  ): { readonly peer: string } | null {
    if (
      entry !== undefined &&
      entry.lastLoggedAtMs !== null &&
      t - entry.lastLoggedAtMs < policies.logSuppressionMs
    ) {
      count((c) => {
        c.logLinesSuppressed += 1;
      });
      return null;
    }
    const refillAt = Math.max(t, globalLog.updatedAtMs);
    globalLog.tokens = virtualTokens(globalLog, refillAt, policies.globalLog);
    globalLog.updatedAtMs = refillAt;
    if (globalLog.tokens < 1) {
      count((c) => {
        c.logLinesSuppressed += 1;
      });
      return null;
    }
    globalLog.tokens -= 1;
    if (entry !== undefined) entry.lastLoggedAtMs = t;
    return Object.freeze({ peer: fingerprint(fingerprintSource) });
  }

  function consume(layer: Layer, key: string, fingerprintSource: string): Decision {
    const t = monotonicNow();
    const result = tables[layer].tryConsume(key, t);
    const viaOverflow = result.location === "OVERFLOW";
    if (viaOverflow) {
      count((c) => {
        c.layers[layer].overflowAdmissions += 1;
      });
    }
    if (result.granted) {
      if (layer === "L2") {
        count((c) => {
          c.layers.L2.individualRejections += 1;
        });
      }
      return ALLOWED;
    }
    count((c) => {
      const counters = c.layers[layer];
      counters.limited += 1;
      if (layer === "L2") counters.limitedConverted += 1;
      if (viaOverflow) counters.limitedViaOverflow += 1;
    });
    noteDistinct(layer, key);
    return Object.freeze({
      allowed: false,
      layer,
      retryAfterSeconds: result.retryAfterSeconds,
      log: logPermit(result.entry, t, fingerprintSource),
    });
  }

  const limiter: RateLimiter = Object.freeze({
    peerKey: (remoteAddress: string | undefined) => normalizePeer(remoteAddress),
    consumeRequest: (peer: PeerKey) => consume("L1", peer, peer),
    peekRejectionAllowance: (peer: PeerKey): PeekResult => {
      const result = tables.L2.peek(peer, monotonicNow());
      if (result.allowed) return ALLOWED;
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: result.retryAfterSeconds,
        bucket: result.location,
      });
    },
    recordPrecheckDenied: (
      peer: PeerKey,
      peek: PeekResult & { allowed: false },
    ): Denial => {
      const t = monotonicNow();
      count((c) => {
        c.layers.L2.limited += 1;
        c.layers.L2.limitedPrecheck += 1;
        if (peek.bucket === "OVERFLOW") c.layers.L2.limitedViaOverflow += 1;
      });
      noteDistinct("L2", peer);
      // Log state only (never bucket state): the effective entry for
      // suppression is found with the same pure lookup as the peek.
      const location = tables.L2.locate(peer, t);
      const entry =
        location.kind === "EXISTING" || location.kind === "OVERFLOW"
          ? location.entry
          : undefined;
      return Object.freeze({
        allowed: false,
        layer: "L2",
        retryAfterSeconds: peek.retryAfterSeconds,
        log: logPermit(entry, t, peer),
      });
    },
    consumeRejectionAllowance: (peer: PeerKey) => consume("L2", peer, peer),
    consumeVerified: (integrationId: string, peer: PeerKey) =>
      consume("L3", integrationId, peer),
    recordAbortedBeforeResponse: () => {
      count((c) => {
        c.abortedBeforeResponse += 1;
      });
    },
    recordFault: () => {
      count((c) => {
        c.limiterFaults += 1;
      });
    },
  });

  /**
   * Failure-atomic: every clock read and the complete summary happen
   * before the ledger is replaced in a single assignment, so a throw
   * consumes no sequence, resets nothing and keeps the interval start.
   */
  function drain(): RateLimitSummary {
    const endMono = monotonicNow();
    const endWall = wallNow().toISOString();
    const sequence = ledger.sequence + 1;
    const distinctView = (layer: Layer): DistinctKeys => {
      const saturated = ledger.distinct[layer].size >= policies.distinctKeysCap;
      return Object.freeze({
        count: ledger.distinct[layer].size,
        saturated,
        lowerBound: saturated,
      });
    };
    const gauge = (layer: Layer): TableGauge =>
      Object.freeze({
        tableSize: tables[layer].size,
        tableCapacity: policies[layer].maxKeys,
      });
    const summary: RateLimitSummary = Object.freeze({
      schemaVersion: 1,
      limiterInstanceId,
      instanceStartedAt,
      firstSequence: sequence,
      lastSequence: sequence,
      intervalStartedAt: ledger.intervalStartWall,
      intervalEndedAt: endWall,
      intervalMs: endMono - ledger.intervalStartMono,
      delta: frozenCounters(ledger.delta),
      distinctKeys: Object.freeze({
        L1: distinctView("L1"),
        L2: distinctView("L2"),
        L3: distinctView("L3"),
      }),
      cumulative: frozenCounters(cumulative),
      gauges: Object.freeze({ L1: gauge("L1"), L2: gauge("L2"), L3: gauge("L3") }),
    });
    ledger = {
      sequence,
      intervalStartMono: endMono,
      intervalStartWall: endWall,
      delta: zeroCounters(),
      distinct: { L1: new Set(), L2: new Set(), L3: new Set() },
    };
    return summary;
  }

  const evidence: RateLimitEvidence = Object.freeze({
    limiterInstanceId,
    instanceStartedAt,
    drain,
  });

  return Object.freeze({ limiter, evidence });
}

/**
 * Pure. Merges two contiguous summaries of the same instance; never merges
 * across instances or gaps.
 */
export function mergeSummaries(
  a: RateLimitSummary,
  b: RateLimitSummary,
): MergeResult {
  if (a.limiterInstanceId !== b.limiterInstanceId) {
    return Object.freeze({ ok: false, reason: "INSTANCE_MISMATCH" });
  }
  if (b.firstSequence !== a.lastSequence + 1) {
    return Object.freeze({ ok: false, reason: "NOT_CONTIGUOUS" });
  }
  const distinct = (layer: Layer): DistinctKeys =>
    Object.freeze({
      count: Math.max(a.distinctKeys[layer].count, b.distinctKeys[layer].count),
      saturated: a.distinctKeys[layer].saturated || b.distinctKeys[layer].saturated,
      lowerBound: true,
    });
  const summary: RateLimitSummary = Object.freeze({
    schemaVersion: 1,
    limiterInstanceId: a.limiterInstanceId,
    instanceStartedAt: a.instanceStartedAt,
    firstSequence: a.firstSequence,
    lastSequence: b.lastSequence,
    intervalStartedAt: a.intervalStartedAt,
    intervalEndedAt: b.intervalEndedAt,
    intervalMs: a.intervalMs + b.intervalMs,
    delta: sumCounters(a.delta, b.delta),
    distinctKeys: Object.freeze({
      L1: distinct("L1"),
      L2: distinct("L2"),
      L3: distinct("L3"),
    }),
    cumulative: frozenCounters(b.cumulative),
    gauges: Object.freeze({
      L1: Object.freeze({ ...b.gauges.L1 }),
      L2: Object.freeze({ ...b.gauges.L2 }),
      L3: Object.freeze({ ...b.gauges.L3 }),
    }),
  });
  return Object.freeze({ ok: true, summary });
}
