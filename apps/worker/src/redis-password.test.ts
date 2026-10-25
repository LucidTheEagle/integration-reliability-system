import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedisPasswordFileError, loadRedisPassword } from "./redis-password.js";
import type { RedisPasswordCheck } from "./redis-password.js";

// Redis-free tests of the D6 password-file loader. Each test works in its own
// directory from fs.mkdtemp under the OS temp directory, removed afterwards.
// The fixture value is built at run time and is not a real credential.

const VALUE = "0123456789abcdef".repeat(4);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "irs-worker-password-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function refusedBy(check: RedisPasswordCheck, action: () => unknown, hidden: readonly string[] = []): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RedisPasswordFileError, "expected a RedisPasswordFileError");
    assert.equal(error.check, check);
    for (const text of [VALUE, dir, ...hidden]) {
      assert.ok(!error.message.includes(text), "a refusal never echoes a path or a value");
    }
    return true;
  });
}

describe("loadRedisPassword", () => {
  it("reads an absolute path, independent of the repository root", async () => {
    const file = join(dir, "redis_password");
    await writeFile(file, VALUE);
    const otherRoot = await mkdtemp(join(dir, "root-"));
    assert.equal(loadRedisPassword({ REDIS_PASSWORD_FILE: file }, otherRoot), VALUE);
  });

  it("resolves a relative path against the repository root, not the process cwd", async () => {
    await mkdir(join(dir, "secrets"));
    await writeFile(join(dir, "secrets", "redis_password"), VALUE);
    assert.notEqual(process.cwd(), dir);
    assert.equal(loadRedisPassword({ REDIS_PASSWORD_FILE: "secrets/redis_password" }, dir), VALUE);
  });

  it("refuses a missing or empty variable", () => {
    refusedBy("missing-variable", () => loadRedisPassword({}, dir));
    refusedBy("missing-variable", () => loadRedisPassword({ REDIS_PASSWORD_FILE: "" }, dir));
  });

  it("refuses a missing file", () => {
    refusedBy("unreadable-file", () => loadRedisPassword({ REDIS_PASSWORD_FILE: "absent" }, dir), ["absent"]);
    refusedBy("unreadable-file", () => loadRedisPassword({ REDIS_PASSWORD_FILE: join(dir, "absent") }, dir));
  });

  it("refuses a directory in place of the file", () => {
    refusedBy("unreadable-file", () => loadRedisPassword({ REDIS_PASSWORD_FILE: dir }, dir));
  });

  it("refuses a wrong format", async () => {
    const file = join(dir, "redis_password");
    const env = { REDIS_PASSWORD_FILE: file };
    const wrong = [
      "",
      VALUE.slice(1),
      `${VALUE}0`,
      `${VALUE.slice(1)}g`,
      ` ${VALUE.slice(1)}`,
      `${VALUE}\n\n`,
      `${VALUE}\r\n\r\n`,
      `${VALUE}\r`,
      `\n${VALUE}`,
    ];
    for (const content of wrong) {
      await writeFile(file, content);
      refusedBy("bad-format", () => loadRedisPassword(env, dir));
    }
  });

  it("trims exactly one trailing LF or CRLF", async () => {
    const file = join(dir, "redis_password");
    for (const content of [`${VALUE}\n`, `${VALUE}\r\n`]) {
      await writeFile(file, content);
      assert.equal(loadRedisPassword({ REDIS_PASSWORD_FILE: file }, dir), VALUE);
    }
  });

  it("refuses a relative repository root", () => {
    refusedBy("repository-root", () => loadRedisPassword({ REDIS_PASSWORD_FILE: "x" }, "relative/root"));
  });
});
