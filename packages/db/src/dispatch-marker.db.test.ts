import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomUUIDv7 } from "node:crypto";
import { assertServerBaseline } from "./test-support/baseline.js";
import { bootstrapScratch, dropScratch } from "./test-support/bootstrap.js";
import { connectGuarded, requireTestUrl, withDatabase } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { sqlState } from "./test-support/pg.js";
import type { PgClient } from "./test-support/pg.js";
import { migrateScratch } from "./test-support/provision.js";
import { API_ROLE, STATUS_FUNCTION, WORKER_ROLE, scratchDatabaseName } from "./test-support/registry.js";
import { DISPATCH_AUDIT_INSERT_SQL } from "./dispatch-audit.js";

// Task 012B (B1-4, B1-5, Q1, PL-2): the dispatch-marker trigger, rule by rule
// (T0-T5, B1-5's matrix, FD-8), the consistency CHECK, Q1's privilege state,
// and the worker role's permitted and refused operations. Everything runs in
// the registered scratch database `dispatch` (FD-6), so marked rows never touch
// irs_011_test; it is dropped afterwards. Every assertion is by SQLSTATE
// (and constraint name for 23514), never by message.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const workerUrl = requireTestUrl("IRS_TEST_WORKER_DATABASE_URL");
const PURPOSE = "dispatch";
const FN = `"public"."irs_event_dispatch_marker_guard"()`;

/**
 * F5: the SQLSTATE of the worker's direct call of the trigger function,
 * observed by this test's first run (012B-2 RUN A, A7) and then pinned.
 * A placeholder until then.
 */
const F5_DIRECT_CALL_SQLSTATE = "PLACEHOLDER-NOT-CAPTURED:F5";
/** Q1: the trigger function's exact ACL, captured from irs_011_test (A6). A placeholder until then. */
const GOLDEN_DISPATCH_FUNCTION_ACL = "{postgres=X/postgres}";

// Admin mode on irs_011_test: the baseline, and creating and dropping the scratch database.
let admin: GuardedConnection;
// Admin mode on the scratch database: row construction (the database does not enforce the state machine).
let scratchAdmin: GuardedConnection;
let worker: GuardedConnection;
let api: GuardedConnection;
let integrationId: string;

before(async () => {
  admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-dispatch-marker" });
  await assertServerBaseline(admin.client);
  const adminScratchUrl = await bootstrapScratch(admin, adminUrl, PURPOSE);
  await migrateScratch(adminScratchUrl, [API_ROLE, WORKER_ROLE]);
  scratchAdmin = await connectGuarded({ url: adminScratchUrl, mode: "admin", applicationName: "irs-test-dispatch-marker-admin" });
  worker = await connectGuarded({ url: withDatabase(workerUrl, scratchDatabaseName(PURPOSE)), mode: "worker", applicationName: "irs-test-dispatch-marker-worker" });
  api = await connectGuarded({ url: withDatabase(apiUrl, scratchDatabaseName(PURPOSE)), mode: "api", applicationName: "irs-test-dispatch-marker-api" });
  integrationId = randomUUID();
  await scratchAdmin.client.query(
    `INSERT INTO "public"."Integration" ("id", "name", "provider", "type", "configStatus", "environment", "updatedAt")
     VALUES ($1, 'dispatch seed', 'test', 'test', 'ACTIVE', 'test', now())`,
    [integrationId],
  );
});

after(async () => {
  await api?.close();
  await worker?.close();
  await scratchAdmin?.close();
  await dropScratch(admin, PURPOSE);
  await assertServerBaseline(admin.client);
  await admin.close();
});

type Outcome = string; // "ok" or a SQLSTATE (with the constraint name for 23514)

async function outcome(client: PgClient, sql: string, values: unknown[] = []): Promise<Outcome> {
  try {
    await client.query(sql, values);
    return "ok";
  } catch (error) {
    const state = sqlState(error) ?? "no-sqlstate";
    const constraint = (error as { constraint?: unknown }).constraint;
    return state === "23514" && typeof constraint === "string" ? `${state}:${constraint}` : state;
  }
}

const INSERT_COLUMNS = `"id", "integrationId", "externalEventId", "eventType", "resourceType", "resourceId", "payload", "occurredAt", "receivedAt", "status", "schemaVersion", "rawBody", "rawBodySha256"`;
const DIGEST = "a".repeat(64);

function insertSql(marker: "none" | "both" | "kind"): string {
  const extraColumns = marker === "both" ? `, "dispatchAnomalyAt", "dispatchAnomalyKind"` : marker === "kind" ? `, "dispatchAnomalyKind"` : "";
  const extraValues = marker === "both" ? `, now(), 'COMPLETED_WHILE_QUEUED'` : marker === "kind" ? `, 'COMPLETED_WHILE_QUEUED'` : "";
  return `INSERT INTO "public"."Event" (${INSERT_COLUMNS}${extraColumns})
          VALUES ($1, $2, $3, 't', 't', 't', '{}'::jsonb, now(), now(), $4::"public"."EventState", '1', '\\x61'::bytea, '${DIGEST}'${extraValues})`;
}

/** Admin mode: one unmarked row in the given status. */
async function row(status: string): Promise<string> {
  const id = randomUUID();
  assert.equal(await outcome(scratchAdmin.client, insertSql("none"), [id, integrationId, `m-${id}`, status]), "ok");
  return id;
}

/** Admin mode: a QUEUED row marked through T1 (the audit's initial setting). */
async function markedQueued(): Promise<string> {
  const id = await row("QUEUED");
  assert.equal(
    await outcome(scratchAdmin.client, `UPDATE "public"."Event" SET "dispatchAnomalyAt" = now(), "dispatchAnomalyKind" = 'COMPLETED_WHILE_QUEUED' WHERE "id" = $1`, [id]),
    "ok",
  );
  return id;
}

const SET_MARKER = `"dispatchAnomalyAt" = now(), "dispatchAnomalyKind" = 'FAILED_WHILE_QUEUED'`;
const roles = () => [
  ["worker", worker.client],
  ["admin", scratchAdmin.client],
] as const;

describe("T0: an INSERT carrying the marker is refused (B1-4 class sweep)", () => {
  it("the worker cannot insert at all (42501: a privilege denial, not a T0 test)", async () => {
    for (const marker of ["both", "kind", "none"] as const) {
      const id = randomUUID();
      assert.equal(await outcome(worker.client, insertSql(marker), [id, integrationId, `w-${id}`, "VALIDATED"]), "42501", marker);
    }
  });

  it("admin and the API role (both permitted to insert): both marker fields → IRST0; only the kind → IRST0 (the BEFORE trigger precedes the CHECK); unmarked → ok", async () => {
    for (const [label, client] of [["admin", scratchAdmin.client], ["api", api.client]] as const) {
      for (const [marker, expected] of [["both", "IRST0"], ["kind", "IRST0"], ["none", "ok"]] as const) {
        const id = randomUUID();
        assert.equal(await outcome(client, insertSql(marker), [id, integrationId, `t0-${id}`, "VALIDATED"]), expected, `${label} ${marker}`);
      }
    }
  });
});

describe("T1: the initial setting is allowed only while QUEUED, with the kind, in the same statement", () => {
  it("control: QUEUED, marker and kind set, status stays QUEUED → ok (worker and admin)", async () => {
    for (const [label, client] of roles()) {
      const id = await row("QUEUED");
      assert.equal(await outcome(client, `UPDATE "public"."Event" SET ${SET_MARKER} WHERE "id" = $1`, [id]), "ok", label);
    }
  });

  it("VALIDATED or FAILED; QUEUED → PROCESSING in the same statement; the marker without the kind → IRST1 (worker and admin)", async () => {
    for (const [label, client] of roles()) {
      for (const status of ["VALIDATED", "FAILED"]) {
        const id = await row(status);
        assert.equal(await outcome(client, `UPDATE "public"."Event" SET ${SET_MARKER} WHERE "id" = $1`, [id]), "IRST1", `${label} ${status}`);
      }
      const processing = await row("QUEUED");
      assert.equal(
        await outcome(client, `UPDATE "public"."Event" SET ${SET_MARKER}, "status" = 'PROCESSING' WHERE "id" = $1`, [processing]),
        "IRST1",
        `${label} to PROCESSING`,
      );
      const noKind = await row("QUEUED");
      assert.equal(await outcome(client, `UPDATE "public"."Event" SET "dispatchAnomalyAt" = now() WHERE "id" = $1`, [noKind]), "IRST1", `${label} no kind`);
    }
  });
});

describe("T2: clearing or changing the marker is refused, in every status", () => {
  it("marked QUEUED: clear both; change the kind; change dispatchAnomalyAt; FAILED and clear in one statement → IRST2 (worker and admin)", async () => {
    for (const [label, client] of roles()) {
      const statements = [
        `UPDATE "public"."Event" SET "dispatchAnomalyAt" = NULL, "dispatchAnomalyKind" = NULL WHERE "id" = $1`,
        `UPDATE "public"."Event" SET "dispatchAnomalyKind" = 'FAILED_WHILE_QUEUED' WHERE "id" = $1`,
        `UPDATE "public"."Event" SET "dispatchAnomalyAt" = "dispatchAnomalyAt" + interval '1 second' WHERE "id" = $1`,
        `UPDATE "public"."Event" SET "status" = 'FAILED', "dispatchAnomalyAt" = NULL, "dispatchAnomalyKind" = NULL WHERE "id" = $1`,
      ];
      for (const sql of statements) {
        const id = await markedQueued();
        assert.equal(await outcome(client, sql, [id]), "IRST2", `${label}: ${sql}`);
      }
    }
  });
});

describe("T3: entering PROCESSING while marked is refused", () => {
  it("marker kept → IRST3; marker cleared in the same statement → IRST2 (T2 is evaluated first; FD-8) (worker and admin)", async () => {
    for (const [label, client] of roles()) {
      const kept = await markedQueued();
      assert.equal(await outcome(client, `UPDATE "public"."Event" SET "status" = 'PROCESSING' WHERE "id" = $1`, [kept]), "IRST3", `${label} kept`);
      const cleared = await markedQueued();
      assert.equal(
        await outcome(
          client,
          `UPDATE "public"."Event" SET "status" = 'PROCESSING', "dispatchAnomalyAt" = NULL, "dispatchAnomalyKind" = NULL WHERE "id" = $1`,
          [cleared],
        ),
        "IRST2",
        `${label} cleared`,
      );
    }
  });

  it("control: an unmarked QUEUED row enters PROCESSING (worker and admin)", async () => {
    for (const [label, client] of roles()) {
      const id = await row("QUEUED");
      assert.equal(await outcome(client, `UPDATE "public"."Event" SET "status" = 'PROCESSING' WHERE "id" = $1`, [id]), "ok", label);
    }
  });
});

describe("T4 and T5", () => {
  it("T4: marked QUEUED → FAILED with the marker preserved is not refused (constructed in SQL); T5: clearing it afterwards → IRST2 (worker and admin)", async () => {
    for (const [label, client] of roles()) {
      const id = await markedQueued();
      assert.equal(await outcome(client, `UPDATE "public"."Event" SET "status" = 'FAILED' WHERE "id" = $1`, [id]), "ok", `${label} T4`);
      assert.equal(
        await outcome(client, `UPDATE "public"."Event" SET "dispatchAnomalyAt" = NULL, "dispatchAnomalyKind" = NULL WHERE "id" = $1`, [id]),
        "IRST2",
        `${label} T5`,
      );
    }
  });
});

describe("the consistency CHECK (B1-2)", () => {
  it("unmarked: setting the kind only → 23514 on Event_dispatchAnomaly_consistency_check (worker and admin)", async () => {
    for (const [label, client] of roles()) {
      const id = await row("QUEUED");
      assert.equal(
        await outcome(client, `UPDATE "public"."Event" SET "dispatchAnomalyKind" = 'COMPLETED_WHILE_QUEUED' WHERE "id" = $1`, [id]),
        "23514:Event_dispatchAnomaly_consistency_check",
        label,
      );
    }
  });
});

describe("Step 1 respects the marker (ADD §6)", () => {
  it("a VALIDATED row with the marker set (constructed: QUEUED, T1, then T4 to VALIDATED) is never claimed; an unmarked one is (control)", async () => {
    const marked = await markedQueued();
    assert.equal(await outcome(scratchAdmin.client, `UPDATE "public"."Event" SET "status" = 'VALIDATED' WHERE "id" = $1`, [marked]), "ok");
    const unmarked = await row("VALIDATED");
    const claimed = await worker.client.query<{ id: string }>(
      `UPDATE "public"."Event" SET "status" = 'QUEUED', "queuedAt" = now(), "lastPublishAttemptAt" = now(), "publishAttemptCount" = 1
        WHERE "id" IN (SELECT "id" FROM "public"."Event"
                        WHERE "status" = 'VALIDATED' AND "dispatchAnomalyAt" IS NULL AND "id" = ANY($1::uuid[])
                        ORDER BY "receivedAt" LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING "id"`,
      [[marked, unmarked]],
    );
    assert.deepEqual(claimed.rows.map((r) => r.id), [unmarked]);
  });
});

describe("Q1: the trigger function's privilege state, and the trigger firing without EXECUTE", () => {
  it("the ACL holds no PUBLIC entry and equals the captured value; PUBLIC, the worker and the API role have no EXECUTE", async () => {
    const acl = await scratchAdmin.client.query<{ acl: string | null }>(
      `SELECT p.proacl::text AS acl FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'irs_event_dispatch_marker_guard'`,
    );
    assert.equal(acl.rows.length, 1);
    assert.equal(acl.rows[0]?.acl, GOLDEN_DISPATCH_FUNCTION_ACL);
    assert.doesNotMatch(acl.rows[0]?.acl ?? "", /(^|[{,])=/, "no PUBLIC entry (an ACL item with an empty grantee)");
    const privileges = await scratchAdmin.client.query<{ public_execute: boolean; worker_execute: boolean; api_execute: boolean }>(
      `SELECT has_function_privilege('public', '${FN}', 'EXECUTE') AS public_execute,
              has_function_privilege('${WORKER_ROLE}', '${FN}', 'EXECUTE') AS worker_execute,
              has_function_privilege('${API_ROLE}', '${FN}', 'EXECUTE') AS api_execute`,
    );
    assert.deepEqual(privileges.rows[0], { public_execute: false, worker_execute: false, api_execute: false });
    // Control: the inquiry does report EXECUTE where it is held (the owner).
    const owner = await scratchAdmin.client.query<{ owner_execute: boolean }>(
      `SELECT has_function_privilege('postgres', '${FN}', 'EXECUTE') AS owner_execute`,
    );
    assert.equal(owner.rows[0]?.owner_execute, true);
  });

  it("the worker's permitted UPDATE and the API's permitted INSERT fire the trigger without EXECUTE (their refusal cases are the trigger's own SQLSTATEs)", async () => {
    // Fired for the worker's UPDATE: T1 refuses a VALIDATED row; the control succeeds.
    const validated = await row("VALIDATED");
    assert.equal(await outcome(worker.client, `UPDATE "public"."Event" SET ${SET_MARKER} WHERE "id" = $1`, [validated]), "IRST1");
    const queued = await row("QUEUED");
    assert.equal(await outcome(worker.client, `UPDATE "public"."Event" SET ${SET_MARKER} WHERE "id" = $1`, [queued]), "ok");
    // Fired for the API role's INSERT: T0 refuses a marked insert; the unmarked control succeeds.
    const marked = randomUUID();
    assert.equal(await outcome(api.client, insertSql("both"), [marked, integrationId, `q1-${marked}`, "VALIDATED"]), "IRST0");
    const plain = randomUUID();
    assert.equal(await outcome(api.client, insertSql("none"), [plain, integrationId, `q1-${plain}`, "VALIDATED"]), "ok");
  });

  it("F5: the worker's direct call of the trigger function is refused, with the pinned SQLSTATE", async () => {
    const observed = await outcome(worker.client, `SELECT ${FN}`);
    process.stdout.write(`[F5] the worker's direct call of the trigger function: SQLSTATE ${observed}\n`);
    assert.notEqual(observed, "ok");
    assert.equal(observed, F5_DIRECT_CALL_SQLSTATE);
  });
});

describe("the worker role: refused operations (42501 each; B1-7)", () => {
  it("columns, tables and functions outside its grant set", async () => {
    const id = await row("QUEUED");
    const auditId = randomUUID();
    const denied: [string, unknown[]][] = [
      [`SELECT "payload" FROM "public"."Event" WHERE "id" = $1`, [id]],
      [`SELECT "rawBody" FROM "public"."Event" WHERE "id" = $1`, [id]],
      [`SELECT "metadata" FROM "public"."Event" WHERE "id" = $1`, [id]],
      [`SELECT "integrationId" FROM "public"."Event" WHERE "id" = $1`, [id]],
      [`SELECT "externalEventId" FROM "public"."Event" WHERE "id" = $1`, [id]],
      [`SELECT * FROM "public"."Event" WHERE "id" = $1`, [id]],
      [`UPDATE "public"."Event" SET "payload" = '{}'::jsonb WHERE "id" = $1`, [id]],
      [`UPDATE "public"."Event" SET "receivedAt" = now() WHERE "id" = $1`, [id]],
      [`UPDATE "public"."Event" SET "integrationId" = "integrationId" WHERE "id" = $1`, [id]],
      [`DELETE FROM "public"."Event" WHERE "id" = $1`, [id]],
      [`TRUNCATE "public"."Event"`, []],
      [`SELECT "id" FROM "public"."AuditEntry" LIMIT 1`, []],
      [`UPDATE "public"."AuditEntry" SET "action" = "action" WHERE "id" = $1`, [auditId]],
      [`DELETE FROM "public"."AuditEntry" WHERE "id" = $1`, [auditId]],
      [`${DISPATCH_AUDIT_INSERT_SQL} RETURNING "id"`, [auditId, "SYSTEM", "irs-dispatcher", "EVENT_REDISPATCH_REQUESTED", id, `{"schema":1}`]],
      [`SELECT "public"."${STATUS_FUNCTION}"($1)`, [integrationId]],
      [`CREATE TABLE "public"."irs_worker_planted" ("id" integer)`, []],
      [`SELECT "id" FROM "public"."Integration" LIMIT 1`, []],
      [`INSERT INTO "public"."_prisma_migrations" ("id", "checksum", "migration_name") VALUES ('x', 'x', 'x')`, []],
      [`UPDATE "public"."_prisma_migrations" SET "migration_name" = "migration_name"`, []],
      [`DELETE FROM "public"."_prisma_migrations"`, []],
    ];
    for (const [sql, values] of denied) assert.equal(await outcome(worker.client, sql, values), "42501", sql);
  });
});

describe("the worker role: permitted operations (B1-7's derivation; the production statements are 012B-4's)", () => {
  it("the Step 1 claim, the Step 3 acknowledgement, the Step 4.1 retry claim, the repair request, the anomaly recording, the backlog read and the B2-11 insert", async () => {
    const validated = await row("VALIDATED");
    const claim = await worker.client.query<{ id: string }>(
      `UPDATE "public"."Event" SET "status" = 'QUEUED', "queuedAt" = now(), "lastPublishAttemptAt" = now(), "publishAttemptCount" = 1
        WHERE "id" IN (SELECT "id" FROM "public"."Event" WHERE "status" = 'VALIDATED' AND "dispatchAnomalyAt" IS NULL AND "id" = $1
                        ORDER BY "receivedAt" LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING "id"`,
      [validated],
    );
    assert.deepEqual(claim.rows.map((r) => r.id), [validated], "Step 1");
    const ack = await worker.client.query(
      `UPDATE "public"."Event" SET "publishAckedAt" = COALESCE("publishAckedAt", now()), "lastPublishAckAt" = now() WHERE "id" = $1`,
      [validated],
    );
    assert.equal(ack.rowCount, 1, "Step 3");

    const unacked = await row("QUEUED");
    await scratchAdmin.client.query(
      `UPDATE "public"."Event" SET "queuedAt" = now() - interval '1 hour', "lastPublishAttemptAt" = now() - interval '1 hour', "publishAttemptCount" = 1 WHERE "id" = $1`,
      [unacked],
    );
    const retry = await worker.client.query<{ id: string; publishAttemptCount: number }>(
      `UPDATE "public"."Event" SET "lastPublishAttemptAt" = now(), "publishAttemptCount" = "publishAttemptCount" + 1
        WHERE "id" IN (SELECT "id" FROM "public"."Event"
                        WHERE "status" = 'QUEUED' AND "publishAckedAt" IS NULL AND "queuedAt" < now() - interval '30 seconds'
                          AND "lastPublishAttemptAt" < now() - interval '30 seconds' AND "dispatchAnomalyAt" IS NULL AND "id" = $1
                        FOR UPDATE SKIP LOCKED)
        RETURNING "id", "publishAttemptCount"`,
      [unacked],
    );
    assert.deepEqual(retry.rows, [{ id: unacked, publishAttemptCount: 2 }], "Step 4.1");

    await scratchAdmin.client.query(`UPDATE "public"."Event" SET "queuedAt" = now() - interval '1 hour' WHERE "id" = $1`, [validated]);
    await worker.client.query("BEGIN");
    try {
      const repair = await worker.client.query(
        `UPDATE "public"."Event" SET "redispatchRequestedAt" = now(), "redispatchCount" = "redispatchCount" + 1
          WHERE "id" = $1 AND "status" = 'QUEUED' AND "dispatchAnomalyAt" IS NULL AND "publishAckedAt" IS NOT NULL
            AND "queuedAt" < now() - interval '300 seconds'
            AND ("redispatchRequestedAt" IS NULL OR "redispatchRequestedAt" < now() - interval '300 seconds') AND "redispatchCount" < 3`,
        [validated],
      );
      assert.equal(repair.rowCount, 1, "repair request");
      await worker.client.query(DISPATCH_AUDIT_INSERT_SQL, [
        randomUUIDv7(),
        "SYSTEM",
        "irs-dispatcher",
        "EVENT_REDISPATCH_REQUESTED",
        validated,
        JSON.stringify({ schema: 1, classification: "CONFIRMED_MISSING", redispatchCount: 1, thresholds: { T: 300, B: 3 } }),
      ]);
      await worker.client.query("COMMIT");
    } catch (error) {
      await worker.client.query("ROLLBACK");
      throw error;
    }

    const anomaly = await row("QUEUED");
    assert.equal(await outcome(worker.client, `UPDATE "public"."Event" SET ${SET_MARKER} WHERE "id" = $1 AND "dispatchAnomalyAt" IS NULL`, [anomaly]), "ok", "anomaly");

    const backlog = await worker.client.query<{ validated: number; queued: number; anomalies: number }>(
      `SELECT count(*) FILTER (WHERE "status" = 'VALIDATED')::int AS validated,
              count(*) FILTER (WHERE "status" = 'QUEUED')::int AS queued,
              count(*) FILTER (WHERE "dispatchAnomalyAt" IS NOT NULL)::int AS anomalies,
              max("publishAttemptCount")::int AS max_attempts, max("redispatchCount")::int AS max_repairs,
              min("receivedAt")::text AS oldest
         FROM "public"."Event" WHERE "id" = ANY($1::uuid[])`,
      [[validated, unacked, anomaly]],
    );
    assert.deepEqual(
      { validated: backlog.rows[0]?.validated, queued: backlog.rows[0]?.queued, anomalies: backlog.rows[0]?.anomalies },
      { validated: 0, queued: 3, anomalies: 1 },
      "backlog read",
    );
    const audit = await scratchAdmin.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "public"."AuditEntry" WHERE "entityId" = $1 AND "action" = 'EVENT_REDISPATCH_REQUESTED'`,
      [validated],
    );
    assert.equal(audit.rows[0]?.n, 1, "the B2-11 insert, read back by admin");
  });
});
