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

function sendError(
  reply: FastifyReply,
  code: ApiErrorCode,
  requestId: string,
): FastifyReply {
  return reply.code(statusFor(code)).send(errorBody(code, requestId));
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
      sendError(reply, code, request.id);
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
    if (code === "PAYLOAD_TOO_LARGE") {
      // The remainder of an oversized body must not be read on this socket.
      reply.header("connection", "close");
    }
    return sendError(reply, code, request.id);
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, "NOT_FOUND", request.id),
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
        return sendError(reply, "NOT_FOUND", request.id);
      }

      // 2. Header guards (duplicates, missing IRS-Signature, content type
      //    and encoding). These run before any secret resolution and
      //    before the body is consumed.
      const headers = evaluateRequestHeaders(request.raw.rawHeaders);
      if (!headers.ok) {
        return sendError(reply, headers.code, request.id);
      }

      // 3. Secret resolution, only after the header checks. An identifier
      //    without a configured secret fails closed.
      const secret = dependencies.secrets(integrationId);
      if (secret === undefined) {
        return sendError(reply, "NOT_FOUND", request.id);
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
        return sendError(reply, "BAD_REQUEST", request.id);
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
        return sendError(reply, codeForRejection(result.rejection), request.id);
      }

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
        return sendError(reply, "INTERNAL_ERROR", request.id);
      }

      const status =
        typeof outcome === "object" && outcome !== null
          ? (outcome as { status?: unknown }).status
          : undefined;
      if (status === "ACCEPTED") {
        return reply
          .code(202)
          .send({ status: "ACCEPTED", requestId: request.id });
      }
      if (status === "UNAVAILABLE") {
        return sendError(reply, "SERVICE_UNAVAILABLE", request.id);
      }
      request.log.error("ingestion handoff returned an invalid outcome");
      return sendError(reply, "INTERNAL_ERROR", request.id);
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
