import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyIrsV1Webhook } from "@irs/integrations";
import type { VerifyIrsV1WebhookResult } from "@irs/integrations";
import {
  codeForFrameworkError,
  errorBody,
  statusFor,
} from "./errors.js";
import type { ApiErrorCode } from "./errors.js";
import {
  MAX_BODY_BYTES,
  evaluateRequestHeaders,
  parseIntegrationId,
} from "./guards.js";
import type { IngestionHandoff } from "./handoff.js";
import { buildLoggerOptions, safePath } from "./logging.js";
import type { LoggerSettings } from "./logging.js";
import { createRateLimiter } from "./rate-limit.js";
import type {
  Decision,
  Denial,
  PeekResult,
  PeerKey,
  RateLimiter,
} from "./rate-limit.js";
import type { SecretResolver } from "./secrets.js";

/** The server binds to loopback only. */
export const LISTEN_HOST = "127.0.0.1";

export const WEBHOOK_ROUTE = "/api/webhooks/:integrationKey";

export interface ServerDependencies {
  /** Resolves the secret for an `Integration.id`; undefined fails closed. */
  readonly secrets: SecretResolver;
  /**
   * Required (no default) so that wiring a server always makes an explicit
   * choice. Production wiring supplies the always-unavailable handoff.
   */
  readonly ingestion: IngestionHandoff;
  /** Injectable for exact-byte and reference-identity tests. */
  readonly verifyWebhook?: typeof verifyIrsV1Webhook;
  /** Clock used for the receipt timestamp and signature tolerance. */
  readonly now?: () => Date;
  /**
   * Request-path half of a `createRateLimiter()` pair. When absent, a
   * default limiter is created and its evidence half is discarded: limits
   * are still enforced, but summaries cannot be drained.
   */
  readonly rateLimiter?: RateLimiter;
}

export interface ServerOptions {
  /** `false` disables logging entirely. */
  readonly logger?: LoggerSettings | false;
  /** Whole request deadline (headers + body), default 10 s. */
  readonly requestTimeoutMs?: number;
  /** Deadline for receiving request headers, default 5 s (<= request timeout). */
  readonly headersTimeoutMs?: number;
  /** Idle keep-alive timeout, default 5 s. */
  readonly keepAliveTimeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_HEADERS_TIMEOUT_MS = 5_000;
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HANDLER_TIMEOUT_MARGIN_MS = 5_000;

interface RequestContext {
  readonly integrationId: string;
  readonly secret: Uint8Array;
  readonly signatureHeader: string;
  readonly contentType: string;
  readonly receivedAt: Date;
}

/**
 * Rejections that consume the peer's rejection allowance (L2) before they
 * are sent; with no allowance left they are sent as 429 instead.
 */
const ALLOWANCE_ELIGIBLE: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
]);

/** @internal — test seam, not public API */
export interface ResponseGate {
  setPeer(request: FastifyRequest, peer: PeerKey): void;
  /** The peer stored at P1/P2, or computed from the socket if absent. */
  peerOf(request: FastifyRequest): PeerKey;
  /** The rejection code if this request consumed L2 allowance (B1). */
  individualRejectionOf(request: FastifyRequest): ApiErrorCode | undefined;
  deliver(
    request: FastifyRequest,
    reply: FastifyReply,
    status: 202 | ApiErrorCode,
    extraHeaders?: Readonly<Record<string, string>>,
  ): FastifyReply;
  send429(request: FastifyRequest, reply: FastifyReply, denial: Denial): FastifyReply;
  rejectWith(
    request: FastifyRequest,
    reply: FastifyReply,
    code: ApiErrorCode,
    extraHeaders?: Readonly<Record<string, string>>,
  ): FastifyReply;
  fault(request: FastifyRequest, reply: FastifyReply): FastifyReply;
}

// The single path for every application response (202, errors, 429), and
// the server-local request state it needs. Created once per buildServer.
/** @internal — test seam, not public API */
export function createResponseGate(limiter: RateLimiter): ResponseGate {
  const peers = new WeakMap<FastifyRequest, PeerKey>();
  const aborted = new WeakSet<FastifyRequest>();
  const individualRejections = new WeakMap<FastifyRequest, ApiErrorCode>();

  function peerOf(request: FastifyRequest): PeerKey {
    return peers.get(request) ?? limiter.peerKey(request.raw.socket?.remoteAddress);
  }

  /**
   * No caller sets a status or header before this. A destroyed reply is
   * never written to: the abort is recorded once per request.
   */
  function deliver(
    request: FastifyRequest,
    reply: FastifyReply,
    status: 202 | ApiErrorCode,
    extraHeaders?: Readonly<Record<string, string>>,
  ): FastifyReply {
    if (reply.raw.destroyed) {
      if (!aborted.has(request)) {
        aborted.add(request);
        try {
          limiter.recordAbortedBeforeResponse();
        } catch {
          // Secondary failure: nothing can be reported on this request.
        }
      }
      // DEV-1: Fastify 5.12.5 continues the lifecycle (body parsing,
      // handler) after an onRequest hook returns an unsent reply. Hijacking
      // ends it without writing anything.
      try {
        reply.hijack();
      } catch {
        // Nothing further can be done for a destroyed reply.
      }
      return reply;
    }
    if (extraHeaders !== undefined) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        reply.header(name, value);
      }
    }
    if (status === 202) {
      return reply.code(202).send({ status: "ACCEPTED", requestId: request.id });
    }
    return reply.code(statusFor(status)).send(errorBody(status, request.id));
  }

  function fault(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    try {
      limiter.recordFault();
    } catch {
      // Secondary failure; the response is still the generic 500.
    }
    return deliver(request, reply, "INTERNAL_ERROR");
  }

  function send429(
    request: FastifyRequest,
    reply: FastifyReply,
    denial: Denial,
  ): FastifyReply {
    // Only the log attempt is guarded; delivery below is outside the catch,
    // so a delivery failure can never produce a second response.
    if (denial.log !== null) {
      try {
        request.log.warn(
          { layer: denial.layer, peer: denial.log.peer },
          "rate limit exceeded",
        );
      } catch {
        return fault(request, reply);
      }
    }
    return deliver(request, reply, "TOO_MANY_REQUESTS", {
      "retry-after": String(denial.retryAfterSeconds),
      connection: "close",
    });
  }

  function rejectWith(
    request: FastifyRequest,
    reply: FastifyReply,
    code: ApiErrorCode,
    extraHeaders?: Readonly<Record<string, string>>,
  ): FastifyReply {
    if (reply.raw.destroyed || !ALLOWANCE_ELIGIBLE.has(code)) {
      return deliver(request, reply, code, extraHeaders);
    }
    let decision: Decision;
    try {
      decision = limiter.consumeRejectionAllowance(peerOf(request));
    } catch {
      return fault(request, reply);
    }
    if (decision.allowed) {
      individualRejections.set(request, code);
      return deliver(request, reply, code, extraHeaders);
    }
    return send429(request, reply, decision);
  }

  return {
    setPeer: (request, peer) => {
      peers.set(request, peer);
    },
    peerOf,
    individualRejectionOf: (request) => individualRejections.get(request),
    deliver,
    send429,
    rejectWith,
    fault,
  };
}

/**
 * Maps a verifier rejection to a generic response. The rejection reason is
 * deliberately not exposed: every signature/timestamp failure is an
 * indistinguishable 401. Payload/envelope problems are only reachable
 * after the signature has verified, so they cannot be used as a signature
 * oracle.
 */
function codeForRejection(
  rejection: Extract<VerifyIrsV1WebhookResult, { ok: false }>["rejection"],
): ApiErrorCode {
  switch (rejection.reason) {
    case "BODY_TOO_LARGE":
      return "PAYLOAD_TOO_LARGE";
    case "MALFORMED_PAYLOAD":
    case "INVALID_ENVELOPE":
      return "BAD_REQUEST";
    default:
      return "UNAUTHORIZED";
  }
}

export function buildServer(
  dependencies: ServerDependencies,
  options: ServerOptions = {},
): FastifyInstance {
  const verifyWebhook = dependencies.verifyWebhook ?? verifyIrsV1Webhook;
  const now = dependencies.now ?? (() => new Date());
  // Without an injected limiter the evidence half is discarded (HD-18).
  const limiter = dependencies.rateLimiter ?? createRateLimiter().limiter;
  const gate = createResponseGate(limiter);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const headersTimeoutMs = Math.min(
    options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    requestTimeoutMs,
  );

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : buildLoggerOptions(options.logger ?? {}),
    // Request IDs are always generated here; a client-supplied ID header
    // is never trusted or echoed.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: MAX_BODY_BYTES,
    requestTimeout: requestTimeoutMs,
    // Application-level bound on the whole lifecycle including the
    // ingestion handoff. Kept above the socket-level request timeout so a
    // stalled upload is ended by that (408) first.
    handlerTimeout: requestTimeoutMs + HANDLER_TIMEOUT_MARGIN_MS,
    keepAliveTimeout: options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    // Node only evaluates request/header timeouts every
    // `connectionsCheckingInterval` (default 30 s); keep it tight so the
    // configured deadlines are honoured promptly.
    http: {
      connectionsCheckingInterval: Math.max(
        50,
        Math.min(1_000, Math.floor(headersTimeoutMs / 2)),
      ),
    },
    forceCloseConnections: "idle",
    trustProxy: false,
    // Router-level rejections (a malformed URL, or a path parameter longer
    // than the router's limit) happen before any route or error handler
    // runs. In Fastify 5.12.5 both are delivered here, with a request that
    // already carries the server-generated ID. The replacement response is
    // generic: it never echoes the rejected path or the framework's error
    // code/message.
    frameworkErrors: (error, request, reply) => {
      // A path parameter over the length limit can only be a malformed
      // integration identifier, which the routing contract answers with 404.
      const code: ApiErrorCode =
        error.code === "FST_ERR_MAX_PARAM_LENGTH" ? "NOT_FOUND" : "BAD_REQUEST";
      request.log.info(
        { statusCode: statusFor(code), route: "unmatched" },
        "request rejected before routing",
      );
      // P1: no onRequest hook runs for these requests, so L1 is charged
      // here before the rejection gate.
      let decision: Decision;
      try {
        const peer = limiter.peerKey(request.raw.socket?.remoteAddress);
        gate.setPeer(request, peer);
        decision = limiter.consumeRequest(peer);
      } catch {
        gate.fault(request, reply);
        return;
      }
      if (!decision.allowed) {
        gate.send429(request, reply, decision);
        return;
      }
      gate.rejectWith(request, reply, code);
    },
  });
  app.server.headersTimeout = headersTimeoutMs;

  // Only a raw-Buffer `application/json` parser exists. The bytes are
  // never decoded or parsed here; the Task 010 verifier is the sole
  // consumer of their meaning. The size limit is enforced by the
  // framework while the stream is consumed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const contexts = new WeakMap<FastifyRequest, RequestContext>();

  // P2: peer limits for every routed request (including not-found), before
  // any route work. Registered before the not-found handler and the route.
  app.addHook("onRequest", async (request, reply) => {
    let peer: PeerKey;
    let decision: Decision;
    try {
      peer = limiter.peerKey(request.raw.socket?.remoteAddress);
      gate.setPeer(request, peer);
      decision = limiter.consumeRequest(peer);
    } catch {
      return gate.fault(request, reply);
    }
    if (!decision.allowed) return gate.send429(request, reply, decision);

    // L2 precheck (HD-20): while the peer's rejection allowance holds less
    // than one token, every request from it is refused before verification.
    let peek: PeekResult;
    try {
      peek = limiter.peekRejectionAllowance(peer);
    } catch {
      return gate.fault(request, reply);
    }
    if (!peek.allowed) {
      let denial: Denial;
      try {
        denial = limiter.recordPrecheckDenied(peer, peek);
      } catch {
        return gate.fault(request, reply);
      }
      return gate.send429(request, reply, denial);
    }
    return undefined;
  });

  app.setErrorHandler((error, request, reply) => {
    const code = codeForFrameworkError(error);
    if (code === "INTERNAL_ERROR") {
      // Name and code only: messages and stacks may carry sensitive data.
      const { name, code: errorCode } = error as { name?: unknown; code?: unknown };
      request.log.error(
        {
          errorName: typeof name === "string" ? name : undefined,
          errorCode: typeof errorCode === "string" ? errorCode : undefined,
        },
        "unhandled request error",
      );
    }
    // The remainder of an oversized body must not be read on this socket;
    // the header is applied by deliver(), never to a destroyed reply.
    return gate.rejectWith(
      request,
      reply,
      code,
      code === "PAYLOAD_TOO_LARGE" ? { connection: "close" } : undefined,
    );
  });

  app.setNotFoundHandler((request, reply) =>
    gate.rejectWith(request, reply, "NOT_FOUND"),
  );

  app.addHook("onResponse", (request, reply, done) => {
    const context = contexts.get(request);
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        path: context === undefined ? undefined : safePath(request.raw.url),
        integrationId: context?.integrationId,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
    done();
  });

  app.route<{ Params: { integrationKey: string } }>({
    method: "POST",
    url: WEBHOOK_ROUTE,
    bodyLimit: MAX_BODY_BYTES,
    // Runs before the body is consumed: a rejection here never reads it.
    onRequest: async (request, reply) => {
      const receivedAt = now();

      // 1. Identifier format. Malformed identifiers never reach a lookup.
      const integrationId = parseIntegrationId(request.params.integrationKey);
      if (integrationId === null) {
        return gate.rejectWith(request, reply, "NOT_FOUND");
      }

      // 2. Header guards (duplicates, missing IRS-Signature, content type
      //    and encoding). These run before any secret resolution and
      //    before the body is consumed.
      const headers = evaluateRequestHeaders(request.raw.rawHeaders);
      if (!headers.ok) {
        return gate.rejectWith(request, reply, headers.code);
      }

      // 3. Secret resolution, only after the header checks. An identifier
      //    without a configured secret fails closed.
      const secret = dependencies.secrets(integrationId);
      if (secret === undefined) {
        return gate.rejectWith(request, reply, "NOT_FOUND");
      }

      contexts.set(request, {
        integrationId,
        secret,
        signatureHeader: headers.signatureHeader,
        contentType: headers.contentType,
        receivedAt,
      });
      return undefined;
    },
    handler: async (request, reply) => {
      const context = contexts.get(request);
      if (context === undefined || !(request.body instanceof Uint8Array)) {
        return gate.rejectWith(request, reply, "BAD_REQUEST");
      }

      // A standalone, exactly-sized copy: the same array is given to the
      // verifier and to the handoff, and never aliases a shared buffer pool.
      const rawBody = new Uint8Array(request.body.byteLength);
      rawBody.set(request.body);

      const result = verifyWebhook({
        rawBody,
        signatureHeader: context.signatureHeader,
        secret: context.secret,
        now: context.receivedAt,
        maxBodyBytes: MAX_BODY_BYTES,
      });

      if (!result.ok) {
        return gate.rejectWith(request, reply, codeForRejection(result.rejection));
      }

      // P6: L3 only after the verifier has accepted signature, timestamp,
      // payload and envelope; before the ingestion handoff.
      let decision: Decision;
      try {
        decision = limiter.consumeVerified(context.integrationId, gate.peerOf(request));
      } catch {
        return gate.fault(request, reply);
      }
      if (!decision.allowed) return gate.send429(request, reply, decision);

      // Outcome contract: ACCEPTED -> 202, UNAVAILABLE -> 503. Anything
      // else (a thrown error, or an outcome outside the contract) is an
      // internal fault -> 500. A 2xx is only ever sent for ACCEPTED.
      let outcome: unknown;
      try {
        outcome = await dependencies.ingestion.accept({
          requestId: request.id,
          integrationId: context.integrationId,
          envelope: result.envelope,
          rawBody,
          receivedAt: context.receivedAt,
          metadata: {
            contentType: context.contentType,
            bodyByteLength: rawBody.byteLength,
          },
        });
      } catch (error) {
        // Name only: messages and stacks may carry sensitive data.
        const name = error instanceof Error ? error.name : undefined;
        request.log.error({ errorName: name }, "ingestion handoff failed");
        return gate.rejectWith(request, reply, "INTERNAL_ERROR");
      }

      const status =
        typeof outcome === "object" && outcome !== null
          ? (outcome as { status?: unknown }).status
          : undefined;
      if (status === "ACCEPTED") {
        return gate.deliver(request, reply, 202);
      }
      if (status === "UNAVAILABLE") {
        return gate.rejectWith(request, reply, "SERVICE_UNAVAILABLE");
      }
      request.log.error("ingestion handoff returned an invalid outcome");
      return gate.rejectWith(request, reply, "INTERNAL_ERROR");
    },
  });

  return app;
}

/**
 * Closes the server, waiting at most `graceMs` for in-flight requests
 * before forcibly closing remaining connections. Never rejects on timeout.
 */
export async function closeWithGrace(
  app: FastifyInstance,
  graceMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const forced = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      app.server.closeAllConnections();
      resolve();
    }, graceMs);
  });
  try {
    await Promise.race([app.close(), forced]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
