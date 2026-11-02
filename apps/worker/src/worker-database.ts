import type { CreateDatabaseOptions } from "@irs/db";

// The worker's database composition (Task 012B-3; B2-2; F-TOPG; F-ADAPTER;
// R1). createDatabase is injected, so the options it receives are pinned by a
// test without widening @irs/db's public surface (F-TOPG). R1's UTC pin keeps
// every worker session's TimeZone at UTC: under a non-UTC session the pinned
// adapter reads timestamptz shifted (F-ADAPTER, dispatch-time.db's
// [R1 adapter] line).

/** The worker's pool: max 3 connections; every other setting stays at @irs/db's default (B2-2). */
export const WORKER_POOL = Object.freeze({ maxConnections: 3 });

export function openWorkerDatabase<D>(create: (options: CreateDatabaseOptions) => D, url: string): D {
  return create({ connectionString: url, pool: { ...WORKER_POOL }, sessionTimeZone: "UTC" });
}
