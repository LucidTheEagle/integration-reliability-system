import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISPATCH_QUEUE_NAME } from "./dispatch-queue/index.js";
import { REPOSITORY_ROOT } from "./repository-root.js";
import { LIBRARY, scanPackage, scanSource } from "./test-support/source-scan.js";

// The no-bypass test (addendum §3.2 rule 4 and 6d; Task 012A record §8 A1
// 2a-2d). It scans every source file of @irs/worker, tracked or not
// (dist and node_modules excluded), and fails on any way around the central
// dispatch-queue module. Each rule has a planted-violation control below. The
// fixtures are strings built at run time, so this file does not trip the
// rules it tests.

const PACKAGE_ROOT = join(REPOSITORY_ROOT, "apps", "worker");
const MODULE_FILE = "src/dispatch-queue/implementation.ts";
const OTHER_FILE = "src/some-dispatcher.ts";
const L = LIBRARY;
const SELECTOR = ["back", "end"].join("");

function rules(file: string, text: string): string[] {
  return scanSource(file, text).violations.map((violation) => violation.rule);
}

function failsWith(rule: string, file: string, text: string): void {
  const found = rules(file, text);
  assert.ok(found.includes(rule), `expected rule ${rule}, found [${found.join(", ")}]`);
}

describe("no-bypass: the real @irs/worker source", () => {
  const scan = scanPackage(PACKAGE_ROOT);

  it("passes", () => {
    assert.deepEqual(scan.violations, []);
  });

  it("positive controls: the module's files, test support and this file were scanned", () => {
    for (const file of [
      "src/dispatch-queue/index.ts",
      MODULE_FILE,
      "src/dispatch-queue/policy.ts",
      "src/test-support/redis-guard.ts",
      "src/no-bypass.test.ts",
    ]) {
      assert.ok(scan.files.includes(file), `${file} was scanned`);
    }
    assert.ok(!scan.files.some((file) => file.startsWith("dist/") || file.includes("node_modules/")));
  });

  it("positive controls: exactly one library import of each kind, in the module, from the allowlists", () => {
    assert.deepEqual(
      scan.libraryImports.map((record) => ({ ...record, valueNames: [...record.valueNames], typeNames: [...record.typeNames] })),
      [
        { file: MODULE_FILE, valueNames: ["Queue", "Worker"], typeNames: [] },
        { file: MODULE_FILE, valueNames: [], typeNames: ["JobsOptions", "QueueOptions", "WorkerOptions"] },
      ],
    );
  });

  it("positive controls: one two-argument Queue and one three-argument Worker construction", () => {
    assert.deepEqual(
      [...scan.constructions],
      [
        { file: MODULE_FILE, className: "Queue", argumentCount: 2 },
        { file: MODULE_FILE, className: "Worker", argumentCount: 3 },
      ],
    );
  });
});

describe("no-bypass: planted-violation controls", () => {
  it("fails on createPostgresRelayBackend imported, even beside an allowed name", () => {
    const text = `import { Queue, createPostgresRelayBackend } from "${L}";\n`;
    failsWith("library-value-not-allowed", MODULE_FILE, text);
    failsWith("relay-symbol", MODULE_FILE, text);
    failsWith("relay-symbol", OTHER_FILE, "const x = createPostgresRelayBackend;\n");
  });

  it("fails on any other value or type outside the allowlists", () => {
    failsWith("library-value-not-allowed", MODULE_FILE, `import { FlowProducer } from "${L}";\n`);
    failsWith("library-value-not-allowed", MODULE_FILE, `import { setDefault${"Back" + "end"}Factory } from "${L}";\n`);
    failsWith("library-type-not-allowed", MODULE_FILE, `import type { Job } from "${L}";\n`);
    failsWith("library-type-not-allowed", MODULE_FILE, `import { type ConnectionOptions } from "${L}";\n`);
  });

  it("fails on a namespace import", () => {
    failsWith("library-namespace-import", MODULE_FILE, `import * as lib from "${L}";\n`);
  });

  it("fails on a default import, an alias, a side-effect import and a subpath", () => {
    failsWith("library-default-import", MODULE_FILE, `import lib from "${L}";\n`);
    failsWith("library-import-alias", MODULE_FILE, `import { Queue as Q } from "${L}";\n`);
    failsWith("library-side-effect", MODULE_FILE, `import "${L}";\n`);
    failsWith("library-subpath-import", MODULE_FILE, `import { Queue } from "${L}/dist/esm/classes/queue.js";\n`);
  });

  it("fails on a require, a dynamic import and a re-export of the library", () => {
    failsWith("library-require", MODULE_FILE, `const lib = require("${L}");\n`);
    failsWith("library-dynamic", MODULE_FILE, `const lib = await import("${L}");\n`);
    failsWith("library-re-export", MODULE_FILE, `export { Queue } from "${L}";\n`);
    failsWith("library-re-export", MODULE_FILE, `export * from "${L}";\n`);
  });

  it("fails on a library import in a non-module file, in any form", () => {
    for (const text of [
      `import { Queue } from "${L}";\n`,
      `import type { Job } from "${L}";\n`,
      `const lib = require("${L}");\n`,
      `const lib = await import(\`${L}\`);\n`,
      `export * from "${L}/esm";\n`,
      `type J = import("${L}").Job;\n`,
    ]) {
      failsWith("library-outside-module", OTHER_FILE, text);
    }
  });

  it(`fails on a ${SELECTOR}Factory identifier and a ${SELECTOR} option key`, () => {
    failsWith("backend-identifier", MODULE_FILE, `const ${SELECTOR}Factory = undefined;\n`);
    failsWith("backend-identifier", MODULE_FILE, `new Queue(name, { connection, ${SELECTOR}: other });\n`);
    failsWith("backend-key", OTHER_FILE, `const options = { "${SELECTOR}": other };\n`);
    failsWith("backend-key", OTHER_FILE, `options["${SELECTOR}Factory"] = other;\n`);
  });

  it("fails on a three-argument Queue and a four-argument Worker, read from the table", () => {
    failsWith("queue-argument-count", MODULE_FILE, "const q = new Queue(name, options, factory);\n");
    failsWith("worker-argument-count", MODULE_FILE, "const w = new Worker(name, processor, options, factory);\n");
    failsWith("queue-argument-count", OTHER_FILE, "const q = new lib.Queue<Data>(name, { a: [1, 2], b: f(x, y) }, factory);\n");
    failsWith("constructor-spread", MODULE_FILE, "const q = new Queue(name, ...rest);\n");
  });

  it("fails on a library class used other than in `new` inside the module", () => {
    failsWith("class-alias", MODULE_FILE, "const Q = Queue;\nconst q = new Q(name, options, factory);\n");
    failsWith("class-alias", MODULE_FILE, "const w = Reflect.construct(Worker, [name, processor, options, factory]);\n");
  });

  it("accepts valid two-argument Queue and three-argument Worker constructions", () => {
    const text = [
      `import { Queue, Worker } from "${L}";`,
      `import type { JobsOptions, QueueOptions, WorkerOptions } from "${L}";`,
      "const q = new Queue(name, { connection: { host, port }, defaultJobOptions: { removeOnFail: false } });",
      "const w = new Worker(name, async (job) => { await run(job, [1, 2]); }, options,);",
      "",
    ].join("\n");
    assert.deepEqual(rules(MODULE_FILE, text), []);
    assert.deepEqual(
      scanSource(MODULE_FILE, text).constructions.map((construction) => construction.argumentCount),
      [2, 3],
    );
  });

  it("fails on the queue-name literal outside the module, also in a comment", () => {
    failsWith("queue-name-literal", OTHER_FILE, `const name = "${DISPATCH_QUEUE_NAME}";\n`);
    failsWith("queue-name-literal", OTHER_FILE, `// see ${DISPATCH_QUEUE_NAME}\n`);
    assert.deepEqual(rules("src/dispatch-queue/policy.ts", `export const NAME = "${DISPATCH_QUEUE_NAME}";\n`), []);
  });

  it("fails on an import of a module file other than index.ts from outside the module", () => {
    failsWith("module-internal-import", OTHER_FILE, 'import { openDispatchQueueWith } from "./dispatch-queue/implementation.js";\n');
    failsWith("module-internal-import", "src/test-support/x.ts", 'import { DISPATCH_JOB_NAME } from "../dispatch-queue/policy.js";\n');
    failsWith("module-internal-import", OTHER_FILE, 'export * from "./dispatch-queue/types.js";\n');
    failsWith("module-internal-import", OTHER_FILE, 'const m = await import("../dist/dispatch-queue/implementation.js");\n');
    assert.deepEqual(rules(OTHER_FILE, 'import { openDispatchQueue } from "./dispatch-queue/index.js";\n'), []);
  });

  it("ignores comments and string contents for the symbol rules", () => {
    const text = [
      "// createPostgresRelayBackend, new Queue(a, b, c), require(lib)",
      `const note = "a ${SELECTOR}Factory, Relay and import * as lib from ${L}";`,
      "",
    ].join("\n");
    assert.deepEqual(rules(OTHER_FILE, text), []);
  });
});

// ---- Task 012B-3: the pinned amendment (FD-16, FD-19, FD-20; RC-2, RC-6) ----

const ACCESSOR = ["get", "Back", "end"].join("");
const DEL = ["d", "el"].join("");

/** The pinned member-site multiset of the real implementation file, as `function:member`. */
const PINNED_MEMBER_SITES = [
  `watchReady:${ACCESSOR}`,
  `pingThrough:${ACCESSOR}`,
  "pingThrough:client",
  "pingThrough:ping",
  `readJobHash:${ACCESSOR}`,
  "readJobHash:client",
  "readJobHash:toKey",
  "readJobHash:hmgetBuffer",
  `retireQueue:${ACCESSOR}`,
  "retireQueue:close",
  "retireQueue:close",
  "isPingClient:ping",
  "isHashClient:hmgetBuffer",
  "openDispatchQueueWith:createQueue",
  "openDispatchProbeWith:createQueue",
  "startDispatchWorkerWith:createWorker",
  "startDispatchWorkerWith:close",
].sort();

function memberSitesOf(sites: readonly { readonly file: string; readonly member: string; readonly function: string }[]): string[] {
  return sites.map((site) => `${site.function}:${site.member}`).sort();
}

/** A readJobHash body with one planted client member. */
function readJobHashWith(member: string): string {
  return [
    "async function readJobHash(queue, jobId, active) {",
    `  const client = await queue.${ACCESSOR}().client;`,
    `  return client.${member}(queue.toKey(jobId));`,
    "}",
    "",
  ].join("\n");
}

describe("no-bypass (012B-3): the member-site table, positive control", () => {
  const scan = scanPackage(PACKAGE_ROOT);

  it("the real package's member sites are exactly the pinned multiset, all in the implementation file", () => {
    assert.deepEqual(memberSitesOf(scan.memberSites), PINNED_MEMBER_SITES);
    assert.ok(scan.memberSites.every((site) => site.file === MODULE_FILE));
  });

  it("control: the planted readJobHash with the permitted member passes", () => {
    assert.deepEqual(rules(MODULE_FILE, readJobHashWith("hmgetBuffer")), []);
  });
});

describe("no-bypass (012B-3): the pinned amendment's planted-violation controls", () => {
  it("refuses the connection accessor outside its exception files, and any suffixed name everywhere", () => {
    failsWith("backend-identifier", OTHER_FILE, `const c = queue.${ACCESSOR}();\n`);
    failsWith("backend-identifier", "src/dispatch-queue/policy.ts", `const c = queue.${ACCESSOR}();\n`);
    failsWith("backend-identifier", MODULE_FILE, `const ${ACCESSOR}Factory = undefined;\n`);
    failsWith("backend-identifier", "src/dispatch-queue/policy.test.ts", `const ${ACCESSOR}s = undefined;\n`);
    assert.deepEqual(rules(MODULE_FILE, `function watchReady(queue) { queue.${ACCESSOR}(); }\n`), []);
  });

  it("refuses any client member other than the function's set, and a computed member", () => {
    for (const member of ["hgetall", "call", "sendCommand", DEL]) {
      failsWith("client-member-not-allowed", MODULE_FILE, readJobHashWith(member));
    }
    const computed = [
      "async function readJobHash(queue, jobId, active) {",
      `  const client = await queue.${ACCESSOR}().client;`,
      '  return client["hgetall"](queue.toKey(jobId));',
      "}",
      "",
    ].join("\n");
    failsWith("client-computed-member", MODULE_FILE, computed);
    const pingPlant = [
      "async function pingThrough(queue, active) {",
      `  const client = await queue.${ACCESSOR}().client;`,
      "  await client.hmgetBuffer(key);",
      "}",
      "",
    ].join("\n");
    failsWith("client-member-not-allowed", MODULE_FILE, pingPlant);
  });

  it("refuses a table member outside its listed functions", () => {
    failsWith("module-member-site", MODULE_FILE, "function openDispatchQueueWith(factories, settings) { const c = queue.client; }\n");
    failsWith("module-member-site", MODULE_FILE, `function openDispatchQueueWith(factories, settings) { queue.${ACCESSOR}(); }\n`);
    failsWith("module-member-site", MODULE_FILE, "function startDispatchWorkerWith(f, s, p) { f.createQueue(name, options); }\n");
    failsWith("module-member-site", MODULE_FILE, "function openAnother(f) { return f.createQueue(name, options); }\n");
    // An ordinary close before the forced one.
    failsWith(
      "module-member-site",
      MODULE_FILE,
      "function openDispatchQueueWith(f, s) { const queue = f.createQueue(name, options); void queue.close(); }\n",
    );
  });

  it("a second createQueue inside openDispatchQueueWith changes the member sites, so the positive control fails", () => {
    const text = readFileSync(join(PACKAGE_ROOT, MODULE_FILE), "utf8");
    const anchor = "  const ready = watchReady(queue);\n";
    assert.ok(text.includes(anchor));
    const planted = text.replace(anchor, `${anchor}  const second = factories.createQueue(DISPATCH_QUEUE_NAME, queueOptions(settings));\n`);
    assert.notEqual(planted, text);
    const sites = memberSitesOf(scanSource(MODULE_FILE, planted).memberSites);
    assert.notDeepEqual(sites, PINNED_MEMBER_SITES);
    assert.equal(sites.filter((site) => site === "openDispatchQueueWith:createQueue").length, 2);
  });
});

describe("no-bypass: the file walk covers untracked files and skips build output", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "irs-worker-scan-"));
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(root, "src", "deep", "planted.mjs"), `import { Queue } from "${L}";\n`);
    await writeFile(join(root, "scripts.cjs"), `require("${L}");\n`);
    await writeFile(join(root, "dist", "built.js"), `require("${L}");\n`);
    await writeFile(join(root, "node_modules", "x", "index.js"), `require("${L}");\n`);
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scans new files anywhere in the package, and only outside dist and node_modules", () => {
    const scan = scanPackage(root);
    assert.deepEqual([...scan.files], ["scripts.cjs", "src/deep/planted.mjs"]);
    assert.deepEqual(
      scan.violations.map((violation) => `${violation.file}:${violation.rule}`),
      ["scripts.cjs:library-outside-module", "src/deep/planted.mjs:library-outside-module"],
    );
  });
});
