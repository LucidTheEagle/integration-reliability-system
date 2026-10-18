import { randomUUID } from "node:crypto";
import { createDatabase } from "../client.js";
import type { Database, PoolSettings } from "../client.js";
import type { EventIngestionInput } from "../event-ingestion.js";
import { connectGuarded } from "./guard.js";
import type { GuardMode } from "./guard.js";
import type { PgClient } from "./pg.js";

// Production Database instances for tests (path P3). The guard checks the
// target in full (structure, then post-connect checks including the
// sentinel) before createDatabase receives the URL; the pool then reaches
// that same validated target, as Prisma CLI children do under P4.

export async function guardedDatabase(options: {
  readonly url: string;
  readonly mode: GuardMode;
  readonly special?: string;
  readonly pool?: Partial<PoolSettings>;
  readonly monotonicNow?: () => number;
}): Promise<Database> {
  const check = await connectGuarded({
    url: options.url,
    mode: options.mode,
    special: options.special,
    applicationName: "irs-test-guard-check",
  });
  await check.close();
  return createDatabase({
    connectionString: options.url,
    pool: options.pool,
    monotonicNow: options.monotonicNow,
  });
}

export type ConfigStatus = "DRAFT" | "ACTIVE" | "DISABLED" | "DECOMMISSIONED";

/** Admin mode: test-data seeding. */
export async function seedIntegration(admin: PgClient, configStatus: ConfigStatus = "ACTIVE"): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO "public"."Integration" ("id", "name", "provider", "type", "configStatus", "environment", "updatedAt")
     VALUES ($1, 'test seed', 'test', 'test', $2, 'test', now())`,
    [id, configStatus],
  );
  return id;
}

/** Admin mode: removes the rows written for the given integrations (seeding's inverse). */
export async function removeIntegrations(admin: PgClient, integrationIds: readonly string[]): Promise<void> {
  if (integrationIds.length === 0) return;
  await admin.query(`DELETE FROM "public"."AuditEntry" WHERE "metadata"->>'integrationId' = ANY($1::text[])`, [integrationIds]);
  await admin.query(`DELETE FROM "public"."Event" WHERE "integrationId" = ANY($1::uuid[])`, [integrationIds]);
  await admin.query(`DELETE FROM "public"."Integration" WHERE "id" = ANY($1::uuid[])`, [integrationIds]);
}

/** A synthetic verified delivery whose raw bytes are the given JSON text. */
export function ingestionInput(
  integrationId: string,
  externalEventId: string,
  options: { readonly rawText?: string; readonly payload?: Record<string, unknown>; readonly requestId?: string } = {},
): EventIngestionInput {
  const payload = options.payload ?? { amount: 1, note: "synthetic" };
  const rawText =
    options.rawText ??
    JSON.stringify({
      externalEventId,
      eventType: "order.created",
      resourceType: "order",
      resourceId: "ord_1",
      occurredAt: "2026-10-17T00:00:00.000Z",
      schemaVersion: "1",
      payload,
    });
  return {
    requestId: options.requestId ?? randomUUID(),
    integrationId,
    externalEventId,
    eventType: "order.created",
    resourceType: "order",
    resourceId: "ord_1",
    occurredAt: new Date("2026-10-17T00:00:00.000Z"),
    schemaVersion: "1",
    correlationId: null,
    payload,
    rawBody: new TextEncoder().encode(rawText),
    receivedAt: new Date(),
    contentType: "application/json",
  };
}

/** Admin mode: counts rows for one integration (observation). */
export async function countRows(admin: PgClient, integrationId: string): Promise<{ events: number; audits: number }> {
  const result = await admin.query<{ events: number; audits: number }>(
    `SELECT (SELECT count(*)::int FROM "public"."Event" WHERE "integrationId" = $1) AS events,
            (SELECT count(*)::int FROM "public"."AuditEntry" WHERE "metadata"->>'integrationId' = $1::text) AS audits`,
    [integrationId],
  );
  return result.rows[0] ?? { events: Number.NaN, audits: Number.NaN };
}

/** A latch for pausing work inside a transaction. */
export function latch(): { readonly wait: Promise<void>; release(): void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
