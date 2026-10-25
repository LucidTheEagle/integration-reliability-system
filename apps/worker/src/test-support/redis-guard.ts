import { isAbsolute, resolve } from "node:path";
import { Redis } from "ioredis";
import { RedisPasswordFileError, loadRedisPassword } from "../redis-password.js";
import { REPOSITORY_ROOT } from "../repository-root.js";
import {
  DEV_PASSWORD_FILE,
  DEV_REDIS_PORT,
  MAIN_DATABASE_INDEX,
  REGISTERED_DATABASE_INDEXES,
  SENTINEL_KEY,
  SENTINEL_MARKER,
  TEST_PASSWORD_FILE,
  TEST_REDIS_HOST,
  TEST_REDIS_PORT,
} from "./redis-registry.js";

// The test-Redis guard (DR-11; Task 012A record D7, D17). Every test
// connection, the bootstrap and the preflight go through it. A refusal names
// the failed check and never a value (no host, port, path or password).

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
  | "sentinel-mismatch";

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
    error instanceof RedisPasswordFileError
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

export interface GuardedRedis {
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

/**
 * Pre-connect checks, then a connection, without the sentinel check. For the
 * bootstrap and the guard's own post-connect tests only.
 */
export async function connectUnverified(
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
export async function verifySentinel(client: Redis): Promise<void> {
  let value: string | null;
  try {
    value = await client.get(SENTINEL_KEY);
  } catch (error) {
    if (redisErrorCode(error) === "WRONGTYPE") {
      throw new RedisGuardRefusal("sentinel-mismatch", "the sentinel key does not hold the registered marker");
    }
    throw new RedisConnectionFailure(redisErrorCode(error));
  }
  if (value === null) {
    throw new RedisGuardRefusal("sentinel-missing", "the sentinel key is absent");
  }
  if (value !== SENTINEL_MARKER) {
    throw new RedisGuardRefusal("sentinel-mismatch", "the sentinel key does not hold the registered marker");
  }
}

/** The guarded connection every test uses: pre-connect checks, connection, sentinel. */
export async function connectGuarded(
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
