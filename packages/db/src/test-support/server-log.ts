import { spawn } from "node:child_process";

// Statement capture from the disposable container's server log
// (log_statement = all; log_line_prefix '%m [%p] %u@%d '). The only Docker
// command used is `docker logs irs-011-test-pg` (Prompt B §4.3).

export interface ServerLogEntry {
  readonly time: string;
  readonly pid: number;
  readonly user: string;
  readonly database: string;
  readonly level: string;
  /** The message, with continuation lines joined by newlines. */
  readonly message: string;
}

const LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) UTC \[(\d+)\] (\S*)@(\S*) ([A-Z]+):  (.*)$/;

export async function readServerLog(since: Date): Promise<ServerLogEntry[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("docker", ["logs", "--since", since.toISOString(), "irs-011-test-pg"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error(`docker logs exited ${code}`))));
  });
  const entries: ServerLogEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = LINE.exec(raw);
    if (match !== null) {
      entries.push({
        time: match[1] ?? "",
        pid: Number(match[2]),
        user: match[3] ?? "",
        database: match[4] ?? "",
        level: match[5] ?? "",
        message: match[6] ?? "",
      });
    } else if (raw.startsWith("\t") && entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last !== undefined) entries[entries.length - 1] = { ...last, message: `${last.message}\n${raw.slice(1)}` };
    }
  }
  return entries;
}

/** The SQL text of statements one backend executed, in order (simple and extended protocol). */
export function statementsOf(entries: readonly ServerLogEntry[], pid: number): string[] {
  return entries
    .filter((entry) => entry.pid === pid && entry.level === "LOG")
    .map((entry) => /^(?:statement|execute [^:]*): (.*)$/s.exec(entry.message)?.[1])
    .filter((sql): sql is string => sql !== undefined)
    .map((sql) => sql.trim());
}

/** Waits until the server log has caught up (the log is written asynchronously). */
export async function settleLog(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}
