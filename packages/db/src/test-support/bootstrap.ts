import { readServerBaseline } from "./baseline.js";
import { openClient, validateTarget, verifyPostConnect, withDatabase } from "./guard.js";
import type { GuardedConnection } from "./guard.js";
import {
  emptinessProblems,
  expectedSentinelAcl,
  listDatabases,
  listRoles,
  readContents,
  readRole,
  sentinelAcl,
} from "./inspect.js";
import type { PgClient } from "./pg.js";
import {
  ADMIN_ROLE,
  BOOTSTRAP_ROLES,
  MAIN_DATABASE,
  MAIN_SENTINEL_ROLES,
  SENTINEL_MARKER,
  SHADOW_DATABASE,
  scratchDatabaseName,
  scratchPurposeOf,
} from "./registry.js";

// Bootstrap procedures (Prompt B §4.2, path P2). They initialise databases
// that cannot carry a sentinel yet. Any unexpected state or failure stops
// with a description of the state: nothing is retried, repaired, cleaned
// up or done in admin mode instead.

export class BootstrapStop extends Error {
  override readonly name = "BootstrapStop";
  constructor(
    readonly step: string,
    readonly state: readonly string[],
  ) {
    super(`bootstrap stopped at ${step}: ${state.join("; ")}`);
  }
}

const EXPECTED_INITIAL_DATABASES = [MAIN_DATABASE, "postgres", "template0", "template1"];

async function identityProblems(client: PgClient, database: string): Promise<string[]> {
  const row = (
    await client.query<{ db: string; version: string; usr: string }>(
      "SELECT current_database() AS db, current_setting('server_version_num') AS version, current_user AS usr",
    )
  ).rows[0];
  const problems: string[] = [];
  if (row?.db !== database) problems.push(`current_database ${row?.db ?? "?"}`);
  if (Number(row?.version) < 170000) problems.push(`server_version_num ${row?.version ?? "?"}`);
  if (row?.usr !== ADMIN_ROLE) problems.push(`current_user ${row?.usr ?? "?"}`);
  return problems;
}

/** The §0 item 5(b) checks, host-side and read-only, through the URL itself. */
async function mainPreconditionProblems(client: PgClient): Promise<string[]> {
  await client.query("BEGIN READ ONLY");
  try {
    const problems = await identityProblems(client, MAIN_DATABASE);
    const readOnly = (await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only"))
      .rows[0]?.transaction_read_only;
    if (readOnly !== "on") problems.push(`transaction_read_only ${readOnly ?? "?"}`);
    problems.push(...emptinessProblems(await readContents(client)));
    const roles = await listRoles(client);
    if (JSON.stringify(roles) !== JSON.stringify([ADMIN_ROLE])) {
      problems.push(`roles other than postgres and pg_*: ${roles.filter((r) => r !== ADMIN_ROLE).join(", ")}`);
    }
    const baseline = await readServerBaseline(client);
    if (baseline.roleSettings !== 0) problems.push(`${baseline.roleSettings} pg_db_role_setting rows`);
    if (baseline.autoConfEntries !== 0) problems.push(`${baseline.autoConfEntries} postgresql.auto.conf entries`);
    const databases = await listDatabases(client);
    if (JSON.stringify(databases) !== JSON.stringify([...EXPECTED_INITIAL_DATABASES].sort())) {
      problems.push(`databases: ${databases.join(", ")}`);
    }
    return problems;
  } finally {
    await client.query("COMMIT");
  }
}

async function createSentinel(
  client: PgClient,
  database: string,
  readers: readonly string[],
  extra: readonly string[] = [],
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`CREATE SCHEMA "irs_test_meta"`);
    await client.query(`REVOKE ALL ON SCHEMA "irs_test_meta" FROM PUBLIC`);
    await client.query(
      `CREATE TABLE "irs_test_meta"."sentinel" (database_name text PRIMARY KEY, marker uuid NOT NULL)`,
    );
    await client.query(`REVOKE ALL ON TABLE "irs_test_meta"."sentinel" FROM PUBLIC`);
    await client.query(
      `INSERT INTO "irs_test_meta"."sentinel" (database_name, marker) VALUES ($1, $2)`,
      [database, SENTINEL_MARKER],
    );
    for (const statement of extra) await client.query(statement);
    for (const role of readers) {
      await client.query(`GRANT USAGE ON SCHEMA "irs_test_meta" TO "${role}"`);
      await client.query(`GRANT SELECT ON TABLE "irs_test_meta"."sentinel" TO "${role}"`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function sentinelProblems(
  client: PgClient,
  database: string,
  readers: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  try {
    await verifyPostConnect(client, { database, user: ADMIN_ROLE, mode: "admin" });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "post-connect check failed");
  }
  const acl = await sentinelAcl(client);
  const expected = expectedSentinelAcl(readers);
  if (JSON.stringify(acl) !== JSON.stringify(expected)) {
    problems.push(`sentinel ACL ${JSON.stringify(acl)} != expected ${JSON.stringify(expected)}`);
  }
  return problems;
}

function roleStatement(name: string, login: boolean): string {
  return `CREATE ROLE "${name}" ${login ? "LOGIN" : "NOLOGIN"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
}

export interface BootstrapMainResult {
  /** The bootstrap-main connection, kept open for bootstrap-shadow. */
  readonly client: PgClient;
  readonly evidence: readonly string[];
}

/** bootstrap-main: runs once, on irs_011_test only, before any other setup. */
export async function bootstrapMain(adminUrl: string): Promise<BootstrapMainResult> {
  const target = validateTarget(adminUrl, "admin");
  if (target.database !== MAIN_DATABASE) {
    throw new BootstrapStop("target", [`bootstrap-main accepts only ${MAIN_DATABASE}`]);
  }
  const client = await openClient(adminUrl, "irs-test-bootstrap-main");
  const evidence: string[] = [];
  try {
    const before = await mainPreconditionProblems(client);
    if (before.length > 0) throw new BootstrapStop("preconditions", before);
    evidence.push("preconditions: §0 item 5(b) checks passed host-side, read-only");

    try {
      await createSentinel(
        client,
        MAIN_DATABASE,
        MAIN_SENTINEL_ROLES,
        BOOTSTRAP_ROLES.map((role) => roleStatement(role.name, role.login)),
      );
    } catch (error) {
      throw new BootstrapStop("create", [
        `transaction failed and was rolled back: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
    }
    evidence.push(`created irs_test_meta.sentinel row for ${MAIN_DATABASE} and roles ${BOOTSTRAP_ROLES.map((r) => r.name).join(", ")}`);

    const after = await sentinelProblems(client, MAIN_DATABASE, MAIN_SENTINEL_ROLES);
    for (const role of BOOTSTRAP_ROLES) {
      const record = await readRole(client, role.name);
      if (
        record === undefined ||
        record.login !== role.login ||
        record.super ||
        record.createdb ||
        record.createrole ||
        record.replication ||
        record.bypassrls ||
        record.memberOf.length !== 0
      ) {
        after.push(`role ${role.name} attributes ${JSON.stringify(record)}`);
      }
    }
    const roles = await listRoles(client);
    const expectedRoles = [ADMIN_ROLE, ...BOOTSTRAP_ROLES.map((r) => r.name)].sort();
    if (JSON.stringify(roles) !== JSON.stringify(expectedRoles)) after.push(`roles: ${roles.join(", ")}`);
    if (after.length > 0) throw new BootstrapStop("re-verify", after);
    evidence.push("re-verified: sentinel, marker, role attributes, memberships, exact sentinel ACL");
    return { client, evidence };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

/**
 * bootstrap-shadow: immediately after bootstrap-main, from its connection.
 * CREATE DATABASE has no IF NOT EXISTS, so an existing database stops it.
 */
export async function bootstrapShadow(mainClient: PgClient, adminUrl: string): Promise<string[]> {
  const evidence: string[] = [];
  try {
    await mainClient.query(`CREATE DATABASE "${SHADOW_DATABASE}" TEMPLATE template0`);
  } catch (error) {
    throw new BootstrapStop("create-database", [
      `CREATE DATABASE ${SHADOW_DATABASE} failed: ${error instanceof Error ? error.message : "unknown"}`,
    ]);
  }
  evidence.push(`created database ${SHADOW_DATABASE} from template0`);
  const shadowUrl = withDatabase(adminUrl, SHADOW_DATABASE);
  validateTarget(shadowUrl, "admin");
  const shadow = await openClient(shadowUrl, "irs-test-bootstrap-shadow");
  try {
    const before = [
      ...(await identityProblems(shadow, SHADOW_DATABASE)),
      ...emptinessProblems(await readContents(shadow)),
    ];
    if (before.length > 0) throw new BootstrapStop("shadow-empty", before);
    try {
      await createSentinel(shadow, SHADOW_DATABASE, []);
    } catch (error) {
      throw new BootstrapStop("shadow-create", [
        `transaction failed and was rolled back: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
    }
    const after = await sentinelProblems(shadow, SHADOW_DATABASE, []);
    if (after.length > 0) throw new BootstrapStop("shadow-re-verify", after);
    evidence.push(`created and re-verified the ${SHADOW_DATABASE} sentinel; no role other than postgres has privileges on it`);
    return evidence;
  } finally {
    await shadow.end().catch(() => undefined);
  }
}

/** bootstrap-scratch: a registered scratch database, from a guarded admin connection to irs_011_test. */
export async function bootstrapScratch(
  admin: GuardedConnection,
  adminUrl: string,
  purpose: string,
): Promise<string> {
  const database = scratchDatabaseName(purpose);
  const registered = scratchPurposeOf(database);
  if (registered === undefined) throw new BootstrapStop("scratch-purpose", [`${purpose} is not registered`]);
  if (admin.target.database !== MAIN_DATABASE || admin.target.user !== ADMIN_ROLE) {
    throw new BootstrapStop("scratch-source", ["requires a guarded admin connection to irs_011_test"]);
  }
  try {
    await admin.client.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  } catch (error) {
    throw new BootstrapStop("scratch-create-database", [
      `CREATE DATABASE ${database} failed: ${error instanceof Error ? error.message : "unknown"}`,
    ]);
  }
  const url = withDatabase(adminUrl, database);
  validateTarget(url, "admin");
  const scratch = await openClient(url, "irs-test-bootstrap-scratch");
  try {
    const before = [
      ...(await identityProblems(scratch, database)),
      ...emptinessProblems(await readContents(scratch)),
    ];
    if (before.length > 0) throw new BootstrapStop("scratch-empty", before);
    await createSentinel(scratch, database, registered.sentinelRoles);
    const after = await sentinelProblems(scratch, database, registered.sentinelRoles);
    if (after.length > 0) throw new BootstrapStop("scratch-re-verify", after);
    process.stdout.write(`[scratch] created ${database}\n`);
    return url;
  } finally {
    await scratch.end().catch(() => undefined);
  }
}

/** Drops a registered scratch database (admin mode) and verifies that it is gone. */
export async function dropScratch(admin: GuardedConnection, purpose: string): Promise<void> {
  const database = scratchDatabaseName(purpose);
  if (scratchPurposeOf(database) === undefined) throw new Error(`${purpose} is not a registered scratch purpose`);
  await admin.client.query(`DROP DATABASE "${database}"`);
  const remaining = (await listDatabases(admin.client)).filter((name) => name === database);
  if (remaining.length !== 0) throw new Error(`${database} still exists after DROP DATABASE`);
  process.stdout.write(`[scratch] dropped ${database} (verified absent)\n`);
}
