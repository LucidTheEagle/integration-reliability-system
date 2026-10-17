import { readServerBaseline } from "./baseline.js";
import { connectGuarded, grantsHeldBy, withDatabase } from "./guard.js";
import { listDatabases, listRoles, readContents, readRole, sentinelAcl } from "./inspect.js";
import type { PgClient } from "./pg.js";
import { SHADOW_DATABASE, STATUS_FUNCTION } from "./registry.js";

// Catalog evidence (admin-mode observation queries) recorded at Checkpoint A
// for comparison at a later resumption (Prompt B §0A item 6).

async function lines(client: PgClient, title: string, sql: string, values?: unknown[]): Promise<string[]> {
  const result = await client.query<Record<string, unknown>>(sql, values);
  return [
    `## ${title}`,
    ...result.rows.map((row) => Object.values(row).map((value) => JSON.stringify(value)).join(" | ")),
  ];
}

export async function collectEvidence(adminUrl: string): Promise<string> {
  const out: string[] = [];
  const admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-evidence" });
  try {
    const c = admin.client;
    out.push(
      ...(await lines(c, "identity", "SELECT current_database(), current_setting('server_version_num'), current_user")),
      ...(await lines(
        c,
        "relations (non-system)",
        `SELECT n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
          ORDER BY 1, 2`,
      )),
      ...(await lines(
        c,
        "columns (public)",
        `SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid) AS "default"
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY 1, 2`,
      )),
      ...(await lines(
        c,
        "enums",
        `SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY 1`,
      )),
      ...(await lines(
        c,
        "indexes",
        `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
          WHERE schemaname IN ('public', 'irs_test_meta') ORDER BY 1, 2, 3`,
      )),
      ...(await lines(
        c,
        "constraints",
        `SELECT n.nspname, cl.relname, co.conname, co.contype, co.convalidated, pg_get_constraintdef(co.oid) AS def
           FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname IN ('public', 'irs_test_meta') ORDER BY 1, 2, 3`,
      )),
      ...(await lines(
        c,
        "functions (non-system)",
        `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
                format_type(p.prorettype, NULL) AS returns, l.lanname, p.prosecdef, p.provolatile,
                p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.prosrc
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2`,
      )),
      ...(await lines(
        c,
        "status function privileges",
        `SELECT has_function_privilege('public', $1, 'EXECUTE') AS public_execute`,
        [`public.${STATUS_FUNCTION}(uuid)`],
      )),
      ...(await lines(
        c,
        "_prisma_migrations",
        `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at, applied_steps_count, logs IS NULL AS no_logs
           FROM "public"."_prisma_migrations" ORDER BY started_at`,
      )),
      ...(await lines(c, "schemas", `SELECT nspname, pg_get_userbyid(nspowner), nspacl::text FROM pg_namespace
          WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' ORDER BY 1`)),
      ...(await lines(c, "extensions", "SELECT extname, extversion FROM pg_extension ORDER BY 1")),
      ...(await lines(c, "default ACLs", "SELECT count(*) FROM pg_default_acl")),
      ...(await lines(c, "sentinel rows", `SELECT database_name, marker FROM "irs_test_meta"."sentinel" ORDER BY 1`)),
      "## sentinel ACL",
      ...(await sentinelAcl(c)),
      "## roles (non pg_*)",
    );
    for (const name of await listRoles(c)) {
      out.push(JSON.stringify(await readRole(c, name)));
    }
    out.push("## grants held, per role (this database)");
    for (const name of await listRoles(c)) {
      if (name === "postgres") continue;
      out.push(`${name}: ${JSON.stringify(await grantsHeldBy(c, name))}`);
    }
    out.push(
      ...(await lines(
        c,
        "objects owned by non-postgres roles",
        `SELECT 'class', c.relname, pg_get_userbyid(c.relowner) FROM pg_class c WHERE pg_get_userbyid(c.relowner) <> 'postgres'
         UNION ALL SELECT 'proc', p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p WHERE pg_get_userbyid(p.proowner) <> 'postgres'
         UNION ALL SELECT 'namespace', n.nspname, pg_get_userbyid(n.nspowner) FROM pg_namespace n
                    WHERE pg_get_userbyid(n.nspowner) NOT IN ('postgres', 'pg_database_owner')
         UNION ALL SELECT 'type', t.typname, pg_get_userbyid(t.typowner) FROM pg_type t WHERE pg_get_userbyid(t.typowner) <> 'postgres'
         ORDER BY 1, 2`,
      )),
      "## databases",
      ...(await listDatabases(c)),
    );
    const baseline = await readServerBaseline(c);
    out.push(`## server baseline`, `pg_db_role_setting ${baseline.roleSettings}; auto.conf ${baseline.autoConfEntries}`);
  } finally {
    await admin.close();
  }

  const shadow = await connectGuarded({
    url: withDatabase(adminUrl, SHADOW_DATABASE),
    mode: "admin",
    applicationName: "irs-test-evidence",
  });
  try {
    const contents = await readContents(shadow.client);
    out.push(
      `## ${SHADOW_DATABASE} contents`,
      JSON.stringify(contents),
      ...(await lines(
        shadow.client,
        `${SHADOW_DATABASE} relations`,
        `SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1, 2`,
      )),
      ...(await lines(shadow.client, `${SHADOW_DATABASE} sentinel rows`, `SELECT database_name, marker FROM "irs_test_meta"."sentinel"`)),
      `## ${SHADOW_DATABASE} sentinel ACL`,
      ...(await sentinelAcl(shadow.client)),
    );
  } finally {
    await shadow.close();
  }
  return out.join("\n");
}
