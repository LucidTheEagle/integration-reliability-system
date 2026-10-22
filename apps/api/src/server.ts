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
import type {
  EligibleErrorCode,
  RejectionAuditSink,
  RejectionCandidate,
  RejectionContext,
  ResponseCompletion,
} from "./rejection-audit.js";

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
  /**
   * Task 011A: the request-path rejection-audit capability. Absent → no
   * individual audit, and Task 011B's behaviour is unchanged.
   */
  readonly rejectionAudit?: RejectionAuditSink;
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
  // Task 011 (B-3, decision D1): the ingestion 422 consumes L2 like the other rejections.
  "UNPROCESSABLE_PAYLOAD",
]);

/** @internal — test seam, not public API */
export interface ResponseGate {
  setPeer(request: FastifyRequest, peer: PeerKey): void;
  /** The peer stored at P1/P2, or computed from the socket if absent. */
  peerOf(request: FastifyRequest): PeerKey;
  /** The rejection code if this request consumed L2 allowance (B1). */
  individualRejectionOf(request: FastifyRequest): ApiErrorCode | undefined;
  /** Task 011 (B-4): the stored event's ID, for response-attempt telemetry only. */
  noteEventId(request: FastifyRequest, eventId: string): void;
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
    context?: RejectionContext,
  ): FastifyReply;
  fault(request: FastifyRequest, reply: FastifyReply): FastifyReply;
  /** Task 011A (B-7): the receipt time for this request's rejection stage. */
  noteReceivedAt(request: FastifyRequest, receivedAt: Date): void;
  /** Task 011A (B-7): the canonical UUID parseIntegrationId returned. */
  noteClaimedIntegrationId(request: FastifyRequest, integrationId: string): void;
}

/** Task 011A options of the gate; all optional. */
export interface ResponseGateAuditOptions {
  /** Fallback clock when no receipt time was noted (default: new Date()). */
  readonly now?: () => Date;
  /** RD-15: called once per candidate mapped to HANDLER by fallback, with only the Fastify code. */
  readonly onUnmapped?: (fastifyCode: string | null) => void;
}

/**
 * @internal — RD-15: the rejection stage of a setErrorHandler rejection, by
 * route, then code. Not on the webhook route → NOT_FOUND (counted only).
 * On it: body-limit and Content-Length errors → BODY; anything else →
 * HANDLER, flagged as unmapped (logged once, with only the code).
 */
export function stageForErrorHandler(routeUrl: string | undefined, fastifyCode: string | null): RejectionContext {
  if (routeUrl !== WEBHOOK_ROUTE) return { stage: "NOT_FOUND" };
  if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE" || fastifyCode === "FST_ERR_CTP_INVALID_CONTENT_LENGTH") {
    return { stage: "BODY" };
  }
  return { stage: "HANDLER", unmappedCode: fastifyCode };
}

// The single path for every application response (202, errors, 429), and
// the server-local request state it needs. Created once per buildServer.
/** @internal — test seam, not public API */
export function createResponseGate(
  limiter: RateLimiter,
  audit?: RejectionAuditSink,
  auditOptions: ResponseGateAuditOptions = {},
): ResponseGate {
  const peers = new WeakMap<FastifyRequest, PeerKey>();
  const aborted = new WeakSet<FastifyRequest>();
  const individualRejections = new WeakMap<FastifyRequest, ApiErrorCode>();
  const eventIds = new WeakMap<FastifyRequest, string>();
  // Task 011A (B-7): server-local request state for rejection candidates.
  const receivedAts = new WeakMap<FastifyRequest, string>();
  const claimedIntegrationIds = new WeakMap<FastifyRequest, string>();

  function safeSubmit(candidate: RejectionCandidate): void {
    try {
      audit?.submit(candidate);
    } catch {
      // A throwing sink is a defect, not a request failure (§5.3).
    }
  }

  /**
   * Task 011A (B-3, RD-9): a separate, once-only settlement observer on
   * reply.raw: "finish" gives FINISH_OBSERVED; "close" before any "finish"
   * gives CLOSE_BEFORE_FINISH. It submits exactly once, never reads
   * writableFinished, and attaching it can never affect the response.
   */
  function observeRejection(request: FastifyRequest, reply: FastifyReply, code: ApiErrorCode, context: RejectionContext): void {
    try {
      const raw = reply.raw as Partial<Pick<NodeJS.EventEmitter, "once">>;
      if (typeof raw.once !== "function") return;
      if (context.unmappedCode !== undefined) {
        try {
          auditOptions.onUnmapped?.(context.unmappedCode);
        } catch {
          // Log-only.
        }
      }
      const receivedAt = receivedAts.get(request) ?? (auditOptions.now ?? (() => new Date()))().toISOString();
      const candidate = (responseCompletion: ResponseCompletion): RejectionCandidate => ({
        requestId: request.id,
        receivedAt,
        stage: context.stage,
        httpStatus: statusFor(code) as RejectionCandidate["httpStatus"],
        errorCode: code as EligibleErrorCode,
        claimedIntegrationId: claimedIntegrationIds.get(request) ?? null,
        verifierReason: context.stage === "VERIFIER" ? (context.verifierReason ?? null) : null,
        responseCompletion,
      });
      let submitted = false;
      const settle = (completion: ResponseCompletion): void => {
        if (submitted) return;
        submitted = true;
        safeSubmit(candidate(completion));
      };
      raw.once("finish", () => settle("FINISH_OBSERVED"));
      raw.once("close", () => settle("CLOSE_BEFORE_FINISH"));
    } catch {
      // Never affects the response.
    }
  }

  function peerOf(request: FastifyRequest): PeerKey {
    return peers.get(request) ?? limiter.peerKey(request.raw.socket?.remoteAddress);
  }

  /**
   * Task 011 (B-4): response-attempt telemetry. One log-only record per
   * response attempt, written when the outcome is observed. It never
   * changes, delays or decides a response, never touches the reply, and is
   * never used for a destroyed reply. FINISH_OBSERVED means Node handed the
   * response to the connection; it is not proof that the sender received it.
   */
  function observeAttempt(
    request: FastifyRequest,
    reply: FastifyReply,
    statusAttempted: number,
    disposition: string,
  ): void {
    try {
      const raw = reply.raw as Partial<Pick<NodeJS.EventEmitter, "once">> & { writableFinished?: boolean };
      if (typeof raw.once !== "function") return;
      let reported = false;
      const report = (completion: "FINISH_OBSERVED" | "CLOSED_BEFORE_FINISH" | "DELIVERY_ERROR"): void => {
        if (reported) return;
        reported = true;
        try {
          const eventId = eventIds.get(request);
          request.log.info(
            {
              requestId: request.id,
              ...(eventId === undefined ? {} : { eventId }),
              disposition,
              statusAttempted,
              completion,
              responseTimeMs: Math.round(reply.elapsedTime),
            },
            "response attempt",
          );
        } catch {
          // Log-only: a failing logger changes nothing.
        }
      };
      raw.once("finish", () => report("FINISH_OBSERVED"));
      raw.once("close", () => report(raw.writableFinished === true ? "FINISH_OBSERVED" : "CLOSED_BEFORE_FINISH"));
      raw.once("error", () => report("DELIVERY_ERROR"));
    } catch {
      // Telemetry never affects the response.
    }
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
    observeAttempt(request, reply, status === 202 ? 202 : statusFor(status), status === 202 ? "ACCEPTED" : status);
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
    context?: RejectionContext,
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
      // Task 011A: step 4 only, so a candidate exists only for a granted rejection.
      if (audit !== undefined && context !== undefined) observeRejection(request, reply, code, context);
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
    noteEventId: (request, eventId) => {
      eventIds.set(request, eventId);
    },
    deliver,
    send429,
    rejectWith,
    fault,
    noteReceivedAt: (request, receivedAt) => {
      receivedAts.set(request, receivedAt.toISOString());
    },
    noteClaimedIntegrationId: (request, integrationId) => {
      claimedIntegrationIds.set(request, integrationId);
    },
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

/** @internal — test seam, not public API (Task 011 DEV-2, B-6). */
export type DeadlineSettlement =
  | { readonly kind: "outcome"; readonly outcome: unknown }
  | { readonly kind: "threw"; readonly error: unknown };

/** @internal — test seam, not public API (Task 011 DEV-2, B-6). */
export type DeadlineDecision =
  | DeadlineSettlement
  | { readonly kind: "deadline"; readonly late: Promise<DeadlineSettlement> };

/**
 * @internal — test seam, not public API (Task 011 DEV-2, B-6).
 *
 * Races a pending handoff against the response deadline under one decision
 * rule: a settlement is the response only if it is observed while
 * `remainingMs()` is above zero; otherwise, and when the timer finds no
 * budget left, the decision is the deadline. Both paths read the clock at
 * the moment of observation, so a settlement observed after the deadline
 * takes the late path even if the timer callback has not run yet. A timer
 * that fires early re-arms for the remainder. The timer is unref'd and
 * cleared on decision. Neither the result nor `late` ever rejects.
 */
export function raceResponseDeadline(
  pending: Promise<unknown>,
  remainingMs: () => number,
): Promise<DeadlineDecision> {
  const settled: Promise<DeadlineSettlement> = pending.then(
    (outcome): DeadlineSettlement => ({ kind: "outcome", outcome }),
    (error: unknown): DeadlineSettlement => ({ kind: "threw", error }),
  );
  return new Promise<DeadlineDecision>((resolve) => {
    let decided = false;
    let timer: NodeJS.Timeout | undefined;
    const decide = (decision: DeadlineDecision): void => {
      decided = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(decision);
    };
    const arm = (ms: number): void => {
      timer = setTimeout(onTimer, ms);
      timer.unref();
    };
    function onTimer(): void {
      timer = undefined;
      if (decided) return;
      const remaining = remainingMs();
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      decide({ kind: "deadline", late: settled });
    }
    void settled.then((settlement) => {
      if (decided) return;
      decide(remainingMs() > 0 ? settlement : { kind: "deadline", late: settled });
    });
    const initial = remainingMs();
    if (initial > 0) arm(initial);
    else decide({ kind: "deadline", late: settled });
  });
}

/** The late-outcome record for a result observed after the deadline response (DEV-2 §2.4). */
function lateOutcomeFields(settlement: DeadlineSettlement): Record<string, unknown> {
  if (settlement.kind === "threw") {
    // The phase of a rejection is attested neither by the error nor by the
    // handoff contract, so it is never reported as a fault (FD-12).
    const errorName = settlement.error instanceof Error ? settlement.error.name : undefined;
    return { late: "UNKNOWN_AFTER_RESPONSE", errorName };
  }
  const outcome = settlement.outcome;
  const status =
    typeof outcome === "object" && outcome !== null ? (outcome as { status?: unknown }).status : undefined;
  switch (status) {
    case "ACCEPTED": {
      const eventId = (outcome as { eventId?: unknown }).eventId;
      return { late: "COMMITTED_AFTER_RESPONSE", ...(typeof eventId === "string" ? { eventId } : {}) };
    }
    case "UNAVAILABLE": {
      const classification = (outcome as { classification?: unknown }).classification;
      return {
        late: "UNAVAILABLE_AFTER_RESPONSE",
        handoffClassification:
          classification === "TRANSIENT" || classification === "COMMIT_UNKNOWN" ? classification : "UNSPECIFIED",
      };
    }
    case "UNPROCESSABLE_PAYLOAD":
    case "INTEGRATION_INELIGIBLE":
      return { late: "REJECTED_AFTER_RESPONSE" };
    default:
      return { late: "INVALID_OUTCOME" };
  }
}

const ROUTE_GUARD: RejectionContext = Object.freeze({ stage: "ROUTE_GUARD" });

export function buildServer(
  dependencies: ServerDependencies,
  options: ServerOptions = {},
): FastifyInstance {
  const verifyWebhook = dependencies.verifyWebhook ?? verifyIrsV1Webhook;
  const now = dependencies.now ?? (() => new Date());
  // Without an injected limiter the evidence half is discarded (HD-18).
  const limiter = dependencies.rateLimiter ?? createRateLimiter().limiter;
  let appRef: FastifyInstance | undefined;
  const gate = createResponseGate(limiter, dependencies.rejectionAudit, {
    now,
    // RD-15: the server logger, no request bindings, only the Fastify code.
    onUnmapped: (fastifyCode) => appRef?.log.warn({ event: "REJECTION_STAGE_UNMAPPED", fastifyCode }, "REJECTION_STAGE_UNMAPPED"),
  });
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const headersTimeoutMs = Math.min(
    options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    requestTimeoutMs,
  );
  // One budget for Fastify's handlerTimeout and the response deadline
  // (Task 011 DEV-2). PROVISIONAL (AR-3): 15 s by default.
  const handlerTimeoutMs = requestTimeoutMs + HANDLER_TIMEOUT_MARGIN_MS;

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
    // stalled upload is ended by that (408) first. Fastify 5.12.5 clears
    // this timer when the request emits `close`, which Node 24 does once the
    // body has been read, so it never bounds the handoff; the response
    // deadline in the handler does (Task 011 DEV-2).
    handlerTimeout: handlerTimeoutMs,
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
      gate.noteReceivedAt(request, now());
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
      gate.rejectWith(request, reply, code, undefined, { stage: "ROUTER" });
    },
  });
  appRef = app;
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
    gate.noteReceivedAt(request, now());
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
    const fastifyCode = (error as { code?: unknown }).code;
    return gate.rejectWith(
      request,
      reply,
      code,
      code === "PAYLOAD_TOO_LARGE" ? { connection: "close" } : undefined,
      stageForErrorHandler(request.routeOptions.url, typeof fastifyCode === "string" ? fastifyCode : null),
    );
  });

  app.setNotFoundHandler((request, reply) =>
    gate.rejectWith(request, reply, "NOT_FOUND", undefined, { stage: "NOT_FOUND" }),
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
      gate.noteReceivedAt(request, receivedAt);

      // 1. Identifier format. Malformed identifiers never reach a lookup.
      const integrationId = parseIntegrationId(request.params.integrationKey);
      if (integrationId === null) {
        return gate.rejectWith(request, reply, "NOT_FOUND", undefined, ROUTE_GUARD);
      }
      gate.noteClaimedIntegrationId(request, integrationId);

      // 2. Header guards (duplicates, missing IRS-Signature, content type
      //    and encoding). These run before any secret resolution and
      //    before the body is consumed.
      const headers = evaluateRequestHeaders(request.raw.rawHeaders);
      if (!headers.ok) {
        return gate.rejectWith(request, reply, headers.code, undefined, ROUTE_GUARD);
      }

      // 3. Secret resolution, only after the header checks. An identifier
      //    without a configured secret fails closed.
      const secret = dependencies.secrets(integrationId);
      if (secret === undefined) {
        return gate.rejectWith(request, reply, "NOT_FOUND", undefined, ROUTE_GUARD);
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
        return gate.rejectWith(request, reply, "BAD_REQUEST", undefined, { stage: "HANDLER" });
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
        return gate.rejectWith(request, reply, codeForRejection(result.rejection), undefined, {
          stage: "VERIFIER",
          verifierReason: result.rejection.reason,
        });
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

      // Outcome contract: ACCEPTED -> 202, UNAVAILABLE -> 503,
      // UNPROCESSABLE_PAYLOAD -> 422, INTEGRATION_INELIGIBLE -> 404 (Task 011,
      // B-1). Anything else (a thrown error, or an outcome outside the
      // contract) is an internal fault -> 500. A 2xx is only ever sent for
      // ACCEPTED.
      //
      // Response deadline (Task 011 DEV-2, B-6): an end-to-end limit measured
      // from routing, the start point of Fastify's own timer (reply.elapsedTime).
      // At the deadline the 503 goes through the gate, logged UNKNOWN; a result
      // observed later is logged once and never answered. The deadline neither
      // cancels the database work nor releases its connection.
      const remainingMs = (): number => handlerTimeoutMs - reply.elapsedTime;
      const deadlineResponse = (reason: string, outcome: string): FastifyReply => {
        request.log.warn(
          { requestId: request.id, outcome, reason, elapsedMs: Math.round(reply.elapsedTime) },
          "ingestion response deadline reached",
        );
        if (reply.sent) return reply;
        return gate.rejectWith(request, reply, "SERVICE_UNAVAILABLE");
      };
      if (remainingMs() <= 0) {
        // Nothing was handed off, so nothing can commit later.
        return deadlineResponse("RESPONSE_DEADLINE_BEFORE_HANDOFF", "NOT_ATTEMPTED");
      }
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(
          dependencies.ingestion.accept({
            requestId: request.id,
            integrationId: context.integrationId,
            envelope: result.envelope,
            rawBody,
            receivedAt: context.receivedAt,
            metadata: {
              contentType: context.contentType,
              bodyByteLength: rawBody.byteLength,
            },
          }),
        );
      } catch (error) {
        pending = Promise.reject(error);
      }
      const settlement = await raceResponseDeadline(pending, remainingMs);
      if (settlement.kind === "deadline") {
        const decidedAt = performance.now();
        void settlement.late.then((late) => {
          try {
            request.log.warn(
              { requestId: request.id, lateByMs: Math.round(performance.now() - decidedAt), ...lateOutcomeFields(late) },
              "late ingestion outcome",
            );
          } catch {
            // Log-only: a failing logger changes nothing.
          }
        });
        return deadlineResponse("RESPONSE_DEADLINE", "UNKNOWN");
      }
      if (settlement.kind === "threw") {
        // Name only: messages and stacks may carry sensitive data.
        const name = settlement.error instanceof Error ? settlement.error.name : undefined;
        request.log.error({ errorName: name }, "ingestion handoff failed");
        return gate.rejectWith(request, reply, "INTERNAL_ERROR");
      }
      const outcome = settlement.outcome;

      const status =
        typeof outcome === "object" && outcome !== null
          ? (outcome as { status?: unknown }).status
          : undefined;
      if (status === "ACCEPTED") {
        const eventId = (outcome as { eventId?: unknown }).eventId;
        if (typeof eventId === "string") gate.noteEventId(request, eventId);
        return gate.deliver(request, reply, 202);
      }
      if (status === "UNAVAILABLE") {
        return gate.rejectWith(request, reply, "SERVICE_UNAVAILABLE");
      }
      if (status === "UNPROCESSABLE_PAYLOAD") {
        // Task 011 (B-1): a payload with P1/P2, rejected before any ingestion-path
        // database access. Task 011A supplies its rejection stage
        // (INGESTION_PAYLOAD, Amendment Note E6) at this call site.
        return gate.rejectWith(request, reply, "UNPROCESSABLE_PAYLOAD", undefined, { stage: "INGESTION_PAYLOAD" });
      }
      if (status === "INTEGRATION_INELIGIBLE") {
        // Task 011 (B-1): the integration is not ACTIVE, or not registered; only
        // the status-check read ran and nothing was written. The generic 404.
        // Task 011A supplies its rejection stage (INGESTION_INTEGRATION,
        // Amendment Note E7) at this call site.
        return gate.rejectWith(request, reply, "NOT_FOUND", undefined, { stage: "INGESTION_INTEGRATION" });
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
 * Task 011A (AD-11): `forced` is true exactly when closeAllConnections()
 * ran before app.close() settled.
 */
export async function closeWithGrace(
  app: FastifyInstance,
  graceMs: number,
): Promise<{ readonly forced: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  let forced = false;
  const forcedClose = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      forced = true;
      app.server.closeAllConnections();
      resolve();
    }, graceMs);
  });
  try {
    await Promise.race([app.close(), forcedClose]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { forced };
}
