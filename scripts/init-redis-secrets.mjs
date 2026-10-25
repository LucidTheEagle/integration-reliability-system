/**
 * Task 012A (record D5, D17): creates the development and test Redis secrets
 * without displaying them.
 *
 * Run by the founder only, from Git Bash in the repository root:
 *
 *   node scripts/init-redis-secrets.mjs
 *
 * Prerequisites: none beyond Node (built-in modules only; nothing to build).
 * `secrets/` is git-ignored.
 *
 * Creates, in secrets/:
 *   redis_password          32 random bytes as 64 lowercase hex, no trailing newline (the client file)
 *   redis_users.acl         one line: user default on #<SHA-256 of that password, 64 lowercase hex> ~* &* +@all
 *   redis_test_password     as redis_password, a separate value, for the test Redis
 *   redis_test_users.acl    as redis_users.acl, for the test password
 *
 * Refuses, creating nothing, if any of the four files already exists. Each
 * file is created exclusively (it can never overwrite one).
 *
 * Prints exactly these lines and nothing else (never a password or a hash):
 *   CREATED=<comma-separated names of the files this run created; empty if none>
 *   SECRETS_OK=true|false   every file was created and read back well-formed, and
 *                           each ACL hash matches its password
 * Exit code: 0 when SECRETS_OK=true, 2 on refusal, 1 otherwise.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = join(ROOT, "secrets");

const PAIRS = [
  { password: "redis_password", acl: "redis_users.acl" },
  { password: "redis_test_password", acl: "redis_test_users.acl" },
];
const NAMES = PAIRS.flatMap((pair) => [pair.password, pair.acl]);

const PASSWORD_PATTERN = /^[0-9a-f]{64}$/;
const ACL_PATTERN = /^user default on #([0-9a-f]{64}) ~\* &\* \+@all\n$/;

// Never let a stack trace or a message reach the terminal.
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));

const created = [];

function finish(ok, exitCode) {
  process.stdout.write(`CREATED=${created.join(",")}\nSECRETS_OK=${ok}\n`);
  process.exit(exitCode);
}

const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");

if (NAMES.some((name) => existsSync(join(SECRETS, name)))) finish(false, 2);

try {
  mkdirSync(SECRETS, { recursive: true });
  for (const pair of PAIRS) {
    const password = randomBytes(32).toString("hex");
    writeFileSync(join(SECRETS, pair.password), password, { flag: "wx", mode: 0o600 });
    created.push(pair.password);
    writeFileSync(join(SECRETS, pair.acl), `user default on #${sha256Hex(password)} ~* &* +@all\n`, {
      flag: "wx",
      mode: 0o600,
    });
    created.push(pair.acl);
  }
} catch {
  finish(false, 1);
}

// Read back and check, in memory only.
let ok = true;
try {
  const passwords = [];
  for (const pair of PAIRS) {
    const password = readFileSync(join(SECRETS, pair.password), "utf8");
    const acl = readFileSync(join(SECRETS, pair.acl), "utf8");
    const match = ACL_PATTERN.exec(acl);
    if (!PASSWORD_PATTERN.test(password) || match === null) {
      ok = false;
      continue;
    }
    if (!timingSafeEqual(Buffer.from(sha256Hex(password), "utf8"), Buffer.from(match[1], "utf8"))) ok = false;
    passwords.push(password);
  }
  if (passwords.length === 2 && passwords[0] === passwords[1]) ok = false;
} catch {
  ok = false;
}
finish(ok, ok ? 0 : 1);
