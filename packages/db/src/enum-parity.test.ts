import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventState as GeneratedEventState } from "./generated/prisma/enums.js";

// DB-T15 under founder decision FD-1 (2026-10-17). @irs/db does not depend on
// @irs/domain, so this test, and only this test, loads the domain package's
// built output by file path. It deviates from Rev 1.7 §8.2's assumption that
// @irs/db can see @irs/domain; declaring @irs/domain as a workspace
// devDependency is a future founder decision.
const DOMAIN_DIST_ENTRY = new URL("../../domain/dist/index.js", import.meta.url);

async function loadDomainEventState(): Promise<Record<string, unknown>> {
  if (!existsSync(DOMAIN_DIST_ENTRY)) {
    assert.fail(
      `@irs/domain build output not found at ${fileURLToPath(DOMAIN_DIST_ENTRY)}; ` +
        "build the workspace first (pnpm build)",
    );
  }
  const domain = (await import(DOMAIN_DIST_ENTRY.href)) as { EventState?: unknown };
  assert.equal(typeof domain.EventState, "object", "@irs/domain dist exports no EventState");
  return domain.EventState as Record<string, unknown>;
}

function sortedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== "generated") files.push(...sourceFiles(path));
    } else if (name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

const DB_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const API_SRC = fileURLToPath(new URL("../../../apps/api/src/", import.meta.url));

describe("DB-T15: generated enums and the import boundary", () => {
  it("generated EventState equals @irs/domain EventState exactly, in both directions", async () => {
    const domainEventState = await loadDomainEventState();
    const generated = GeneratedEventState as Record<string, unknown>;
    assert.deepEqual(Object.keys(generated).sort(), Object.keys(domainEventState).sort());
    assert.deepEqual(sortedEntries(generated), sortedEntries(domainEventState));
    for (const [key, value] of Object.entries(domainEventState)) {
      assert.equal(generated[key], value, `domain member ${key} missing or different`);
    }
    for (const [key, value] of Object.entries(generated)) {
      assert.equal(domainEventState[key], value, `generated member ${key} missing or different`);
    }
  });

  it("nothing imports PrismaClient from the @prisma/client package root", () => {
    for (const file of [...sourceFiles(DB_SRC), ...sourceFiles(API_SRC)]) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /from\s+["']@prisma\/client["']/, file);
    }
  });

  it("only @irs/db imports the generated client", () => {
    for (const file of sourceFiles(API_SRC)) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /generated\/prisma/, file);
    }
  });

  it("no non-test file in @irs/db imports @irs/domain by any route (FD-1)", () => {
    for (const file of sourceFiles(DB_SRC)) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /@irs\/domain/, file);
      assert.doesNotMatch(text, /domain\/(dist|src)/, file);
    }
  });
});
