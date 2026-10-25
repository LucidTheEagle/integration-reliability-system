/**
 * Task 012A (record §5 item 3, as DR-10b H3): verifies the development Redis
 * credential without printing it.
 *
 * Run by the founder only, from Git Bash in the repository root:
 *
 *   pnpm --filter @irs/config --filter @irs/worker run build && node scripts/verify-dev-redis.mjs
 *
 * Prerequisites: `pnpm install` has been run; @irs/config and @irs/worker have been
 * built (the command above); scripts/init-redis-secrets.mjs has created the four
 * secret files; `.env` sets REDIS_HOST="127.0.0.1", REDIS_PORT="6379" and
 * REDIS_PASSWORD_FILE (pointing at secrets/redis_password); `irs-redis` is running,
 * and the containers `irs-redis` and `irs-test-redis` exist (running or stopped).
 *
 * Uses only Node built-ins, @irs/worker's installed ioredis, @irs/config and
 * @irs/worker's built D6 password loader.
 *
 * Source of REDIS_PASSWORD_FILE: any REDIS_PASSWORD_FILE inherited from the shell
 * is recorded, then deleted from process.env. The script then loads `.env` itself
 * with process.loadEnvFile, before @irs/config and the loader are imported
 * (dynamically, afterwards), so the path tested can only come from `.env`. Host
 * and port are read through @irs/config's `loadConfig(process.env)`.
 *
 * Prints exactly these lines and nothing else:
 *   INHERITED_REDIS_PASSWORD_FILE_PRESENT=true|false
 *   FILE_MATCHES_ACL=true|false          SHA-256 of secrets/redis_password equals the hash in
 *                                        secrets/redis_users.acl (constant time)
 *   REDIS_ACCEPTS_CREDENTIAL=true|false  ioredis to 127.0.0.1:6379 with the file password, then PING
 *   SERVER_CONFIG_OK=true|false          on that connection, CONFIG GET reports maxmemory 268435456,
 *                                        maxmemory-policy noeviction, appendonly yes, appendfsync everysec
 *   APP_PATH_CONNECTS=true|false         host and port from loadConfig, password through the D6
 *                                        loader (REDIS_PASSWORD_FILE from .env), then PING
 *   INSPECT_HAS_NO_PASSWORD=true|false   `docker inspect irs-redis` and `docker inspect irs-test-redis`
 *                                        both succeed, and their output, checked in memory, contains
 *                                        neither the dev nor the test password, nor either hash
 *   ERROR_CODE=<word>                    only when a check is false: AUTH_FAILED, CONNECTION_REFUSED,
 *                                        TIMEOUT, CONFIG_INVALID or OTHER
 * ERROR_CODE is the code of the first false check, in the order above. AUTH_FAILED only
 * for a Redis error reply whose first word is WRONGPASS or NOAUTH; CONNECTION_REFUSED
 * from the client code ECONNREFUSED; TIMEOUT from ETIMEDOUT or this script's own
 * deadline; CONFIG_INVALID when `.env` cannot be loaded, loadConfig rejects the
 * configuration (every check false, no connection attempted), or the D6 loader refuses.
 * A configuration mismatch, a hash mismatch and an inspect failure are OTHER. An error
 * message is never printed; for a Redis reply only its first word is read.
 *
 * Refusals (prints only REFUSED=<word>, exits 2, no connection attempted):
 *   TARGET         loadConfig's REDIS_HOST is not 127.0.0.1 or its REDIS_PORT is not 6379
 *   SECRET_FORMAT  secrets/redis_password is missing or unreadable, or after one trailing newline
 *                  is trimmed it is not exactly 64 hexadecimal characters; or secrets/redis_users.acl
 *                  is missing, unreadable or not exactly one well-formed ACL line
 *
 * Exit code: 0 when every check is true, 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_PASSWORD_FILE = join(ROOT, "secrets", "redis_password");
const DEV_ACL_FILE = join(ROOT, "secrets", "redis_users.acl");
const TEST_PASSWORD_FILE = join(ROOT, "secrets", "redis_test_password");
const TEST_ACL_FILE = join(ROOT, "secrets", "redis_test_users.acl");
const DEV_HOST = "127.0.0.1";
const DEV_PORT = 6379;
const CHECK_DEADLINE_MS = 10_000;
const EXPECTED_CONFIG = {
  maxmemory: "268435456",
  "maxmemory-policy": "noeviction",
  appendonly: "yes",
  appendfsync: "everysec",
};
const INSPECTED_CONTAINERS = ["irs-redis", "irs-test-redis"];

// Never let a stack trace or client message reach the terminal.
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));

const inheritedPresent = Object.prototype.hasOwnProperty.call(process.env, "REDIS_PASSWORD_FILE");
delete process.env.REDIS_PASSWORD_FILE;

function print(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function refuse(word) {
  print([`REFUSED=${word}`]);
  process.exit(2);
}

function configInvalid() {
  print([
    `INHERITED_REDIS_PASSWORD_FILE_PRESENT=${inheritedPresent}`,
    "FILE_MATCHES_ACL=false",
    "REDIS_ACCEPTS_CREDENTIAL=false",
    "SERVER_CONFIG_OK=false",
    "APP_PATH_CONNECTS=false",
    "INSPECT_HAS_NO_PASSWORD=false",
    "ERROR_CODE=CONFIG_INVALID",
  ]);
  process.exit(1);
}

const property = (value, key) => (typeof value === "object" && value !== null ? value[key] : undefined);

class DeadlineError extends Error {}

function classifyRedisError(error) {
  if (error instanceof DeadlineError) return "TIMEOUT";
  if (property(error, "name") === "ReplyError") {
    const word = String(property(error, "message")).split(" ", 1)[0];
    return word === "WRONGPASS" || word === "NOAUTH" ? "AUTH_FAILED" : "OTHER";
  }
  const code = property(error, "code");
  if (code === "ECONNREFUSED") return "CONNECTION_REFUSED";
  if (code === "ETIMEDOUT") return "TIMEOUT";
  return "OTHER";
}

/** Runs `operation`, failing with DeadlineError after CHECK_DEADLINE_MS. */
async function withinDeadline(operation) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), CHECK_DEADLINE_MS);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function constantTimeEqual(a, b) {
  const digest = (value) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

function readPassword(file) {
  const value = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("format");
  return value;
}

function readAclHash(file) {
  const match = /^user default on #([0-9a-f]{64}) ~\* &\* \+@all(\r?\n)?$/.exec(readFileSync(file, "utf8"));
  if (match === null) throw new Error("format");
  return match[1];
}

// 1. Load .env before importing anything that may read the configuration.
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  configInvalid();
}

const requireFromWorker = createRequire(join(ROOT, "apps", "worker", "package.json"));
const { loadConfig } = await import(pathToFileURL(requireFromWorker.resolve("@irs/config")).href);

let config;
try {
  config = loadConfig(process.env);
} catch {
  configInvalid();
}

// 2. Refusals.
if (config.redis.host !== DEV_HOST || config.redis.port !== DEV_PORT) refuse("TARGET");

let filePassword;
let aclHash;
try {
  filePassword = readPassword(DEV_PASSWORD_FILE);
  aclHash = readAclHash(DEV_ACL_FILE);
} catch {
  refuse("SECRET_FORMAT");
}

// 3. Checks.
const errorCodes = [];
const fileMatchesAcl = constantTimeEqual(sha256Hex(filePassword), aclHash);
if (!fileMatchesAcl) errorCodes.push("OTHER");

const Redis = requireFromWorker("ioredis");

/** Connects with `password`, runs `check(client)`, always disconnects. Returns an error code or undefined. */
async function withClient(host, port, password, check) {
  let lastError;
  const client = new Redis({
    host,
    port,
    password,
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on("error", (error) => {
    lastError = error;
  });
  try {
    await withinDeadline(async () => {
      await client.connect();
      await check(client);
    });
    return undefined;
  } catch (error) {
    if (error instanceof CheckFailed) return "OTHER";
    const code = classifyRedisError(error);
    return code === "OTHER" && lastError !== undefined ? classifyRedisError(lastError) : code;
  } finally {
    client.disconnect();
  }
}

class CheckFailed extends Error {}

let redisAcceptsCredential = false;
let serverConfigOk = false;
const credentialCode = await withClient(DEV_HOST, DEV_PORT, filePassword, async (client) => {
  if ((await client.ping()) !== "PONG") throw new CheckFailed();
  redisAcceptsCredential = true;
  for (const [name, expected] of Object.entries(EXPECTED_CONFIG)) {
    const reply = await client.config("GET", name);
    if (!Array.isArray(reply) || reply.length !== 2 || reply[0] !== name || reply[1] !== expected) {
      throw new CheckFailed();
    }
  }
  serverConfigOk = true;
});
if (credentialCode !== undefined) errorCodes.push(credentialCode);

let appPathConnects = false;
const workerLoader = pathToFileURL(join(ROOT, "apps", "worker", "dist", "redis-password.js")).href;
try {
  const { loadRedisPassword } = await import(workerLoader);
  const appPassword = loadRedisPassword(process.env, ROOT);
  const appCode = await withClient(config.redis.host, config.redis.port, appPassword, async (client) => {
    if ((await client.ping()) !== "PONG") throw new CheckFailed();
  });
  if (appCode === undefined) appPathConnects = true;
  else errorCodes.push(appCode);
} catch {
  errorCodes.push("CONFIG_INVALID");
}

let inspectHasNoPassword = false;
try {
  const secrets = [filePassword, aclHash, readPassword(TEST_PASSWORD_FILE), readAclHash(TEST_ACL_FILE)].map(
    (value) => value.toLowerCase(),
  );
  let clean = true;
  for (const name of INSPECTED_CONTAINERS) {
    const result = spawnSync("docker", ["inspect", name], { encoding: "utf8", windowsHide: true });
    // Positive evidence only: exit 0 and exactly one inspected object.
    const parsed = result.status === 0 ? JSON.parse(result.stdout) : undefined;
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      clean = false;
      break;
    }
    const text = result.stdout.toLowerCase();
    if (secrets.some((secret) => text.includes(secret))) clean = false;
  }
  inspectHasNoPassword = clean;
} catch {
  inspectHasNoPassword = false;
}
if (!inspectHasNoPassword) errorCodes.push("OTHER");

// 4. Report.
const allTrue = fileMatchesAcl && redisAcceptsCredential && serverConfigOk && appPathConnects && inspectHasNoPassword;
const lines = [
  `INHERITED_REDIS_PASSWORD_FILE_PRESENT=${inheritedPresent}`,
  `FILE_MATCHES_ACL=${fileMatchesAcl}`,
  `REDIS_ACCEPTS_CREDENTIAL=${redisAcceptsCredential}`,
  `SERVER_CONFIG_OK=${serverConfigOk}`,
  `APP_PATH_CONNECTS=${appPathConnects}`,
  `INSPECT_HAS_NO_PASSWORD=${inspectHasNoPassword}`,
];
if (!allTrue) lines.push(`ERROR_CODE=${errorCodes[0] ?? "OTHER"}`);
print(lines);
process.exit(allTrue ? 0 : 1);
