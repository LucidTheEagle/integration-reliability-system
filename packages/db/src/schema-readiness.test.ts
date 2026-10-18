import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REQUIRED_MIGRATIONS, STATUS_FUNCTION_BODY, evaluateReadiness } from "./schema-readiness.js";
import type { ReadinessObservations, ReadinessQueryId } from "./schema-readiness.js";

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
  ]);
}

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
          { migration_name: required, finished: true, rolled_back: false },
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
