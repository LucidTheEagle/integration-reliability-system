import { readServerBaseline } from "./baseline.js";
import { connectGuarded } from "./guard.js";
import type { GuardedConnection } from "./guard.js";
import type { PgClient } from "./pg.js";

// The FD-6 COMMIT stall (DB-T20, DL-PG-2), with the FD-14 harness fix for
// the SyncRep setup race (HC-6). Mechanism unchanged: synchronous_commit =
// local server-wide, a non-existent synchronous standby, and
// synchronous_commit = on for irs_test_api_role_setting only, so only that
// role's COMMITs wait.
//
// HC-6: an admin session that committed right after pg_reload_conf(), before
// applying the reload itself, still had synchronous_commit = on and waited
// on SyncRep indefinitely. So every admin, observer and clean-up session
// here pins synchronous_commit = local at session level before any statement
// that commits; the role setting is made while no standby is configured;
// the revert releases waiters before anything else; and every step is
// bounded by a 10 s watchdog, after which the revert runs from a fresh
// pinned session and the caller fails with a named reason.

export const STALL_ROLE = "irs_test_api_role_setting";
export const NO_SUCH_STANDBY = "irs_011_no_such_standby";
export const STEP_TIMEOUT_MS = 10_000;

/** A setup or revert step exceeded the watchdog; the message names the step. */
export class SyncRepStepTimeoutError extends Error {
  override readonly name = "SyncRepStepTimeoutError";
  constructor(readonly step: string) {
    super(`SyncRep stall step exceeded ${STEP_TIMEOUT_MS} ms: ${step}`);
  }
}

/** The revert could not restore and verify the server baseline. */
export class SyncRepRevertError extends Error {
  override readonly name = "SyncRepRevertError";
}

async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SyncRepStepTimeoutError(name)), STEP_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([work(), watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Admin mode, with synchronous_commit = local pinned for this session before anything commits. */
export async function pinnedAdmin(adminUrl: string, applicationName: string): Promise<GuardedConnection> {
  const connection = await connectGuarded({ url: adminUrl, mode: "admin", applicationName });
  await pinSession(connection.client);
  return connection;
}

/** Pins synchronous_commit = local for an existing admin or observer session. */
export async function pinSession(client: PgClient): Promise<void> {
  await client.query("SET synchronous_commit = local");
}

async function closeQuietly(connection: GuardedConnection): Promise<void> {
  await step("close session", () => connection.close()).catch(() => undefined);
}

/** Reads settings from a new pinned session (the reload is visible to new sessions). */
async function freshSettings(adminUrl: string): Promise<{ commit: string; standby: string }> {
  const probe = await pinnedAdmin(adminUrl, "irs-test-syncrep-probe");
  try {
    // A new session reads the configured synchronous_commit, not the pinned one, via the reset value.
    const row = (
      await probe.client.query<{ commit: string; standby: string }>(
        `SELECT (SELECT reset_val FROM pg_catalog.pg_settings WHERE name = 'synchronous_commit') AS commit,
                current_setting('synchronous_standby_names') AS standby`,
      )
    ).rows[0];
    return { commit: row?.commit ?? "?", standby: row?.standby ?? "?" };
  } finally {
    await closeQuietly(probe);
  }
}

async function until(adminUrl: string, wanted: { commit?: string; standby?: string }): Promise<void> {
  for (;;) {
    const seen = await freshSettings(adminUrl);
    if ((wanted.commit === undefined || seen.commit === wanted.commit) && (wanted.standby === undefined || seen.standby === wanted.standby)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Starts the stall. `admin` must be a pinned admin session. On any failure
 * (including a watchdog timeout) the revert runs from a fresh pinned session
 * and the original error is rethrown.
 */
export async function stallCommits(adminUrl: string, admin: PgClient, label: string): Promise<void> {
  try {
    await step("setup: ALTER ROLE … SET synchronous_commit = on (no standby configured yet)", () =>
      admin.query(`ALTER ROLE "${STALL_ROLE}" SET synchronous_commit = 'on'`),
    );
    await step("setup: ALTER SYSTEM SET synchronous_commit = local", () =>
      admin.query(`ALTER SYSTEM SET synchronous_commit = 'local'`),
    );
    await step("setup: ALTER SYSTEM SET synchronous_standby_names", () =>
      admin.query(`ALTER SYSTEM SET synchronous_standby_names = '${NO_SUCH_STANDBY}'`),
    );
    await step("setup: reload", () => admin.query("SELECT pg_reload_conf()"));
    await step("setup: settings active in a new session", () => until(adminUrl, { commit: "local", standby: NO_SUCH_STANDBY }));
    await step("setup: role setting present", async () => {
      const rows = (
        await admin.query<{ setconfig: string[] }>(
          `SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole WHERE r.rolname = $1`,
          [STALL_ROLE],
        )
      ).rows;
      if (!rows.some((row) => row.setconfig.includes("synchronous_commit=on"))) {
        throw new SyncRepRevertError(`setup: ${STALL_ROLE} has no synchronous_commit=on setting`);
      }
    });
    process.stdout.write(`[${label}] stall active: ${STALL_ROLE} synchronous_commit=on; synchronous_commit=local; synchronous_standby_names=${NO_SUCH_STANDBY}\n`);
  } catch (error) {
    process.stdout.write(`[${label}] stall setup failed (${error instanceof Error ? error.message : "unknown"}); reverting from a fresh pinned session\n`);
    await revertCommitStall(adminUrl, `${label} (setup failed)`);
    throw error;
  }
}

async function revertSteps(adminUrl: string): Promise<void> {
  const session = await pinnedAdmin(adminUrl, "irs-test-syncrep-revert");
  try {
    await step("revert: ALTER SYSTEM RESET synchronous_standby_names", () =>
      session.client.query("ALTER SYSTEM RESET synchronous_standby_names"),
    );
    await step("revert: reload (releases waiters)", () => session.client.query("SELECT pg_reload_conf()"));
    await step("revert: no standby configured in a new session", () => until(adminUrl, { standby: "" }));
    await step("revert: ALTER ROLE … RESET synchronous_commit", () =>
      session.client.query(`ALTER ROLE "${STALL_ROLE}" RESET synchronous_commit`),
    );
    await step("revert: ALTER SYSTEM RESET synchronous_commit", () => session.client.query("ALTER SYSTEM RESET synchronous_commit"));
    await step("revert: reload", () => session.client.query("SELECT pg_reload_conf()"));
    await step("revert: synchronous_commit on in a new session", () => until(adminUrl, { commit: "on", standby: "" }));
  } finally {
    await closeQuietly(session);
  }
}

/**
 * Reverts the stall from a fresh pinned session (a second fresh session if a
 * step exceeds the watchdog), then verifies the baseline from another fresh
 * pinned session. Throws SyncRepRevertError, naming the cause, if the
 * baseline is not restored.
 */
export async function revertCommitStall(adminUrl: string, label: string): Promise<void> {
  try {
    await revertSteps(adminUrl);
  } catch (first) {
    process.stdout.write(`[${label}] revert attempt failed (${first instanceof Error ? first.message : "unknown"}); retrying from a fresh pinned session\n`);
    try {
      await revertSteps(adminUrl);
    } catch (second) {
      throw new SyncRepRevertError(
        `STOP: ${label} revert failed twice: ${second instanceof Error ? second.message : "unknown"}`,
      );
    }
  }
  const verifier = await pinnedAdmin(adminUrl, "irs-test-syncrep-verify");
  try {
    const baseline = await step("revert: baseline read", () => readServerBaseline(verifier.client));
    const settings = await step("revert: settings read", () => freshSettings(adminUrl));
    process.stdout.write(
      `[${label}] revert: pg_db_role_setting ${baseline.roleSettings}; auto.conf ${baseline.autoConfEntries}; ` +
        `synchronous_commit ${settings.commit}; synchronous_standby_names '${settings.standby}'\n`,
    );
    if (baseline.roleSettings !== 0 || baseline.autoConfEntries !== 0 || settings.commit !== "on" || settings.standby !== "") {
      throw new SyncRepRevertError(`STOP: ${label} revert verification failed; server-wide settings are not at baseline`);
    }
  } finally {
    await closeQuietly(verifier);
  }
}
