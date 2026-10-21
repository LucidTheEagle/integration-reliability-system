import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database, PrismaClient } from "./client.js";
import {
  EVIDENCE_LOCKED_TRANSACTION,
  EVIDENCE_LOCK_NAMESPACE,
  EVIDENCE_MAX_WAIT_MS,
  EVIDENCE_UNLOCKED_TRANSACTION,
  REGISTRATION_VERIFICATION_TRANSACTION,
  canonicalJson,
  evidenceRecordHash,
  findEvidenceRecoveryCandidates,
  readEvidenceDurableState,
  readEvidenceRegistration,
  validateEvidenceHistoricalGap,
  writeEvidenceGroup,
  writeEvidenceUncleanGap,
} from "./rate-limit-evidence-store.js";
import type { EvidenceDurableState, EvidenceRecordRow } from "./rate-limit-evidence-store.js";
import { writeRejectionAuditRows } from "./rejection-audit-store.js";

// Task 011A database-free tests for the evidence store and its tooling.

// ---------------------------------------------------------------------------
// RD-3: every 011A transaction path passes EVIDENCE_MAX_WAIT_MS (U3: its own
// set). A fake Database records the options each primitive hands to
// prisma.$transaction, then fails the call: no connection is ever made.

const NOW = 1_000;

function recordingDatabase(): { readonly db: Database; readonly options: unknown[] } {
  const options: unknown[] = [];
  const prisma = {
    $transaction: async (_work: unknown, transactionOptions: unknown) => {
      options.push(transactionOptions);
      throw new Error("fake database: no connection");
    },
  };
  return {
    db: { prisma: prisma as unknown as PrismaClient, monotonicNow: () => NOW, ping: async () => undefined },
    options,
  };
}

function row(changes: Partial<EvidenceRecordRow> = {}): EvidenceRecordRow {
  return {
    id: randomUUID(),
    limiterInstanceId: "00000000-0000-4000-8000-0000000000aa",
    scope: "s",
    kind: "EVIDENCE_GAP",
    gapReason: "UNCLEAN_TERMINATION",
    firstSequence: null,
    lastSequence: null,
    missingFrom: null,
    missingTo: null,
    payload: { schemaVersion: 1 },
    recordSha256: "0".repeat(64),
    recordedAt: "2026-10-21T10:00:00.000Z",
    ...changes,
  };
}

const STATE: EvidenceDurableState = {
  limiterInstanceId: "00000000-0000-4000-8000-0000000000aa",
  startedScope: "s",
  lastDurableSequence: 0,
  cumulativeAsOfLastDurable: null,
  auditCumulativeAsOfLastDurable: null,
};

describe("RD-3: maxWait instrumentation (database-free)", () => {
  it("J1: EVIDENCE_MAX_WAIT_MS is 500; the fixed option sets and the lock namespace", () => {
    assert.equal(EVIDENCE_MAX_WAIT_MS, 500);
    assert.deepEqual(
      { ...EVIDENCE_LOCKED_TRANSACTION },
      { windowMs: 5_000, lockTimeoutMs: 1_000, postLockReserveMs: 2_000, commitReserveMs: 250, maxWaitMs: 500 },
    );
    assert.deepEqual(
      { ...REGISTRATION_VERIFICATION_TRANSACTION },
      { maxWaitMs: 200, lockTimeoutMs: 500, postLockReserveMs: 250, commitReserveMs: 50 },
    );
    assert.deepEqual({ ...EVIDENCE_UNLOCKED_TRANSACTION }, { isolationLevel: "ReadCommitted", maxWait: 500, timeout: 4_500 });
    assert.equal(EVIDENCE_LOCK_NAMESPACE, "irs.rate-limit-evidence.instance");
  });

  const locked = { isolationLevel: "ReadCommitted", maxWait: 500, timeout: 4_500 };
  const unlocked = { isolationLevel: "ReadCommitted", maxWait: 500, timeout: 4_500 };
  const cases: readonly (readonly [string, (db: Database) => Promise<unknown>, unknown])[] = [
    ["findEvidenceRecoveryCandidates (unlocked)", (db) => findEvidenceRecoveryCandidates(db, "s", randomUUID()), unlocked],
    ["readEvidenceDurableState (unlocked)", (db) => readEvidenceDurableState(db, randomUUID()), unlocked],
    ["writeRejectionAuditRows (unlocked)", (db) => writeRejectionAuditRows(db, []), unlocked],
    ["writeEvidenceUncleanGap (locked, 5 s window)", (db) => writeEvidenceUncleanGap(db, row(), STATE), locked],
    ["validateEvidenceHistoricalGap (locked, 5 s window)", (db) => validateEvidenceHistoricalGap(db, randomUUID(), "s"), locked],
    ["writeEvidenceGroup (locked, 5 s window)", (db) => writeEvidenceGroup(db, [row()]), locked],
    // U3: the lifecycle's deadline (now + 1,000): timeout = w0 − maxWait = 1,000 − 200.
    [
      "readEvidenceRegistration (U3)",
      (db) => readEvidenceRegistration(db, randomUUID(), NOW + 1_000),
      { isolationLevel: "ReadCommitted", maxWait: 200, timeout: 800 },
    ],
  ];

  for (const [label, call, expected] of cases) {
    it(`${label}: the options handed to $transaction`, async () => {
      const { db, options } = recordingDatabase();
      await assert.rejects(call(db), /fake database/);
      assert.deepEqual(options, [expected]);
    });
  }

  it("U3 that cannot fit its runner values before the deadline never opens a transaction", async () => {
    const { db, options } = recordingDatabase();
    const error = await readEvidenceRegistration(db, randomUUID(), NOW + 900).then(
      () => assert.fail("expected a deadline error"),
      (caught: unknown) => caught as { phase?: unknown; outcome?: unknown },
    );
    assert.deepEqual([error.phase, error.outcome], ["NOT_STARTED", "NOT_COMMITTED"]);
    assert.deepEqual(options, []);
  });
});

describe("evidence primitives: preconditions and outcome annotation (database-free)", () => {
  it("an empty or mixed-instance group, and a non-unclean gap, throw TypeError before any transaction", async () => {
    const { db, options } = recordingDatabase();
    await assert.rejects(writeEvidenceGroup(db, []), TypeError);
    await assert.rejects(writeEvidenceGroup(db, [row(), row({ limiterInstanceId: randomUUID() })]), TypeError);
    await assert.rejects(writeEvidenceUncleanGap(db, row({ gapReason: "SEQUENCE_DISCONTINUITY" }), STATE), TypeError);
    await assert.rejects(writeEvidenceUncleanGap(db, row({ limiterInstanceId: randomUUID() }), STATE), TypeError);
    assert.deepEqual(options, []);
  });

  it("B-1: an unlocked transaction failing after its callback completed is COMMIT/UNKNOWN; before it, NOT_COMMITTED", async () => {
    const outcomes: unknown[] = [];
    for (const failAfterCallback of [true, false]) {
      const prisma = {
        $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
          if (!failAfterCallback) throw new Error("fake: acquisition failed");
          await work({});
          throw new Error("fake: commit acknowledgement lost");
        },
      };
      const db: Database = { prisma: prisma as unknown as PrismaClient, monotonicNow: () => NOW, ping: async () => undefined };
      const error = (await writeRejectionAuditRows(db, []).then(
        () => assert.fail("expected an error"),
        (caught: unknown) => caught,
      )) as { phase?: unknown; outcome?: unknown };
      outcomes.push([error.phase, error.outcome]);
    }
    assert.deepEqual(outcomes, [
      ["COMMIT", "UNKNOWN"],
      ["NOT_STARTED", "NOT_COMMITTED"],
    ]);
  });
});

describe("canonical JSON and the complete-record hash: the pinned vector shared with apps/api", () => {
  it("reproduces apps/api's pinned canonical text and SHA-256", () => {
    const fields = {
      id: "00000000-0000-4000-8000-000000000001",
      limiterInstanceId: "00000000-0000-4000-8000-000000000002",
      scope: "irs.contract",
      kind: "INSTANCE_STARTED",
      gapReason: null,
      firstSequence: null,
      lastSequence: null,
      missingFrom: null,
      missingTo: null,
      recordedAt: "2026-10-21T10:00:00.000Z",
      payload: { schemaVersion: 1, b: [1, 2.5, null, true], a: "x", "é": "☃" },
    };
    assert.equal(
      canonicalJson(fields),
      '{"firstSequence":null,"gapReason":null,"id":"00000000-0000-4000-8000-000000000001","kind":"INSTANCE_STARTED",' +
        '"lastSequence":null,"limiterInstanceId":"00000000-0000-4000-8000-000000000002","missingFrom":null,"missingTo":null,' +
        '"payload":{"a":"x","b":[1,2.5,null,true],"schemaVersion":1,"é":"☃"},"recordedAt":"2026-10-21T10:00:00.000Z",' +
        '"scope":"irs.contract"}',
    );
    assert.equal(evidenceRecordHash(fields), "fb3cc9a2931751aa1f7844850bc81e1e27e2c6a8c317fa30e079059d50a515c7");
  });

  it("rejects non-JSON values, as apps/api's canonicalJson does", () => {
    for (const value of [Number.NaN, 2 ** 53, { a: undefined }, new Date(0), () => 1]) {
      assert.throws(() => canonicalJson(value), TypeError);
    }
  });
});

const MIGRATIONS = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));
const SETUP = fileURLToPath(new URL("./test-support/setup.js", import.meta.url));

function migrationEntries(): string[] {
  return readdirSync(MIGRATIONS).sort();
}

/**
 * Runs `setup.js author-next <argument>` with no test-database variables, so
 * nothing can connect: an invalid argument stops at validation, and a valid
 * one stops at requireTestUrl.
 */
function authorNext(argument: string | undefined): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["IRS_TEST_DATABASE_URL"];
  delete env["IRS_TEST_ADMIN_DATABASE_URL"];
  const args = argument === undefined ? [SETUP, "author-next"] : [SETUP, "author-next", argument];
  const run = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  return { status: run.status, stderr: run.stderr };
}

describe("setup.js author-next: argument validation (Task 011A, RD-4; database-free)", () => {
  it("refuses a missing, malformed, _init, earlier, existing or outside path, and writes nothing", () => {
    const before = migrationEntries();
    const later = migrationEntries().filter((name) => /^\d{14}_/.test(name) && !name.endsWith("_init"));
    const cases: [string | undefined, RegExp][] = [
      [undefined, /usage: author-next/],
      ["prisma/migrations/20261017101850_init/migration.sql", /usage: author-next/],
      ["prisma/migrations/2026101710185_short/migration.sql", /usage: author-next/],
      ["prisma/migrations/29990101000000_Upper/migration.sql", /usage: author-next/],
      ["prisma/migrations/29990101000000_x/other.sql", /usage: author-next/],
      ["../outside/migration.sql", /usage: author-next/],
      ["prisma/migrations/20200101000000_earlier/migration.sql", /later than every existing migration/],
      ["prisma/migrations/20261017101850_same_time/migration.sql", /later than every existing migration/],
      ...later.map((name): [string, RegExp] => [`prisma/migrations/${name}/migration.sql`, /already exists; not overwriting/]),
    ];
    for (const [argument, expected] of cases) {
      const run = authorNext(argument);
      assert.equal(run.status, 1, String(argument));
      assert.match(run.stderr, expected, String(argument));
    }
    assert.deepEqual(migrationEntries(), before);
  });

  it("a valid path passes validation and then stops before any connection (no test-database variable)", () => {
    const target = "prisma/migrations/29990101000000_valid_name/migration.sql";
    const run = authorNext(target);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /IRS_TEST_ADMIN_DATABASE_URL is not set/);
    assert.equal(existsSync(fileURLToPath(new URL(`../../../${target}`, import.meta.url))), false);
  });
});
