/**
 * DR-10b (H3): verifies the development PostgreSQL credential without printing it.
 *
 * Run by the founder only, from Git Bash in the repository root:
 *
 *   pnpm --filter @irs/config --filter @irs/db run build && node scripts/verify-dev-postgres.mjs
 *
 * Prerequisites: `pnpm install` has been run, and @irs/config and @irs/db have been
 * built. The `@irs/db` build also generates the Prisma client. `irs-postgres` is
 * running (`docker compose start postgres`).
 *
 * Source of DATABASE_URL: any DATABASE_URL inherited from the shell is recorded,
 * then deleted from process.env. The script then loads `.env` itself with
 * process.loadEnvFile, before any module that might read DATABASE_URL is
 * imported (@irs/config, @irs/db and pg are imported dynamically afterwards), so
 * the value tested can only come from `.env`. It is then read through
 * @irs/config's `loadConfig(process.env)`.
 *
 * Prints exactly these lines and nothing else:
 *   INHERITED_DATABASE_URL_PRESENT=true|false
 *   FILE_MATCHES_ENV=true|false        file password equals the URL's decoded password (constant time)
 *   DB_ACCEPTS_CREDENTIAL=true|false   direct pg connection to 127.0.0.1:5432/irs_dev as postgres with
 *                                      the password from secrets/postgres_password, then SELECT 1
 *   APP_CONFIG_CONNECTS=true|false     @irs/db createDatabase({ connectionString: config.database.url }),
 *                                      ping() (SELECT 1), then disconnectWithin (an error from that
 *                                      final disconnect is ignored, as is one from the direct client's end())
 *   ERROR_CODE=<word>                  only when a check is false: AUTH_FAILED, CONNECTION_REFUSED,
 *                                      TIMEOUT, CONFIG_INVALID or OTHER
 * ERROR_CODE is the code of the first failing connection check (direct first). It is
 * OTHER when only FILE_MATCHES_ENV is false. It is CONFIG_INVALID, with every check
 * false and no connection attempted, when `.env` cannot be loaded, loadConfig rejects
 * the configuration, or the URL cannot be parsed or decoded.
 *
 * Refusals (prints only REFUSED=<word>, exits 2, no connection attempted):
 *   URL_TARGET          the URL's user name is not postgres, its host is not 127.0.0.1, its port is not 5432
 *                       or its database is not irs_dev
 *   SECRET_FORMAT       secrets/postgres_password is missing or unreadable, or after one trailing newline
 *                       is trimmed it is not exactly 64 hexadecimal characters
 *   URL_PASSWORD_EMPTY  the URL's decoded password is empty
 *
 * Error classification: AUTH_FAILED only for SQLSTATE 28P01 (invalid_password) returned
 * by the server. 28000 and every other SQLSTATE are OTHER. CONNECTION_REFUSED comes from
 * the client code ECONNREFUSED, or from the adapter kind DatabaseNotReachable that
 * adapter-pg derives from it. TIMEOUT comes from the client code ETIMEDOUT, the adapter
 * kind SocketTimeout, or this script's own deadline. An error message is never read or
 * printed. Exit code: 0 when every check is true, 1 otherwise.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_FILE = join(ROOT, "secrets", "postgres_password");
const CHECK_DEADLINE_MS = 10_000;

// Never let a stack trace or driver message reach the terminal.
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));

const inheritedPresent = Object.prototype.hasOwnProperty.call(process.env, "DATABASE_URL");
delete process.env.DATABASE_URL;

function print(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function refuse(word) {
  print([`REFUSED=${word}`]);
  process.exit(2);
}

function configInvalid() {
  print([
    `INHERITED_DATABASE_URL_PRESENT=${inheritedPresent}`,
    "FILE_MATCHES_ENV=false",
    "DB_ACCEPTS_CREDENTIAL=false",
    "APP_CONFIG_CONNECTS=false",
    "ERROR_CODE=CONFIG_INVALID",
  ]);
  process.exit(1);
}

const property = (value, key) => (typeof value === "object" && value !== null ? value[key] : undefined);

/** The driver-adapter cause, located as @irs/db's errors.ts does (adapterCause). */
function adapterCause(error) {
  const fromMeta = property(property(property(error, "meta"), "driverAdapterError"), "cause");
  if (fromMeta !== undefined) return fromMeta;
  if (error instanceof Error && error.name === "DriverAdapterError") return property(error, "cause");
  return undefined;
}

function classifyByCode(code) {
  if (code === "ECONNREFUSED") return "CONNECTION_REFUSED";
  if (code === "ETIMEDOUT") return "TIMEOUT";
  return undefined;
}

/** Direct pg client errors: a server SQLSTATE comes only from pg's DatabaseError. */
function classifyPgError(error, pg) {
  if (error instanceof pg.DatabaseError) return error.code === "28P01" ? "AUTH_FAILED" : "OTHER";
  const errors = error instanceof AggregateError ? error.errors : [error];
  for (const item of errors) {
    const word = classifyByCode(property(item, "code"));
    if (word !== undefined) return word;
  }
  return "OTHER";
}

/** Prisma and driver-adapter errors from the application path. */
function classifyAppError(error) {
  const cause = adapterCause(error);
  const sqlState = property(cause, "originalCode");
  if (typeof sqlState === "string" && sqlState !== "") return sqlState === "28P01" ? "AUTH_FAILED" : "OTHER";
  const kind = property(cause, "kind");
  if (kind === "DatabaseNotReachable") return "CONNECTION_REFUSED";
  if (kind === "SocketTimeout") return "TIMEOUT";
  return classifyByCode(property(error, "code")) ?? "OTHER";
}

class DeadlineError extends Error {}

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

function constantTimeEqual(a, b) {
  const digest = (value) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

// 1. Load .env before importing anything that may read DATABASE_URL.
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  configInvalid();
}

const requireFromApi = createRequire(join(ROOT, "apps", "api", "package.json"));
const requireFromDb = createRequire(join(ROOT, "packages", "db", "package.json"));
const { loadConfig } = await import(pathToFileURL(requireFromApi.resolve("@irs/config")).href);

let config;
let url;
let urlPassword;
try {
  config = loadConfig(process.env);
  url = new URL(config.database.url);
  urlPassword = decodeURIComponent(url.password);
} catch {
  configInvalid();
}

// 2. Refusals.
const targetOk =
  (url.protocol === "postgresql:" || url.protocol === "postgres:") &&
  url.username === "postgres" &&
  url.hostname === "127.0.0.1" &&
  url.port === "5432" &&
  url.pathname === "/irs_dev";
if (!targetOk) refuse("URL_TARGET");

let filePassword;
try {
  filePassword = readFileSync(SECRET_FILE, "utf8").replace(/\r?\n$/, "");
} catch {
  refuse("SECRET_FORMAT");
}
if (!/^[0-9a-fA-F]{64}$/.test(filePassword)) refuse("SECRET_FORMAT");
if (urlPassword === "") refuse("URL_PASSWORD_EMPTY");

// 3. Checks.
const fileMatchesEnv = constantTimeEqual(filePassword, urlPassword);
const errorCodes = [];

const requireFromAdapter = createRequire(requireFromDb.resolve("@prisma/adapter-pg"));
const pg = requireFromAdapter("pg");

let dbAcceptsCredential = false;
const client = new pg.Client({
  host: "127.0.0.1",
  port: 5432,
  database: "irs_dev",
  user: "postgres",
  password: filePassword,
});
client.on("error", () => {});
try {
  await withinDeadline(async () => {
    await client.connect();
    await client.query("SELECT 1");
  });
  dbAcceptsCredential = true;
} catch (error) {
  errorCodes.push(error instanceof DeadlineError ? "TIMEOUT" : classifyPgError(error, pg));
} finally {
  await withinDeadline(() => client.end()).catch(() => {});
}

const { createDatabase, disconnectWithin, DISCONNECT_TIMEOUT_MS } = await import(
  pathToFileURL(requireFromApi.resolve("@irs/db")).href
);
let appConfigConnects = false;
const db = createDatabase({ connectionString: config.database.url });
try {
  await withinDeadline(() => db.ping());
  appConfigConnects = true;
} catch (error) {
  errorCodes.push(error instanceof DeadlineError ? "TIMEOUT" : classifyAppError(error));
} finally {
  await disconnectWithin(db, DISCONNECT_TIMEOUT_MS).catch(() => {});
}

// 4. Report.
const allTrue = fileMatchesEnv && dbAcceptsCredential && appConfigConnects;
const lines = [
  `INHERITED_DATABASE_URL_PRESENT=${inheritedPresent}`,
  `FILE_MATCHES_ENV=${fileMatchesEnv}`,
  `DB_ACCEPTS_CREDENTIAL=${dbAcceptsCredential}`,
  `APP_CONFIG_CONNECTS=${appConfigConnects}`,
];
if (!allTrue) lines.push(`ERROR_CODE=${errorCodes[0] ?? "OTHER"}`);
print(lines);
process.exit(allTrue ? 0 : 1);
