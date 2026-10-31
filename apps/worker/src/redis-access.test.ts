import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPOSITORY_ROOT } from "./repository-root.js";
import {
  CLIENT_PACKAGE,
  REDIS_CLIENT_ALLOWLIST,
  scanDeclarationsForClient,
  scanPackageRedisAccess,
  scanRedisAccess,
  tokenize,
} from "./test-support/source-scan.js";

// DF-1 (012B record Part A2): the raw Redis client is locked away, by an
// explicit allowlist (REDIS_CLIENT_ALLOWLIST in source-scan.ts) that this
// test enforces over every source file of @irs/worker, tracked or not, and
// over the build's declaration files. Then D-F2's "no substitutable cleanup
// capability": the test support's exports are exactly the designed ones, and
// none deletes or takes a prefix or a handle for deletion. Each rule has a
// planted-violation control. Fixture words are built at run time, so this
// file does not trip the rules it tests.

const PACKAGE_ROOT = join(REPOSITORY_ROOT, "apps", "worker");
const DIST = fileURLToPath(new URL(".", import.meta.url));
const C = CLIENT_PACKAGE;
const DEL = ["d", "el"].join("");
const UNLINK = ["un", "link"].join("");
const FLUSHALL = ["flush", "all"].join("");
const OBLITERATE = ["obli", "terate"].join("");
const GUARD_FILE = "src/test-support/redis-guard.ts";
const NAMESPACE_FILE = "src/test-support/test-namespace.ts";
const OTHER_FILE = "src/some-redis-helper.ts";

function rules(file: string, text: string): string[] {
  return scanRedisAccess(file, text).violations.map((violation) => violation.rule);
}

function failsWith(rule: string, file: string, text: string): void {
  const found = rules(file, text);
  assert.ok(found.includes(rule), `expected rule ${rule}, found [${found.join(", ")}]`);
}

describe("DF-1 allowlist: as written", () => {
  it("one client module, no client exporter, three deletion locations", () => {
    assert.ok(Object.isFrozen(REDIS_CLIENT_ALLOWLIST));
    assert.deepEqual([...REDIS_CLIENT_ALLOWLIST.clientModules], [GUARD_FILE]);
    assert.deepEqual([...REDIS_CLIENT_ALLOWLIST.clientExporters], []);
    assert.deepEqual(
      REDIS_CLIENT_ALLOWLIST.deletionLocations.map((location) => ({ ...location })),
      [
        { file: GUARD_FILE, function: "openNamespaceStore", command: UNLINK },
        { file: "src/test-support/test-namespace.ts", function: "unlinkOwnedKeys", command: UNLINK },
        { file: GUARD_FILE, function: "deleteGuardCheckSentinel", command: DEL },
      ],
    );
    assert.equal(REDIS_CLIENT_ALLOWLIST.issuerFactory, "createNamespaceIssuer");
    assert.equal(REDIS_CLIENT_ALLOWLIST.issuerModule, NAMESPACE_FILE);
    assert.deepEqual([...REDIS_CLIENT_ALLOWLIST.issuerCallers], [GUARD_FILE, "src/test-namespace.test.ts"]);
  });
});

describe("DF-1 allowlist: the real @irs/worker source", () => {
  const scan = scanPackageRedisAccess(PACKAGE_ROOT);

  it("passes", () => {
    assert.deepEqual(scan.violations, []);
  });

  it("positive controls: every deletion location is used exactly once, and the source and tests were scanned", () => {
    assert.deepEqual(
      scan.deletions.map((location) => `${location.file}#${location.function}:${location.command}`).sort(),
      [
        `${GUARD_FILE}#deleteGuardCheckSentinel:${DEL}`,
        `${GUARD_FILE}#openNamespaceStore:${UNLINK}`,
        `src/test-support/test-namespace.ts#unlinkOwnedKeys:${UNLINK}`,
      ],
    );
    for (const file of [
      GUARD_FILE,
      "src/test-support/test-namespace.ts",
      "src/dispatch-queue/implementation.ts",
      "src/redis-guard.redis.test.ts",
      "src/redis-access.test.ts",
    ]) {
      assert.ok(scan.files.includes(file), `${file} was scanned`);
    }
    assert.ok(!scan.files.some((file) => file.startsWith("dist/") || file.includes("node_modules/")));
  });
});

describe("DF-1 allowlist: the build's declaration files name no Redis client", () => {
  it("passes over every declaration file in dist", () => {
    const scan = scanDeclarationsForClient(DIST);
    assert.deepEqual(scan.violations, []);
    for (const file of ["test-support/redis-guard.d.ts", "test-support/test-namespace.d.ts", "dispatch-queue/implementation.d.ts"]) {
      assert.ok(scan.files.includes(file), `${file} was checked`);
    }
  });

  describe("planted-violation controls", () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "irs-worker-client-declarations-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("finds an inline import type, an import and a reference directive of the client", async () => {
      await writeFile(join(dir, "inline.d.ts"), `export declare function rawClient(): import("${C}").Redis;\n`);
      await writeFile(join(dir, "named.d.ts"), `import type { Redis } from "${C}";\nexport declare const leak: Redis;\n`);
      await writeFile(join(dir, "directive.d.ts"), `/// <reference types="${C}" />\nexport {};\n`);
      await writeFile(join(dir, "clean.d.ts"), "export declare function f(): Promise<number>;\n");
      const scan = scanDeclarationsForClient(dir);
      const found = scan.violations.map((violation) => `${violation.file}:${violation.rule}`);
      assert.ok(found.includes("inline.d.ts:declaration-client-reference"));
      assert.ok(found.includes("named.d.ts:declaration-client-reference"));
      assert.ok(found.includes("directive.d.ts:declaration-client-directive"));
      assert.ok(!found.some((entry) => entry.startsWith("clean.d.ts")));
    });
  });
});

describe("DF-1 allowlist: planted-violation controls", () => {
  it("(i) fails on an import of the client outside the allowlist, in any form", () => {
    for (const text of [
      `import { Redis } from "${C}";\n`,
      `import type { Redis } from "${C}";\n`,
      `const lib = require("${C}");\n`,
      `const lib = await import("${C}");\n`,
      `export * from "${C}";\n`,
      `type R = import("${C}").Redis;\n`,
      `import { Redis } from "${C}/built/Redis.js";\n`,
    ]) {
      failsWith("redis-client-import", OTHER_FILE, text);
    }
  });

  it("(i) fails on a raw client constructed outside the allowlist", () => {
    failsWith("redis-client-construction", OTHER_FILE, "const client = new Redis({ port });\n");
    failsWith("redis-client-construction", OTHER_FILE, "const cluster = new lib.Cluster([]);\n");
  });

  it("(i) inside the client module, only a static import", () => {
    failsWith("redis-client-import-form", GUARD_FILE, `const lib = await import("${C}");\n`);
    assert.deepEqual(rules(GUARD_FILE, `import { Redis } from "${C}";\nconst client = new Redis({});\n`), []);
  });

  it("(ii) fails on an export that returns or exposes a raw client, in the client module", () => {
    const head = `import { Redis } from "${C}";\n`;
    for (const text of [
      "export function rawClient(): Redis { return client; }\n",
      "export async function open(): Promise<Redis> { return client; }\n",
      "export interface Leak { readonly client: Redis }\n",
      "export const leak: Redis = make();\n",
      "export type Client = Redis;\n",
      "export class Holder { client?: Redis; }\n",
      `export { Redis } from "${C}";\n`,
    ]) {
      failsWith("redis-client-export", GUARD_FILE, head + text);
    }
  });

  it("(ii) control: a private function returning the client is accepted", () => {
    assert.deepEqual(
      rules(GUARD_FILE, `import { Redis } from "${C}";\nfunction open(): Redis { return new Redis({}); }\nexport function count(): number { return 1; }\n`),
      [],
    );
  });

  it("(iii) fails on a deleting command outside the permitted locations, in any form", () => {
    for (const text of [
      `await client.${FLUSHALL}();\n`,
      `await client.${DEL}(key);\n`,
      `await client?.${UNLINK}(key);\n`,
      `await client.call("${UNLINK.toUpperCase()}", key);\n`,
      `await client["${DEL}"](key);\n`,
      `const remove = client.${DEL};\n`,
      `await queue.${OBLITERATE}({ force: true });\n`,
      `function cleanUpKeys(c) { return c.${UNLINK}(keys); }\n`,
    ]) {
      failsWith("deleting-command", OTHER_FILE, text);
    }
  });

  it("(iii) fails on a deletion inside the client module but in a function not permitted", () => {
    failsWith("deleting-command", GUARD_FILE, `function sneaky(client) { return client.${DEL}("k"); }\n`);
    failsWith("deleting-command", GUARD_FILE, `client.${UNLINK}(key);\n`);
    // The permitted function, but the other command.
    failsWith("deleting-command", GUARD_FILE, `function openNamespaceStore(client) { return client.${DEL}(key); }\n`);
    // A named function nested inside the permitted one is not the permitted one.
    failsWith(
      "deleting-command",
      GUARD_FILE,
      `function openNamespaceStore(client) { function inner() { return client.${UNLINK}(key); } return inner; }\n`,
    );
    // The permitted function name, in another file.
    failsWith("deleting-command", OTHER_FILE, `function openNamespaceStore(client) { return client.${UNLINK}(key); }\n`);
  });

  it("(iii) controls: the permitted function and command are accepted, including inside its arrow functions", () => {
    for (const text of [
      `function openNamespaceStore(client) { return { go: (keys) => client.${UNLINK}(keys) }; }\n`,
      `async function openNamespaceStore(client): Promise<{ readonly n: number }> { return client.${UNLINK}(keys); }\n`,
      `function openNamespaceStore(client): { readonly n: number } { return client.${UNLINK}(keys); }\n`,
    ]) {
      const scan = scanRedisAccess(GUARD_FILE, text);
      assert.deepEqual(scan.violations, [], text);
      assert.equal(scan.deletions.length, 1);
    }
  });

  it("ignores comments", () => {
    assert.deepEqual(rules(OTHER_FILE, `// client.${DEL}(key); import { Redis } from "${C}"; new Redis()\nconst x = 1;\n`), []);
  });
});

// ---- S1-C2: the namespace-issuer factory's call sites -----------------------

const ISSUER = "createNamespaceIssuer";
const UNIT_TEST_FILE = "src/test-namespace.test.ts";

describe("DF-1 allowlist (iv): the namespace-issuer factory", () => {
  it("positive control: the real package calls it at exactly the two permitted sites", () => {
    const scan = scanPackageRedisAccess(PACKAGE_ROOT);
    assert.deepEqual(scan.violations, []);
    assert.equal(scan.issuerCalls.length, 2);
    assert.deepEqual(scan.issuerCalls.map((site) => site.file).sort(), [UNIT_TEST_FILE, GUARD_FILE].sort());
  });

  it("fails on a Redis test file that imports and calls it", () => {
    const text = `import { ${ISSUER} } from "./test-support/test-namespace.js";\nconst issuer = ${ISSUER}(dependencies);\n`;
    failsWith("issuer-import", "src/planted.redis.test.ts", text);
    failsWith("issuer-call", "src/planted.redis.test.ts", text);
  });

  it("fails on another test-support module that calls it", () => {
    const text = `import { ${ISSUER} } from "./test-namespace.js";\nexport const issuer = ${ISSUER}(dependencies);\n`;
    failsWith("issuer-import", "src/test-support/planted.ts", text);
    failsWith("issuer-call", "src/test-support/planted.ts", text);
  });

  it("fails on a re-export, named or by star, also from a permitted file", () => {
    for (const file of ["src/test-support/planted.ts", GUARD_FILE]) {
      failsWith("issuer-re-export", file, `export { ${ISSUER} } from "./test-namespace.js";\n`);
      failsWith("issuer-re-export", file, `export * from "./test-namespace.js";\n`);
    }
  });

  it("fails on an aliased import that is then called, also in a permitted file", () => {
    for (const file of ["src/planted.test.ts", UNIT_TEST_FILE]) {
      const text = `import { ${ISSUER} as make } from "./test-support/test-namespace.js";\nconst issuer = make(dependencies);\n`;
      failsWith("issuer-alias", file, text);
      failsWith("issuer-call", file, text);
    }
  });

  it("fails on a namespace import, a dynamic import and an import of the built module", () => {
    const namespaceImport = `import * as ns from "./test-support/test-namespace.js";\nconst issuer = ns.${ISSUER}(dependencies);\n`;
    failsWith("issuer-namespace-import", "src/planted.test.ts", namespaceImport);
    failsWith("issuer-reference", "src/planted.test.ts", namespaceImport);
    failsWith("issuer-dynamic-import", "src/planted.test.ts", `const m = await import("./test-support/test-namespace.js");\n`);
    failsWith("issuer-import", "src/planted.test.ts", `import { ${ISSUER} } from "../dist/test-support/test-namespace.js";\n`);
  });

  it("in a permitted file, fails on any use other than the import and a direct call", () => {
    failsWith("issuer-reference", GUARD_FILE, `import { ${ISSUER} } from "./test-namespace.js";\nconst f = ${ISSUER};\n`);
    failsWith("issuer-call", NAMESPACE_FILE, `export function ${ISSUER}() { return ${ISSUER}(); }\n`);
  });

  it("controls: the permitted import and call are accepted, and the declaration in its own module", () => {
    const scan = scanRedisAccess(GUARD_FILE, `import { ${ISSUER} } from "./test-namespace.js";\nconst NAMESPACES = ${ISSUER}({});\n`);
    assert.deepEqual(scan.violations, []);
    assert.deepEqual(scan.issuerCalls, [{ file: GUARD_FILE, line: 2 }]);
    assert.deepEqual(rules(NAMESPACE_FILE, `export function ${ISSUER}(dependencies) { return dependencies; }\n`), []);
  });
});

describe("S1-C2: what the issuer seam exposes (redis-guard.ts)", () => {
  const source = readFileSync(join(PACKAGE_ROOT, GUARD_FILE), "utf8");

  it("openNamespaceStore and the NAMESPACES issuer are declared and not exported", async () => {
    // Positive controls: both declarations exist, at module level.
    assert.match(source, /^async function openNamespaceStore\(/m);
    assert.match(source, /^const NAMESPACES = createNamespaceIssuer\(/m);
    assert.doesNotMatch(source, /^export\b[^\n]*\b(openNamespaceStore|NAMESPACES)\b/m);
    const exports = (await import(pathToFileURL(join(DIST, "test-support", "redis-guard.js")).href)) as object;
    assert.ok(!Object.hasOwn(exports, "openNamespaceStore"));
    assert.ok(!Object.hasOwn(exports, "NAMESPACES"));
  });

  it("the NAMESPACES issuer is used only through issue, activePrefix and issuedPrefix, never as a value", () => {
    const tokens = tokenize(source);
    const uses: string[] = [];
    tokens.forEach((token, k) => {
      if (token.kind !== "identifier" || token.value !== "NAMESPACES") return;
      if (tokens[k - 1]?.value === "const") return;
      const member = tokens[k + 1]?.value === "." ? tokens[k + 2]?.value : undefined;
      uses.push(member ?? "(as a value)");
    });
    assert.deepEqual(uses.sort(), ["activePrefix", "issue", "issuedPrefix"]);
  });

  it("namespaceKeyCount is read-only: a complete SCAN through the guard, and no deleting command", () => {
    const start = source.indexOf("export async function namespaceKeyCount(");
    assert.ok(start !== -1);
    const excerpt = source.slice(start);
    assert.match(excerpt, /scanAll\(scanStep\(guarded\.client, `\$\{prefix\}:\*`\)\)/);
    const scan = scanRedisAccess(GUARD_FILE, excerpt);
    assert.deepEqual(scan.violations, []);
    assert.deepEqual(scan.deletions, []);
    // Control: the same excerpt with a deletion planted in it fails.
    const planted = excerpt.replace("try {", `try {\n    await guarded.client.${UNLINK}(prefix);`);
    assert.ok(rules(GUARD_FILE, planted).includes("deleting-command"));
    // And the real package's deletions are exactly the three permitted ones, none in namespaceKeyCount.
    assert.ok(!scanPackageRedisAccess(PACKAGE_ROOT).deletions.some((location) => location.function === "namespaceKeyCount"));
  });
});

// ---- D-F2: no substitutable cleanup capability ------------------------------

/** Every module of the test support and its designed exports. */
const DESIGNED_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "dispatch-redis": ["waitUntil"],
  "handle-surface": ["QUEUE_HANDLE_METHODS", "WORKER_HANDLE_METHODS", "handleSurfaceProblems"],
  "redis-bootstrap": [],
  "redis-guard": [
    "REGISTERED_TARGET",
    "RedisCommandFailure",
    "RedisConnectionFailure",
    "RedisGuardRefusal",
    "auditTestRedis",
    "bootstrapSentinel",
    "checkGuardCheckScope",
    "checkGuardedEndpoint",
    "checkSelectedDatabase",
    "checkSentinelValue",
    "describeClientInfoShape",
    "guardCheckSentinel",
    "guardedDispatchSettings",
    "issueTestNamespace",
    "namespaceKeyCount",
    "observeClientInfoShape",
    "readServerBaseline",
    "redisErrorCode",
    "safeReason",
    "usedMemoryBytes",
    "validateRedisTarget",
  ],
  "redis-preflight": [
    "PreflightFailure",
    "preflightFailureReason",
    "preflightReport",
    "runPreflight",
    "runPreflightWith",
    "withinUsedMemoryLimit",
  ],
  "redis-registry": [
    "DEV_PASSWORD_FILE",
    "DEV_REDIS_PORT",
    "EXPECTED_REDIS_VERSION",
    "EXPECTED_SERVER_CONFIG",
    "GUARD_CHECK_DATABASE_INDEX",
    "MAIN_DATABASE_INDEX",
    "REGISTERED_DATABASE_INDEXES",
    "SENTINEL_KEY",
    "SENTINEL_MARKER",
    "TEST_NAMESPACE_STEM",
    "TEST_PASSWORD_FILE",
    "TEST_REDIS_HOST",
    "TEST_REDIS_PORT",
    "USED_MEMORY_LIMIT_BYTES",
  ],
  "redis-suite": ["REDIS_TEST_ARGUMENTS", "runRedisSuite"],
  "source-scan": [
    "CLIENT_PACKAGE",
    "DELETING_COMMANDS",
    "LIBRARY",
    "MAX_CONSTRUCTOR_ARGUMENTS",
    "MODULE_DIRECTORY",
    "MODULE_ENTRY",
    "REDIS_CLIENT_ALLOWLIST",
    "TYPE_ALLOWLIST",
    "VALUE_ALLOWLIST",
    "checkDeclarationSurface",
    "listSourceFiles",
    "scanDeclarationsForClient",
    "scanPackage",
    "scanPackageRedisAccess",
    "scanRedisAccess",
    "scanSource",
    "tokenize",
  ],
  "test-namespace": [
    "MAX_SCAN_STEPS",
    "NamespaceCleanupFailure",
    "NamespaceRefusal",
    "ScanIncomplete",
    "checkNamespacePrefix",
    "createNamespaceIssuer",
    "scanAll",
  ],
};

/**
 * Exports reviewed as taking a prefix, a namespace handle, a key or a
 * database. None deletes: a validator, two read-only uses of an issued
 * handle, and the dispatch-handle surface check.
 */
const REVIEWED_ARGUMENT_TAKERS = [
  "handle-surface.handleSurfaceProblems",
  "redis-guard.checkGuardCheckScope",
  "redis-guard.guardedDispatchSettings",
  "redis-guard.namespaceKeyCount",
  "test-namespace.checkNamespacePrefix",
];
/**
 * Exports whose names match a deleting word: the one deleting operation,
 * DF-3's guard-check sentinel helper (D-F2(b)); and the cleanup's error
 * class, whose construction deletes nothing.
 */
const REVIEWED_DELETERS = ["redis-guard.guardCheckSentinel.deleteKey", "test-namespace.NamespaceCleanupFailure"];

const DELETING_NAME = /del|unlink|flush|clean|purge|drain|obliterate|remove|wipe|erase|destroy|drop|evict|expire/i;
const TARGETING_PARAMETER = /prefix|handle|namespace|key|pattern|match|database|^db$/i;

/** Parameter names of a function or a class constructor, from its source text. */
function parameterNames(fn: Function): string[] {
  const text = Function.prototype.toString.call(fn);
  const start = /^class\b/.test(text) ? text.indexOf("constructor(") : text.indexOf("(");
  if (start === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = text.indexOf("(", start); i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) {
      end = i;
      break;
    }
  }
  const inner = text.slice(text.indexOf("(", start) + 1, end);
  const names: string[] = [];
  let level = 0;
  let current = "";
  for (const c of inner) {
    if ("([{".includes(c)) level++;
    if (")]}".includes(c)) level--;
    if (c === "," && level === 0) {
      names.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  names.push(current);
  return names.map((name) => name.split("=")[0]?.trim() ?? "").filter((name) => name !== "");
}

interface SurfaceFindings {
  readonly problems: string[];
  readonly argumentTakers: string[];
  readonly deleters: string[];
}

/** Compares a module's runtime exports with its design, and lists the exports that delete or take a target. */
function exportSurface(moduleName: string, exports: object, designed: readonly string[]): SurfaceFindings {
  const problems: string[] = [];
  const argumentTakers: string[] = [];
  const deleters: string[] = [];
  const names = Object.keys(exports).sort();
  for (const name of names) if (!designed.includes(name)) problems.push(`${moduleName}.${name} is not designed`);
  for (const name of designed) if (!names.includes(name)) problems.push(`${moduleName}.${name} is missing`);
  const inspect = (path: string, name: string, value: unknown) => {
    if (typeof value !== "function") return;
    if (DELETING_NAME.test(name)) deleters.push(path);
    if (parameterNames(value).some((parameter) => TARGETING_PARAMETER.test(parameter))) argumentTakers.push(path);
  };
  for (const name of names) {
    const value: unknown = (exports as Record<string, unknown>)[name];
    inspect(`${moduleName}.${name}`, name, value);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const member of Reflect.ownKeys(value)) {
        if (typeof member === "string") inspect(`${moduleName}.${name}.${member}`, member, (value as Record<string, unknown>)[member]);
      }
    }
  }
  return { problems, argumentTakers, deleters };
}

describe("Q4 (Task 012B, PL-11): the DF-3 refusal path is wired", () => {
  const source = readFileSync(join(PACKAGE_ROOT, GUARD_FILE), "utf8");

  /** The body of a module-level function declaration, by its exact head, up to its closing brace at column 0. */
  function body(text: string, head: string): string {
    const start = text.indexOf(head);
    assert.notEqual(start, -1, `${head} is declared`);
    const end = text.indexOf("\n}", start);
    assert.notEqual(end, -1);
    return text.slice(start, end + 2);
  }

  /** The wiring rule: the body calls the strict parser and holds no regular expression. */
  function wiringProblems(excerpt: string): string[] {
    const problems: string[] = [];
    if (!excerpt.includes("checkSelectedDatabase(")) problems.push("no checkSelectedDatabase call");
    const tokens = tokenize(excerpt);
    if (tokens.some((token) => token.kind === "regex")) problems.push("a regular-expression literal");
    if (tokens.some((token) => token.kind === "identifier" && token.value === "RegExp")) problems.push("a RegExp construction");
    return problems;
  }

  it("verifySelectedDatabase's body calls checkSelectedDatabase( and holds no regular expression", () => {
    const excerpt = body(source, "async function verifySelectedDatabase(");
    assert.deepEqual(wiringProblems(excerpt), []);
  });

  it("planted control: the same body with the call removed (the old regex restored) fails the check", () => {
    const excerpt = body(source, "async function verifySelectedDatabase(");
    const planted = excerpt.replace(
      "checkSelectedDatabase(info, db);",
      `const selected = /(?:^|\\s)db=([0-9]+)(?:\\s|$)/.exec(info)?.[1];\n  void selected;`,
    );
    assert.notEqual(planted, excerpt, "the plant changed the body");
    assert.deepEqual(wiringProblems(planted).sort(), ["a regular-expression literal", "no checkSelectedDatabase call"]);
  });

  it("observeClientInfoShape returns only describeClientInfoShape's result and runs no deleting command", () => {
    const excerpt = body(source, "export async function observeClientInfoShape(");
    assert.match(excerpt, /return describeClientInfoShape\(reply\);/);
    assert.equal((excerpt.match(/\breturn\b/g) ?? []).length, 1, "a single return path");
    const scan = scanRedisAccess(GUARD_FILE, excerpt);
    assert.deepEqual(scan.violations, []);
    assert.deepEqual(scan.deletions, []);
  });
});

describe("D-F2: no substitutable cleanup capability (the export surface)", () => {
  it("the design lists every module of the test support", async () => {
    const built = (await readdir(join(DIST, "test-support")))
      .filter((file) => file.endsWith(".js"))
      .map((file) => file.slice(0, -".js".length))
      .sort();
    assert.deepEqual(built, Object.keys(DESIGNED_EXPORTS).sort());
  });

  it("every module exports exactly its design; none deletes or takes a target beyond the reviewed ones", async () => {
    const problems: string[] = [];
    const argumentTakers: string[] = [];
    const deleters: string[] = [];
    for (const [moduleName, designed] of Object.entries(DESIGNED_EXPORTS)) {
      const exports = (await import(pathToFileURL(join(DIST, "test-support", `${moduleName}.js`)).href)) as object;
      const found = exportSurface(moduleName, exports, designed);
      problems.push(...found.problems);
      argumentTakers.push(...found.argumentTakers);
      deleters.push(...found.deleters);
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(argumentTakers.sort(), REVIEWED_ARGUMENT_TAKERS);
    assert.deepEqual(deleters.sort(), REVIEWED_DELETERS);
  });

  describe("planted-violation controls", () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "irs-worker-export-surface-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("detects a new deleting export, a prefix-taking export and a deleting member", async () => {
      const file = join(dir, "planted.mjs");
      await writeFile(
        file,
        [
          "export async function cleanupNamespace(handle) { void handle; }",
          "export function settingsFor(prefix) { return prefix; }",
          "export const tools = Object.freeze({ purgeKeys: (pattern) => pattern });",
          "export function waitUntil() {}",
          "",
        ].join("\n"),
      );
      const exports = (await import(pathToFileURL(file).href)) as object;
      const found = exportSurface("planted", exports, ["waitUntil"]);
      assert.deepEqual(found.problems.sort(), [
        "planted.cleanupNamespace is not designed",
        "planted.settingsFor is not designed",
        "planted.tools is not designed",
      ]);
      assert.deepEqual(found.deleters.sort(), ["planted.cleanupNamespace", "planted.tools.purgeKeys"]);
      assert.deepEqual(found.argumentTakers.sort(), ["planted.cleanupNamespace", "planted.settingsFor", "planted.tools.purgeKeys"]);
    });

    it("detects a missing designed export", async () => {
      const found = exportSurface("planted", {}, ["waitUntil"]);
      assert.deepEqual(found.problems, ["planted.waitUntil is missing"]);
    });
  });
});
