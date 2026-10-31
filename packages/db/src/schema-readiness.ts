import type { Database } from "./client.js";
import { classifyDatabaseError } from "./errors.js";
import { Prisma } from "./generated/prisma/client.js";

// Schema readiness (Rev 1.7 §8.5, amended by Addendum VPF-3b and VPF-6).
// Read-only and fail-closed. The ledger is read through the three columns
// the API role may select; every catalog assertion resolves tables through
// pg_namespace (never search_path) and reads pg_catalog only, because the
// API role's column-level grants hide columns from information_schema.

/** Case Q (VP-011 V2): the generated statements name "public" explicitly. */
export const EXPECTED_SCHEMA = "public";

/** Every migration this build requires; Task 011A and Task 012B append their own (RD-T7). */
export const REQUIRED_MIGRATIONS: readonly string[] = Object.freeze([
  "20261017101850_init",
  "20261021144921_rate_limit_evidence",
  "20261031145727_event_dispatch",
]);

/**
 * S1 – S5 (Task 011), the Task 011A RD-7 assertions for "RateLimitEvidence":
 * the table, its `id` primary key and its four natural-key partial unique
 * indexes, and (Task 012B, B1-6, Q3; additive) the dispatch objects of the
 * event_dispatch migration.
 */
export type StructureAssertion =
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "RLE.table"
  | "RLE.pk"
  | "RLE.lifecycle_uq"
  | "RLE.summary_range_uq"
  | "RLE.gap_discontinuity_uq"
  | "RLE.gap_unclean_uq"
  | "DISPATCH.columns"
  | "DISPATCH.enum"
  | "DISPATCH.index"
  | "DISPATCH.check"
  | "DISPATCH.function"
  | "DISPATCH.trigger"
  | "DISPATCH.trigger_enabled";
/** S6.a – S6.c (Task 011) and S6.d (Task 012B R1: the session TimeZone is UTC; worker profile only). */
export type SessionAssertion = "S6.a" | "S6.b" | "S6.c" | "S6.d";

/**
 * Task 012B (B1-6, FD-4): who runs readiness. `api` is every check except
 * S6.d; `worker` is identical except that it does not require EXECUTE on the
 * status function and does require S6.d.
 */
export type ReadinessProfile = "api" | "worker";

export type SchemaReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: "LEDGER_MISSING" | "MIGRATION_MISSING" | "MIGRATION_FAILED" | "UNKNOWN_MIGRATION" }
  | { readonly ready: false; readonly reason: "STRUCTURE_MISMATCH"; readonly assertion: StructureAssertion }
  | { readonly ready: false; readonly reason: "SESSION_INVARIANT"; readonly assertion: SessionAssertion };

export type ReadinessQueryId =
  | "S6.b"
  | "L1"
  | "L2"
  | "S1.index"
  | "S1.keys"
  | "S2"
  | "S3.enum"
  | "S3.function"
  | "S4"
  | "S5"
  | "S6.a"
  | "S6.c"
  | "RLE.table"
  | "RLE.pk"
  | "RLE.indexes"
  | "DISPATCH.columns"
  | "DISPATCH.enum"
  | "DISPATCH.index"
  | "DISPATCH.check"
  | "DISPATCH.function"
  | "DISPATCH.trigger"
  | "S6.d";

type Row = Record<string, unknown>;

type RateLimitEvidenceIndexAssertion = Extract<StructureAssertion, `RLE.${string}_uq`>;

/**
 * RD-7: the golden pg_get_indexdef() text of the four natural-key indexes
 * (A14 §7.4; Task 011A migration), captured once from PostgreSQL 17 after
 * the migration was applied and changed only by deliberate review. The text
 * encodes uniqueness, the key columns and the predicate. M2 pins the same text.
 */
export const RATE_LIMIT_EVIDENCE_INDEXES: Readonly<Record<RateLimitEvidenceIndexAssertion, string>> = Object.freeze({
  "RLE.lifecycle_uq":
    `CREATE UNIQUE INDEX rle_instance_lifecycle_uq ON public."RateLimitEvidence" USING btree ("limiterInstanceId", kind) WHERE (kind = ANY (ARRAY['INSTANCE_STARTED'::text, 'INSTANCE_CLOSED'::text]))`,
  "RLE.summary_range_uq":
    `CREATE UNIQUE INDEX rle_summary_range_uq ON public."RateLimitEvidence" USING btree ("limiterInstanceId", "firstSequence", "lastSequence") WHERE (kind = 'SUMMARY'::text)`,
  "RLE.gap_discontinuity_uq":
    `CREATE UNIQUE INDEX rle_gap_discontinuity_uq ON public."RateLimitEvidence" USING btree ("limiterInstanceId", "missingFrom", "missingTo") WHERE ((kind = 'EVIDENCE_GAP'::text) AND ("gapReason" = 'SEQUENCE_DISCONTINUITY'::text))`,
  "RLE.gap_unclean_uq":
    `CREATE UNIQUE INDEX rle_gap_unclean_uq ON public."RateLimitEvidence" USING btree ("limiterInstanceId") WHERE ((kind = 'EVIDENCE_GAP'::text) AND ("gapReason" = 'UNCLEAN_TERMINATION'::text))`,
});

/**
 * Task 012B (B1-6, PL-4): golden PostgreSQL 17.11 text of the dispatch
 * objects, captured once from the migrated irs_011_test (A6) and changed only
 * by deliberate review. M2 pins the same text. Each starts as a deliberately
 * non-matching placeholder until replaced from the capture (Part B5 decision 4).
 */
export const DISPATCH_INDEX_DEFINITION = "CREATE INDEX \"Event_status_receivedAt_idx\" ON public.\"Event\" USING btree (status, \"receivedAt\")";
export const DISPATCH_CHECK_DEFINITION = "CHECK (((\"dispatchAnomalyAt\" IS NULL) = (\"dispatchAnomalyKind\" IS NULL)))";
/** The trigger function's `prosrc`, exactly as created by the event_dispatch migration. */
export const DISPATCH_FUNCTION_BODY = "\nBEGIN\n  IF TG_OP = 'INSERT' THEN\n    IF NEW.\"dispatchAnomalyAt\" IS NOT NULL OR NEW.\"dispatchAnomalyKind\" IS NOT NULL THEN\n      RAISE EXCEPTION 'irs dispatch marker rule T0' USING ERRCODE = 'IRST0';\n    END IF;\n    RETURN NEW;\n  END IF;\n  IF OLD.\"dispatchAnomalyAt\" IS NOT NULL\n     AND (NEW.\"dispatchAnomalyAt\" IS DISTINCT FROM OLD.\"dispatchAnomalyAt\"\n          OR NEW.\"dispatchAnomalyKind\" IS DISTINCT FROM OLD.\"dispatchAnomalyKind\") THEN\n    RAISE EXCEPTION 'irs dispatch marker rule T2' USING ERRCODE = 'IRST2';\n  END IF;\n  IF OLD.\"dispatchAnomalyAt\" IS NULL AND NEW.\"dispatchAnomalyAt\" IS NOT NULL\n     AND NOT (OLD.\"status\" = 'QUEUED'::\"public\".\"EventState\"\n              AND NEW.\"status\" = 'QUEUED'::\"public\".\"EventState\"\n              AND NEW.\"dispatchAnomalyKind\" IS NOT NULL) THEN\n    RAISE EXCEPTION 'irs dispatch marker rule T1' USING ERRCODE = 'IRST1';\n  END IF;\n  IF NEW.\"status\" = 'PROCESSING'::\"public\".\"EventState\"\n     AND (OLD.\"dispatchAnomalyAt\" IS NOT NULL OR NEW.\"dispatchAnomalyAt\" IS NOT NULL) THEN\n    RAISE EXCEPTION 'irs dispatch marker rule T3' USING ERRCODE = 'IRST3';\n  END IF;\n  RETURN NEW;\nEND\n";
/** The trigger's `tgtype` (ROW, BEFORE, INSERT, UPDATE), as text. */
export const DISPATCH_TRIGGER_TYPE = "23";
const DISPATCH_FUNCTION_CONFIG = ["search_path=pg_catalog, pg_temp"];
const DISPATCH_INDEX = "Event_status_receivedAt_idx";
const DISPATCH_CHECK = "Event_dispatchAnomaly_consistency_check";
const DISPATCH_FUNCTION = "irs_event_dispatch_marker_guard";

/** The nine dispatch columns (B1-1, B1-2): format_type, NOT NULL, default expression. */
export const DISPATCH_COLUMNS: readonly { readonly column_name: string; readonly type: string; readonly notnull: boolean; readonly column_default: string | null }[] =
  Object.freeze([
    { column_name: "dispatchAnomalyAt", type: "timestamp(3) with time zone", notnull: false, column_default: null },
    { column_name: "dispatchAnomalyKind", type: `"DispatchAnomalyKind"`, notnull: false, column_default: null },
    { column_name: "lastPublishAckAt", type: "timestamp(3) with time zone", notnull: false, column_default: null },
    { column_name: "lastPublishAttemptAt", type: "timestamp(3) with time zone", notnull: false, column_default: null },
    { column_name: "publishAckedAt", type: "timestamp(3) with time zone", notnull: false, column_default: null },
    { column_name: "publishAttemptCount", type: "integer", notnull: true, column_default: "0" },
    { column_name: "queuedAt", type: "timestamp(3) with time zone", notnull: false, column_default: null },
    { column_name: "redispatchCount", type: "integer", notnull: true, column_default: "0" },
    { column_name: "redispatchRequestedAt", type: "timestamp(3) with time zone", notnull: false, column_default: null },
  ]);
const DISPATCH_ENUM_LABELS = ["COMPLETED_WHILE_QUEUED", "FAILED_WHILE_QUEUED"];

/** Rows per query; a query that failed (or did not run) is absent. */
export type ReadinessObservations = ReadonlyMap<ReadinessQueryId, readonly Row[]>;

/** The VPF-3a function body, exactly as created by the init migration. */
export const STATUS_FUNCTION_BODY =
  '\n  SELECT "configStatus" FROM "public"."Integration" WHERE "id" = p_integration_id FOR SHARE\n';
const STATUS_FUNCTION_CONFIG = ["search_path=pg_catalog, pg_temp"];

const ZERO_DURATION = /^0(?:us|ms|s|min|h|d)?$/;
const NONZERO_TRANSACTION_TIMEOUT = /^transaction_timeout=(?!0(?:us|ms|s|min|h|d)?$)/;

/** The queries run inside the readiness transaction, in evaluation order. $1 is the expected schema. */
const TRANSACTION_QUERIES: readonly { readonly id: ReadinessQueryId; readonly sql: string; readonly schema: boolean }[] = [
  {
    id: "L1",
    schema: true,
    sql: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = '_prisma_migrations' AND c.relkind = 'r') AS ledger_exists`,
  },
  {
    id: "L2",
    schema: false,
    // Only the three columns the API role holds SELECT on (VPF-3b).
    sql: `SELECT migration_name, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolled_back
          FROM "public"."_prisma_migrations"`,
  },
  {
    id: "S1.index",
    schema: true,
    sql: `SELECT ic.relname::text AS index_name, i.indisunique, i.indisvalid, i.indisready, i.indislive, i.indimmediate,
                 (i.indpred IS NULL) AS no_predicate, (i.indexprs IS NULL) AS no_expressions,
                 i.indnkeyatts::int AS nkeyatts, i.indnatts::int AS natts, i.indisexclusion, am.amname::text AS amname
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          JOIN pg_catalog.pg_am am ON am.oid = ic.relam
          WHERE n.nspname = $1 AND t.relname = 'Event'`,
  },
  {
    id: "S1.keys",
    schema: true,
    sql: `SELECT ic.relname::text AS index_name, k.ord::int AS ord, k.attnum::int AS attnum, a.attname::text AS attname,
                 a.attnotnull, (oc.opcintype = a.atttypid) AS opclass_type_matches, oc.opcdefault,
                 oam.amname::text AS opclass_method, (k.coll = a.attcollation) AS collation_matches,
                 (k.coll = 0) AS no_collation, ty.typname::text AS type_name,
                 coll.collprovider::text AS collprovider, coll.collisdeterministic,
                 (k.coll <> 0 AND coll.oid IS NULL) AS collation_row_missing
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          CROSS JOIN LATERAL unnest(i.indkey::int2[], i.indclass::oid[], i.indcollation::oid[])
               WITH ORDINALITY AS k(attnum, opclass, coll, ord)
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum AND NOT a.attisdropped
          LEFT JOIN pg_catalog.pg_opclass oc ON oc.oid = k.opclass
          LEFT JOIN pg_catalog.pg_am oam ON oam.oid = oc.opcmethod
          LEFT JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
          LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = k.coll
          WHERE n.nspname = $1 AND t.relname = 'Event' AND k.ord <= i.indnkeyatts`,
  },
  {
    id: "S2",
    schema: true,
    sql: `SELECT count(*)::int AS fk_count
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_class rt ON rt.oid = con.confrelid
          JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.relnamespace
          WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = 'Event' AND rn.nspname = $1 AND rt.relname = 'Integration'`,
  },
  {
    id: "S3.enum",
    schema: true,
    sql: `SELECT t.typname::text AS type_name, e.enumlabel::text AS label
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = $1 AND t.typname IN ('EventState', 'IntegrationConfigState')`,
  },
  {
    id: "S3.function",
    schema: true,
    // The VPF-6 S3 extension: the status function's signature, properties, body and EXECUTE for this role.
    sql: `SELECT p.pronargs::int AS nargs, (p.proargtypes[0] = 'pg_catalog.uuid'::regtype::oid) AS arg_is_uuid,
                 (p.prorettype = (SELECT rt.oid FROM pg_catalog.pg_type rt JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.typnamespace
                                   WHERE rn.nspname = $1 AND rt.typname = 'IntegrationConfigState')) AS returns_config_state,
                 p.proretset, p.prosecdef, p.provolatile::text AS provolatile, p.proconfig, p.prosrc, l.lanname::text AS lanname,
                 has_function_privilege(p.oid, 'EXECUTE') AS can_execute
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid = p.prolang
          WHERE n.nspname = $1 AND p.proname = 'irs_integration_config_status_for_share'`,
  },
  {
    id: "S4",
    schema: true,
    sql: `SELECT c.relname::text AS table_name, a.attname::text AS column_name,
                 tn.nspname::text AS type_schema, t.typname::text AS type_name
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
          JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
          WHERE n.nspname = $1 AND c.relname IN ('Event', 'AuditEntry', 'Integration') AND c.relkind = 'r'
            AND a.attnum > 0 AND NOT a.attisdropped`,
  },
  {
    id: "S5",
    schema: true,
    sql: `SELECT array_agg(a.attname::text ORDER BY a.attname) AS pk_columns
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'p' AND n.nspname = $1 AND t.relname = 'AuditEntry'`,
  },
  { id: "S6.a", schema: false, sql: "SELECT current_setting('server_version_num')::int AS server_version_num" },
  {
    id: "S6.c",
    schema: false,
    sql: `SELECT s.setconfig
          FROM pg_catalog.pg_db_role_setting s
          WHERE s.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
            AND s.setrole IN (0, (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))`,
  },
  // Task 011A RD-7: appended after every Task 011 query, so they cannot remove an earlier observation.
  {
    id: "RLE.table",
    schema: true,
    sql: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = 'RateLimitEvidence' AND c.relkind = 'r') AS table_exists`,
  },
  {
    id: "RLE.pk",
    schema: true,
    sql: `SELECT array_agg(a.attname::text ORDER BY a.attname) AS pk_columns
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'p' AND n.nspname = $1 AND t.relname = 'RateLimitEvidence'`,
  },
  {
    id: "RLE.indexes",
    schema: true,
    sql: `SELECT ic.relname::text AS index_name, pg_catalog.pg_get_indexdef(i.indexrelid) AS indexdef,
                 i.indisunique, i.indisvalid, i.indisready, i.indislive, i.indimmediate
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE n.nspname = $1 AND t.relname = 'RateLimitEvidence'`,
  },
  // Task 012B (B1-6, PL-4): appended after RLE (011A's precedent). Each reads
  // pg_catalog through pg_namespace; none casts an object that may be absent,
  // so an absent object gives no rows, never an aborted transaction.
  {
    id: "DISPATCH.columns",
    schema: true,
    sql: `SELECT a.attname::text AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                 a.attnotnull AS notnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS column_default
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relname = 'Event' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('queuedAt', 'lastPublishAttemptAt', 'publishAttemptCount', 'publishAckedAt', 'lastPublishAckAt',
                              'redispatchRequestedAt', 'redispatchCount', 'dispatchAnomalyAt', 'dispatchAnomalyKind')`,
  },
  {
    id: "DISPATCH.enum",
    schema: true,
    sql: `SELECT e.enumlabel::text AS label
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = $1 AND t.typname = 'DispatchAnomalyKind'
          ORDER BY e.enumsortorder`,
  },
  {
    id: "DISPATCH.index",
    schema: true,
    sql: `SELECT ic.relname::text AS index_name, pg_catalog.pg_get_indexdef(i.indexrelid) AS indexdef,
                 i.indisunique, i.indisvalid, i.indisready, i.indislive, i.indimmediate
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE n.nspname = $1 AND t.relname = 'Event' AND ic.relname = '${DISPATCH_INDEX}'`,
  },
  {
    id: "DISPATCH.check",
    schema: true,
    sql: `SELECT con.contype::text AS contype, pg_catalog.pg_get_constraintdef(con.oid) AS def, con.convalidated
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'Event' AND con.conname = '${DISPATCH_CHECK}'`,
  },
  {
    id: "DISPATCH.function",
    schema: true,
    sql: `SELECT p.oid::text AS oid, p.pronargs::int AS nargs,
                 (p.prorettype = (SELECT rt.oid FROM pg_catalog.pg_type rt JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.typnamespace
                                   WHERE rn.nspname = 'pg_catalog' AND rt.typname = 'trigger')) AS returns_trigger,
                 p.proretset, p.prosecdef, p.provolatile::text AS provolatile, p.proconfig, p.prosrc, l.lanname::text AS lanname
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid = p.prolang
          WHERE n.nspname = $1 AND p.proname = '${DISPATCH_FUNCTION}'`,
  },
  {
    id: "DISPATCH.trigger",
    schema: true,
    sql: `SELECT tg.tgfoid::text AS tgfoid, tg.tgtype::text AS tgtype, tg.tgenabled::text AS tgenabled, tg.tgisinternal,
                 tg.tgnargs::int AS nargs, (pg_catalog.cardinality(tg.tgattr::int2[]) = 0) AS no_columns,
                 (tg.tgqual IS NULL) AS no_when
          FROM pg_catalog.pg_trigger tg
          JOIN pg_catalog.pg_class t ON t.oid = tg.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'Event' AND tg.tgname = '${DISPATCH_FUNCTION}'`,
  },
  { id: "S6.d", schema: false, sql: "SELECT current_setting('TimeZone') AS tz" },
];

/** Columns Task 011 writes or reads, as table.column → schema.type (§7.2, TD-3, F-15). */
const EXPECTED_COLUMNS: readonly string[] = [
  "Event.id:pg_catalog.uuid",
  "Event.integrationId:pg_catalog.uuid",
  "Event.externalEventId:pg_catalog.text",
  "Event.eventType:pg_catalog.text",
  "Event.resourceType:pg_catalog.text",
  "Event.resourceId:pg_catalog.text",
  "Event.payload:pg_catalog.jsonb",
  "Event.metadata:pg_catalog.jsonb",
  "Event.occurredAt:pg_catalog.timestamp",
  "Event.receivedAt:pg_catalog.timestamp",
  "Event.status:public.EventState",
  "Event.schemaVersion:pg_catalog.text",
  "Event.correlationId:pg_catalog.text",
  "Event.rawBody:pg_catalog.bytea",
  "Event.rawBodySha256:pg_catalog.text",
  "AuditEntry.id:pg_catalog.uuid",
  "AuditEntry.actorType:pg_catalog.text",
  "AuditEntry.actorId:pg_catalog.text",
  "AuditEntry.action:pg_catalog.text",
  "AuditEntry.entityType:pg_catalog.text",
  "AuditEntry.entityId:pg_catalog.text",
  "AuditEntry.metadata:pg_catalog.jsonb",
  "AuditEntry.createdAt:pg_catalog.timestamp",
  "Integration.configStatus:public.IntegrationConfigState",
];

/** S1: at least one index on "Event" must satisfy S1.a – S1.m (§8.5). */
export function s1Holds(index: Row, keys: readonly Row[]): boolean {
  const keyRows = keys.filter((key) => key.index_name === index.index_name);
  const columns = new Set(keyRows.map((key) => key.attname));
  return (
    index.indisunique === true && // a
    index.indisvalid === true && // b
    index.indisready === true && // c
    index.indislive === true &&
    index.indimmediate === true && // d
    index.no_predicate === true && // e
    index.no_expressions === true && // f
    keyRows.every((key) => key.attnum !== 0) &&
    index.nkeyatts === 2 && // g
    index.natts === 2 &&
    keyRows.length === 2 && // h
    columns.size === 2 &&
    columns.has("integrationId") &&
    columns.has("externalEventId") &&
    keyRows.every((key) => key.attnotnull === true) && // i
    index.indisexclusion === false && // j
    index.amname === "btree" && // k
    keyRows.every(
      // l
      (key) => key.opclass_type_matches === true && key.opcdefault === true && key.opclass_method === "btree",
    ) &&
    keyRows.every((key) =>
      // m
      key.type_name === "uuid"
        ? key.no_collation === true
        : key.collation_matches === true &&
          key.collation_row_missing === false &&
          (key.collisdeterministic === true || key.collprovider === "d"),
    )
  );
}

function structure(assertion: StructureAssertion): SchemaReadiness {
  return { ready: false, reason: "STRUCTURE_MISMATCH", assertion };
}

function session(assertion: SessionAssertion): SchemaReadiness {
  return { ready: false, reason: "SESSION_INVARIANT", assertion };
}

/** Task 012B (B1-6): the nine dispatch columns, exactly, with type, nullability and default. */
function dispatchColumnsHold(rows: readonly Row[] | undefined): boolean {
  if (rows === undefined || rows.length !== DISPATCH_COLUMNS.length) return false;
  const seen = rows
    .map((row) => ({ column_name: row.column_name, type: row.type, notnull: row.notnull, column_default: row.column_default }))
    .sort((a, b) => String(a.column_name).localeCompare(String(b.column_name)));
  return JSON.stringify(seen) === JSON.stringify(DISPATCH_COLUMNS);
}

/**
 * Pure evaluation, in §8.5 order, then RLE, then (Task 012B) the dispatch
 * objects and S6.d. A missing observation fails closed. The profile changes
 * only S3's EXECUTE requirement (api) and S6.d (worker).
 */
export function evaluateReadiness(
  observations: ReadinessObservations,
  requiredMigrations: readonly string[] = REQUIRED_MIGRATIONS,
  profile: ReadinessProfile = "api",
): SchemaReadiness {
  const rows = (id: ReadinessQueryId) => observations.get(id);

  const s6b = rows("S6.b");
  const tt = s6b?.[0]?.tt;
  if (typeof tt !== "string" || !ZERO_DURATION.test(tt)) return session("S6.b");

  const l1 = rows("L1");
  if (l1 === undefined || l1[0]?.ledger_exists !== true) return { ready: false, reason: "LEDGER_MISSING" };
  const l2 = rows("L2");
  if (l2 === undefined) return { ready: false, reason: "LEDGER_MISSING" };
  if (l2.some((row) => row.finished !== true && row.rolled_back !== true)) {
    return { ready: false, reason: "MIGRATION_FAILED" };
  }
  const done = new Set(
    l2.filter((row) => row.finished === true && row.rolled_back !== true).map((row) => row.migration_name),
  );
  if (requiredMigrations.some((name) => !done.has(name))) return { ready: false, reason: "MIGRATION_MISSING" };
  if ([...done].some((name) => typeof name !== "string" || !requiredMigrations.includes(name))) {
    return { ready: false, reason: "UNKNOWN_MIGRATION" };
  }

  const indexes = rows("S1.index");
  const keys = rows("S1.keys");
  if (indexes === undefined || keys === undefined || !indexes.some((index) => s1Holds(index, keys))) {
    return structure("S1");
  }

  const s2 = rows("S2");
  if (s2 === undefined || !(Number(s2[0]?.fk_count) >= 1)) return structure("S2");

  const s3 = rows("S3.enum");
  const hasLabel = (type: string, label: string) =>
    s3?.some((row) => row.type_name === type && row.label === label) === true;
  if (!hasLabel("EventState", "VALIDATED") || !hasLabel("IntegrationConfigState", "ACTIVE")) return structure("S3");
  const fn = rows("S3.function");
  const f = fn?.[0];
  if (
    fn === undefined ||
    fn.length !== 1 ||
    f === undefined ||
    f.nargs !== 1 ||
    f.arg_is_uuid !== true ||
    f.returns_config_state !== true ||
    f.proretset !== false ||
    f.prosecdef !== true ||
    f.provolatile !== "v" ||
    f.lanname !== "sql" ||
    JSON.stringify(f.proconfig) !== JSON.stringify(STATUS_FUNCTION_CONFIG) ||
    f.prosrc !== STATUS_FUNCTION_BODY ||
    // Task 012B (B1-6, FD-4): the worker has no legitimate need to execute the status function.
    (profile === "api" && f.can_execute !== true)
  ) {
    return structure("S3");
  }

  const s4 = rows("S4");
  const present = new Set(
    (s4 ?? []).map((row) => `${String(row.table_name)}.${String(row.column_name)}:${String(row.type_schema)}.${String(row.type_name)}`),
  );
  if (s4 === undefined || EXPECTED_COLUMNS.some((column) => !present.has(column))) return structure("S4");

  const s5 = rows("S5");
  const pk = s5?.[0]?.pk_columns;
  if (!Array.isArray(pk) || pk.length !== 1 || pk[0] !== "id") return structure("S5");

  const s6a = rows("S6.a");
  if (s6a === undefined || !(Number(s6a[0]?.server_version_num) >= 170000)) return session("S6.a");
  const s6c = rows("S6.c");
  if (s6c === undefined) return session("S6.c");
  // Strict: any applicable nonzero transaction_timeout fails closed, even though the
  // connection-start option would override it (§8.5 S6.c permits this stricter reading).
  const nonzero = s6c.some(
    (row) => Array.isArray(row.setconfig) && row.setconfig.some((entry) => typeof entry === "string" && NONZERO_TRANSACTION_TIMEOUT.test(entry)),
  );
  if (nonzero) return session("S6.c");

  // Task 011A RD-7, evaluated last so that no earlier failure changes its reason.
  const table = rows("RLE.table");
  if (table === undefined || table[0]?.table_exists !== true) return structure("RLE.table");
  const rlePk = rows("RLE.pk")?.[0]?.pk_columns;
  if (!Array.isArray(rlePk) || rlePk.length !== 1 || rlePk[0] !== "id") return structure("RLE.pk");
  const rleIndexes = rows("RLE.indexes");
  for (const [assertion, definition] of Object.entries(RATE_LIMIT_EVIDENCE_INDEXES) as [RateLimitEvidenceIndexAssertion, string][]) {
    const holds = rleIndexes?.some(
      (index) =>
        index.indexdef === definition &&
        index.indisunique === true &&
        index.indisvalid === true &&
        index.indisready === true &&
        index.indislive === true &&
        index.indimmediate === true,
    );
    if (holds !== true) return structure(assertion);
  }

  // Task 012B (B1-6, PL-4), evaluated after RLE so that no earlier failure changes its reason.
  if (!dispatchColumnsHold(rows("DISPATCH.columns"))) return structure("DISPATCH.columns");
  const labels = rows("DISPATCH.enum")?.map((row) => row.label);
  if (labels === undefined || JSON.stringify(labels) !== JSON.stringify(DISPATCH_ENUM_LABELS)) return structure("DISPATCH.enum");
  const index = rows("DISPATCH.index");
  const ix = index?.[0];
  if (
    index === undefined ||
    index.length !== 1 ||
    ix === undefined ||
    ix.indexdef !== DISPATCH_INDEX_DEFINITION ||
    // A non-unique index by design (B1-3): founder decision in 012B-2 RUN A on PL-4's "five flags".
    ix.indisunique !== false ||
    ix.indisvalid !== true ||
    ix.indisready !== true ||
    ix.indislive !== true ||
    ix.indimmediate !== true
  ) {
    return structure("DISPATCH.index");
  }
  const check = rows("DISPATCH.check");
  const ck = check?.[0];
  if (check === undefined || check.length !== 1 || ck === undefined || ck.contype !== "c" || ck.def !== DISPATCH_CHECK_DEFINITION || ck.convalidated !== true) {
    return structure("DISPATCH.check");
  }
  const dispatchFunction = rows("DISPATCH.function");
  const df = dispatchFunction?.[0];
  if (
    dispatchFunction === undefined ||
    dispatchFunction.length !== 1 ||
    df === undefined ||
    df.nargs !== 0 ||
    df.returns_trigger !== true ||
    df.proretset !== false ||
    df.prosecdef !== false ||
    df.provolatile !== "v" ||
    df.lanname !== "plpgsql" ||
    JSON.stringify(df.proconfig) !== JSON.stringify(DISPATCH_FUNCTION_CONFIG) ||
    df.prosrc !== DISPATCH_FUNCTION_BODY ||
    typeof df.oid !== "string"
  ) {
    return structure("DISPATCH.function");
  }
  const trigger = rows("DISPATCH.trigger");
  const tg = trigger?.[0];
  if (
    trigger === undefined ||
    trigger.length !== 1 ||
    tg === undefined ||
    tg.tgisinternal !== false ||
    tg.tgfoid !== df.oid ||
    tg.tgtype !== DISPATCH_TRIGGER_TYPE ||
    tg.nargs !== 0 ||
    tg.no_columns !== true ||
    tg.no_when !== true
  ) {
    return structure("DISPATCH.trigger");
  }
  // B1-6: origin-enabled (O) or always-enabled (A) fires for ordinary operations; disabled (D) and replica-only (R) do not.
  if (tg.tgenabled !== "O" && tg.tgenabled !== "A") return structure("DISPATCH.trigger_enabled");

  if (profile === "worker") {
    const tz = rows("S6.d")?.[0]?.tz;
    if (tz !== "UTC") return session("S6.d");
  }

  return { ready: true };
}

class ReadinessQueryFailure extends Error {
  override readonly name = "ReadinessQueryFailure";
  constructor(
    readonly id: ReadinessQueryId,
    cause: unknown,
  ) {
    super(`readiness query ${id} failed`, { cause });
  }
}

/** The readiness transaction (read-only work; bounded by the session statement_timeout per statement). */
const READINESS_TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 2_000,
  timeout: 10_000,
});

/**
 * Runs the readiness checks. Read-only: it never migrates, alters, resets or
 * repairs anything. Throws only for connectivity (TRANSIENT-class) errors;
 * every other failure is a fail-closed `ready: false` result.
 */
export async function verifySchemaReadiness(db: Database, profile: ReadinessProfile = "api"): Promise<SchemaReadiness> {
  await db.ping();
  const observations = new Map<ReadinessQueryId, readonly Row[]>();

  try {
    observations.set(
      "S6.b",
      await db.prisma.$queryRawUnsafe<Row[]>("SELECT current_setting('transaction_timeout') AS tt"),
    );
  } catch (error) {
    if (classifyDatabaseError(error).failureClass === "TRANSIENT") throw error;
    return evaluateReadiness(observations, REQUIRED_MIGRATIONS, profile);
  }

  try {
    await db.prisma.$transaction(async (tx) => {
      for (const query of TRANSACTION_QUERIES) {
        try {
          const result = query.schema
            ? await tx.$queryRawUnsafe<Row[]>(query.sql, EXPECTED_SCHEMA)
            : await tx.$queryRawUnsafe<Row[]>(query.sql);
          observations.set(query.id, result);
        } catch (error) {
          // A failed statement aborts the transaction; nothing later can run.
          throw new ReadinessQueryFailure(query.id, error);
        }
      }
    }, READINESS_TRANSACTION_OPTIONS);
  } catch (error) {
    const cause = error instanceof ReadinessQueryFailure ? error.cause : error;
    if (classifyDatabaseError(cause).failureClass === "TRANSIENT") throw cause;
    // Fail closed: evaluation stops at the first query without an observation.
  }
  return evaluateReadiness(observations, REQUIRED_MIGRATIONS, profile);
}
