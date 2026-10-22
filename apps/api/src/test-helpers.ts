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
import { createRateLimiter } from "./rate-limit.js";
import type {
  RateLimitEvidence,
  RateLimitPolicies,
  RateLimiter,
} from "./rate-limit.js";
import type { RejectionAuditSink, RejectionCandidate } from "./rejection-audit.js";
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

/**
 * Manual monotonic clock for the rate limiter. `wall()` moves in step
 * with it, starting at NOW. Nothing advances unless a test calls advance().
 */
export class ManualClock {
  private elapsedMs = 0;
  readonly now = (): number => this.elapsedMs;
  readonly wall = (): Date => new Date(NOW.getTime() + this.elapsedMs);
  advance(ms: number): void {
    this.elapsedMs += ms;
  }
}

/** Lets promise chains and I/O callbacks settle (a few macrotask turns). */
export async function settleTurns(count = 10): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Task 011A timers on a ManualClock: advance() moves the clock to each due
 * task in order, runs it, and lets promise chains settle in between.
 */
export class ManualScheduler {
  private next = 0;
  private readonly tasks = new Map<number, { readonly due: number; readonly callback: () => void }>();
  constructor(readonly clock: ManualClock) {}
  readonly setTimeout = (callback: () => void, delayMs: number): unknown => {
    this.next += 1;
    this.tasks.set(this.next, { due: this.clock.now() + Math.max(0, delayMs), callback });
    return this.next;
  };
  readonly clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  get pending(): number {
    return this.tasks.size;
  }
  async advance(ms: number): Promise<void> {
    const target = this.clock.now() + ms;
    for (;;) {
      await settleTurns();
      let earliest: [number, { readonly due: number; readonly callback: () => void }] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].due > target) continue;
        if (earliest === undefined || entry[1].due < earliest[1].due) earliest = entry;
      }
      if (earliest === undefined) break;
      this.tasks.delete(earliest[0]);
      if (earliest[1].due > this.clock.now()) this.clock.advance(earliest[1].due - this.clock.now());
      earliest[1].callback();
    }
    if (target > this.clock.now()) this.clock.advance(target - this.clock.now());
    await settleTurns();
  }
}

export class LogCapture {
  readonly lines: string[] = [];
  /** A write containing `throwOn` throws instead of being recorded. */
  constructor(private readonly throwOn?: string) {}
  write(message: string): void {
    if (this.throwOn !== undefined && message.includes(this.throwOn)) {
      throw new Error("log write failed");
    }
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
  /** Task 011A: the number of records whose message is `message`. */
  count(message: string): number {
    return this.records().filter((record) => record.msg === message).length;
  }
}

/** Task 011A: a sink that records every candidate; optionally throws after recording. */
export class RecordingSink implements RejectionAuditSink {
  readonly candidates: RejectionCandidate[] = [];
  constructor(private readonly throws = false) {}
  submit(candidate: RejectionCandidate): void {
    this.candidates.push(candidate);
    if (this.throws) throw new Error("sink failed");
  }
}

/** Task 011A unmapped-log accounting: only the designated RD-15 test may log REJECTION_STAGE_UNMAPPED. */
export function assertNoUnmappedLog(logs: LogCapture): void {
  if (logs.count("REJECTION_STAGE_UNMAPPED") !== 0) {
    throw new Error("REJECTION_STAGE_UNMAPPED was logged outside the designated RD-15 test");
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

export type LimiterMethod = keyof RateLimiter;

export interface LimiterSpy {
  /** Pass this to the server; calls go to `overrides` first, then the inner limiter. */
  readonly limiter: RateLimiter;
  /** Calls per method, including calls that threw. */
  readonly calls: Record<LimiterMethod, number>;
}

const LIMITER_METHODS: readonly LimiterMethod[] = [
  "peerKey",
  "consumeRequest",
  "peekRejectionAllowance",
  "recordPrecheckDenied",
  "consumeRejectionAllowance",
  "consumeVerified",
  "recordAbortedBeforeResponse",
  "recordFault",
];

/** Counts limiter calls; `overrides` replace methods (for example to throw). */
export function spyLimiter(
  inner: RateLimiter,
  overrides: Partial<RateLimiter> = {},
): LimiterSpy {
  const calls = Object.fromEntries(
    LIMITER_METHODS.map((name) => [name, 0]),
  ) as Record<LimiterMethod, number>;
  const wrapped: Record<string, unknown> = {};
  for (const name of LIMITER_METHODS) {
    const target = (overrides[name] ?? inner[name]) as (...args: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      calls[name] += 1;
      return target(...args);
    };
  }
  return { limiter: wrapped as unknown as RateLimiter, calls };
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly handoff: RecordingHandoff;
  readonly logs: LogCapture;
  readonly verifyInputs: VerifyIrsV1WebhookInput[];
  /** Integration IDs passed to the secret resolver, in call order. */
  readonly resolved: string[];
  /** Present when `rateLimit` was given: the unwrapped request-path half. */
  readonly limiter?: RateLimiter;
  /** Present when `rateLimit` was given. */
  readonly evidence?: RateLimitEvidence;
  /** Present when `rateLimit` was given. */
  readonly clock?: ManualClock;
}

export function makeApp(
  options: {
    handoff?: RecordingHandoff;
    server?: ServerOptions;
    secrets?: Record<string, string>;
    /** Composes a limiter pair on a manual clock; omitted -> server default. */
    rateLimit?: {
      policies?: Partial<RateLimitPolicies>;
      clock?: ManualClock;
      /** Wraps the limiter given to the server (spies, stubs). */
      wrap?: (limiter: RateLimiter) => RateLimiter;
    };
    logs?: LogCapture;
    /** Replaces the real verifier; inputs are still recorded. */
    verifyWebhook?: typeof verifyIrsV1Webhook;
    /** Task 011A: an explicit request-path limiter (for example a composed one); exclusive with `rateLimit`. */
    rateLimiter?: RateLimiter;
    /** Task 011A: the rejection-audit sink given to buildServer. */
    rejectionAudit?: RejectionAuditSink;
  } = {},
): TestApp {
  const handoff = options.handoff ?? new RecordingHandoff();
  const logs = options.logs ?? new LogCapture();
  const verify = options.verifyWebhook ?? verifyIrsV1Webhook;
  let rateLimit:
    | { limiter: RateLimiter; evidence: RateLimitEvidence; clock: ManualClock }
    | undefined;
  if (options.rateLimit !== undefined) {
    const clock = options.rateLimit.clock ?? new ManualClock();
    const pair = createRateLimiter({
      ...(options.rateLimit.policies === undefined
        ? {}
        : { policies: options.rateLimit.policies }),
      monotonicNow: clock.now,
      wallNow: clock.wall,
    });
    rateLimit = { limiter: pair.limiter, evidence: pair.evidence, clock };
  }
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
        return verify(input);
      },
      ...(rateLimit === undefined
        ? {}
        : {
            rateLimiter:
              options.rateLimit?.wrap?.(rateLimit.limiter) ?? rateLimit.limiter,
          }),
      ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
      ...(options.rejectionAudit === undefined ? {} : { rejectionAudit: options.rejectionAudit }),
    },
    { logger: { level: "info", stream: logs }, ...options.server },
  );
  return { app, handoff, logs, verifyInputs, resolved, ...rateLimit };
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
