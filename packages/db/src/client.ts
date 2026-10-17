import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import type { Prisma } from "./generated/prisma/client.js";

export type { PrismaClient };
export type TransactionClient = Prisma.TransactionClient;
export type TransactionIsolationLevel = Prisma.TransactionIsolationLevel;

/**
 * Connection-pool and session settings. Code constants only (F-7, VPF-5):
 * there is no environment override. There is deliberately no client-side
 * query timeout (VPF-5: PB-1 failed, `query_timeout` is not adopted).
 */
export interface PoolSettings {
  /** Per pool, i.e. per API process; not a global limit across processes. */
  readonly maxConnections: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  /** Server-side `statement_timeout`. */
  readonly statementTimeoutMs: number;
  /** Server-side `idle_in_transaction_session_timeout`. */
  readonly idleInTransactionTimeoutMs: number;
  /** TCP keepalive: reclaims dead or half-open peers. It is not a deadline. */
  readonly keepAlive: true;
  readonly keepAliveInitialDelayMs: number;
  /**
   * Every physical session starts with `transaction_timeout = 0`, set as a
   * connection-start option (VP-011 V1 primary mechanism).
   */
  readonly sessionTransactionTimeoutZero: true;
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = Object.freeze({
  maxConnections: 10,
  connectTimeoutMs: 2_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMs: 10_000,
  sessionTransactionTimeoutZero: true,
});

/** Options for ingestion transactions (lock-scoped transactions use their own deadline). */
export const DEFAULT_TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: "ReadCommitted",
  maxWait: 2_000,
  timeout: 5_000,
} as const);

/** The `pg` pool configuration handed to `@prisma/adapter-pg` unchanged. */
export interface PgPoolConfig {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly statement_timeout: number;
  readonly idle_in_transaction_session_timeout: number;
  readonly keepAlive: boolean;
  readonly keepAliveInitialDelayMillis: number;
  readonly options: string;
}

/** @internal — exported for the settings tests; not part of the package API. */
export function toPgPoolConfig(connectionString: string, settings: PoolSettings): PgPoolConfig {
  return {
    connectionString,
    max: settings.maxConnections,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    idleTimeoutMillis: settings.idleTimeoutMs,
    statement_timeout: settings.statementTimeoutMs,
    idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
    keepAlive: settings.keepAlive,
    keepAliveInitialDelayMillis: settings.keepAliveInitialDelayMs,
    options: "-c transaction_timeout=0",
  };
}

export interface Database {
  /** The generated client, for repositories in `@irs/db` and Task 011A's store. */
  readonly prisma: PrismaClient;
  /** `SELECT 1`. */
  ping(): Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly connectionString: string;
  readonly pool?: Partial<PoolSettings>;
}

/** Builds the client and its pool. Performs no I/O: the pool connects lazily. */
export function createDatabase(options: CreateDatabaseOptions): Database {
  const settings: PoolSettings = { ...DEFAULT_POOL_SETTINGS, ...options.pool };
  const adapter = new PrismaPg({ ...toPgPoolConfig(options.connectionString, settings) });
  const prisma = new PrismaClient({ adapter });
  return {
    prisma,
    async ping(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`;
    },
  };
}
