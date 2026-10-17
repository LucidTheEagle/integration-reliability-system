/**
 * @irs/db
 *
 * Database client initialization, transactions,
 * persistence utilities, and database-facing abstractions.
 *
 * Only this package imports the generated Prisma client
 * (`./generated/prisma`); callers use the types re-exported here.
 */

export {
  DEFAULT_POOL_SETTINGS,
  DEFAULT_TRANSACTION_OPTIONS,
  createDatabase,
} from "./client.js";
export type {
  CreateDatabaseOptions,
  Database,
  PoolSettings,
  PrismaClient,
  TransactionClient,
  TransactionIsolationLevel,
} from "./client.js";
