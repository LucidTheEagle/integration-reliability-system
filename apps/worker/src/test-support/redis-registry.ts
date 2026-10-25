import { randomUUID } from "node:crypto";

// Test-Redis registry (DR-11; Task 012A record D7, D17). Everything the guard
// accepts is named here; anything not named is refused.

export const TEST_REDIS_HOST = "127.0.0.1";
export const TEST_REDIS_PORT = 46379;

/** The test password file, relative to the repository root (D17). */
export const TEST_PASSWORD_FILE = "secrets/redis_test_password";

/** The development endpoint and password file the guard must never accept. */
export const DEV_REDIS_PORT = 6379;
export const DEV_PASSWORD_FILE = "secrets/redis_password";

/** Logical database holding the sentinel every test connection verifies. */
export const MAIN_DATABASE_INDEX = 0;
/** Logical database used only by the guard's own post-connect tests. */
export const GUARD_CHECK_DATABASE_INDEX = 1;
export const REGISTERED_DATABASE_INDEXES: readonly number[] = [MAIN_DATABASE_INDEX, GUARD_CHECK_DATABASE_INDEX];

export const SENTINEL_KEY = "irs:test:sentinel";
/** Fixed marker stored under the sentinel key. */
export const SENTINEL_MARKER = "e1569c0e-9598-46a4-8eff-5ce762cb94dc";

/** Server baseline checked by the preflight (D7). */
export const EXPECTED_REDIS_VERSION = "7.4.11";
export const EXPECTED_SERVER_CONFIG: Readonly<Record<string, string>> = {
  maxmemory: "67108864",
  "maxmemory-policy": "noeviction",
  appendonly: "yes",
  appendfsync: "everysec",
};

/** Tests never flush: each uses its own queue name under this prefix. */
export const TEST_QUEUE_PREFIX = "irs-test-";

export function testQueueName(label: string): string {
  return `${TEST_QUEUE_PREFIX}${label}-${randomUUID()}`;
}
