// Test-database registry (Prompt B §4.1–§4.2). Everything the guard accepts
// is named here; anything not named is refused.

export const TEST_HOST = "127.0.0.1";
export const TEST_PORT = 55433;

export const MAIN_DATABASE = "irs_011_test";
export const SHADOW_DATABASE = "irs_011_shadow_test";

export const SENTINEL_SCHEMA = "irs_test_meta";
export const SENTINEL_TABLE = "sentinel";
/** Fixed marker stored with each database's name in its sentinel row. */
export const SENTINEL_MARKER = "ca049134-a7d6-4dd2-b915-ceef1b2266e3";

export const ADMIN_ROLE = "postgres";
export const API_ROLE = "irs_test_api";
/** NOLOGIN owner of the VPF-3a function; no mode connects as it. */
export const LOCK_OWNER_ROLE = "irs_test_status_lock_owner";

export const STATUS_FUNCTION = "irs_integration_config_status_for_share";

export interface SpecialRole {
  readonly name: string;
  readonly purpose: string;
  /** Whether the role holds the sentinel privileges in `irs_011_test`. */
  readonly sentinelPrivileges: boolean;
}

/** Registered special roles (FA-4: all registered before bootstrap-main). */
export const SPECIAL_ROLES: readonly SpecialRole[] = [
  {
    name: "irs_test_api_no_ledger",
    purpose: "VPF-3b: without the ledger grant, readiness fails closed with LEDGER_MISSING",
    sentinelPrivileges: true,
  },
  {
    name: "irs_test_api_no_execute",
    purpose: "VPF-6 S3 extension: without EXECUTE on the status function, readiness fails closed",
    sentinelPrivileges: true,
  },
  {
    name: "irs_test_api_role_setting",
    purpose: "the only role given ALTER ROLE ... SET in tests (RD-T8b/c, AL-T7e, AL-T10e)",
    sentinelPrivileges: true,
  },
  {
    name: "irs_test_no_sentinel",
    purpose: "negative only: the guard must refuse a role without the sentinel privileges",
    sentinelPrivileges: false,
  },
];

/** Roles created by bootstrap-main, in creation order. */
export const BOOTSTRAP_ROLES: readonly { readonly name: string; readonly login: boolean }[] = [
  { name: API_ROLE, login: true },
  { name: LOCK_OWNER_ROLE, login: false },
  ...SPECIAL_ROLES.map((role) => ({ name: role.name, login: true })),
];

/** Roles holding USAGE on irs_test_meta and SELECT on its sentinel in irs_011_test. */
export const MAIN_SENTINEL_ROLES: readonly string[] = [
  API_ROLE,
  ...SPECIAL_ROLES.filter((role) => role.sentinelPrivileges).map((role) => role.name),
];

export interface ScratchPurpose {
  readonly purpose: string;
  readonly description: string;
  /** Roles given the sentinel privileges in this scratch database. */
  readonly sentinelRoles: readonly string[];
}

export const SCRATCH_PURPOSES: readonly ScratchPurpose[] = [
  {
    purpose: "migt1",
    description: "MIG-T1: migrate deploy into an empty database, then catalog checks",
    sentinelRoles: [],
  },
];

export function scratchDatabaseName(purpose: string): string {
  return `irs_011_scratch_${purpose}_test`;
}

export function scratchPurposeOf(database: string): ScratchPurpose | undefined {
  return SCRATCH_PURPOSES.find((entry) => scratchDatabaseName(entry.purpose) === database);
}

// Application grants applied by provisioning (FD-2: the minimum Task 011
// needs). Each entry is one privilege, in the form the grant check reads
// back from the catalogs.
export type GrantSpec =
  | { readonly kind: "SCHEMA"; readonly schema: string; readonly privilege: "USAGE" }
  | { readonly kind: "TABLE"; readonly table: string; readonly privilege: "INSERT" | "SELECT" }
  | {
      readonly kind: "COLUMN";
      readonly table: string;
      readonly column: string;
      readonly privilege: "SELECT" | "UPDATE";
    }
  | { readonly kind: "FUNCTION"; readonly fn: string; readonly privilege: "EXECUTE" };

const LEDGER_COLUMNS = ["migration_name", "finished_at", "rolled_back_at"] as const;
const EVENT_SELECT_COLUMNS = ["id", "integrationId", "externalEventId", "rawBodySha256"] as const;

const INGESTION_GRANTS: readonly GrantSpec[] = [
  // §7.3 insert (createManyAndReturn).
  { kind: "TABLE", table: "Event", privilege: "INSERT" },
  // §7.3 RETURNING "id" and the step 2b confirming SELECT.
  ...EVENT_SELECT_COLUMNS.map(
    (column): GrantSpec => ({ kind: "COLUMN", table: "Event", column, privilege: "SELECT" }),
  ),
  // §7.2 EVENT_RECEIVED row, inserted without RETURNING.
  { kind: "TABLE", table: "AuditEntry", privilege: "INSERT" },
];
const EXECUTE_GRANT: GrantSpec = { kind: "FUNCTION", fn: STATUS_FUNCTION, privilege: "EXECUTE" };
// VPF-3b: column-level only.
const LEDGER_GRANTS: readonly GrantSpec[] = LEDGER_COLUMNS.map(
  (column): GrantSpec => ({ kind: "COLUMN", table: "_prisma_migrations", column, privilege: "SELECT" }),
);

export const APPLICATION_GRANTS: Readonly<Record<string, readonly GrantSpec[]>> = {
  [API_ROLE]: [...INGESTION_GRANTS, EXECUTE_GRANT, ...LEDGER_GRANTS],
  irs_test_api_no_ledger: [...INGESTION_GRANTS, EXECUTE_GRANT],
  irs_test_api_no_execute: [...INGESTION_GRANTS, ...LEDGER_GRANTS],
  irs_test_api_role_setting: [...INGESTION_GRANTS, EXECUTE_GRANT, ...LEDGER_GRANTS],
  irs_test_no_sentinel: [],
  // Addendum VPF-3a.2: exactly what the function body needs.
  [LOCK_OWNER_ROLE]: [
    { kind: "SCHEMA", schema: "public", privilege: "USAGE" },
    { kind: "COLUMN", table: "Integration", column: "id", privilege: "SELECT" },
    { kind: "COLUMN", table: "Integration", column: "configStatus", privilege: "SELECT" },
    { kind: "COLUMN", table: "Integration", column: "updatedAt", privilege: "UPDATE" },
  ],
};

/** The catalog form of a grant, e.g. `COLUMN public.Event.id SELECT`. */
export function grantKey(grant: GrantSpec): string {
  switch (grant.kind) {
    case "SCHEMA":
      return `SCHEMA ${grant.schema} ${grant.privilege}`;
    case "TABLE":
      return `TABLE public.${grant.table} ${grant.privilege}`;
    case "COLUMN":
      return `COLUMN public.${grant.table}.${grant.column} ${grant.privilege}`;
    case "FUNCTION":
      return `FUNCTION public.${grant.fn} ${grant.privilege}`;
  }
}

/** The GRANT statement for one privilege. Identifiers are fixed registry values. */
export function grantStatement(grant: GrantSpec, role: string): string {
  switch (grant.kind) {
    case "SCHEMA":
      return `GRANT ${grant.privilege} ON SCHEMA "${grant.schema}" TO "${role}"`;
    case "TABLE":
      return `GRANT ${grant.privilege} ON TABLE "public"."${grant.table}" TO "${role}"`;
    case "COLUMN":
      return `GRANT ${grant.privilege} ("${grant.column}") ON TABLE "public"."${grant.table}" TO "${role}"`;
    case "FUNCTION":
      return `GRANT ${grant.privilege} ON FUNCTION "public"."${grant.fn}"(uuid) TO "${role}"`;
  }
}
