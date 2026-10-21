import type { Database, TransactionClient } from "./client.js";
import { canonicalJson, unlockedEvidenceTransaction } from "./rate-limit-evidence-store.js";
import type { EvidenceJson, EvidenceStoreHooks, EvidenceWriteResult } from "./rate-limit-evidence-store.js";

// Task 011A EVENT_REJECTED batch writes (addendum RD-2; design Revision 1.4
// §5.4, §6.1, §9.3). One unlocked READ COMMITTED transaction per batch
// (maxWait EVIDENCE_MAX_WAIT_MS): INSERT … ON CONFLICT ("id") DO NOTHING
// RETURNING "id" per row, then, for an id that already exists, a complete
// comparison of all 8 columns. A CONFLICT rolls nothing back and nothing
// is ever overwritten. Errors carry phase and outcome (B-1).

/** One EVENT_REJECTED AuditEntry row: all 8 columns as plain values. */
export interface RejectionAuditRow {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly metadata: EvidenceJson | null;
  /** ISO 8601 UTC, millisecond precision; never the column default. */
  readonly createdAt: string;
}

function canonicalRow(row: RejectionAuditRow): string {
  return canonicalJson({
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  });
}

interface RawRejectionRow extends Omit<RejectionAuditRow, "metadata"> {
  readonly metadata: string | null;
}

async function storedRow(tx: TransactionClient, id: string): Promise<RejectionAuditRow | undefined> {
  // "createdAt" is timestamp(3) without time zone holding UTC wall time; metadata is read as text.
  const rows = await tx.$queryRaw<RawRejectionRow[]>`SELECT "id"::text AS "id", "actorType", "actorId", "action",
      "entityType", "entityId", "metadata"::text AS "metadata",
      to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM "public"."AuditEntry" WHERE "id" = ${id}::uuid`;
  const row = rows[0];
  if (row === undefined) return undefined;
  return { ...row, metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as EvidenceJson) };
}

/** Per row, in order: CREATED, IDENTICAL_EXISTS or CONFLICT. */
export async function writeRejectionAuditRows(
  db: Database,
  rows: readonly RejectionAuditRow[],
  hooks: EvidenceStoreHooks = {},
): Promise<readonly EvidenceWriteResult[]> {
  return unlockedEvidenceTransaction(db, "writeRejectionAuditRows", hooks, async (tx) => {
    const results: EvidenceWriteResult[] = [];
    for (const row of rows) {
      const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "public"."AuditEntry"
          ("id", "actorType", "actorId", "action", "entityType", "entityId", "metadata", "createdAt")
        VALUES (${row.id}::uuid, ${row.actorType}::text, ${row.actorId}::text, ${row.action}::text,
          ${row.entityType}::text, ${row.entityId}::text,
          ${row.metadata === null ? null : JSON.stringify(row.metadata)}::jsonb,
          (${row.createdAt}::timestamptz AT TIME ZONE 'UTC'))
        ON CONFLICT ("id") DO NOTHING
        RETURNING "id"::text AS "id"`;
      if (inserted.length === 1) {
        results.push("CREATED");
        continue;
      }
      const existing = await storedRow(tx, row.id);
      results.push(existing !== undefined && canonicalRow(existing) === canonicalRow(row) ? "IDENTICAL_EXISTS" : "CONFLICT");
    }
    return results;
  });
}
