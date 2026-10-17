import { createRequire } from "node:module";

// The `pg` that @prisma/adapter-pg brings (G4 record §2: no direct `pg`
// dependency). Only the members the test support uses are typed here.

export interface PgQueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface PgClientConfig {
  readonly connectionString: string;
  readonly connectionTimeoutMillis?: number;
  readonly application_name?: string;
}

interface PgModule {
  readonly Client: new (config: PgClientConfig) => PgClient;
}

const requireHere = createRequire(import.meta.url);
const requireFromAdapter = createRequire(requireHere.resolve("@prisma/adapter-pg"));

export const pg = requireFromAdapter("pg") as PgModule;

/** The SQLSTATE of a `pg` error, if it has one. */
export function sqlState(error: unknown): string | undefined {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}
