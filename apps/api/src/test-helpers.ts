/**
 * Test-only helpers. Compiled with the package but never imported by
 * production code; excluded from the package's public index.
 */
import { createHmac } from "node:crypto";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { verifyIrsV1Webhook } from "@irs/integrations";
import type { VerifyIrsV1WebhookInput } from "@irs/integrations";
import type {
  IngestionHandoff,
  IngestionOutcome,
  IngestionRequest,
} from "./handoff.js";
import { createSecretResolver } from "./secrets.js";
import { buildServer } from "./server.js";
import type { ServerOptions } from "./server.js";

export const INTEGRATION_ID = "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61";
export const OTHER_INTEGRATION_ID = "3f2b8a64-1c9d-4e7a-9b21-5d6e7f8a9b0c";
export const UNCONFIGURED_ID = "11111111-2222-4333-8444-555555555555";
export const SECRET_TEXT = "irs-api-test-secret-0123456789abcdef";
export const NOW_SECONDS = 1_760_000_000;
export const NOW = new Date(NOW_SECONDS * 1000);
export const WEBHOOK_PATH = `/api/webhooks/${INTEGRATION_ID}`;

export function sign(
  body: Uint8Array,
  timestamp: number | string = NOW_SECONDS,
  secret: string | Uint8Array = SECRET_TEXT,
): string {
  const key =
    typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  const digest = createHmac("sha256", key)
    .update(Buffer.from(`${timestamp}.`, "ascii"))
    .update(body)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function envelopeJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    externalEventId: "evt_123",
    eventType: "payment.completed",
    resourceType: "payment",
    resourceId: "pay_456",
    occurredAt: "2026-10-12T10:00:00Z",
    schemaVersion: "1",
    payload: { amount: 100 },
    ...overrides,
  });
}

export function validRequest(body: string | Buffer = envelopeJson()): {
  body: Buffer;
  headers: Record<string, string>;
} {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return {
    body: buffer,
    headers: {
      "content-type": "application/json",
      "irs-signature": sign(buffer),
    },
  };
}

export class LogCapture {
  readonly lines: string[] = [];
  write(message: string): void {
    this.lines.push(message);
  }
  text(): string {
    return this.lines.join("");
  }
  records(): Array<Record<string, unknown>> {
    return this.lines
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

export class RecordingHandoff implements IngestionHandoff {
  readonly requests: IngestionRequest[] = [];
  constructor(
    private readonly respond: (
      request: IngestionRequest,
    ) => Promise<IngestionOutcome> = () =>
      Promise.resolve({ status: "ACCEPTED" }),
  ) {}
  accept(request: IngestionRequest): Promise<IngestionOutcome> {
    this.requests.push(request);
    return this.respond(request);
  }
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly handoff: RecordingHandoff;
  readonly logs: LogCapture;
  readonly verifyInputs: VerifyIrsV1WebhookInput[];
  /** Integration IDs passed to the secret resolver, in call order. */
  readonly resolved: string[];
}

export function makeApp(
  options: {
    handoff?: RecordingHandoff;
    server?: ServerOptions;
    secrets?: Record<string, string>;
  } = {},
): TestApp {
  const handoff = options.handoff ?? new RecordingHandoff();
  const logs = new LogCapture();
  const verifyInputs: VerifyIrsV1WebhookInput[] = [];
  const resolved: string[] = [];
  const secrets = new Map<string, Uint8Array>(
    Object.entries(
      options.secrets ?? {
        [INTEGRATION_ID]: SECRET_TEXT,
        [OTHER_INTEGRATION_ID]: "another-integration-secret-0123456789",
      },
    ).map(([id, text]) => [id, new TextEncoder().encode(text)]),
  );
  const resolveSecret = createSecretResolver(secrets);
  const app = buildServer(
    {
      secrets: (integrationId) => {
        resolved.push(integrationId);
        return resolveSecret(integrationId);
      },
      ingestion: handoff,
      now: () => NOW,
      verifyWebhook: (input) => {
        verifyInputs.push(input);
        return verifyIrsV1Webhook(input);
      },
    },
    { logger: { level: "info", stream: logs }, ...options.server },
  );
  return { app, handoff, logs, verifyInputs, resolved };
}

export async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

export interface RawResponse {
  readonly raw: string;
  readonly status: number | undefined;
  readonly body: string;
  readonly closed: boolean;
}

/**
 * Minimal raw-TCP HTTP exchange. Each element of `writes` is sent in
 * order, `gapMs` apart. Resolves when the server closes the socket, or
 * after `waitMs` with `closed: false`.
 */
export function rawExchange(
  port: number,
  writes: ReadonlyArray<string | Buffer>,
  options: { gapMs?: number; waitMs?: number; endAfter?: boolean } = {},
): Promise<RawResponse> {
  const gapMs = options.gapMs ?? 0;
  const waitMs = options.waitMs ?? 3_000;
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const raw = Buffer.concat(chunks).toString("latin1");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
      const split = raw.indexOf("\r\n\r\n");
      resolve({
        raw,
        status: match === null ? undefined : Number(match[1]),
        body: split === -1 ? "" : raw.slice(split + 4),
        closed,
      });
    };

    const timer = setTimeout(() => finish(false), waitMs);
    socket.on("data", (data: Buffer) => chunks.push(data));
    socket.on("close", () => finish(true));
    socket.on("error", () => {
      /* resets are expected when the server closes early */
    });

    socket.on("connect", () => {
      void (async () => {
        for (const piece of writes) {
          if (settled) return;
          socket.write(piece);
          if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        }
        if (options.endAfter === true && !settled) socket.end();
      })();
    });
  });
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
