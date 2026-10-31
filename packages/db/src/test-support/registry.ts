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

/** Task 012B (B1-7, B1-8): the dispatcher's test role. LOGIN NOINHERIT, no password. */
export const WORKER_ROLE = "irs_test_worker";

/** Task 012B (FD-1): the worker role's connection limit (sessions authenticating as it, all databases). */
export const WORKER_CONNECTION_LIMIT = 16;

/**
 * Task 012B (Q2, PL-6.1): the attributes each registered role must have, checked
 * in both directions. Every role is also NOSUPERUSER NOCREATEDB NOCREATEROLE
 * NOREPLICATION NOBYPASSRLS, has no password and no expiry, is a member of no
 * role, and has no member. The six Task 011 roles' values are the observed
 * PostgreSQL defaults, made explicit.
 */
export interface RoleProfile {
  readonly login: boolean;
  readonly inherit: boolean;
  readonly connectionLimit: number;
}

/** Roles created by bootstrap-main, in creation order. */
export const BOOTSTRAP_ROLES: readonly { readonly name: string; readonly login: boolean }[] = [
  { name: API_ROLE, login: true },
  { name: LOCK_OWNER_ROLE, login: false },
  ...SPECIAL_ROLES.map((role) => ({ name: role.name, login: true })),
  { name: WORKER_ROLE, login: true },
];

/** The profile of every registered role (BOOTSTRAP_ROLES), by name. */
export const ROLE_PROFILES: Readonly<Record<string, RoleProfile>> = Object.freeze({
  [API_ROLE]: { login: true, inherit: true, connectionLimit: -1 },
  [LOCK_OWNER_ROLE]: { login: false, inherit: true, connectionLimit: -1 },
  ...Object.fromEntries(SPECIAL_ROLES.map((role) => [role.name, { login: true, inherit: true, connectionLimit: -1 }])),
  [WORKER_ROLE]: { login: true, inherit: false, connectionLimit: WORKER_CONNECTION_LIMIT },
});

/** The only roles the incremental bootstrap step (bootstrap-roles) may create. */
export const INCREMENTAL_ROLES: readonly string[] = [WORKER_ROLE];

/** Roles holding USAGE on irs_test_meta and SELECT on its sentinel in irs_011_test. */
export const MAIN_SENTINEL_ROLES: readonly string[] = [
  API_ROLE,
  ...SPECIAL_ROLES.filter((role) => role.sentinelPrivileges).map((role) => role.name),
  WORKER_ROLE,
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
  {
    purpose: "rdt1",
    description: "RD-T1: readiness on an empty database, then on tables without a ledger",
    sentinelRoles: [API_ROLE],
  },
  {
    purpose: "ledger",
    description: "RD-T2/T3/T5: readiness against manipulated migration-ledger rows",
    sentinelRoles: [API_ROLE],
  },
  {
    purpose: "rdt4",
    description: "RD-T4: readiness after a deliberately failing migration",
    sentinelRoles: [API_ROLE],
  },
  {
    purpose: "structure",
    description: "RD-T6: readiness against altered structures (S2–S5, the S3 function)",
    sentinelRoles: [API_ROLE],
  },
  {
    purpose: "s1",
    description: "RD-T6a–p: readiness against substitute idempotency indexes and collations",
    sentinelRoles: [API_ROLE],
  },
  {
    purpose: "decoy",
    description: "DB-T1/V2: ingestion with a decoy schema first on the search_path",
    sentinelRoles: [API_ROLE],
  },
  {
    purpose: "lock",
    description: "AL-T7e/AL-T9/AL-T11: a probe table for advisory-lock tests",
    sentinelRoles: [API_ROLE],
  },
  {
    purpose: "rle",
    description: "Task 011A RD-7: readiness against an altered RateLimitEvidence table, primary key and natural-key indexes",
    sentinelRoles: [API_ROLE],
  },
  // Task 012B (FD-6, PL-6.6): marked rows and dispatch audit rows never touch irs_011_test.
  {
    purpose: "dispatch",
    description: "Task 012B: the dispatch-marker trigger matrix T0-T5, the CHECK, Q1 and the worker's permitted and refused operations",
    sentinelRoles: [API_ROLE, WORKER_ROLE],
  },
  {
    purpose: "dispatchtime",
    description: "Task 012B: R1 (UTC-pinned worker sessions), the B1-1 backlog age and the B2-11 audit insert under a non-UTC session",
    sentinelRoles: [API_ROLE, WORKER_ROLE],
  },
  {
    purpose: "dispatchready",
    description: "Task 012B: readiness against altered dispatch objects (trigger modes, CHECK, index, function, column type)",
    sentinelRoles: [API_ROLE, WORKER_ROLE],
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

const AUDIT_ENTRY_COLUMNS = ["id", "actorType", "actorId", "action", "entityType", "entityId", "metadata", "createdAt"] as const;
const RATE_LIMIT_EVIDENCE_COLUMNS = [
  "id",
  "limiterInstanceId",
  "scope",
  "kind",
  "gapReason",
  "firstSequence",
  "lastSequence",
  "missingFrom",
  "missingTo",
  "payload",
  "recordSha256",
  "recordedAt",
] as const;

// Task 011A RD-6 (Addendum §2; P-3): the complete-row and complete-record
// comparisons read every column. INSERT on AuditEntry is already part of
// INGESTION_GRANTS. No UPDATE or DELETE. The API role only: the special roles
// keep exactly their Task 011 sets.
const EVIDENCE_GRANTS: readonly GrantSpec[] = [
  ...AUDIT_ENTRY_COLUMNS.map((column): GrantSpec => ({ kind: "COLUMN", table: "AuditEntry", column, privilege: "SELECT" })),
  { kind: "TABLE", table: "RateLimitEvidence", privilege: "INSERT" },
  ...RATE_LIMIT_EVIDENCE_COLUMNS.map(
    (column): GrantSpec => ({ kind: "COLUMN", table: "RateLimitEvidence", column, privilege: "SELECT" }),
  ),
];

/** Task 012B (B1-1, B1-2; ADD §3.3c): the nine dispatch columns of "Event". */
export const DISPATCH_COLUMNS = [
  "queuedAt",
  "lastPublishAttemptAt",
  "publishAttemptCount",
  "publishAckedAt",
  "lastPublishAckAt",
  "redispatchRequestedAt",
  "redispatchCount",
  "dispatchAnomalyAt",
  "dispatchAnomalyKind",
] as const;

/**
 * Task 012B (B1-7, PL-5; B2-11 freezes the AuditEntry grant): SELECT on "Event"
 * id, status, receivedAt and the nine dispatch columns; UPDATE on status and
 * the nine dispatch columns; INSERT only on "AuditEntry" (no RETURNING, no ON
 * CONFLICT); the three ledger columns for readiness. Nothing else: no payload,
 * rawBody, metadata, integration or external identifier, no DELETE, TRUNCATE,
 * EXECUTE or schema CREATE.
 */
const WORKER_GRANTS: readonly GrantSpec[] = [
  ...(["id", "status", "receivedAt", ...DISPATCH_COLUMNS] as const).map(
    (column): GrantSpec => ({ kind: "COLUMN", table: "Event", column, privilege: "SELECT" }),
  ),
  ...(["status", ...DISPATCH_COLUMNS] as const).map(
    (column): GrantSpec => ({ kind: "COLUMN", table: "Event", column, privilege: "UPDATE" }),
  ),
  { kind: "TABLE", table: "AuditEntry", privilege: "INSERT" },
  ...LEDGER_GRANTS,
];

export const APPLICATION_GRANTS: Readonly<Record<string, readonly GrantSpec[]>> = {
  [API_ROLE]: [...INGESTION_GRANTS, EXECUTE_GRANT, ...LEDGER_GRANTS, ...EVIDENCE_GRANTS],
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
  [WORKER_ROLE]: WORKER_GRANTS,
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
