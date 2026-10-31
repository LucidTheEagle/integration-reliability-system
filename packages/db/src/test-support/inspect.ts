import type { PgClient } from "./pg.js";

// Read-only catalog inspection shared by the bootstrap procedures and the
// evidence dump. "Empty" is Prompt A's sense: the default public schema may
// exist but holds no objects, and there is no user-created schema, type,
// function or extension other than plpgsql.

const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

export interface DatabaseContents {
  readonly schemas: string[];
  readonly relations: number;
  readonly types: number;
  readonly functions: number;
  readonly collations: number;
  readonly extensions: string[];
  readonly eventTriggers: number;
  readonly publications: number;
  readonly subscriptions: number;
}

export async function readContents(client: PgClient): Promise<DatabaseContents> {
  const one = async (sql: string): Promise<number> =>
    Number((await client.query<{ n: string }>(sql)).rows[0]?.n ?? NaN);
  const schemas = (
    await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE ${SYSTEM_SCHEMA_FILTER} ORDER BY 1`,
    )
  ).rows.map((row) => row.nspname);
  return {
    schemas,
    relations: await one(
      `SELECT count(*)::text AS n FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${SYSTEM_SCHEMA_FILTER}`,
    ),
    types: await one(
      `SELECT count(*)::text AS n FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE ${SYSTEM_SCHEMA_FILTER}`,
    ),
    functions: await one(
      `SELECT count(*)::text AS n FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE ${SYSTEM_SCHEMA_FILTER}`,
    ),
    collations: await one(
      `SELECT count(*)::text AS n FROM pg_catalog.pg_collation c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace WHERE ${SYSTEM_SCHEMA_FILTER}`,
    ),
    extensions: (
      await client.query<{ extname: string }>(
        "SELECT extname FROM pg_catalog.pg_extension ORDER BY 1",
      )
    ).rows.map((row) => row.extname),
    eventTriggers: await one("SELECT count(*)::text AS n FROM pg_catalog.pg_event_trigger"),
    publications: await one("SELECT count(*)::text AS n FROM pg_catalog.pg_publication"),
    subscriptions: await one("SELECT count(*)::text AS n FROM pg_catalog.pg_subscription"),
  };
}

/** Empty in Prompt A's sense; returns the reasons it is not, if any. */
export function emptinessProblems(contents: DatabaseContents): string[] {
  const problems: string[] = [];
  if (JSON.stringify(contents.schemas) !== JSON.stringify(["public"])) {
    problems.push(`schemas: ${contents.schemas.join(", ")}`);
  }
  if (contents.relations !== 0) problems.push(`${contents.relations} relations`);
  if (contents.types !== 0) problems.push(`${contents.types} types`);
  if (contents.functions !== 0) problems.push(`${contents.functions} functions`);
  if (contents.collations !== 0) problems.push(`${contents.collations} collations`);
  if (JSON.stringify(contents.extensions) !== JSON.stringify(["plpgsql"])) {
    problems.push(`extensions: ${contents.extensions.join(", ")}`);
  }
  if (contents.eventTriggers !== 0) problems.push(`${contents.eventTriggers} event triggers`);
  if (contents.publications !== 0) problems.push(`${contents.publications} publications`);
  if (contents.subscriptions !== 0) problems.push(`${contents.subscriptions} subscriptions`);
  return problems;
}

export async function listRoles(client: PgClient): Promise<string[]> {
  return (
    await client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1",
    )
  ).rows.map((row) => row.rolname).sort();
}

export async function listDatabases(client: PgClient): Promise<string[]> {
  return (
    await client.query<{ datname: string }>("SELECT datname FROM pg_catalog.pg_database ORDER BY 1")
  ).rows.map((row) => row.datname).sort();
}

export interface RoleRecord {
  readonly name: string;
  readonly super: boolean;
  readonly login: boolean;
  readonly createdb: boolean;
  readonly createrole: boolean;
  readonly replication: boolean;
  readonly bypassrls: boolean;
  readonly inherit: boolean;
  /** Roles this role is a member of (direct). */
  readonly memberOf: string[];
  /** Task 012B (Q2): `rolconnlimit` (-1 is no limit). */
  readonly connectionLimit: number;
  /** Task 012B (Q2): whether `rolvaliduntil` is set (the value is never read). */
  readonly validUntilSet: boolean;
  /** Task 012B (Q2): roles that are members of this role (direct; the other direction). */
  readonly members: string[];
}

export async function readRole(client: PgClient, name: string): Promise<RoleRecord | undefined> {
  const result = await client.query<{
    rolsuper: boolean;
    rolcanlogin: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolinherit: boolean;
    member_of: string[] | null;
    rolconnlimit: number;
    valid_until_set: boolean;
    members: string[] | null;
  }>(
    `SELECT r.rolsuper, r.rolcanlogin, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
            r.rolbypassrls, r.rolinherit,
            (SELECT array_agg(g.rolname ORDER BY g.rolname) FROM pg_catalog.pg_auth_members m
               JOIN pg_catalog.pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
            r.rolconnlimit, (r.rolvaliduntil IS NOT NULL) AS valid_until_set,
            (SELECT array_agg(u.rolname ORDER BY u.rolname) FROM pg_catalog.pg_auth_members m
               JOIN pg_catalog.pg_roles u ON u.oid = m.member WHERE m.roleid = r.oid) AS members
       FROM pg_catalog.pg_roles r WHERE r.rolname = $1`,
    [name],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    name,
    super: row.rolsuper,
    login: row.rolcanlogin,
    createdb: row.rolcreatedb,
    createrole: row.rolcreaterole,
    replication: row.rolreplication,
    bypassrls: row.rolbypassrls,
    inherit: row.rolinherit,
    memberOf: row.member_of ?? [],
    connectionLimit: row.rolconnlimit,
    validUntilSet: row.valid_until_set,
    members: row.members ?? [],
  };
}

/**
 * Task 012B (Q2; F6): whether a role has a password, as a Boolean only. Admin
 * mode only: `pg_authid` is readable by a superuser alone. The password column
 * itself is never selected. Undefined when the role does not exist.
 */
export async function readPasswordPresence(admin: PgClient, name: string): Promise<boolean | undefined> {
  const result = await admin.query<{ present: boolean }>(
    `SELECT (a.rolpassword IS NOT NULL) AS present FROM pg_catalog.pg_authid a WHERE a.rolname = $1`,
    [name],
  );
  return result.rows[0]?.present;
}

/** Every ACL entry on irs_test_meta and its sentinel table, as `grantee privilege`. */
export async function sentinelAcl(client: PgClient): Promise<string[]> {
  const result = await client.query<{ entry: string }>(
    `SELECT 'SCHEMA ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
              || ' ' || a.privilege_type AS entry
       FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'irs_test_meta'
     UNION ALL
     SELECT 'TABLE ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
              || ' ' || a.privilege_type
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            aclexplode(c.relacl) a WHERE n.nspname = 'irs_test_meta' AND c.relname = 'sentinel'
     ORDER BY 1`,
  );
  return result.rows.map((row) => row.entry).sort();
}

/** Expected ACL on irs_test_meta: the owner postgres, plus read access for the given roles. */
export function expectedSentinelAcl(readers: readonly string[]): string[] {
  const owner = [
    "SCHEMA postgres CREATE",
    "SCHEMA postgres USAGE",
    ...["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"].map(
      (privilege) => `TABLE postgres ${privilege}`,
    ),
  ];
  const read = readers.flatMap((role) => [`SCHEMA ${role} USAGE`, `TABLE ${role} SELECT`]);
  return [...owner, ...read].sort();
}
