import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TransactionClient } from "./client.js";
import {
  DISPATCH_AUDIT_ACTOR_ID,
  DISPATCH_AUDIT_ACTOR_TYPE,
  DISPATCH_AUDIT_INSERT_SQL,
  DispatchAuditError,
  insertDispatchAuditEntry,
} from "./dispatch-audit.js";
import type { DispatchAuditEntryInput } from "./dispatch-audit.js";

// Task 012B (B2-11, PL-7): the dispatcher's audit insert, without a database.
// The statement text is pinned; a v4 (or any non-v7) id is refused before the
// statement is sent. The database half is dispatch-time.db.test.ts (PL-10).

const V7 = "01933b5c-7f2a-7c3d-9e4f-0123456789ab";
const V4 = "3b241101-e2bb-4255-8caf-4136c566a962";
const EVENT_ID = "01933b5c-7f2a-7000-8000-00000000e001";

function fakeTx(result = 1): { tx: TransactionClient; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const tx = {
    $executeRawUnsafe: async (...args: unknown[]) => {
      calls.push(args);
      return result;
    },
  } as unknown as TransactionClient;
  return { tx, calls };
}

function entry(overrides: Partial<DispatchAuditEntryInput> = {}): DispatchAuditEntryInput {
  return {
    id: V7,
    action: "EVENT_REDISPATCH_REQUESTED",
    eventId: EVENT_ID,
    metadata: { schema: 1, classification: "CONFIRMED_MISSING", redispatchCount: 1, thresholds: { T: 300, B: 3 } },
    ...overrides,
  };
}

function refused(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof DispatchAuditError, `expected DispatchAuditError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

describe("B2-11: the dispatcher's AuditEntry insert (unit)", () => {
  it("pins the statement: eight columns, 'EVENT', createdAt from the database clock as UTC, no RETURNING, no ON CONFLICT", () => {
    assert.equal(
      DISPATCH_AUDIT_INSERT_SQL,
      `INSERT INTO "public"."AuditEntry" ("id", "actorType", "actorId", "action", "entityType", "entityId", "metadata", "createdAt")\n` +
        `VALUES ($1::uuid, $2::text, $3::text, $4::text, 'EVENT', $5::text, $6::jsonb, (now() AT TIME ZONE 'UTC'))`,
    );
    assert.doesNotMatch(DISPATCH_AUDIT_INSERT_SQL, /RETURNING/i);
    assert.doesNotMatch(DISPATCH_AUDIT_INSERT_SQL, /ON CONFLICT/i);
    assert.equal(DISPATCH_AUDIT_ACTOR_TYPE, "SYSTEM");
    assert.equal(DISPATCH_AUDIT_ACTOR_ID, "irs-dispatcher");
  });

  it("sends exactly that statement once, on the caller's transaction, with the fixed actor and versioned metadata", async () => {
    const { tx, calls } = fakeTx();
    await insertDispatchAuditEntry(tx, entry());
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      DISPATCH_AUDIT_INSERT_SQL,
      V7,
      "SYSTEM",
      "irs-dispatcher",
      "EVENT_REDISPATCH_REQUESTED",
      EVENT_ID,
      JSON.stringify({ schema: 1, classification: "CONFIRMED_MISSING", redispatchCount: 1, thresholds: { T: 300, B: 3 } }),
    ]);
    const anomaly = fakeTx();
    await insertDispatchAuditEntry(anomaly.tx, entry({ action: "EVENT_DISPATCH_ANOMALY", metadata: { schema: 1, kind: "FAILED_WHILE_QUEUED" } }));
    assert.equal(anomaly.calls[0]?.[4], "EVENT_DISPATCH_ANOMALY");
  });

  it("a planted v4 id, and any other non-v7 id, is refused before the statement is sent", async () => {
    for (const id of [V4, V7.toUpperCase(), V7.replace("-7c3d-", "-6c3d-"), V7.replace("-9e4f-", "-7e4f-"), "", "not-a-uuid"]) {
      const { tx, calls } = fakeTx();
      await assert.rejects(insertDispatchAuditEntry(tx, entry({ id })), refused("DISPATCH_AUDIT_ID_NOT_V7"), id);
      assert.equal(calls.length, 0, `no statement for ${id}`);
    }
  });

  it("refuses an unknown action, a non-UUID event id and unversioned metadata, before the statement", async () => {
    const cases: [Partial<DispatchAuditEntryInput>, string][] = [
      [{ action: "EVENT_RECEIVED" as DispatchAuditEntryInput["action"] }, "DISPATCH_AUDIT_ACTION"],
      [{ eventId: "evt-1" }, "DISPATCH_AUDIT_EVENT_ID"],
      [{ metadata: { schema: 2 } as unknown as DispatchAuditEntryInput["metadata"] }, "DISPATCH_AUDIT_METADATA"],
      [{ metadata: null as unknown as DispatchAuditEntryInput["metadata"] }, "DISPATCH_AUDIT_METADATA"],
    ];
    for (const [overrides, code] of cases) {
      const { tx, calls } = fakeTx();
      await assert.rejects(insertDispatchAuditEntry(tx, entry(overrides)), refused(code), code);
      assert.equal(calls.length, 0);
    }
  });

  it("a row count other than 1 is reported by code, never silently accepted", async () => {
    const { tx } = fakeTx(0);
    await assert.rejects(insertDispatchAuditEntry(tx, entry()), refused("DISPATCH_AUDIT_ROW_COUNT"));
  });
});
