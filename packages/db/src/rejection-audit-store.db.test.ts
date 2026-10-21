import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "./client.js";
import { disconnectWithin } from "./client.js";
import { classifyDatabaseError } from "./errors.js";
import type { EvidenceStoreHooks } from "./rate-limit-evidence-store.js";
import { writeRejectionAuditRows } from "./rejection-audit-store.js";
import type { RejectionAuditRow } from "./rejection-audit-store.js";
import { assertServerBaseline } from "./test-support/baseline.js";
import { guardedDatabase } from "./test-support/database.js";
import { requireTestUrl } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { pinnedAdmin, revertCommitStall, stallCommits } from "./test-support/syncrep-stall.js";

// Task 011A: EVENT_REJECTED batch writes on PostgreSQL (A-T11, store half;
// design §5.4, §9.3). Every write runs as irs_test_api (api mode). Admin mode
// (synchronous_commit = local pinned, FD-14): the baseline check, the RD-8
// stall and its verified revert, observation, backend termination and
// clean-up of exactly the rows this file created (by id). Tolerance: the
// SyncRep wait must be observed within 10 s, otherwise the case is not
// established and fails.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const TAG = randomUUID();
const CREATED_AT = "2026-10-21T10:01:00.123Z";

let admin: GuardedConnection;
let db: Database;
const written: string[] = [];

before(async () => {
  admin = await pinnedAdmin(adminUrl, "irs-test-rejection-admin");
  await assertServerBaseline(admin.client);
  db = await guardedDatabase({ url: apiUrl, mode: "api" });
});

after(async () => {
  try {
    await disconnectWithin(db, 5_000);
    await admin.client.query(`DELETE FROM "public"."AuditEntry" WHERE "id" = ANY($1::uuid[])`, [written]);
    await assertServerBaseline(admin.client);
  } finally {
    await admin.close();
  }
});

function rejection(changes: Partial<RejectionAuditRow> = {}): RejectionAuditRow {
  const id = changes.id ?? randomUUID();
  written.push(id);
  return {
    id,
    actorType: "EXTERNAL_SENDER",
    actorId: null,
    action: "EVENT_REJECTED",
    entityType: "WEBHOOK_DELIVERY",
    entityId: id,
    metadata: {
      schemaVersion: 1,
      limiterInstanceId: TAG,
      stage: "VERIFIER",
      httpStatus: 401,
      errorCode: "UNAUTHORIZED",
      claimedIntegrationId: null,
      verifierReason: "SIGNATURE_MISMATCH",
      responseCompletion: "FINISH_OBSERVED",
      receivedAt: "2026-10-21T10:01:00.000Z",
    },
    createdAt: CREATED_AT,
    ...changes,
  };
}

/** Admin mode, observation: the stored row in the store's text form, under a non-UTC session TimeZone. */
async function stored(id: string): Promise<RejectionAuditRow | null> {
  await admin.client.query("SET TIME ZONE 'America/New_York'");
  try {
    const row = (
      await admin.client.query<RejectionAuditRow & { metadata: string | null }>(
        `SELECT "id"::text AS "id", "actorType", "actorId", "action", "entityType", "entityId", "metadata"::text AS "metadata",
                to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
           FROM "public"."AuditEntry" WHERE "id" = $1::uuid`,
        [id],
      )
    ).rows[0];
    return row === undefined ? null : { ...row, metadata: row.metadata === null ? null : JSON.parse(row.metadata) };
  } finally {
    await admin.client.query("RESET TIME ZONE");
  }
}

describe("EVENT_REJECTED batches on PostgreSQL (A-T11 store half)", () => {
  it("CREATED, then IDENTICAL_EXISTS; createdAt is stored as the frozen UTC value", async () => {
    const a = rejection();
    const b = rejection();
    assert.deepEqual(await writeRejectionAuditRows(db, [a, b]), ["CREATED", "CREATED"]);
    assert.deepEqual(await writeRejectionAuditRows(db, [a, b]), ["IDENTICAL_EXISTS", "IDENTICAL_EXISTS"]);
    assert.deepEqual(await stored(a.id), a);
    assert.deepEqual(await stored(b.id), b);
  });

  it("any differing column → CONFLICT; the stored row is never overwritten", async () => {
    const a = rejection();
    assert.deepEqual(await writeRejectionAuditRows(db, [a]), ["CREATED"]);
    const metadata = a.metadata as Record<string, unknown>;
    const variants: readonly (readonly [string, RejectionAuditRow])[] = [
      ["createdAt only", { ...a, createdAt: "2026-10-21T10:01:00.124Z" }],
      ["one metadata field", { ...a, metadata: { ...metadata, verifierReason: "TIMESTAMP_SKEW" } as RejectionAuditRow["metadata"] }],
      ["metadata null", { ...a, metadata: null }],
      ["actorType", { ...a, actorType: "SYSTEM" }],
      ["actorId", { ...a, actorId: "someone" }],
      ["action", { ...a, action: "EVENT_RECEIVED" }],
      ["entityType", { ...a, entityType: "EVENT" }],
      ["entityId", { ...a, entityId: randomUUID() }],
    ];
    for (const [label, other] of variants) {
      assert.deepEqual(await writeRejectionAuditRows(db, [other]), ["CONFLICT"], label);
    }
    assert.deepEqual(await stored(a.id), a);
  });

  it("a CONFLICT does not roll the batch back; a repeated id inside one batch is compared with the earlier row", async () => {
    const a = rejection();
    assert.deepEqual(await writeRejectionAuditRows(db, [a]), ["CREATED"]);
    const c = rejection();
    const d = rejection();
    assert.deepEqual(
      await writeRejectionAuditRows(db, [c, { ...a, createdAt: "2026-10-21T10:02:00.000Z" }, d, d, { ...d, entityId: randomUUID() }]),
      ["CREATED", "CONFLICT", "CREATED", "IDENTICAL_EXISTS", "CONFLICT"],
    );
    assert.deepEqual(await stored(c.id), c);
    assert.deepEqual(await stored(d.id), d);
  });

  it("RD-8: a lost acknowledgement (COMMIT/UNKNOWN); the row is durable and unchanged; the identical retry is IDENTICAL_EXISTS", async () => {
    const a = rejection();
    const stalledDb = await guardedDatabase({ url: apiUrl, mode: "api", pool: { maxConnections: 1 } });
    let stallStarted = false;
    try {
      await stallCommits(adminUrl, admin.client, "A-T11 RD-8");
      stallStarted = true;
      const hooks: EvidenceStoreHooks = {
        beforeWork: async (tx) => {
          await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
        },
      };
      const pending = writeRejectionAuditRows(stalledDb, [a], hooks).then(
        (value) => ({ settled: "resolved" as const, value }),
        (error: unknown) => ({ settled: "rejected" as const, error }),
      );
      const until = performance.now() + 10_000;
      let pid: number | undefined;
      while (pid === undefined) {
        pid = (
          await admin.client.query<{ pid: number }>(
            `SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename = 'irs_test_api' AND datname = current_database() AND wait_event = 'SyncRep'`,
          )
        ).rows[0]?.pid;
        if (pid === undefined) {
          if (performance.now() > until) assert.fail("not established: no SyncRep wait within 10 s");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
      const outcome = await pending;
      assert.equal(outcome.settled, "rejected");
      const error = (outcome as { error: { phase?: unknown; outcome?: unknown } }).error;
      assert.deepEqual([error.phase, error.outcome], ["COMMIT", "UNKNOWN"]);
      assert.equal(classifyDatabaseError(error).failureClass, "TRANSIENT");
      // The durability read, inside the stall.
      assert.deepEqual(await stored(a.id), a);
    } finally {
      await disconnectWithin(stalledDb, 5_000);
      if (stallStarted) await revertCommitStall(adminUrl, "A-T11 RD-8");
    }
    assert.deepEqual(await writeRejectionAuditRows(db, [a]), ["IDENTICAL_EXISTS"]);
    const count = await admin.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "public"."AuditEntry" WHERE "id" = $1::uuid`, [a.id]);
    assert.equal(count.rows[0]?.n, 1);
  });
});
