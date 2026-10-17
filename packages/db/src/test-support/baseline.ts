import type { PgClient } from "./pg.js";

// Server-wide baseline (Prompt B §4.3): no role or database settings and no
// postgresql.auto.conf entries. Admin-mode observation query.

export interface ServerBaseline {
  readonly roleSettings: number;
  readonly autoConfEntries: number;
}

export async function readServerBaseline(admin: PgClient): Promise<ServerBaseline> {
  const result = await admin.query<{ role_settings: string; auto_conf: string }>(
    `SELECT (SELECT count(*) FROM pg_catalog.pg_db_role_setting)::text AS role_settings,
            (SELECT count(*) FROM pg_catalog.pg_file_settings
              WHERE sourcefile LIKE '%postgresql.auto.conf')::text AS auto_conf`,
  );
  const row = result.rows[0];
  return {
    roleSettings: Number(row?.role_settings ?? NaN),
    autoConfEntries: Number(row?.auto_conf ?? NaN),
  };
}

export async function assertServerBaseline(admin: PgClient): Promise<void> {
  const baseline = await readServerBaseline(admin);
  if (baseline.roleSettings !== 0 || baseline.autoConfEntries !== 0) {
    throw new Error(
      `server baseline violated: ${baseline.roleSettings} role/database settings, ` +
        `${baseline.autoConfEntries} postgresql.auto.conf entries`,
    );
  }
}
