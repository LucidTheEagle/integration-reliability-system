import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditTestRedis, safeReason } from "./redis-guard.js";
import type { TestRedisAudit } from "./redis-guard.js";
import { preflightFailureReason, preflightReport, runPreflight } from "./redis-preflight.js";
import type { PreflightResult } from "./redis-preflight.js";

// The `test:redis` suite runner (012B record Part A2 DF-4, and the partner's
// execution rule). After the build, `test:redis` runs only this file, which:
//   1. runs the preflight and records used_memory; if it refuses, no test runs;
//   2. runs the Redis tests as a child process and keeps its own exit status;
//   3. always attempts the post-run audit afterwards, whatever the result of
//      steps 1 and 2 (founder correction S1-C1: also after a preflight
//      refusal, with no before value to compare);
//   4. reports the test status and the audit outcome separately, then exits.
// It exits 0 only when the tests passed and the audit passed. Neither result
// masks the other, and a state that cannot be established is never a pass.

/** The child's arguments, relative to the package root; node --test expands the glob. */
export const REDIS_TEST_ARGUMENTS: readonly string[] = Object.freeze([
  "--test",
  "--test-concurrency=1",
  "dist/**/*.redis.test.js",
]);

export interface ChildOutcome {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SuiteDependencies {
  preflight(): Promise<PreflightResult>;
  runTests(): Promise<ChildOutcome>;
  audit(): Promise<TestRedisAudit>;
  write(line: string): void;
}

export type StepStatus = "passed" | "failed" | "not-established" | "not-run";

export interface SuiteOutcome {
  readonly tests: StepStatus;
  readonly audit: StepStatus;
  readonly exitCode: 0 | 1;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * The post-run audit (DF-4): sentinel, used_memory and the difference from
 * `before` (when there is one), and the test keys that remain. A reading
 * that cannot be taken is "not established", never a pass.
 */
async function runAudit(
  dependencies: SuiteDependencies,
  before: number | undefined,
  report: (line: string) => void,
): Promise<StepStatus> {
  try {
    const reading = await dependencies.audit();
    const problems: string[] = [];
    if (!reading.sentinelIntact) {
      report("audit: sentinel NOT INTACT; used_memory and remaining keys not established");
      problems.push("the sentinel is not intact");
    } else {
      const { usedMemory, remainingTestKeys } = reading;
      if (usedMemory === undefined || remainingTestKeys === undefined) {
        throw new Error("the audit returned no reading");
      }
      const difference = before === undefined ? "not available (no before value)" : signed(usedMemory - before);
      report(`audit: used_memory_after=${usedMemory} difference=${difference}`);
      report(`audit: remaining_test_keys=${remainingTestKeys} sentinel=intact`);
      if (remainingTestKeys !== 0) problems.push(`${remainingTestKeys} test key(s) remain: a cleanup did not happen`);
    }
    const audit: StepStatus = problems.length === 0 ? "passed" : "failed";
    report(audit === "passed" ? "audit: PASSED" : `audit: FAILED (${problems.join("; ")})`);
    return audit;
  } catch (error) {
    report(`audit: NOT ESTABLISHED (the final state could not be read: ${safeReason(error)})`);
    return "not-established";
  }
}

export async function runRedisSuite(dependencies: SuiteDependencies): Promise<SuiteOutcome> {
  const report = (line: string) => dependencies.write(`[redis-suite] ${line}`);

  let before: PreflightResult;
  try {
    before = await dependencies.preflight();
  } catch (error) {
    report(`preflight: REFUSED (${preflightFailureReason(error)})`);
    report("tests: NOT RUN (the preflight refused)");
    // Always attempted, even with no test run and no before value (S1-C1).
    const audit = await runAudit(dependencies, undefined, report);
    report(`result: FAILED (tests not-run, audit ${audit})`);
    return { tests: "not-run", audit, exitCode: 1 };
  }
  for (const line of preflightReport(before)) dependencies.write(line);
  report(`preflight: PASSED used_memory_before=${before.usedMemory}`);

  let tests: StepStatus;
  try {
    const outcome = await dependencies.runTests();
    if (outcome.code === 0 && outcome.signal === null) {
      tests = "passed";
      report("tests: PASSED (exit status 0)");
    } else {
      tests = "failed";
      report(
        `tests: FAILED (${outcome.signal !== null ? `ended by signal ${outcome.signal}` : `exit status ${outcome.code}`})`,
      );
    }
  } catch (error) {
    tests = "not-established";
    report(`tests: NOT ESTABLISHED (the test process did not run: ${safeReason(error)})`);
  }

  // Always, whatever the tests' result.
  const audit = await runAudit(dependencies, before.usedMemory, report);

  const exitCode = tests === "passed" && audit === "passed" ? 0 : 1;
  report(`result: ${exitCode === 0 ? "PASSED" : "FAILED"} (tests ${tests}, audit ${audit})`);
  return { tests, audit, exitCode };
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function runRedisTests(): Promise<ChildOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...REDIS_TEST_ARGUMENTS], { cwd: PACKAGE_ROOT, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function main(): Promise<void> {
  const outcome = await runRedisSuite({
    preflight: runPreflight,
    runTests: runRedisTests,
    audit: auditTestRedis,
    write: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[redis-suite] FAILED: ${safeReason(error)}\n`);
    process.exitCode = 1;
  });
}
