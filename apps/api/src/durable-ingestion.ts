import { IngestionCommitUnknownError, classifyDatabaseError, ingestEvent } from "@irs/db";
import type { Database, EventIngestionInput, EventIngestionResult } from "@irs/db";
import type { VerifiedWebhookEnvelope } from "@irs/integrations";
import type {
  IngestionHandoff,
  IngestionOutcome,
  IngestionRequest,
  UnprocessableCondition,
} from "./handoff.js";

/**
 * Durable ingestion handoff (Task 011, Rev 1.7 §8.2, §8.4a). Order:
 * pre-validation (P1/P2, in memory) → ingestEvent (status check, insert,
 * audit, one transaction) → outcome. Logs carry identifiers, dispositions
 * and error names/codes only: never payload content, headers, signatures,
 * secrets or database messages.
 */

/** The logger subset the handoff uses (pino-compatible). */
export interface HandoffLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface DurableIngestionDependencies {
  readonly db: Database;
  readonly logger?: HandoffLogger;
  /** Test seam: the repository call (default ingestEvent). */
  readonly ingest?: (db: Database, input: EventIngestionInput) => Promise<EventIngestionResult>;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function conditionOf(text: string): UnprocessableCondition | undefined {
  if (text.includes("\u0000")) return "P1_NUL_CHARACTER";
  if (hasUnpairedSurrogate(text)) return "P2_UNPAIRED_SURROGATE";
  return undefined;
}

/**
 * P1 (U+0000) or P2 (an unpaired UTF-16 surrogate) in any envelope string
 * field, or in any key or string value of the payload at any depth. The
 * walk is iterative, so deep nesting cannot make the check itself fail.
 */
export function findUnstorableCondition(envelope: VerifiedWebhookEnvelope): UnprocessableCondition | undefined {
  const strings: Array<string | undefined> = [
    envelope.externalEventId,
    envelope.eventType,
    envelope.resourceType,
    envelope.resourceId,
    envelope.schemaVersion,
    envelope.correlationId,
  ];
  for (const value of strings) {
    if (value === undefined) continue;
    const found = conditionOf(value);
    if (found !== undefined) return found;
  }
  const stack: unknown[] = [envelope.payload];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      const found = conditionOf(value);
      if (found !== undefined) return found;
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        const found = conditionOf(key);
        if (found !== undefined) return found;
        stack.push(item);
      }
    }
  }
  return undefined;
}

/** Maps the transport request to the persistence input (§7.2; HO-1). */
export function toIngestionInput(request: IngestionRequest): EventIngestionInput {
  const { envelope } = request;
  return {
    requestId: request.requestId,
    integrationId: request.integrationId,
    externalEventId: envelope.externalEventId,
    eventType: envelope.eventType,
    resourceType: envelope.resourceType,
    resourceId: envelope.resourceId,
    occurredAt: envelope.occurredAt,
    schemaVersion: envelope.schemaVersion,
    correlationId: envelope.correlationId ?? null,
    payload: envelope.payload,
    rawBody: request.rawBody,
    receivedAt: request.receivedAt,
    contentType: request.metadata.contentType,
  };
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

export function createDurableIngestionHandoff(dependencies: DurableIngestionDependencies): IngestionHandoff {
  const ingest = dependencies.ingest ?? ingestEvent;
  // A failing logger never changes an outcome (HO-5).
  const log = (level: keyof HandoffLogger, object: Record<string, unknown>, message: string): void => {
    try {
      dependencies.logger?.[level](object, message);
    } catch {
      // Swallowed by design.
    }
  };

  return {
    async accept(request: IngestionRequest): Promise<IngestionOutcome> {
      const condition = findUnstorableCondition(request.envelope);
      if (condition !== undefined) {
        log(
          "warn",
          {
            requestId: request.requestId,
            outcome: "UNPROCESSABLE_PAYLOAD",
            condition: condition === "P1_NUL_CHARACTER" ? "P1" : "P2",
          },
          "ingestion rejected an unstorable payload",
        );
        return { status: "UNPROCESSABLE_PAYLOAD", condition };
      }

      let result: EventIngestionResult;
      try {
        result = await ingest(dependencies.db, toIngestionInput(request));
      } catch (error) {
        if (error instanceof IngestionCommitUnknownError) {
          log("error", { requestId: request.requestId, errorName: error.name, code: "COMMIT_UNKNOWN", outcome: "UNKNOWN" }, "ingestion outcome unknown");
          return { status: "UNAVAILABLE", classification: "COMMIT_UNKNOWN" };
        }
        const { failureClass, code } = classifyDatabaseError(error);
        log("error", { requestId: request.requestId, errorName: errorName(error), code, outcome: failureClass }, "ingestion failed");
        if (failureClass === "TRANSIENT") return { status: "UNAVAILABLE", classification: "TRANSIENT" };
        throw error;
      }

      if (result.disposition === "INTEGRATION_INELIGIBLE") {
        log(
          "warn",
          {
            requestId: request.requestId,
            outcome: result.configStatus === "NOT_REGISTERED" ? "INTEGRATION_NOT_REGISTERED" : "INTEGRATION_INELIGIBLE",
            integrationId: request.integrationId,
            configStatus: result.configStatus,
          },
          "ingestion rejected an ineligible integration",
        );
        return { status: "INTEGRATION_INELIGIBLE" };
      }

      const accepted: Record<string, unknown> = {
        requestId: request.requestId,
        eventId: result.eventId,
        integrationId: request.integrationId,
        disposition: result.disposition,
      };
      if (request.envelope.correlationId !== undefined) accepted.correlationId = request.envelope.correlationId;
      if (result.disposition === "DUPLICATE" && result.contentMatches === false) {
        log("warn", { ...accepted, contentMatches: false }, "duplicate delivery with different content; stored event unchanged");
      } else {
        log("info", accepted, "event accepted");
      }
      return { status: "ACCEPTED", eventId: result.eventId };
    },
  };
}
