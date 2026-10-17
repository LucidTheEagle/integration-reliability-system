import { assertServerBaseline } from "./baseline.js";
import { connectGuarded, expectedGrantsInMain, grantsHeldBy } from "./guard.js";
import type { PgClient } from "./pg.js";
import { runPrismaCli } from "./prisma-cli.js";
import {
  APPLICATION_GRANTS,
  LOCK_OWNER_ROLE,
  STATUS_FUNCTION,
  grantKey,
  grantStatement,
} from "./registry.js";

// Provisioning (admin mode): apply the migration, give the status function
// its NOLOGIN owner, and apply the registry's grants. Grants belong here,
// never in the migration (Addendum VPF-3a, VPF-3b).

export const STATUS_FUNCTION_SIGNATURE = `"public"."${STATUS_FUNCTION}"(uuid)`;

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
  return problems;
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
    evidence.push("verified: exact grant sets, function owner, no PUBLIC EXECUTE");
    await assertServerBaseline(admin.client);
    return evidence;
  } finally {
    await admin.close();
  }
}
