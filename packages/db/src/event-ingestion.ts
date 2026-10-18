import { createHash } from "node:crypto";
import { DEFAULT_TRANSACTION_OPTIONS } from "./client.js";
import type { Database, TransactionClient } from "./client.js";
import { IngestionCommitUnknownError, IngestionInvariantError } from "./errors.js";
import type { Prisma } from "./generated/prisma/client.js";

// Durable event ingestion (Rev 1.7 §6.2, §7; Addendum VPF-3a). One READ
// COMMITTED transaction: the status check through the SECURITY DEFINER
// function first, then INSERT … ON CONFLICT DO NOTHING RETURNING, a
// confirming SELECT when no row came back, and one EVENT_RECEIVED audit row.

/** Plain input; apps/api maps its IngestionRequest to this (§8.1). */
export interface EventIngestionInput {
  /** Server-generated request ID; becomes the AuditEntry id. */
  readonly requestId: string;
  readonly integrationId: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly occurredAt: Date;
  readonly schemaVersion: string;
  readonly correlationId: string | null;
  /** The parsed, verified envelope payload (a JSON object). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The exact received bytes; authoritative over `payload`. */
  readonly rawBody: Uint8Array;
  readonly receivedAt: Date;
  readonly contentType: string;
}

export type IneligibleConfigStatus = "DRAFT" | "DISABLED" | "DECOMMISSIONED" | "NOT_REGISTERED";

export type EventIngestionResult =
  | { readonly disposition: "NEW"; readonly eventId: string }
  | { readonly disposition: "DUPLICATE"; readonly eventId: string; readonly contentMatches: boolean | null }
  | { readonly disposition: "INTEGRATION_INELIGIBLE"; readonly configStatus: IneligibleConfigStatus };

/** Lowercase hex SHA-256 of the bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @internal — the §7.2 Event mapping, exported for unit tests. */
export function toEventRow(input: EventIngestionInput, rawBodySha256: string) {
  return {
    integrationId: input.integrationId,
    externalEventId: input.externalEventId,
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    payload: input.payload as Prisma.InputJsonObject,
    metadata: {
      schemaVersion: 1,
      requestId: input.requestId,
      contentType: input.contentType,
      bodyByteLength: input.rawBody.byteLength,
    },
    occurredAt: input.occurredAt,
    receivedAt: input.receivedAt,
    status: "VALIDATED" as const,
    schemaVersion: input.schemaVersion,
    correlationId: input.correlationId,
    rawBody: new Uint8Array(input.rawBody),
    rawBodySha256,
  };
}

/** @internal — the §7.2 AuditEntry mapping (TD-5), exported for unit tests. */
export function toAuditRow(
  input: EventIngestionInput,
  eventId: string,
  disposition: "NEW" | "DUPLICATE",
  contentMatches: boolean | null,
  rawBodySha256: string,
) {
  return {
    id: input.requestId,
    actorType: "EXTERNAL_SENDER",
    actorId: null,
    action: "EVENT_RECEIVED",
    entityType: "EVENT",
    entityId: eventId,
    metadata: {
      schemaVersion: 1,
      integrationId: input.integrationId,
      disposition,
      contentMatches,
      bodyByteLength: input.rawBody.byteLength,
      rawBodySha256,
    },
    createdAt: input.receivedAt,
  };
}

/** @internal — test seams (DB-T18 pauses inside the transaction). Not part of the package API. */
export interface IngestionHooks {
  readonly afterStatusCheck?: (tx: TransactionClient) => Promise<void>;
}

const INELIGIBLE = new Set<string>(["DRAFT", "DISABLED", "DECOMMISSIONED"]);

/**
 * Ingests one verified event. Returns NEW or DUPLICATE only after the commit
 * was acknowledged. Throws IngestionCommitUnknownError when the transaction
 * fails after its callback completed, IngestionInvariantError for a broken
 * invariant, or the underlying error (classify it with classifyDatabaseError).
 */
export async function ingestEvent(
  db: Database,
  input: EventIngestionInput,
  hooks: IngestionHooks = {},
): Promise<EventIngestionResult> {
  const rawBodySha256 = sha256Hex(input.rawBody);
  let callbackCompleted = false;
  try {
    return await db.prisma.$transaction(async (tx): Promise<EventIngestionResult> => {
      // 0. Status check: the first statement, schema-qualified, through the
      //    function, which takes FOR SHARE on the row until the transaction ends.
      const status = await tx.$queryRaw<{ configStatus: string | null }[]>`SELECT "public"."irs_integration_config_status_for_share"(${input.integrationId}) AS "configStatus"`;
      await hooks.afterStatusCheck?.(tx);
      const configStatus = status[0]?.configStatus ?? null;
      let result: EventIngestionResult;
      if (configStatus === null) {
        result = { disposition: "INTEGRATION_INELIGIBLE", configStatus: "NOT_REGISTERED" };
      } else if (INELIGIBLE.has(configStatus)) {
        result = { disposition: "INTEGRATION_INELIGIBLE", configStatus: configStatus as IneligibleConfigStatus };
      } else if (configStatus !== "ACTIVE") {
        throw new IngestionInvariantError("the status check returned an unknown configStatus");
      } else {
        // 1. INSERT … ON CONFLICT DO NOTHING RETURNING "id" (§7.3).
        const inserted = await tx.event.createManyAndReturn({
          data: [toEventRow(input, rawBodySha256)],
          skipDuplicates: true,
          select: { id: true },
        });
        if (inserted.length === 1 && inserted[0] !== undefined) {
          // 2a. NEW.
          await tx.auditEntry.createMany({ data: [toAuditRow(input, inserted[0].id, "NEW", null, rawBodySha256)] });
          result = { disposition: "NEW", eventId: inserted[0].id };
        } else if (inserted.length === 0) {
          // 2b. Confirming SELECT: a duplicate is proven only by finding the row.
          const existing = await tx.event.findUnique({
            where: {
              integrationId_externalEventId: {
                integrationId: input.integrationId,
                externalEventId: input.externalEventId,
              },
            },
            select: { id: true, rawBodySha256: true },
          });
          if (existing === null) {
            throw new IngestionInvariantError("the insert returned no row and no existing row was found");
          }
          const contentMatches = existing.rawBodySha256 === rawBodySha256;
          await tx.auditEntry.createMany({
            data: [toAuditRow(input, existing.id, "DUPLICATE", contentMatches, rawBodySha256)],
          });
          result = { disposition: "DUPLICATE", eventId: existing.id, contentMatches };
        } else {
          throw new IngestionInvariantError("the insert returned more than one row");
        }
      }
      callbackCompleted = true;
      return result;
    }, DEFAULT_TRANSACTION_OPTIONS);
  } catch (error) {
    if (callbackCompleted) throw new IngestionCommitUnknownError(error);
    throw error;
  }
}
