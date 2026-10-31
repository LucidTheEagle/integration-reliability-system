import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_CHECK_DEFINITION,
  DISPATCH_COLUMNS,
  DISPATCH_FUNCTION_BODY,
  DISPATCH_INDEX_DEFINITION,
  DISPATCH_TRIGGER_TYPE,
  RATE_LIMIT_EVIDENCE_INDEXES,
  REQUIRED_MIGRATIONS,
  STATUS_FUNCTION_BODY,
  evaluateReadiness,
} from "./schema-readiness.js";
import type {
  ReadinessObservations,
  ReadinessProfile,
  ReadinessQueryId,
  SchemaReadiness,
  SessionAssertion,
  StructureAssertion,
} from "./schema-readiness.js";

// Readiness evaluation without a database: injected catalog rows (RD-T6l′,
// RD-T6p, RD-T7, RD-T8a, RD-T8d and one defect per assertion).

type Row = Record<string, unknown>;

const EVENT_COLUMNS: readonly [string, string, string][] = [
  ["id", "pg_catalog", "uuid"],
  ["integrationId", "pg_catalog", "uuid"],
  ["externalEventId", "pg_catalog", "text"],
  ["eventType", "pg_catalog", "text"],
  ["resourceType", "pg_catalog", "text"],
  ["resourceId", "pg_catalog", "text"],
  ["payload", "pg_catalog", "jsonb"],
  ["metadata", "pg_catalog", "jsonb"],
  ["occurredAt", "pg_catalog", "timestamp"],
  ["receivedAt", "pg_catalog", "timestamp"],
  ["status", "public", "EventState"],
  ["schemaVersion", "pg_catalog", "text"],
  ["correlationId", "pg_catalog", "text"],
  ["rawBody", "pg_catalog", "bytea"],
  ["rawBodySha256", "pg_catalog", "text"],
];
const AUDIT_COLUMNS: readonly [string, string, string][] = [
  ["id", "pg_catalog", "uuid"],
  ["actorType", "pg_catalog", "text"],
  ["actorId", "pg_catalog", "text"],
  ["action", "pg_catalog", "text"],
  ["entityType", "pg_catalog", "text"],
  ["entityId", "pg_catalog", "text"],
  ["metadata", "pg_catalog", "jsonb"],
  ["createdAt", "pg_catalog", "timestamp"],
];

const UNIQUE_INDEX: Row = {
  index_name: "Event_integrationId_externalEventId_key",
  indisunique: true,
  indisvalid: true,
  indisready: true,
  indislive: true,
  indimmediate: true,
  no_predicate: true,
  no_expressions: true,
  nkeyatts: 2,
  natts: 2,
  indisexclusion: false,
  amname: "btree",
};
const UNIQUE_KEYS: Row[] = [
  {
    index_name: "Event_integrationId_externalEventId_key",
    ord: 1,
    attnum: 2,
    attname: "integrationId",
    attnotnull: true,
    opclass_type_matches: true,
    opcdefault: true,
    opclass_method: "btree",
    collation_matches: true,
    no_collation: true,
    type_name: "uuid",
    collprovider: null,
    collisdeterministic: null,
    collation_row_missing: false,
  },
  {
    index_name: "Event_integrationId_externalEventId_key",
    ord: 2,
    attnum: 3,
    attname: "externalEventId",
    attnotnull: true,
    opclass_type_matches: true,
    opcdefault: true,
    opclass_method: "btree",
    collation_matches: true,
    no_collation: false,
    type_name: "text",
    collprovider: "d",
    collisdeterministic: true,
    collation_row_missing: false,
  },
];

/** The intact Task 011A RD-7 observations: the four natural-key indexes plus the table's other indexes. */
const RLE_INDEX_FLAGS: Row = { indisunique: true, indisvalid: true, indisready: true, indislive: true, indimmediate: true };
const RLE_INDEXES: Row[] = [
  ...Object.values(RATE_LIMIT_EVIDENCE_INDEXES).map((indexdef) => ({
    index_name: /^CREATE UNIQUE INDEX (\S+) /.exec(indexdef)?.[1],
    indexdef,
    ...RLE_INDEX_FLAGS,
  })),
  {
    index_name: "RateLimitEvidence_pkey",
    indexdef: `CREATE UNIQUE INDEX "RateLimitEvidence_pkey" ON public."RateLimitEvidence" USING btree (id)`,
    ...RLE_INDEX_FLAGS,
  },
  {
    index_name: "RateLimitEvidence_scope_kind_idx",
    indexdef: `CREATE INDEX "RateLimitEvidence_scope_kind_idx" ON public."RateLimitEvidence" USING btree (scope, kind)`,
    ...RLE_INDEX_FLAGS,
    indisunique: false,
  },
];

function good(): Map<ReadinessQueryId, readonly Row[]> {
  return new Map<ReadinessQueryId, readonly Row[]>([
    ["S6.b", [{ tt: "0" }]],
    ["L1", [{ ledger_exists: true }]],
    ["L2", REQUIRED_MIGRATIONS.map((name) => ({ migration_name: name, finished: true, rolled_back: false }))],
    ["S1.index", [{ ...UNIQUE_INDEX, index_name: "Event_pkey", natts: 1, nkeyatts: 1 }, UNIQUE_INDEX]],
    ["S1.keys", UNIQUE_KEYS],
    ["S2", [{ fk_count: 1 }]],
    [
      "S3.enum",
      [
        { type_name: "EventState", label: "RECEIVED" },
        { type_name: "EventState", label: "VALIDATED" },
        { type_name: "IntegrationConfigState", label: "ACTIVE" },
      ],
    ],
    [
      "S3.function",
      [
        {
          nargs: 1,
          arg_is_uuid: true,
          returns_config_state: true,
          proretset: false,
          prosecdef: true,
          provolatile: "v",
          proconfig: ["search_path=pg_catalog, pg_temp"],
          prosrc: STATUS_FUNCTION_BODY,
          lanname: "sql",
          can_execute: true,
        },
      ],
    ],
    [
      "S4",
      [
        ...EVENT_COLUMNS.map(([column, schema, type]) => ({ table_name: "Event", column_name: column, type_schema: schema, type_name: type })),
        ...AUDIT_COLUMNS.map(([column, schema, type]) => ({ table_name: "AuditEntry", column_name: column, type_schema: schema, type_name: type })),
        { table_name: "Integration", column_name: "configStatus", type_schema: "public", type_name: "IntegrationConfigState" },
      ],
    ],
    ["S5", [{ pk_columns: ["id"] }]],
    ["S6.a", [{ server_version_num: 170011 }]],
    ["S6.c", []],
    // Task 011A RD-7 (RD-4a): the intact RateLimitEvidence observations.
    ["RLE.table", [{ table_exists: true }]],
    ["RLE.pk", [{ pk_columns: ["id"] }]],
    ["RLE.indexes", RLE_INDEXES],
    // Task 012B (PL-4): the intact dispatch observations, and a UTC session.
    ["DISPATCH.columns", DISPATCH_COLUMNS.map((column) => ({ ...column }))],
    ["DISPATCH.enum", [{ label: "COMPLETED_WHILE_QUEUED" }, { label: "FAILED_WHILE_QUEUED" }]],
    ["DISPATCH.index", [DISPATCH_INDEX_ROW]],
    ["DISPATCH.check", [{ contype: "c", def: DISPATCH_CHECK_DEFINITION, convalidated: true }]],
    ["DISPATCH.function", [DISPATCH_FUNCTION_ROW]],
    ["DISPATCH.trigger", [DISPATCH_TRIGGER_ROW]],
    ["S6.d", [{ tz: "UTC" }]],
  ]);
}

const DISPATCH_FUNCTION_OID = "16500";
const DISPATCH_INDEX_ROW: Row = {
  index_name: "Event_status_receivedAt_idx",
  indexdef: DISPATCH_INDEX_DEFINITION,
  indisunique: false,
  indisvalid: true,
  indisready: true,
  indislive: true,
  indimmediate: true,
};
const DISPATCH_FUNCTION_ROW: Row = {
  oid: DISPATCH_FUNCTION_OID,
  nargs: 0,
  returns_trigger: true,
  proretset: false,
  prosecdef: false,
  provolatile: "v",
  proconfig: ["search_path=pg_catalog, pg_temp"],
  prosrc: DISPATCH_FUNCTION_BODY,
  lanname: "plpgsql",
};
const DISPATCH_TRIGGER_ROW: Row = {
  tgfoid: DISPATCH_FUNCTION_OID,
  tgtype: DISPATCH_TRIGGER_TYPE,
  tgenabled: "O",
  tgisinternal: false,
  nargs: 0,
  no_columns: true,
  no_when: true,
};

function withRows(id: ReadinessQueryId, rows: readonly Row[] | undefined): ReadinessObservations {
  const map = good();
  if (rows === undefined) map.delete(id);
  else map.set(id, rows);
  return map;
}

function patchRow(id: ReadinessQueryId, index: number, patch: Row): ReadinessObservations {
  const rows = [...(good().get(id) ?? [])];
  rows[index] = { ...rows[index], ...patch };
  return withRows(id, rows);
}

describe("readiness evaluation", () => {
  it("the recognised, structurally valid catalog passes (unit half of RD-T2)", () => {
    assert.deepEqual(evaluateReadiness(good()), { ready: true });
  });

  it("ledger: missing table or unreadable ledger → LEDGER_MISSING", () => {
    assert.deepEqual(evaluateReadiness(withRows("L1", [{ ledger_exists: false }])), { ready: false, reason: "LEDGER_MISSING" });
    assert.deepEqual(evaluateReadiness(withRows("L2", undefined)), { ready: false, reason: "LEDGER_MISSING" });
  });

  it("ledger: failed, missing, rolled-back and unknown migrations", () => {
    const required = REQUIRED_MIGRATIONS[0];
    assert.deepEqual(
      evaluateReadiness(withRows("L2", [{ migration_name: required, finished: false, rolled_back: false }])),
      { ready: false, reason: "MIGRATION_FAILED" },
    );
    assert.deepEqual(evaluateReadiness(withRows("L2", [])), { ready: false, reason: "MIGRATION_MISSING" });
    assert.deepEqual(
      evaluateReadiness(withRows("L2", [{ migration_name: required, finished: true, rolled_back: true }])),
      { ready: false, reason: "MIGRATION_MISSING" },
    );
    assert.deepEqual(
      evaluateReadiness(
        withRows("L2", [
          ...REQUIRED_MIGRATIONS.map((name) => ({ migration_name: name, finished: true, rolled_back: false })),
          { migration_name: "29990101000000_later", finished: true, rolled_back: false },
        ]),
      ),
      { ready: false, reason: "UNKNOWN_MIGRATION" },
    );
  });

  it("S1 rejects each weakened property of the idempotency index", () => {
    const s1 = { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S1" };
    const indexDefects: Row[] = [
      { indisunique: false },
      { indisvalid: false },
      { indisready: false },
      { indislive: false },
      { indimmediate: false },
      { no_predicate: false },
      { no_expressions: false },
      { nkeyatts: 3 },
      { natts: 3 },
      { indisexclusion: true },
    ];
    for (const defect of indexDefects) assert.deepEqual(evaluateReadiness(patchRow("S1.index", 1, defect)), s1, JSON.stringify(defect));
    const keyDefects: Row[] = [
      { attnum: 0 },
      { attname: "eventType" },
      { attnotnull: false },
      { opcdefault: false },
      { opclass_type_matches: false },
      { opclass_method: "hash" },
      { collation_matches: false },
      { collisdeterministic: false, collprovider: "i" },
      { collation_row_missing: true },
    ];
    for (const defect of keyDefects) assert.deepEqual(evaluateReadiness(patchRow("S1.keys", 1, defect)), s1, JSON.stringify(defect));
    assert.deepEqual(evaluateReadiness(patchRow("S1.keys", 0, { no_collation: false })), s1);
  });

  it("RD-T6l′: S1.k — a non-btree access method passing S1.a–j is rejected", () => {
    assert.deepEqual(evaluateReadiness(patchRow("S1.index", 1, { amname: "hash" })), {
      ready: false,
      reason: "STRUCTURE_MISMATCH",
      assertion: "S1",
    });
  });

  it("S1 is order-insensitive and accepts a deterministic non-default collation", () => {
    const keys = good().get("S1.keys") ?? [];
    assert.deepEqual(evaluateReadiness(withRows("S1.keys", [...keys].reverse())), { ready: true });
    assert.deepEqual(evaluateReadiness(patchRow("S1.keys", 1, { collprovider: "c", collisdeterministic: true })), { ready: true });
  });

  it("RD-T6p: a catalog read failure (no observation) fails safe as S1, never ready", () => {
    assert.deepEqual(evaluateReadiness(withRows("S1.keys", undefined)), { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S1" });
    assert.deepEqual(evaluateReadiness(withRows("S1.index", undefined)), { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S1" });
  });

  it("S2, S4, S5 defects", () => {
    assert.deepEqual(evaluateReadiness(withRows("S2", [{ fk_count: 0 }])), { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S2" });
    const s4 = (good().get("S4") ?? []).filter((row) => row.column_name !== "rawBody");
    assert.deepEqual(evaluateReadiness(withRows("S4", s4)), { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S4" });
    const wrongType = (good().get("S4") ?? []).map((row) =>
      row.column_name === "configStatus" ? { ...row, type_schema: "pg_catalog", type_name: "text" } : row,
    );
    assert.deepEqual(evaluateReadiness(withRows("S4", wrongType)), { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S4" });
    assert.deepEqual(evaluateReadiness(withRows("S5", [{ pk_columns: ["actorId"] }])), { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S5" });
    assert.deepEqual(evaluateReadiness(withRows("S5", [{ pk_columns: null }])), { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S5" });
  });

  it("S3: missing labels and every VPF-6 function property", () => {
    const s3 = { ready: false, reason: "STRUCTURE_MISMATCH", assertion: "S3" };
    assert.deepEqual(evaluateReadiness(withRows("S3.enum", [{ type_name: "EventState", label: "VALIDATED" }])), s3);
    assert.deepEqual(evaluateReadiness(withRows("S3.enum", [{ type_name: "IntegrationConfigState", label: "ACTIVE" }])), s3);
    const defects: Row[] = [
      { nargs: 2 },
      { arg_is_uuid: false },
      { returns_config_state: false },
      { proretset: true },
      { prosecdef: false },
      { provolatile: "s" },
      { lanname: "plpgsql" },
      { proconfig: null },
      { proconfig: ["search_path=public"] },
      { prosrc: `${STATUS_FUNCTION_BODY} ` },
      { can_execute: false },
    ];
    for (const defect of defects) assert.deepEqual(evaluateReadiness(patchRow("S3.function", 0, defect)), s3, JSON.stringify(defect));
    assert.deepEqual(evaluateReadiness(withRows("S3.function", [])), s3);
    const fn = good().get("S3.function")?.[0] ?? {};
    assert.deepEqual(evaluateReadiness(withRows("S3.function", [fn, fn])), s3, "an overload fails closed");
  });

  it("RD-T8a: a server older than PG 17 → SESSION_INVARIANT (S6.a)", () => {
    assert.deepEqual(evaluateReadiness(withRows("S6.a", [{ server_version_num: 160000 }])), {
      ready: false,
      reason: "SESSION_INVARIANT",
      assertion: "S6.a",
    });
  });

  it("S6.b: a nonzero or unreadable session transaction_timeout; a zero with a unit passes", () => {
    for (const rows of [[{ tt: "1min" }], [{ tt: "60000" }], [], undefined]) {
      assert.deepEqual(evaluateReadiness(withRows("S6.b", rows)), { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.b" });
    }
    assert.deepEqual(evaluateReadiness(withRows("S6.b", [{ tt: "0ms" }])), { ready: true });
  });

  it("S6.c: an applicable nonzero transaction_timeout fails; zero and unrelated settings pass", () => {
    const fail = { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.c" };
    assert.deepEqual(evaluateReadiness(withRows("S6.c", [{ setconfig: ["transaction_timeout=60s"] }])), fail);
    assert.deepEqual(evaluateReadiness(withRows("S6.c", [{ setconfig: ["search_path=x", "transaction_timeout=1"] }])), fail);
    assert.deepEqual(evaluateReadiness(withRows("S6.c", [{ setconfig: ["transaction_timeout=0"] }])), { ready: true });
    assert.deepEqual(evaluateReadiness(withRows("S6.c", [{ setconfig: ["transaction_timeout=0ms", "lock_timeout=5s"] }])), { ready: true });
  });

  it("RD-T8d: a readiness query error (no S6.c observation) → SESSION_INVARIANT", () => {
    assert.deepEqual(evaluateReadiness(withRows("S6.c", undefined)), { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.c" });
  });
});

describe("RD-7 (Task 011A): RateLimitEvidence table, primary key and natural-key indexes", () => {
  const structure = (assertion: string) => ({ ready: false, reason: "STRUCTURE_MISMATCH", assertion });
  const assertions = Object.keys(RATE_LIMIT_EVIDENCE_INDEXES);
  const withoutIndex = (name: string) => RLE_INDEXES.filter((index) => index.indexdef !== RATE_LIMIT_EVIDENCE_INDEXES[name as keyof typeof RATE_LIMIT_EVIDENCE_INDEXES]);
  const patchIndex = (name: string, patch: Row) =>
    RLE_INDEXES.map((index) =>
      index.indexdef === RATE_LIMIT_EVIDENCE_INDEXES[name as keyof typeof RATE_LIMIT_EVIDENCE_INDEXES] ? { ...index, ...patch } : index,
    );

  it("a missing or unreadable table fails closed as RLE.table", () => {
    assert.deepEqual(evaluateReadiness(withRows("RLE.table", [{ table_exists: false }])), structure("RLE.table"));
    assert.deepEqual(evaluateReadiness(withRows("RLE.table", [])), structure("RLE.table"));
    assert.deepEqual(evaluateReadiness(withRows("RLE.table", undefined)), structure("RLE.table"));
  });

  it("a missing, unreadable or wrong primary key fails closed as RLE.pk", () => {
    for (const rows of [[{ pk_columns: null }], [{ pk_columns: ["scope"] }], [{ pk_columns: ["id", "scope"] }], undefined]) {
      assert.deepEqual(evaluateReadiness(withRows("RLE.pk", rows)), structure("RLE.pk"), JSON.stringify(rows));
    }
  });

  it("each natural-key index: missing, non-unique, wrong predicate or not usable → its own assertion", () => {
    for (const name of assertions) {
      const expected = structure(name);
      const definition = RATE_LIMIT_EVIDENCE_INDEXES[name as keyof typeof RATE_LIMIT_EVIDENCE_INDEXES];
      assert.deepEqual(evaluateReadiness(withRows("RLE.indexes", withoutIndex(name))), expected, `${name} missing`);
      const nonUnique = definition.replace("CREATE UNIQUE INDEX", "CREATE INDEX");
      assert.deepEqual(
        evaluateReadiness(withRows("RLE.indexes", patchIndex(name, { indexdef: nonUnique, indisunique: false }))),
        expected,
        `${name} non-unique`,
      );
      const wrongPredicate = definition.replace(/ WHERE .*$/, " WHERE (kind = 'OTHER'::text)");
      assert.deepEqual(
        evaluateReadiness(withRows("RLE.indexes", patchIndex(name, { indexdef: wrongPredicate }))),
        expected,
        `${name} wrong predicate`,
      );
      for (const flag of ["indisunique", "indisvalid", "indisready", "indislive", "indimmediate"]) {
        assert.deepEqual(evaluateReadiness(withRows("RLE.indexes", patchIndex(name, { [flag]: false }))), expected, `${name} ${flag}`);
      }
    }
  });

  it("an equivalent index under another name fails closed (the golden text includes the name)", () => {
    const [first] = assertions;
    const definition = RATE_LIMIT_EVIDENCE_INDEXES[first as keyof typeof RATE_LIMIT_EVIDENCE_INDEXES];
    const renamed = definition.replace(/^CREATE UNIQUE INDEX \S+ /, "CREATE UNIQUE INDEX irs_renamed ");
    assert.deepEqual(evaluateReadiness(withRows("RLE.indexes", patchIndex(first ?? "", { indexdef: renamed }))), structure(first ?? ""));
  });

  it("an unreadable index observation fails closed at the first index assertion", () => {
    assert.deepEqual(evaluateReadiness(withRows("RLE.indexes", undefined)), structure(assertions[0] ?? ""));
  });

  it("RD-7 is evaluated last: an existing failure keeps its own reason when the RD-7 observations are also absent", () => {
    const noRle = (map: ReadinessObservations) => {
      const copy = new Map(map);
      for (const id of ["RLE.table", "RLE.pk", "RLE.indexes"] as const) copy.delete(id);
      return copy;
    };
    assert.deepEqual(evaluateReadiness(noRle(withRows("S2", [{ fk_count: 0 }]))), structure("S2"));
    assert.deepEqual(evaluateReadiness(noRle(patchRow("S3.function", 0, { can_execute: false }))), structure("S3"));
    assert.deepEqual(evaluateReadiness(noRle(withRows("S6.c", [{ setconfig: ["transaction_timeout=60s"] }]))), {
      ready: false,
      reason: "SESSION_INVARIANT",
      assertion: "S6.c",
    });
    assert.deepEqual(evaluateReadiness(noRle(withRows("L2", []))), { ready: false, reason: "MIGRATION_MISSING" });
    assert.deepEqual(evaluateReadiness(noRle(good())), structure("RLE.table"));
  });
});

describe("Task 012B (B1-6, PL-4): the dispatch objects, the profiles and S6.d", () => {
  const structure = (assertion: string) => ({ ready: false, reason: "STRUCTURE_MISMATCH", assertion });
  const evaluate = (observations: ReadinessObservations, profile: ReadinessProfile = "api") =>
    evaluateReadiness(observations, REQUIRED_MIGRATIONS, profile);

  it("the intact observations are ready under both profiles", () => {
    assert.deepEqual(evaluate(good(), "api"), { ready: true });
    assert.deepEqual(evaluate(good(), "worker"), { ready: true });
    assert.deepEqual(evaluateReadiness(good()), { ready: true }, "the default profile is api");
  });

  it("DISPATCH.columns: a missing column, a timestamp without time zone, a nullable counter, a missing or wrong default, an unreadable observation", () => {
    const columns = good().get("DISPATCH.columns") ?? [];
    const patch = (name: string, change: Row) => columns.map((row) => (row.column_name === name ? { ...row, ...change } : row));
    const defects: [string, readonly Row[] | undefined][] = [
      ["missing queuedAt", columns.filter((row) => row.column_name !== "queuedAt")],
      ["timestamp without time zone", patch("queuedAt", { type: "timestamp(3) without time zone" })],
      ["timestamptz(6)", patch("publishAckedAt", { type: "timestamp(6) with time zone" })],
      ["nullable counter", patch("publishAttemptCount", { notnull: false })],
      ["missing default", patch("redispatchCount", { column_default: null })],
      ["wrong default", patch("redispatchCount", { column_default: "1" })],
      ["NOT NULL timestamp", patch("dispatchAnomalyAt", { notnull: true })],
      ["text kind", patch("dispatchAnomalyKind", { type: "text" })],
      ["a duplicated row", [...columns, columns[0] ?? {}]],
      ["unreadable", undefined],
    ];
    for (const [label, rows] of defects) assert.deepEqual(evaluate(withRows("DISPATCH.columns", rows)), structure("DISPATCH.columns"), label);
    assert.deepEqual(evaluate(withRows("DISPATCH.columns", [...columns].reverse())), { ready: true }, "row order is irrelevant");
  });

  it("DISPATCH.enum: a missing, extra or reordered label, or an unreadable observation", () => {
    for (const rows of [
      [{ label: "COMPLETED_WHILE_QUEUED" }],
      [{ label: "COMPLETED_WHILE_QUEUED" }, { label: "FAILED_WHILE_QUEUED" }, { label: "OTHER" }],
      [{ label: "FAILED_WHILE_QUEUED" }, { label: "COMPLETED_WHILE_QUEUED" }],
      [],
      undefined,
    ]) {
      assert.deepEqual(evaluate(withRows("DISPATCH.enum", rows)), structure("DISPATCH.enum"), JSON.stringify(rows));
    }
  });

  it("DISPATCH.index: missing, wrong text, unique, each usability flag false, duplicated, unreadable", () => {
    const fail = structure("DISPATCH.index");
    assert.deepEqual(evaluate(withRows("DISPATCH.index", [])), fail, "missing");
    assert.deepEqual(evaluate(withRows("DISPATCH.index", undefined)), fail, "unreadable");
    assert.deepEqual(evaluate(withRows("DISPATCH.index", [DISPATCH_INDEX_ROW, DISPATCH_INDEX_ROW])), fail, "two rows");
    for (const patch of [
      { indexdef: `${DISPATCH_INDEX_DEFINITION} ` },
      { indexdef: "CREATE INDEX \"Event_status_receivedAt_idx\" ON public.\"Event\" USING btree (\"receivedAt\", status)" },
      { indisunique: true },
      { indisvalid: false },
      { indisready: false },
      { indislive: false },
      { indimmediate: false },
    ]) {
      assert.deepEqual(evaluate(patchRow("DISPATCH.index", 0, patch)), fail, JSON.stringify(patch));
    }
  });

  it("DISPATCH.check: missing, altered, not validated, another constraint type, unreadable", () => {
    const fail = structure("DISPATCH.check");
    assert.deepEqual(evaluate(withRows("DISPATCH.check", [])), fail);
    assert.deepEqual(evaluate(withRows("DISPATCH.check", undefined)), fail);
    for (const patch of [{ def: `${DISPATCH_CHECK_DEFINITION} ` }, { convalidated: false }, { contype: "f" }]) {
      assert.deepEqual(evaluate(patchRow("DISPATCH.check", 0, patch)), fail, JSON.stringify(patch));
    }
  });

  it("DISPATCH.function: each property and the body", () => {
    const fail = structure("DISPATCH.function");
    for (const patch of [
      { nargs: 1 },
      { returns_trigger: false },
      { proretset: true },
      { prosecdef: true },
      { provolatile: "s" },
      { lanname: "sql" },
      { proconfig: null },
      { proconfig: ["search_path=public"] },
      { prosrc: `${DISPATCH_FUNCTION_BODY} ` },
      { oid: 16500 },
    ]) {
      assert.deepEqual(evaluate(patchRow("DISPATCH.function", 0, patch)), fail, JSON.stringify(patch));
    }
    assert.deepEqual(evaluate(withRows("DISPATCH.function", [])), fail, "missing");
    assert.deepEqual(evaluate(withRows("DISPATCH.function", undefined)), fail, "unreadable");
    assert.deepEqual(evaluate(withRows("DISPATCH.function", [DISPATCH_FUNCTION_ROW, DISPATCH_FUNCTION_ROW])), fail, "an overload");
  });

  it("DISPATCH.trigger: missing, internal, on another function, wrong tgtype, arguments, a column list, a WHEN, duplicated", () => {
    const fail = structure("DISPATCH.trigger");
    for (const patch of [
      { tgisinternal: true },
      { tgfoid: "16501" },
      { tgtype: "7" },
      { nargs: 1 },
      { no_columns: false },
      { no_when: false },
    ]) {
      assert.deepEqual(evaluate(patchRow("DISPATCH.trigger", 0, patch)), fail, JSON.stringify(patch));
    }
    assert.deepEqual(evaluate(withRows("DISPATCH.trigger", [])), fail, "missing");
    assert.deepEqual(evaluate(withRows("DISPATCH.trigger", undefined)), fail, "unreadable");
    assert.deepEqual(evaluate(withRows("DISPATCH.trigger", [DISPATCH_TRIGGER_ROW, DISPATCH_TRIGGER_ROW])), fail, "two rows");
  });

  it("DISPATCH.trigger_enabled: disabled (D) and replica-only (R) fail; origin (O) and always (A) pass", () => {
    for (const mode of ["D", "R"]) {
      assert.deepEqual(evaluate(patchRow("DISPATCH.trigger", 0, { tgenabled: mode })), structure("DISPATCH.trigger_enabled"), mode);
      assert.deepEqual(evaluate(patchRow("DISPATCH.trigger", 0, { tgenabled: mode }), "worker"), structure("DISPATCH.trigger_enabled"), mode);
    }
    for (const mode of ["O", "A"]) {
      assert.deepEqual(evaluate(patchRow("DISPATCH.trigger", 0, { tgenabled: mode })), { ready: true }, mode);
    }
  });

  it("profiles: the worker does not need EXECUTE on the status function; the API does", () => {
    const noExecute = patchRow("S3.function", 0, { can_execute: false });
    assert.deepEqual(evaluate(noExecute, "worker"), { ready: true });
    assert.deepEqual(evaluate(noExecute, "api"), structure("S3"));
    // Every other S3 property still applies to the worker (catalog reads).
    assert.deepEqual(evaluate(patchRow("S3.function", 0, { prosecdef: false }), "worker"), structure("S3"));
  });

  it("S6.d: the worker requires TimeZone exactly UTC; the API does not evaluate it", () => {
    const s6d = { ready: false, reason: "SESSION_INVARIANT", assertion: "S6.d" };
    for (const rows of [[{ tz: "America/New_York" }], [{ tz: "Etc/UTC" }], [{ tz: "utc" }], [], undefined]) {
      assert.deepEqual(evaluate(withRows("S6.d", rows), "worker"), s6d, JSON.stringify(rows));
      assert.deepEqual(evaluate(withRows("S6.d", rows), "api"), { ready: true }, JSON.stringify(rows));
    }
  });

  it("order: an existing failure keeps its reason when the dispatch observations are absent; RLE failures keep theirs", () => {
    const noDispatch = (map: ReadinessObservations) => {
      const copy = new Map(map);
      for (const id of ["DISPATCH.columns", "DISPATCH.enum", "DISPATCH.index", "DISPATCH.check", "DISPATCH.function", "DISPATCH.trigger", "S6.d"] as const) {
        copy.delete(id);
      }
      return copy;
    };
    assert.deepEqual(evaluate(noDispatch(withRows("S2", [{ fk_count: 0 }]))), structure("S2"));
    assert.deepEqual(evaluate(noDispatch(patchRow("S3.function", 0, { can_execute: false }))), structure("S3"));
    assert.deepEqual(evaluate(noDispatch(withRows("S6.c", [{ setconfig: ["transaction_timeout=60s"] }]))), {
      ready: false,
      reason: "SESSION_INVARIANT",
      assertion: "S6.c",
    });
    assert.deepEqual(evaluate(noDispatch(withRows("RLE.table", [{ table_exists: false }]))), structure("RLE.table"));
    assert.deepEqual(evaluate(noDispatch(withRows("RLE.pk", [{ pk_columns: null }]))), structure("RLE.pk"));
    assert.deepEqual(evaluate(noDispatch(withRows("L2", []))), { ready: false, reason: "MIGRATION_MISSING" });
    assert.deepEqual(evaluate(noDispatch(good())), structure("DISPATCH.columns"));
    assert.deepEqual(evaluate(noDispatch(good()), "worker"), structure("DISPATCH.columns"));
  });
});

// Q3 (Task 012B): the exported assertion unions, pinned in both directions. The
// compiler refuses a missing member (an incomplete Record) and an extra one (an
// excess property), so the names are explicit, unique and stable.
const STRUCTURE_ASSERTIONS: Record<StructureAssertion, true> = {
  S1: true,
  S2: true,
  S3: true,
  S4: true,
  S5: true,
  "RLE.table": true,
  "RLE.pk": true,
  "RLE.lifecycle_uq": true,
  "RLE.summary_range_uq": true,
  "RLE.gap_discontinuity_uq": true,
  "RLE.gap_unclean_uq": true,
  "DISPATCH.columns": true,
  "DISPATCH.enum": true,
  "DISPATCH.index": true,
  "DISPATCH.check": true,
  "DISPATCH.function": true,
  "DISPATCH.trigger": true,
  "DISPATCH.trigger_enabled": true,
};
const SESSION_ASSERTIONS: Record<SessionAssertion, true> = { "S6.a": true, "S6.b": true, "S6.c": true, "S6.d": true };

describe("Q3: every readiness assertion name, old and new, is produced by some defect", () => {
  const producers: Record<StructureAssertion | SessionAssertion, () => SchemaReadiness> = {
    S1: () => evaluateReadiness(withRows("S1.index", undefined)),
    S2: () => evaluateReadiness(withRows("S2", [{ fk_count: 0 }])),
    S3: () => evaluateReadiness(withRows("S3.function", [])),
    S4: () => evaluateReadiness(withRows("S4", [])),
    S5: () => evaluateReadiness(withRows("S5", [{ pk_columns: null }])),
    "RLE.table": () => evaluateReadiness(withRows("RLE.table", undefined)),
    "RLE.pk": () => evaluateReadiness(withRows("RLE.pk", undefined)),
    "RLE.lifecycle_uq": () => evaluateReadiness(withRows("RLE.indexes", RLE_INDEXES.filter((i) => i.index_name !== "rle_instance_lifecycle_uq"))),
    "RLE.summary_range_uq": () => evaluateReadiness(withRows("RLE.indexes", RLE_INDEXES.filter((i) => i.index_name !== "rle_summary_range_uq"))),
    "RLE.gap_discontinuity_uq": () =>
      evaluateReadiness(withRows("RLE.indexes", RLE_INDEXES.filter((i) => i.index_name !== "rle_gap_discontinuity_uq"))),
    "RLE.gap_unclean_uq": () => evaluateReadiness(withRows("RLE.indexes", RLE_INDEXES.filter((i) => i.index_name !== "rle_gap_unclean_uq"))),
    "DISPATCH.columns": () => evaluateReadiness(withRows("DISPATCH.columns", [])),
    "DISPATCH.enum": () => evaluateReadiness(withRows("DISPATCH.enum", [])),
    "DISPATCH.index": () => evaluateReadiness(withRows("DISPATCH.index", [])),
    "DISPATCH.check": () => evaluateReadiness(withRows("DISPATCH.check", [])),
    "DISPATCH.function": () => evaluateReadiness(withRows("DISPATCH.function", [])),
    "DISPATCH.trigger": () => evaluateReadiness(withRows("DISPATCH.trigger", [])),
    "DISPATCH.trigger_enabled": () => evaluateReadiness(patchRow("DISPATCH.trigger", 0, { tgenabled: "D" })),
    "S6.a": () => evaluateReadiness(withRows("S6.a", [{ server_version_num: 160000 }])),
    "S6.b": () => evaluateReadiness(withRows("S6.b", undefined)),
    "S6.c": () => evaluateReadiness(withRows("S6.c", undefined)),
    "S6.d": () => evaluateReadiness(withRows("S6.d", [{ tz: "America/New_York" }]), REQUIRED_MIGRATIONS, "worker"),
  };

  it("the pins list 18 structure and 4 session names, and each one is produced by its own defect", () => {
    assert.equal(Object.keys(STRUCTURE_ASSERTIONS).length, 18);
    assert.equal(Object.keys(SESSION_ASSERTIONS).length, 4);
    assert.deepEqual(Object.keys(producers).sort(), [...Object.keys(STRUCTURE_ASSERTIONS), ...Object.keys(SESSION_ASSERTIONS)].sort());
    for (const [name, produce] of Object.entries(producers)) {
      const result = produce();
      assert.equal(result.ready, false, name);
      assert.equal("assertion" in result ? result.assertion : undefined, name, name);
      const expectedReason = name in SESSION_ASSERTIONS ? "SESSION_INVARIANT" : "STRUCTURE_MISMATCH";
      assert.equal(result.ready === false ? result.reason : undefined, expectedReason, name);
    }
  });
});

describe("RD-T7: REQUIRED_MIGRATIONS matches the migration history", () => {
  it("equals the directory names under prisma/migrations", () => {
    const directory = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));
    const names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual([...REQUIRED_MIGRATIONS].sort(), names);
  });
});
