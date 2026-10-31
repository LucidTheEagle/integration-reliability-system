import type { TransactionClient } from "./client.js";

// Task 012B (B2-11, PL-7; FD-5): the dispatcher's AuditEntry insert. Plain
// SQL on the caller's transaction, with no RETURNING and no ON CONFLICT, so
// the worker role needs INSERT on "AuditEntry" and nothing else. Both audit
// rows are exactly-once by construction: the caller writes one only in the
// transaction whose state change justifies it (B1-7, ADD §3.3a item 2).
// `createdAt` is the transaction's database clock as UTC wall-clock time,
// independent of the session TimeZone (E3). The callers are 012B-3/012B-4's.

/** The two dispatcher audit actions (DR5 §5, ADD §3.3a item 2). */
export type DispatchAuditAction = "EVENT_REDISPATCH_REQUESTED" | "EVENT_DISPATCH_ANOMALY";

/** A JSON value with no free text from Redis: classifications, states, counts, timestamps, fingerprints. */
export type DispatchAuditJson =
  | string
  | number
  | boolean
  | null
  | readonly DispatchAuditJson[]
  | { readonly [key: string]: DispatchAuditJson };

/** B2-11's versioned metadata. */
export type DispatchAuditMetadata = { readonly schema: 1 } & { readonly [key: string]: DispatchAuditJson };

export interface DispatchAuditEntryInput {
  /** A UUIDv7 from the worker's generator (Gate A); anything else is refused before the statement. */
  readonly id: string;
  readonly action: DispatchAuditAction;
  /** The Event's id, stored as `entityId` with `entityType` 'EVENT'. */
  readonly eventId: string;
  readonly metadata: DispatchAuditMetadata;
}

/** E3: no system-actor convention exists, so B2-11's stated alternative applies. */
export const DISPATCH_AUDIT_ACTOR_TYPE = "SYSTEM";
export const DISPATCH_AUDIT_ACTOR_ID = "irs-dispatcher";

/** The exact statement (B2-11; casts in 011A's style). */
export const DISPATCH_AUDIT_INSERT_SQL =
  `INSERT INTO "public"."AuditEntry" ("id", "actorType", "actorId", "action", "entityType", "entityId", "metadata", "createdAt")\n` +
  `VALUES ($1::uuid, $2::text, $3::text, $4::text, 'EVENT', $5::text, $6::jsonb, (now() AT TIME ZONE 'UTC'))`;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIONS: readonly string[] = ["EVENT_REDISPATCH_REQUESTED", "EVENT_DISPATCH_ANOMALY"];

export type DispatchAuditRefusalCode =
  | "DISPATCH_AUDIT_ID_NOT_V7"
  | "DISPATCH_AUDIT_ACTION"
  | "DISPATCH_AUDIT_EVENT_ID"
  | "DISPATCH_AUDIT_METADATA"
  | "DISPATCH_AUDIT_ROW_COUNT";

/** A refused or anomalous audit insert, classified by code; it never carries a value. */
export class DispatchAuditError extends Error {
  override readonly name = "DispatchAuditError";
  constructor(readonly code: DispatchAuditRefusalCode) {
    super(`dispatch audit insert refused (${code})`);
  }
}

/** Inserts one dispatcher AuditEntry row on the caller's transaction. Returns nothing (no RETURNING). */
export async function insertDispatchAuditEntry(tx: TransactionClient, entry: DispatchAuditEntryInput): Promise<void> {
  if (!UUID_V7.test(entry.id)) throw new DispatchAuditError("DISPATCH_AUDIT_ID_NOT_V7");
  if (!ACTIONS.includes(entry.action)) throw new DispatchAuditError("DISPATCH_AUDIT_ACTION");
  if (!UUID.test(entry.eventId)) throw new DispatchAuditError("DISPATCH_AUDIT_EVENT_ID");
  if (entry.metadata === null || typeof entry.metadata !== "object" || entry.metadata.schema !== 1) {
    throw new DispatchAuditError("DISPATCH_AUDIT_METADATA");
  }
  const inserted = await tx.$executeRawUnsafe(
    DISPATCH_AUDIT_INSERT_SQL,
    entry.id,
    DISPATCH_AUDIT_ACTOR_TYPE,
    DISPATCH_AUDIT_ACTOR_ID,
    entry.action,
    entry.eventId,
    JSON.stringify(entry.metadata),
  );
  if (inserted !== 1) throw new DispatchAuditError("DISPATCH_AUDIT_ROW_COUNT");
}
