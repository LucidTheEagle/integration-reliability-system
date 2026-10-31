import { pg } from "./pg.js";
import type { PgClient } from "./pg.js";
import {
  ADMIN_ROLE,
  API_ROLE,
  APPLICATION_GRANTS,
  MAIN_DATABASE,
  MAIN_SENTINEL_ROLES,
  ROLE_PROFILES,
  SENTINEL_MARKER,
  SHADOW_DATABASE,
  SPECIAL_ROLES,
  TEST_HOST,
  TEST_PORT,
  WORKER_ROLE,
  grantKey,
  scratchPurposeOf,
} from "./registry.js";

// The test-database guard (Prompt B §4.1–§4.2). Every test connection
// (P3), bootstrap connection (P2) and Prisma CLI target (P4) goes through
// it. A refusal names the failed check and never includes the URL.
// Task 012B (B1-8, Q2): mode `worker` connects as irs_test_worker and also
// checks its registered profile (NOINHERIT, connection limit, no expiry, no
// member roles) and its exact grant set.

export type GuardMode = "api" | "admin" | "special" | "worker";

export class GuardRefusal extends Error {
  override readonly name = "GuardRefusal";
  constructor(
    readonly check: string,
    detail: string,
  ) {
    super(`test-database guard refused (${check}): ${detail}`);
  }
}

export interface ParsedTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
}

/** Endpoint and database-name checks that hold in every mode. No connection. */
export function parseTestUrl(raw: string): ParsedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardRefusal("url", "not a valid URL");
  }
  if (url.protocol !== "postgresql:") throw new GuardRefusal("protocol", "must be postgresql:");
  if (url.hostname !== TEST_HOST) throw new GuardRefusal("host", `must be exactly ${TEST_HOST}`);
  if (url.port !== String(TEST_PORT)) throw new GuardRefusal("port", `must be exactly ${TEST_PORT}`);
  if (url.password !== "") throw new GuardRefusal("password", "the URL must not carry a password");
  if (url.search !== "" || raw.includes("?")) {
    throw new GuardRefusal("query", "the URL must not carry query parameters");
  }
  if (url.hash !== "") throw new GuardRefusal("fragment", "the URL must not carry a fragment");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  if (user === "") throw new GuardRefusal("user", "the URL must name a user");
  if (!isRegisteredDatabase(database)) {
    throw new GuardRefusal("database", `"${database}" is not a registered test database`);
  }
  return { host: url.hostname, port: TEST_PORT, database, user };
}

export function isRegisteredDatabase(database: string): boolean {
  return (
    database === MAIN_DATABASE ||
    database === SHADOW_DATABASE ||
    scratchPurposeOf(database) !== undefined
  );
}

function specialRole(name: string | undefined) {
  const role = SPECIAL_ROLES.find((entry) => entry.name === name);
  if (role === undefined) {
    throw new GuardRefusal("special-role", `"${name ?? ""}" is not a registered special role`);
  }
  return role;
}

export function expectedUser(mode: GuardMode, special?: string): string {
  switch (mode) {
    case "api":
      return API_ROLE;
    case "admin":
      return ADMIN_ROLE;
    case "special":
      return specialRole(special).name;
    case "worker":
      return WORKER_ROLE;
  }
}

/** All structural checks for a mode, including the mode/role pairing. No connection. */
export function validateTarget(raw: string, mode: GuardMode, special?: string): ParsedTarget {
  const target = parseTestUrl(raw);
  const user = expectedUser(mode, special);
  if (target.user !== user) {
    throw new GuardRefusal("mode-user", `mode ${mode} requires user ${user}`);
  }
  if (mode !== "admin" && target.database === SHADOW_DATABASE) {
    throw new GuardRefusal("mode-database", "only admin mode connects to the shadow database");
  }
  if (mode !== "admin" && target.database !== MAIN_DATABASE) {
    const purpose = scratchPurposeOf(target.database);
    if (purpose === undefined || !purpose.sentinelRoles.includes(user)) {
      throw new GuardRefusal("mode-database", `${user} is not registered for ${target.database}`);
    }
  }
  return target;
}

/** The same endpoint and user, a different registered database. */
export function withDatabase(raw: string, database: string): string {
  const url = new URL(raw);
  url.pathname = `/${database}`;
  const next = url.toString();
  parseTestUrl(next);
  return next;
}

/** The same endpoint and database, a different user (for special-mode URLs). */
export function withUser(raw: string, user: string): string {
  const url = new URL(raw);
  url.username = user;
  const next = url.toString();
  parseTestUrl(next);
  return next;
}

export interface PostConnectExpectation {
  readonly database: string;
  readonly user: string;
  readonly mode: GuardMode;
  /** Test seams for the refusal tests: verify against another row or marker. */
  readonly sentinelDatabase?: string;
  readonly sentinelMarker?: string;
}

const ROLE_ATTRIBUTES = ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"];
const SENTINEL_DENIED_TABLE_PRIVILEGES = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];

/** Post-connect checks (every mode except bootstrap). Throws GuardRefusal. */
export async function verifyPostConnect(
  client: PgClient,
  expected: PostConnectExpectation,
): Promise<void> {
  const identity = await client.query<{ db: string; version: string; usr: string }>(
    "SELECT current_database() AS db, current_setting('server_version_num') AS version, current_user AS usr",
  );
  const row = identity.rows[0];
  if (row === undefined) throw new GuardRefusal("identity", "no identity row");
  if (row.db !== expected.database) {
    throw new GuardRefusal("database", `connected to ${row.db}, expected ${expected.database}`);
  }
  if (Number(row.version) < 170000) {
    throw new GuardRefusal("server-version", `server_version_num ${row.version} < 170000`);
  }
  if (row.usr !== expected.user) {
    throw new GuardRefusal("current-user", `current_user is ${row.usr}, expected ${expected.user}`);
  }

  if (expected.mode !== "admin") {
    await verifyUnprivilegedRole(client, expected.user);
    if (expected.mode === "worker") await verifyWorkerProfile(client, expected.user);
    await verifySentinelPrivileges(client);
  }

  const sentinelDatabase = expected.sentinelDatabase ?? expected.database;
  let rows: { marker: string }[];
  try {
    rows = (
      await client.query<{ marker: string }>(
        `SELECT marker::text AS marker FROM "irs_test_meta"."sentinel" WHERE database_name = $1`,
        [sentinelDatabase],
      )
    ).rows;
  } catch {
    throw new GuardRefusal("sentinel", "the sentinel table cannot be read");
  }
  if (rows.length !== 1) {
    throw new GuardRefusal("sentinel", `no sentinel row for ${sentinelDatabase}`);
  }
  if (rows[0]?.marker !== (expected.sentinelMarker ?? SENTINEL_MARKER)) {
    throw new GuardRefusal("sentinel-marker", "the sentinel marker does not match");
  }

  if (expected.mode === "special") {
    await verifySpecialGrants(client, expected.user);
  }
  if (expected.mode === "worker") {
    await verifyWorkerGrants(client, expected.user);
  }
}

/**
 * Task 012B (Q2, PL-6.2): the worker-mode profile check, read from the
 * registry: login, NOINHERIT, the registered connection limit, no expiry, and
 * no role that is a member of it (the other direction is verifyUnprivilegedRole's).
 * Password presence is not readable here (F6): admin mode checks it.
 */
async function verifyWorkerProfile(client: PgClient, user: string): Promise<void> {
  // The worker's registered profile, whatever user is connected (PL-6.2: NOINHERIT, FD-1's limit).
  const profile = ROLE_PROFILES[WORKER_ROLE];
  if (profile === undefined) throw new GuardRefusal("role-profile", `${WORKER_ROLE} has no registered profile`);
  const row = (
    await client.query<{ rolcanlogin: boolean; rolinherit: boolean; rolconnlimit: number; valid_until_set: boolean }>(
      `SELECT rolcanlogin, rolinherit, rolconnlimit, (rolvaliduntil IS NOT NULL) AS valid_until_set
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [user],
    )
  ).rows[0];
  if (row === undefined) throw new GuardRefusal("role-profile", `role ${user} not found`);
  if (
    row.rolcanlogin !== profile.login ||
    row.rolinherit !== profile.inherit ||
    row.rolconnlimit !== profile.connectionLimit ||
    row.valid_until_set !== false
  ) {
    throw new GuardRefusal("role-profile", `${user} does not match its registered profile`);
  }
  const members = await client.query(
    `SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
      WHERE r.rolname = $1`,
    [user],
  );
  if (members.rows.length !== 0) {
    throw new GuardRefusal("role-members", `another role is a member of ${user}`);
  }
}

async function verifyWorkerGrants(client: PgClient, role: string): Promise<void> {
  const held = await grantsHeldBy(client, role);
  const expected = expectedGrantsInMain(WORKER_ROLE);
  if (JSON.stringify(held) !== JSON.stringify(expected)) {
    throw new GuardRefusal("worker-grants", `${role} does not hold exactly its registered grants`);
  }
}

async function verifyUnprivilegedRole(client: PgClient, user: string): Promise<void> {
  const attributes = await client.query<Record<string, boolean>>(
    `SELECT ${ROLE_ATTRIBUTES.join(", ")} FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [user],
  );
  const row = attributes.rows[0];
  if (row === undefined) throw new GuardRefusal("role-attributes", `role ${user} not found`);
  for (const attribute of ROLE_ATTRIBUTES) {
    if (row[attribute] !== false) {
      throw new GuardRefusal("role-attributes", `${user} has ${attribute}`);
    }
  }
  const memberships = await client.query(
    `SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE r.rolname = $1`,
    [user],
  );
  if (memberships.rows.length !== 0) {
    throw new GuardRefusal("role-memberships", `${user} is a member of another role`);
  }
}

async function verifySentinelPrivileges(client: PgClient): Promise<void> {
  // Schema privileges first: resolving the table name below needs USAGE.
  let schema: Record<string, boolean> | undefined;
  try {
    schema = (
      await client.query<Record<string, boolean>>(
        `SELECT has_schema_privilege(current_user, 'irs_test_meta', 'USAGE') AS usage,
                has_schema_privilege(current_user, 'irs_test_meta', 'CREATE') AS "create"`,
      )
    ).rows[0];
  } catch {
    throw new GuardRefusal("sentinel-privileges", "the sentinel privileges cannot be evaluated");
  }
  if (schema === undefined || schema["usage"] !== true) {
    throw new GuardRefusal("sentinel-privileges", "the role cannot read the sentinel");
  }
  if (schema["create"] !== false) {
    throw new GuardRefusal("sentinel-privileges", "the role has CREATE on irs_test_meta");
  }
  let row: Record<string, boolean> | undefined;
  try {
    row = (
      await client.query<Record<string, boolean>>(
        `SELECT has_table_privilege(current_user, 'irs_test_meta.sentinel', 'SELECT') AS "select",
                ${SENTINEL_DENIED_TABLE_PRIVILEGES.map(
                  (privilege) =>
                    `has_table_privilege(current_user, 'irs_test_meta.sentinel', '${privilege}') AS "${privilege.toLowerCase()}"`,
                ).join(", ")}`,
      )
    ).rows[0];
  } catch {
    throw new GuardRefusal("sentinel-privileges", "the sentinel privileges cannot be evaluated");
  }
  if (row === undefined || row["select"] !== true) {
    throw new GuardRefusal("sentinel-privileges", "the role cannot read the sentinel");
  }
  for (const privilege of SENTINEL_DENIED_TABLE_PRIVILEGES) {
    if (row[privilege.toLowerCase()] !== false) {
      throw new GuardRefusal("sentinel-privileges", `the role has ${privilege} on the sentinel`);
    }
  }
}

/** The privileges a role holds directly, read back from the ACL catalogs. */
export async function grantsHeldBy(client: PgClient, role: string): Promise<string[]> {
  const result = await client.query<{ grant: string }>(
    `WITH r AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
     SELECT 'SCHEMA ' || n.nspname || ' ' || a.privilege_type AS "grant"
       FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid
     UNION ALL
     SELECT 'TABLE ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
     UNION ALL
     SELECT 'COLUMN ' || n.nspname || '.' || c.relname || '.' || att.attname || ' ' || a.privilege_type
       FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            aclexplode(att.attacl) a, r WHERE a.grantee = r.oid
     UNION ALL
     SELECT 'FUNCTION ' || n.nspname || '.' || p.proname || ' ' || a.privilege_type
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
            aclexplode(p.proacl) a, r WHERE a.grantee = r.oid
     UNION ALL
     SELECT 'TYPE ' || n.nspname || '.' || t.typname || ' ' || a.privilege_type
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace,
            aclexplode(t.typacl) a, r WHERE a.grantee = r.oid
     UNION ALL
     SELECT 'DATABASE ' || d.datname || ' ' || a.privilege_type
       FROM pg_catalog.pg_database d, aclexplode(d.datacl) a, r WHERE a.grantee = r.oid
     ORDER BY 1`,
    [role],
  );
  return result.rows.map((row) => row.grant).sort();
}

/** The application grants the registry expects, plus the sentinel grants. */
export function expectedGrantsInMain(role: string): string[] {
  const application = (APPLICATION_GRANTS[role] ?? []).map(grantKey);
  // The API role, the special roles with sentinel privileges and (Task 012B) the worker.
  const sentinel = MAIN_SENTINEL_ROLES.includes(role)
    ? ["SCHEMA irs_test_meta USAGE", "TABLE irs_test_meta.sentinel SELECT"]
    : [];
  return [...application, ...sentinel].sort();
}

async function verifySpecialGrants(client: PgClient, role: string): Promise<void> {
  const held = await grantsHeldBy(client, role);
  const expected = expectedGrantsInMain(role);
  if (JSON.stringify(held) !== JSON.stringify(expected)) {
    throw new GuardRefusal("special-grants", `${role} does not hold exactly its registered grants`);
  }
}

export interface GuardedConnection {
  readonly client: PgClient;
  readonly target: ParsedTarget;
  close(): Promise<void>;
}

/** Opens a connection through the guard (P3). */
export async function connectGuarded(options: {
  readonly url: string;
  readonly mode: GuardMode;
  readonly special?: string;
  readonly applicationName?: string;
}): Promise<GuardedConnection> {
  const target = validateTarget(options.url, options.mode, options.special);
  const client = await openClient(options.url, options.applicationName ?? `irs-test-${options.mode}`);
  try {
    await verifyPostConnect(client, {
      database: target.database,
      user: target.user,
      mode: options.mode,
    });
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return { client, target, close: () => client.end() };
}

/** A raw client for an already-validated URL. Used only by the guard and bootstrap. */
export async function openClient(url: string, applicationName: string): Promise<PgClient> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    application_name: applicationName,
  });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

/** The test variables, by name only (Task 012B adds the worker's, B1-8). */
export type TestUrlVariable = "IRS_TEST_DATABASE_URL" | "IRS_TEST_ADMIN_DATABASE_URL" | "IRS_TEST_WORKER_DATABASE_URL";

/** Reads a required test variable; fails loudly, never skips. */
export function requireTestUrl(name: TestUrlVariable): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new GuardRefusal("environment", `${name} is not set; database tests cannot run`);
  }
  return value;
}
