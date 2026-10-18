import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardRefusal, connectGuarded, validateTarget } from "./guard.js";

// Path P4 (Prompt B §4.1): the only way a Prisma CLI child process receives
// a test-database URL. Before spawning, every URL the child will receive is
// checked by the guard (structure, then post-connect checks including the
// sentinel, through its own admin connection), and .env must be absent.
// The URLs exist only in the child's environment. After the child exits,
// the post-connect checks run again; a missing sentinel stops the run.

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PRISMA_CLI = join(REPO_ROOT, "node_modules", "prisma", "build", "index.js");

export interface PrismaRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function checkTargets(urls: readonly string[], phase: string): Promise<void> {
  for (const url of urls) {
    validateTarget(url, "admin");
    let connection;
    try {
      connection = await connectGuarded({ url, mode: "admin", applicationName: `irs-test-p4-${phase}` });
    } catch (error) {
      if (error instanceof GuardRefusal) {
        throw new GuardRefusal(`p4-${phase}`, error.message);
      }
      throw error;
    }
    await connection.close();
  }
}

function redact(text: string, urls: readonly string[]): string {
  return urls.reduce((result, url) => result.split(url).join("<test-database-url>"), text);
}

/**
 * `childEnv` holds test-database URLs only; each is checked by the guard.
 * `extraEnv` holds non-URL values (for example a migrations directory).
 */
export async function runPrismaCli(
  args: readonly string[],
  childEnv: Readonly<Record<string, string>>,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<PrismaRun> {
  for (const value of Object.values(extraEnv)) {
    if (/^postgres(ql)?:/i.test(value)) throw new Error("URLs belong in childEnv, where the guard checks them");
  }
  if (!args.includes("--config")) {
    throw new Error("every Prisma command takes an explicit --config");
  }
  if (existsSync(join(REPO_ROOT, ".env"))) {
    throw new GuardRefusal("env-file", ".env exists in the repository root");
  }
  const urls = Object.values(childEnv);
  await checkTargets(urls, "before");

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["DATABASE_URL"];
  delete env["IRS_DRIFT_DATASOURCE_URL"];
  delete env["IRS_DRIFT_SHADOW_DATABASE_URL"];
  delete env["IRS_PROBE_DATASOURCE_URL"];
  delete env["IRS_PROBE_MIGRATIONS_DIR"];
  Object.assign(env, extraEnv, childEnv);
  // FD-5: no Prisma update or telemetry check from test runs.
  env["CHECKPOINT_DISABLE"] = "1";

  const run = await new Promise<PrismaRun>((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA_CLI, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({ exitCode, stdout: redact(stdout, urls), stderr: redact(stderr, urls) }),
    );
  });

  await checkTargets(urls, "after");
  return run;
}
