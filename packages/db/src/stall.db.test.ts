import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "./client.js";
import { disconnectWithin } from "./client.js";
import { IngestionCommitUnknownError, classifyDatabaseError } from "./errors.js";
import { ingestEvent } from "./event-ingestion.js";
import { assertServerBaseline } from "./test-support/baseline.js";
import { guardedDatabase, ingestionInput, removeIntegrations, seedIntegration } from "./test-support/database.js";
import { requireTestUrl, withUser } from "./test-support/guard.js";
import type { GuardedConnection } from "./test-support/guard.js";
import { STALL_ROLE, pinnedAdmin, revertCommitStall, stallCommits } from "./test-support/syncrep-stall.js";

// DB-T20 (Addendum VPF-5): the residual of a silently stalled COMMIT, under
// founder decision FD-6. Mechanism: a SERVER-SIDE WAIT. The server default is
// synchronous_commit = local with a non-existent synchronous standby, and only
// irs_test_api_role_setting has synchronous_commit = on, so only its COMMITs
// wait for a standby that never answers: the commit is durable locally, the
// socket stays alive, and no reply arrives. (PB-1 used network silence; the
// client sees the same behaviour, but the mechanisms differ.) Every other
// session commits locally, even if a revert were to fail. The stall's setup
// and revert (with the FD-14 / HC-6 race fix and 10 s watchdog) live in
// test-support/syncrep-stall.ts, shared with apps/api's DL-PG-2.

const apiUrl = requireTestUrl("IRS_TEST_DATABASE_URL");
const adminUrl = requireTestUrl("IRS_TEST_ADMIN_DATABASE_URL");
const ROLE = STALL_ROLE;

// Admin mode (synchronous_commit = local pinned for the session, FD-14):
// server-wide changes and their reversal, seeding, observation and backend termination.
let admin: GuardedConnection;
let integrationId = "";

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const started = performance.now();
  while (!(await condition())) {
    if (performance.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

before(async () => {
  admin = await pinnedAdmin(adminUrl, "irs-test-stall-admin");
  await assertServerBaseline(admin.client);
  integrationId = await seedIntegration(admin.client, "ACTIVE");
  await stallCommits(adminUrl, admin.client, "DB-T20");
});

after(async () => {
  try {
    await revertCommitStall(adminUrl, "DB-T20");
    await removeIntegrations(admin.client, [integrationId]);
  } finally {
    await admin.close();
  }
});

describe("DB-T20: silent COMMIT stall against the production pool (server-side wait; FD-6)", () => {
  it("the stall holds pool slots; exhaustion gives 503; shutdown stays bounded; termination gives UNKNOWN; the rows committed; a retry is DUPLICATE", async () => {
    const stalledDb: Database = await guardedDatabase({ url: withUser(apiUrl, ROLE), mode: "special", special: ROLE });
    const shown = (await stalledDb.prisma.$queryRaw<{ value: string }[]>`SELECT current_setting('synchronous_commit') AS value`)[0]?.value;
    assert.equal(shown, "on", "only this role waits for the standby");

    // Ten deliveries fill the production pool (max 10); each COMMIT waits forever.
    const keys = Array.from({ length: 10 }, (_, i) => `db-t20-${i}`);
    const stalled = keys.map((key) =>
      ingestEvent(stalledDb, ingestionInput(integrationId, key)).then(
        (result) => ({ settled: "resolved" as const, result }),
        (error: unknown) => ({ settled: "rejected" as const, error }),
      ),
    );
    const waitingPids = async () =>
      (
        await admin.client.query<{ pid: number }>(
          `SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND wait_event = 'SyncRep'`,
          [ROLE],
        )
      ).rows.map((row) => row.pid);
    await waitFor(async () => (await waitingPids()).length === 10, 15_000, "ten COMMITs waiting on SyncRep");
    const pids = await waitingPids();
    process.stdout.write(`[DB-T20] ten COMMITs waiting on SyncRep, pids ${JSON.stringify(pids)}\n`);

    // The stalled COMMITs hold their slots: the next request fails acquisition → TRANSIENT → 503.
    let started = performance.now();
    const next = await ingestEvent(stalledDb, ingestionInput(integrationId, "db-t20-next")).then(
      () => assert.fail("the 11th request must not succeed"),
      (error: unknown) => error,
    );
    const nextMs = performance.now() - started;
    process.stdout.write(`[DB-T20] 11th request after ${Math.round(nextMs)} ms: ${JSON.stringify(classifyDatabaseError(next))}\n`);
    assert.equal(classifyDatabaseError(next).failureClass, "TRANSIENT");
    assert.ok(nextMs >= 1_900 && nextMs < 2_600, `elapsed ${nextMs} ms (tolerance 1.9–2.6 s)`);

    // Shutdown stays bounded by disconnectWithin.
    started = performance.now();
    const disconnect = await disconnectWithin(stalledDb, 5_000);
    const disconnectMs = performance.now() - started;
    process.stdout.write(`[DB-T20] disconnectWithin: ${JSON.stringify(disconnect)} after ${Math.round(disconnectMs)} ms\n`);
    assert.deepEqual(disconnect, { completed: false, timedOut: true });
    assert.ok(disconnectMs >= 4_900 && disconnectMs < 6_000, `elapsed ${disconnectMs} ms (tolerance 4.9–6.0 s)`);

    // Still unsettled: nothing bounds the wait for a COMMIT reply (the residual).
    const unsettled = await Promise.race([
      Promise.all(stalled).then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
    ]);
    assert.equal(unsettled, true, "the stalled deliveries have not settled");

    // Ending the stall with pg_terminate_backend → UNKNOWN for each delivery.
    for (const pid of pids) await admin.client.query("SELECT pg_terminate_backend($1)", [pid]);
    const outcomes = await Promise.all(stalled);
    for (const outcome of outcomes) {
      assert.equal(outcome.settled, "rejected");
      const error = outcome.settled === "rejected" ? outcome.error : undefined;
      assert.ok(error instanceof IngestionCommitUnknownError, String(error));
      assert.equal(classifyDatabaseError(error).code, "COMMIT_UNKNOWN");
    }
    process.stdout.write(`[DB-T20] all ten deliveries settled as IngestionCommitUnknownError (UNKNOWN) after termination\n`);

    // Admin observation: the rows did commit (durable locally before the wait).
    const committed = (
      await admin.client.query<{ events: number; audits: number }>(
        `SELECT (SELECT count(*)::int FROM "public"."Event" WHERE "integrationId" = $1 AND "externalEventId" = ANY($2::text[])) AS events,
                (SELECT count(*)::int FROM "public"."AuditEntry" WHERE "metadata"->>'integrationId' = $1::text) AS audits`,
        [integrationId, keys],
      )
    ).rows[0];
    process.stdout.write(`[DB-T20] committed rows: ${JSON.stringify(committed)}\n`);
    assert.deepEqual(committed, { events: 10, audits: 10 });

    // A retry with the same idempotency key resolves as DUPLICATE (irs_test_api commits locally).
    const retryDb = await guardedDatabase({ url: apiUrl, mode: "api" });
    try {
      for (const key of keys) {
        const retry = await ingestEvent(retryDb, ingestionInput(integrationId, key));
        assert.equal(retry.disposition, "DUPLICATE", key);
      }
    } finally {
      await retryDb.prisma.$disconnect();
    }
    const after = (
      await admin.client.query<{ events: number }>(
        `SELECT count(*)::int AS events FROM "public"."Event" WHERE "integrationId" = $1`,
        [integrationId],
      )
    ).rows[0];
    assert.deepEqual(after, { events: 10 }, "no second row for any key");
  });
});
