import { ConfigValidationError } from "@irs/config";
import { createProductionServer } from "./production.js";
import { LISTEN_HOST, closeWithGrace } from "./server.js";

/** Maximum time to wait for in-flight requests on shutdown. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  let server;
  try {
    server = createProductionServer();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // Messages are value-free by construction.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { app, port } = server;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    closeWithGrace(app, SHUTDOWN_GRACE_MS)
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await app.listen({ host: LISTEN_HOST, port });
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`Failed to start API: ${name}\n`);
  process.exitCode = 1;
});
