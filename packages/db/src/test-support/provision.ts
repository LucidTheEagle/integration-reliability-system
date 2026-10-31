import { assertServerBaseline } from "./baseline.js";
import { connectGuarded, expectedGrantsInMain, grantsHeldBy } from "./guard.js";
import { readPasswordPresence, readRole } from "./inspect.js";
import type { PgClient } from "./pg.js";
import { runPrismaCli } from "./prisma-cli.js";
import {
  APPLICATION_GRANTS,
  LOCK_OWNER_ROLE,
  ROLE_PROFILES,
  STATUS_FUNCTION,
  grantKey,
  grantStatement,
} from "./registry.js";

// Provisioning (admin mode): apply the migration, give the status function
// its NOLOGIN owner, and apply the registry's grants. Grants belong here,
// never in the migration (Addendum VPF-3a, VPF-3b).

export const STATUS_FUNCTION_SIGNATURE = `"public"."${STATUS_FUNCTION}"(uuid)`;

/** Task 012B (B1-4, Q1): the dispatch-marker trigger function; nobody is granted EXECUTE on it. */
export const DISPATCH_TRIGGER_FUNCTION = "irs_event_dispatch_marker_guard";

/**
 * Task 012B (Q2, PL-6.2): one registered role against its profile, in both
 * directions. Admin mode (password presence reads pg_authid). Booleans and
 * names only; no password, hash or expiry value is ever read.
 */
export async function roleProfileProblemsOf(admin: PgClient, name: string): Promise<string[]> {
  const profile = ROLE_PROFILES[name];
  if (profile === undefined) return [`${name}: no registered profile`];
  const record = await readRole(admin, name);
  if (record === undefined) return [`${name}: role not found`];
  const problems: string[] = [];
  for (const attribute of ["super", "createdb", "createrole", "replication", "bypassrls"] as const) {
    if (record[attribute] !== false) problems.push(`${name}: ${attribute}`);
  }
  if (record.login !== profile.login) problems.push(`${name}: login ${String(record.login)}`);
  if (record.inherit !== profile.inherit) problems.push(`${name}: inherit ${String(record.inherit)}`);
  if (record.connectionLimit !== profile.connectionLimit) problems.push(`${name}: connection limit ${record.connectionLimit}`);
  if (record.validUntilSet) problems.push(`${name}: valid-until is set`);
  if (record.memberOf.length !== 0) problems.push(`${name}: member of ${record.memberOf.join(", ")}`);
  if (record.members.length !== 0) problems.push(`${name}: has members ${record.members.join(", ")}`);
  const password = await readPasswordPresence(admin, name);
  if (password !== false) problems.push(`${name}: password present (${String(password)})`);
  return problems;
}

/** Task 012B (Q2): every registered role that exists, or the given roles, against its profile. */
export async function roleProfileProblems(
  admin: PgClient,
  roles: readonly string[] = Object.keys(ROLE_PROFILES),
): Promise<string[]> {
  const problems: string[] = [];
  for (const role of roles) problems.push(...(await roleProfileProblemsOf(admin, role)));
  return problems;
}

export function expectedGrantsOf(role: string): string[] {
  if (role === LOCK_OWNER_ROLE) {
    // The owner's implicit EXECUTE appears in the ACL once it is materialised.
    return [
      ...(APPLICATION_GRANTS[role] ?? []).map(grantKey),
      `FUNCTION public.${STATUS_FUNCTION} EXECUTE`,
    ].sort();
  }
  return expectedGrantsInMain(role);
}

export async function grantProblems(client: PgClient): Promise<string[]> {
  const problems: string[] = [];
  for (const role of Object.keys(APPLICATION_GRANTS)) {
    const held = await grantsHeldBy(client, role);
    const expected = expectedGrantsOf(role);
    if (JSON.stringify(held) !== JSON.stringify(expected)) {
      problems.push(`${role}: held ${JSON.stringify(held)} expected ${JSON.stringify(expected)}`);
    }
  }
  const fn = (
    await client.query<{ owner: string; public_execute: boolean }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1`,
      [STATUS_FUNCTION],
    )
  ).rows;
  if (fn.length !== 1) problems.push(`status function rows: ${fn.length}`);
  if (fn[0]?.owner !== LOCK_OWNER_ROLE) problems.push(`status function owner ${fn[0]?.owner ?? "?"}`);
  if (fn[0]?.public_execute !== false) problems.push("PUBLIC has EXECUTE on the status function");
  // Task 012B (Q1): the trigger function exists once and the PUBLIC pseudo-role
  // (spelled 'public' in privilege-inquiry functions) has no EXECUTE on it.
  const trigger = (
    await client.query<{ public_execute: boolean }>(
      `SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1`,
      [DISPATCH_TRIGGER_FUNCTION],
    )
  ).rows;
  if (trigger.length !== 1) problems.push(`trigger function rows: ${trigger.length}`);
  if (trigger[0]?.public_execute !== false) problems.push("PUBLIC has EXECUTE on the trigger function");
  return problems;
}

/**
 * Applies the function owner and the registry grants to a migrated scratch
 * database (admin mode), mirroring the irs_011_test provisioning for the
 * given roles, plus any test-specific statements.
 */
/**
 * Task 011A (founder decision P-011A-2): the only table whose grants a
 * scratch database may lack, because RD-T4 deploys a migration history that
 * predates it. Any other missing table still fails the GRANT, as before.
 */
const SKIPPABLE_SCRATCH_TABLE = "RateLimitEvidence";

export async function grantScratch(
  scratchUrl: string,
  roles: readonly string[],
  extraStatements: readonly string[] = [],
): Promise<void> {
  const scratch = await connectGuarded({ url: scratchUrl, mode: "admin", applicationName: "irs-test-scratch-grants" });
  try {
    const evidenceTable = await scratch.client.query<{ t: string | null }>(
      `SELECT to_regclass('"public"."${SKIPPABLE_SCRATCH_TABLE}"')::text AS t`,
    );
    const evidenceTableAbsent = evidenceTable.rows[0]?.t == null;
    await scratch.client.query("BEGIN");
    await scratch.client.query(`ALTER FUNCTION ${STATUS_FUNCTION_SIGNATURE} OWNER TO "${LOCK_OWNER_ROLE}"`);
    for (const role of [LOCK_OWNER_ROLE, ...roles]) {
      for (const grant of APPLICATION_GRANTS[role] ?? []) {
        if (
          evidenceTableAbsent &&
          (grant.kind === "TABLE" || grant.kind === "COLUMN") &&
          grant.table === SKIPPABLE_SCRATCH_TABLE
        ) {
          process.stdout.write(
            `[scratch-grants] skipped ${grantKey(grant)} for ${role}: "public"."${SKIPPABLE_SCRATCH_TABLE}" absent\n`,
          );
          continue;
        }
        await scratch.client.query(grantStatement(grant, role));
      }
    }
    for (const statement of extraStatements) await scratch.client.query(statement);
    await scratch.client.query("COMMIT");
  } catch (error) {
    await scratch.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await scratch.close();
  }
}

/** migrate deploy of the committed migrations into a scratch database (P4), then grantScratch. */
export async function migrateScratch(
  scratchUrl: string,
  roles: readonly string[],
  extraStatements: readonly string[] = [],
): Promise<void> {
  const deploy = await runPrismaCli(["migrate", "deploy", "--config", "prisma7.config.ts"], { DATABASE_URL: scratchUrl });
  if (deploy.exitCode !== 0) throw new Error(`migrate deploy into scratch failed: ${deploy.stderr}`);
  await grantScratch(scratchUrl, roles, extraStatements);
}

export async function provision(adminUrl: string): Promise<string[]> {
  const evidence: string[] = [];
  const admin = await connectGuarded({ url: adminUrl, mode: "admin", applicationName: "irs-test-provision" });
  try {
    await assertServerBaseline(admin.client);
    const deploy = await runPrismaCli(["migrate", "deploy", "--config", "prisma7.config.ts"], {
      DATABASE_URL: adminUrl,
    });
    evidence.push(`migrate deploy exit ${deploy.exitCode}`, deploy.stdout.trim(), deploy.stderr.trim());
    if (deploy.exitCode !== 0) throw new Error("migrate deploy failed; provisioning stopped");

    await admin.client.query("BEGIN");
    try {
      await admin.client.query(`ALTER FUNCTION ${STATUS_FUNCTION_SIGNATURE} OWNER TO "${LOCK_OWNER_ROLE}"`);
      for (const [role, grants] of Object.entries(APPLICATION_GRANTS)) {
        for (const grant of grants) await admin.client.query(grantStatement(grant, role));
      }
      await admin.client.query("COMMIT");
    } catch (error) {
      await admin.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    evidence.push(`function owner set to ${LOCK_OWNER_ROLE}; registry grants applied`);

    const problems = await grantProblems(admin.client);
    if (problems.length > 0) throw new Error(`provisioning verification failed: ${problems.join("; ")}`);
    evidence.push("verified: exact grant sets, function owner, no PUBLIC EXECUTE (status and trigger functions)");
    const roleProblems = await roleProfileProblems(admin.client);
    if (roleProblems.length > 0) throw new Error(`role profile verification failed: ${roleProblems.join("; ")}`);
    evidence.push("verified: every registered role matches its profile in both directions (password absent: Boolean only)");
    await assertServerBaseline(admin.client);
    return evidence;
  } finally {
    await admin.close();
  }
}
