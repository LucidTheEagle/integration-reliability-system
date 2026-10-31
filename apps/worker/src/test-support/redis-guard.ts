import { isAbsolute, resolve } from "node:path";
import { Redis } from "ioredis";
import type { DispatchSettings } from "../dispatch-queue/index.js";
import { RedisPasswordFileError, loadRedisPassword } from "../redis-password.js";
import { REPOSITORY_ROOT } from "../repository-root.js";
import {
  DEV_PASSWORD_FILE,
  DEV_REDIS_PORT,
  EXPECTED_SERVER_CONFIG,
  GUARD_CHECK_DATABASE_INDEX,
  MAIN_DATABASE_INDEX,
  REGISTERED_DATABASE_INDEXES,
  SENTINEL_KEY,
  SENTINEL_MARKER,
  TEST_NAMESPACE_STEM,
  TEST_PASSWORD_FILE,
  TEST_REDIS_HOST,
  TEST_REDIS_PORT,
} from "./redis-registry.js";
import {
  NamespaceCleanupFailure,
  NamespaceRefusal,
  ScanIncomplete,
  checkNamespacePrefix,
  createNamespaceIssuer,
  scanAll,
} from "./test-namespace.js";
import type { NamespaceStore, TestContextLike, TestNamespace } from "./test-namespace.js";

// The test-Redis guard (DR-11; Task 012A record D7, D17), and the only module
// that holds a Redis client (012B record Part A2 DF-1; the allowlist in
// source-scan.ts). Every connection goes through the guard: pre-connect
// checks, then a connection, then the sentinel. No raw client leaves this
// module: callers get only the narrow operations below. The deleting commands
// are confined to two functions: the namespace store's UNLINK
// (openNamespaceStore, D-F2 rule 1) and DF-3's sentinel DEL in the
// guard-check database (deleteGuardCheckSentinel). A refusal names the failed
// check and never a value (no host, port, path, key or password).

export interface RedisTestTarget {
  readonly host: string;
  readonly port: number;
  /** Password file, relative to the repository root or absolute. */
  readonly passwordFile: string;
  /** Logical database index; defaults to the main test database. */
  readonly db?: number;
}

export const REGISTERED_TARGET: RedisTestTarget = Object.freeze({
  host: TEST_REDIS_HOST,
  port: TEST_REDIS_PORT,
  passwordFile: TEST_PASSWORD_FILE,
  db: MAIN_DATABASE_INDEX,
});

export type InheritedEnv = Readonly<Record<string, string | undefined>>;

export type RedisGuardCheck =
  | "host"
  | "port"
  | "password-source"
  | "database"
  | "inherited-endpoint"
  | "sentinel-missing"
  | "sentinel-mismatch"
  | "guard-check-scope"
  // Task 012B (Q4, PL-11): the CLIENT INFO `db=` parser's refusals.
  | "database-expected"
  | "database-reply"
  | "database-field"
  | "database-value"
  | "database-mismatch";

export class RedisGuardRefusal extends Error {
  override readonly name = "RedisGuardRefusal";
  constructor(
    readonly check: RedisGuardCheck,
    detail: string,
  ) {
    super(`test-Redis guard refused (${check}): ${detail}`);
  }
}

/** A connection failure, carrying only a classified code (never a message). */
export class RedisConnectionFailure extends Error {
  override readonly name = "RedisConnectionFailure";
  constructor(readonly code: string) {
    super(`test-Redis connection failed (${code})`);
  }
}

/** A command failure, carrying only a classified code (never a message or an argument). */
export class RedisCommandFailure extends Error {
  override readonly name = "RedisCommandFailure";
  constructor(readonly code: string) {
    super(`test-Redis command failed (${code})`);
  }
}

/**
 * The specific code of a Redis client error: the first word of a Redis error
 * reply (for example NOAUTH, WRONGPASS), or a Node system error code (for
 * example ECONNREFUSED). Anything else is UNCLASSIFIED.
 */
export function redisErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "ReplyError") {
    const word = error.message.split(" ", 1)[0] ?? "";
    return /^[A-Z][A-Z_-]*$/.test(word) ? word : "UNCLASSIFIED";
  }
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z_]+$/.test(code) ? code : "UNCLASSIFIED";
}

/**
 * A printable reason: the message of this package's own typed errors (which
 * never carry a value), otherwise only the classified code.
 */
export function safeReason(error: unknown): string {
  if (
    error instanceof RedisGuardRefusal ||
    error instanceof RedisConnectionFailure ||
    error instanceof RedisCommandFailure ||
    error instanceof RedisPasswordFileError ||
    error instanceof NamespaceRefusal ||
    error instanceof NamespaceCleanupFailure ||
    error instanceof ScanIncomplete
  ) {
    return error.message;
  }
  return `unexpected error (${redisErrorCode(error)})`;
}

const DEV_PORT_TEXT = String(DEV_REDIS_PORT);

function pointsAtDevPort(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const text = value.trim();
  if (name === "REDIS_PORT") return /^0*(\d+)$/.test(text) && Number(text) === DEV_REDIS_PORT;
  return new RegExp(`:${DEV_PORT_TEXT}(?![0-9])`).test(text);
}

function samePath(candidate: string, registered: string): boolean {
  const absolute = (path: string) => (isAbsolute(path) ? resolve(path) : resolve(REPOSITORY_ROOT, path));
  return absolute(candidate) === absolute(registered);
}

/** Every pre-connect check. No connection and no file read. */
export function validateRedisTarget(target: RedisTestTarget, env: InheritedEnv = process.env): void {
  if (target.host !== TEST_REDIS_HOST) {
    throw new RedisGuardRefusal("host", "not the registered test host");
  }
  if (target.port !== TEST_REDIS_PORT) {
    throw new RedisGuardRefusal("port", "not the registered test port");
  }
  if (samePath(target.passwordFile, DEV_PASSWORD_FILE)) {
    throw new RedisGuardRefusal("password-source", "the development password file is never accepted");
  }
  if (!samePath(target.passwordFile, TEST_PASSWORD_FILE)) {
    throw new RedisGuardRefusal("password-source", "not the registered test password file");
  }
  const db = target.db ?? MAIN_DATABASE_INDEX;
  if (!REGISTERED_DATABASE_INDEXES.includes(db)) {
    throw new RedisGuardRefusal("database", "not a registered logical database");
  }
  for (const name of ["REDIS_HOST", "REDIS_PORT"]) {
    if (pointsAtDevPort(name, env[name])) {
      throw new RedisGuardRefusal("inherited-endpoint", `an inherited ${name} points at the development port`);
    }
  }
}

/** The sentinel check on a GET reply: it must equal the registered marker. */
export function checkSentinelValue(value: string | null): void {
  if (value === null) {
    throw new RedisGuardRefusal("sentinel-missing", "the sentinel key is absent");
  }
  if (value !== SENTINEL_MARKER) {
    throw new RedisGuardRefusal("sentinel-mismatch", "the sentinel key does not hold the registered marker");
  }
}

// ---- the raw client (private to this module) ------------------------------

interface GuardedRedis {
  readonly client: Redis;
  close(): Promise<void>;
}

async function closeClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

/** Runs one command; any failure other than the guard's own becomes a coded error. */
async function command<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RedisGuardRefusal || error instanceof RedisCommandFailure) throw error;
    throw new RedisCommandFailure(redisErrorCode(error));
  }
}

/**
 * Pre-connect checks, then a connection, without the sentinel check. For the
 * bootstrap and the post-run audit only.
 */
async function connectUnverified(
  target: RedisTestTarget = REGISTERED_TARGET,
  env: InheritedEnv = process.env,
): Promise<GuardedRedis> {
  validateRedisTarget(target, env);
  const password = loadRedisPassword({ REDIS_PASSWORD_FILE: target.passwordFile }, REPOSITORY_ROOT);
  let lastError: unknown;
  const client = new Redis({
    host: target.host,
    port: target.port,
    password,
    db: target.db ?? MAIN_DATABASE_INDEX,
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on("error", (error: unknown) => {
    lastError = error;
  });
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    const code = redisErrorCode(error);
    throw new RedisConnectionFailure(code === "UNCLASSIFIED" ? redisErrorCode(lastError) : code);
  }
  return { client, close: () => closeClient(client) };
}

/** Post-connect check: GET of the sentinel key must equal the registered marker. */
async function verifySentinel(client: Redis): Promise<void> {
  let value: string | null;
  try {
    value = await client.get(SENTINEL_KEY);
  } catch (error) {
    if (redisErrorCode(error) === "WRONGTYPE") {
      throw new RedisGuardRefusal("sentinel-mismatch", "the sentinel key does not hold the registered marker");
    }
    throw new RedisConnectionFailure(redisErrorCode(error));
  }
  checkSentinelValue(value);
}

/** The guarded connection: pre-connect checks, connection, sentinel. */
async function connectGuarded(
  target: RedisTestTarget = REGISTERED_TARGET,
  env: InheritedEnv = process.env,
): Promise<GuardedRedis> {
  const guarded = await connectUnverified(target, env);
  try {
    await verifySentinel(guarded.client);
  } catch (error) {
    await guarded.close();
    throw error;
  }
  return guarded;
}

/** Keys requested per SCAN step. */
const SCAN_COUNT = 1_000;

function scanStep(client: Redis, pattern: string): (cursor: string) => Promise<unknown> {
  return (cursor) => command(() => client.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT));
}

async function readUsedMemory(client: Redis): Promise<number> {
  const info = await command(() => client.info("memory"));
  const value = /^used_memory:(\d+)\r?$/m.exec(info)?.[1];
  if (value === undefined) throw new Error("INFO memory has no used_memory line");
  return Number(value);
}

// ---- narrow operations ----------------------------------------------------

/** The full guard against `target`; the connection is closed again. */
export async function checkGuardedEndpoint(
  target: RedisTestTarget = REGISTERED_TARGET,
  env: InheritedEnv = process.env,
): Promise<void> {
  const guarded = await connectGuarded(target, env);
  await guarded.close();
}

export interface ServerBaseline {
  /** INFO server redis_version. */
  readonly redisVersion: string | undefined;
  /** The CONFIG GET reply for each name in EXPECTED_SERVER_CONFIG. */
  readonly config: Readonly<Record<string, unknown>>;
}

/** The server-baseline reads of the preflight, through the guard. */
export async function readServerBaseline(): Promise<ServerBaseline> {
  const guarded = await connectGuarded(REGISTERED_TARGET);
  try {
    const info = await command(() => guarded.client.info("server"));
    const redisVersion = /^redis_version:([^\r\n]*)$/m.exec(info)?.[1];
    const config: Record<string, unknown> = {};
    for (const name of Object.keys(EXPECTED_SERVER_CONFIG)) {
      config[name] = await command(() => guarded.client.config("GET", name));
    }
    return { redisVersion, config };
  } finally {
    await guarded.close();
  }
}

/** INFO memory used_memory of the test Redis, through a guarded connection. */
export async function usedMemoryBytes(): Promise<number> {
  const guarded = await connectGuarded(REGISTERED_TARGET);
  try {
    return await readUsedMemory(guarded.client);
  } finally {
    await guarded.close();
  }
}

export type BootstrapOutcome = "written" | "present";

/**
 * Sentinel bootstrap (DR-11): writes the sentinel into the main test database
 * only when the key is absent (SET NX); any other value is refused, never
 * overwritten.
 */
export async function bootstrapSentinel(): Promise<BootstrapOutcome> {
  const guarded = await connectUnverified(REGISTERED_TARGET);
  try {
    const reply = await command(() => guarded.client.set(SENTINEL_KEY, SENTINEL_MARKER, "NX"));
    // Either way, the key must now hold the marker; anything else is refused.
    await verifySentinel(guarded.client);
    return reply === "OK" ? "written" : "present";
  } finally {
    await guarded.close();
  }
}

export interface TestRedisAudit {
  readonly sentinelIntact: boolean;
  /** Absent when the sentinel is not intact: the endpoint is then not verified. */
  readonly usedMemory?: number;
  /** Keys matching `irs-test-*`, from a complete read-only SCAN; absent as above. */
  readonly remainingTestKeys?: number;
}

/**
 * The post-run audit's reads (DF-4): the sentinel, then used_memory and a
 * complete, read-only SCAN of every test namespace's keys. A failure to read
 * is thrown, so the caller reports the state as not established.
 */
export async function auditTestRedis(): Promise<TestRedisAudit> {
  const guarded = await connectUnverified(REGISTERED_TARGET);
  try {
    try {
      await verifySentinel(guarded.client);
    } catch (error) {
      if (error instanceof RedisGuardRefusal) return { sentinelIntact: false };
      throw error;
    }
    const usedMemory = await readUsedMemory(guarded.client);
    const remaining = await scanAll(scanStep(guarded.client, `${TEST_NAMESPACE_STEM}*`));
    return { sentinelIntact: true, usedMemory, remainingTestKeys: remaining.length };
  } finally {
    await guarded.close();
  }
}

// ---- DF-3: the guard-check database's sentinel ----------------------------

const WRONG_SENTINEL_VALUE = "not-the-marker";

/**
 * DF-3 (D-F2(b)): the only scope the guard-check helper acts on is the
 * sentinel key in the guard-check database. Validation only.
 */
export function checkGuardCheckScope(db: number, key: string): void {
  if (db !== GUARD_CHECK_DATABASE_INDEX) {
    throw new RedisGuardRefusal("guard-check-scope", "only the guard-check database");
  }
  if (key !== SENTINEL_KEY) {
    throw new RedisGuardRefusal("guard-check-scope", "only the sentinel key");
  }
}

/** Q4: canonical non-negative decimal, at most nine digits (so no overflow). */
const CANONICAL_DATABASE_NUMBER = /^(0|[1-9][0-9]{0,8})$/;

/**
 * Task 012B (Q4, PL-11; B1-12 carry-forward 1): the strict, pure parser of a
 * CLIENT INFO reply's `db=` field. One line, with at most one trailing "\n";
 * tokens separated by single spaces, each `key=value` with a non-empty key;
 * exactly one token whose key is exactly `db`; its value in canonical decimal;
 * equal to `expected`, itself a registered logical database. Anything
 * malformed or ambiguous fails closed: no fallback to a first occurrence and no
 * other source for the number. Throws RedisGuardRefusal; never echoes a value.
 */
export function checkSelectedDatabase(clientInfo: string, expected: number): void {
  if (!REGISTERED_DATABASE_INDEXES.includes(expected)) {
    throw new RedisGuardRefusal("database-expected", "the expected logical database is not registered");
  }
  const line = clientInfo.endsWith("\n") ? clientInfo.slice(0, -1) : clientInfo;
  if (line === "" || line.includes("\n") || line.includes("\r")) {
    throw new RedisGuardRefusal("database-reply", "the CLIENT INFO reply is not exactly one line");
  }
  const tokens = line.split(" ");
  if (tokens.some((token) => token.indexOf("=") <= 0)) {
    throw new RedisGuardRefusal("database-reply", "the CLIENT INFO reply is not single-space key=value tokens");
  }
  const values = tokens.filter((token) => token.slice(0, token.indexOf("=")) === "db").map((token) => token.slice("db=".length));
  if (values.length !== 1) {
    throw new RedisGuardRefusal("database-field", "the CLIENT INFO reply does not hold exactly one db field");
  }
  const value = values[0] ?? "";
  if (!CANONICAL_DATABASE_NUMBER.test(value)) {
    throw new RedisGuardRefusal("database-value", "the db field is not a canonical decimal number");
  }
  if (Number(value) !== expected) {
    throw new RedisGuardRefusal("database-mismatch", "the connection is not on the expected logical database");
  }
}

async function verifySelectedDatabase(client: Redis, db: number): Promise<void> {
  const info = await command(() => client.client("INFO"));
  checkSelectedDatabase(info, db);
}

/**
 * Task 012B (Part B5 decision 3; Part B4's carry-forward for RUN B): the
 * shape of a CLIENT INFO reply, with no value but the `db` field's. Key names
 * are listed only when they are plain names (lower-case letters, digits and
 * hyphens, at most 32), so a malformed token can never leak a value fragment.
 */
export interface ClientInfoShape {
  readonly lineCount: number;
  readonly endsWithSingleNewline: boolean;
  readonly tokenCount: number;
  readonly allTokensKeyValue: boolean;
  readonly keyNames: readonly string[];
  readonly dbTokenCount: number;
  /** The `db` value, only when exactly one `db` token exists; otherwise null. */
  readonly dbValue: string | null;
  /** checkSelectedDatabase(reply, the guard-check database): "accepted" or the refusal code. */
  readonly verdict: "accepted" | RedisGuardCheck;
}

const PLAIN_KEY_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Pure and string-only: no client, no connection. Returns only the fields of ClientInfoShape. */
export function describeClientInfoShape(reply: string): ClientInfoShape {
  const endsWithSingleNewline = reply.endsWith("\n") && !reply.endsWith("\n\n");
  const body = reply.endsWith("\n") ? reply.slice(0, -1) : reply;
  const tokens = body.split(" ");
  const keyOf = (token: string): string | undefined => (token.indexOf("=") > 0 ? token.slice(0, token.indexOf("=")) : undefined);
  const dbTokens = tokens.filter((token) => keyOf(token) === "db");
  let verdict: "accepted" | RedisGuardCheck = "accepted";
  try {
    checkSelectedDatabase(reply, GUARD_CHECK_DATABASE_INDEX);
  } catch (error) {
    if (!(error instanceof RedisGuardRefusal)) throw error;
    verdict = error.check;
  }
  return Object.freeze({
    lineCount: body.split("\n").length,
    endsWithSingleNewline,
    tokenCount: tokens.length,
    allTokensKeyValue: tokens.every((token) => keyOf(token) !== undefined) && !body.includes("\n") && !body.includes("\r"),
    keyNames: Object.freeze(tokens.map(keyOf).filter((key): key is string => key !== undefined && PLAIN_KEY_NAME.test(key))),
    dbTokenCount: dbTokens.length,
    dbValue: dbTokens.length === 1 ? (dbTokens[0] ?? "").slice("db=".length) : null,
    verdict,
  });
}

/**
 * Task 012B (RUN B, B1): read-only observation of the live reply's shape. The
 * guarded path (endpoint, password file, sentinel), then the guard-check
 * database, then CLIENT INFO, returned only through describeClientInfoShape.
 * The strict check is not run first, so a non-conforming reply is still observed.
 */
export async function observeClientInfoShape(): Promise<ClientInfoShape> {
  checkGuardCheckScope(GUARD_CHECK_DATABASE_INDEX, SENTINEL_KEY);
  const guarded = await connectGuarded(REGISTERED_TARGET);
  try {
    await command(() => guarded.client.select(GUARD_CHECK_DATABASE_INDEX));
    const reply = await command(() => guarded.client.client("INFO"));
    return describeClientInfoShape(reply);
  } finally {
    await guarded.close();
  }
}

/** The approved endpoint (main-database sentinel verified), then the guard-check database, verified by the server. */
async function withGuardCheckDatabase<T>(operation: (client: Redis) => Promise<T>): Promise<T> {
  checkGuardCheckScope(GUARD_CHECK_DATABASE_INDEX, SENTINEL_KEY);
  const guarded = await connectGuarded(REGISTERED_TARGET);
  try {
    await command(() => guarded.client.select(GUARD_CHECK_DATABASE_INDEX));
    await verifySelectedDatabase(guarded.client, GUARD_CHECK_DATABASE_INDEX);
    return await operation(guarded.client);
  } finally {
    await guarded.close();
  }
}

function deleteGuardCheckSentinel(client: Redis): Promise<number> {
  return command(() => client.del(SENTINEL_KEY));
}

/**
 * DF-3's dedicated helper for the guard's own tests: the sentinel key in the
 * guard-check database only, both fixed here. It takes no key and no
 * database, and offers no other deletion.
 */
export const guardCheckSentinel = Object.freeze({
  setMarker: (): Promise<string> =>
    withGuardCheckDatabase((client) => command(() => client.set(SENTINEL_KEY, SENTINEL_MARKER))),
  setWrongValue: (): Promise<string> =>
    withGuardCheckDatabase((client) => command(() => client.set(SENTINEL_KEY, WRONG_SENTINEL_VALUE))),
  deleteKey: (): Promise<number> => withGuardCheckDatabase(deleteGuardCheckSentinel),
});

// ---- test namespaces (D-F2 rule 1) ----------------------------------------

/** The cleanup's store: one guarded connection, bound to one issued prefix. */
async function openNamespaceStore(target: RedisTestTarget, env: InheritedEnv, prefix: string): Promise<NamespaceStore> {
  checkNamespacePrefix(prefix);
  const { client, close } = await connectGuarded(target, env);
  const own = `${prefix}:`;
  return Object.freeze({
    readSentinel: () => command(() => client.get(SENTINEL_KEY)),
    scan: scanStep(client, `${own}*`),
    unlink: (keys: readonly string[]) => {
      // Third line of defence: this store deletes only its own namespace's keys, by name.
      if (keys.length === 0 || keys.some((key) => key === SENTINEL_KEY || !key.startsWith(own))) {
        return Promise.reject(new NamespaceCleanupFailure("candidate", "a key outside the namespace was passed for deletion"));
      }
      return command(() => client.unlink([...keys]));
    },
    close,
  });
}

/** The issuer every Redis test uses: the registered target, the guard and the guarded store. */
const NAMESPACES = createNamespaceIssuer({
  target: REGISTERED_TARGET,
  env: process.env,
  validateTarget: validateRedisTarget,
  checkSentinel: checkSentinelValue,
  openStore: openNamespaceStore,
});

/**
 * Issues this test a new key namespace `irs-test-<label>-<uuid>` and registers
 * its cleanup on `context.after` (the test's own after-hook): after the test
 * body, every key under the namespace is deleted through the guard.
 */
export function issueTestNamespace(context: TestContextLike, label: string): TestNamespace {
  return NAMESPACES.issue(context, label);
}

/**
 * Dispatch settings for an issued namespace that has not been cleaned up. The
 * registered target passes the full guard first; the password is the test
 * password, loaded in-process through the D6 loader and never displayed.
 */
export async function guardedDispatchSettings(namespace: TestNamespace): Promise<DispatchSettings> {
  const prefix = NAMESPACES.activePrefix(namespace);
  await checkGuardedEndpoint(REGISTERED_TARGET);
  const password = loadRedisPassword({ REDIS_PASSWORD_FILE: REGISTERED_TARGET.passwordFile }, REPOSITORY_ROOT);
  return {
    host: REGISTERED_TARGET.host,
    port: REGISTERED_TARGET.port,
    password,
    prefix,
  };
}

/** The number of keys under an issued namespace (complete read-only SCAN), through the guard. */
export async function namespaceKeyCount(namespace: TestNamespace): Promise<number> {
  const prefix = NAMESPACES.issuedPrefix(namespace);
  const guarded = await connectGuarded(REGISTERED_TARGET);
  try {
    return (await scanAll(scanStep(guarded.client, `${prefix}:*`))).length;
  } finally {
    await guarded.close();
  }
}
