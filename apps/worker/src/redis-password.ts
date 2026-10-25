import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// The worker-only Redis password loader (Task 012A record D6). The password
// comes from the file named by REDIS_PASSWORD_FILE; @irs/config's loadConfig
// and the API do not read it. A refusal names the failed check and never
// includes the path, the file's contents or the password.

export const REDIS_PASSWORD_FILE_VARIABLE = "REDIS_PASSWORD_FILE";

export type RedisPasswordCheck = "repository-root" | "missing-variable" | "unreadable-file" | "bad-format";

export class RedisPasswordFileError extends Error {
  override readonly name = "RedisPasswordFileError";
  constructor(
    readonly check: RedisPasswordCheck,
    detail: string,
  ) {
    super(`Redis password file refused (${check}): ${detail}`);
  }
}

const PASSWORD_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Removes exactly one trailing newline (LF or CRLF), if present. */
function trimOneNewline(raw: string): string {
  if (raw.endsWith("\r\n")) return raw.slice(0, -2);
  if (raw.endsWith("\n")) return raw.slice(0, -1);
  return raw;
}

/**
 * Reads the Redis password from the file named by REDIS_PASSWORD_FILE in
 * `env`. A relative path is resolved against `repositoryRoot` (which must be
 * absolute), never against the process cwd.
 *
 * @throws {RedisPasswordFileError} if the variable is missing or empty, the
 * file cannot be read, or its content (after one trailing newline is trimmed)
 * is not exactly 64 hexadecimal characters.
 */
export function loadRedisPassword(
  env: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
): string {
  if (!isAbsolute(repositoryRoot)) {
    throw new RedisPasswordFileError("repository-root", "the repository root must be an absolute path");
  }
  const configured = env[REDIS_PASSWORD_FILE_VARIABLE];
  if (configured === undefined || configured === "") {
    throw new RedisPasswordFileError("missing-variable", `${REDIS_PASSWORD_FILE_VARIABLE} is not set`);
  }
  const path = isAbsolute(configured) ? configured : resolve(repositoryRoot, configured);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new RedisPasswordFileError("unreadable-file", "the password file cannot be read");
  }
  const password = trimOneNewline(raw);
  if (!PASSWORD_PATTERN.test(password)) {
    throw new RedisPasswordFileError("bad-format", "the password file must hold exactly 64 hexadecimal characters");
  }
  return password;
}
