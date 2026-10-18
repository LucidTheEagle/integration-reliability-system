import type { VerifiedWebhookEnvelope } from "@irs/integrations";

/**
 * The only metadata the transport boundary passes to ingestion. Arbitrary
 * HTTP headers are deliberately not forwarded (Master Specification,
 * Section 10, "Security constraint").
 */
export interface IngestionMetadata {
  /** Normalized content type; charset parameters are not preserved. */
  readonly contentType: string;
  readonly bodyByteLength: number;
}

/** Everything the transport boundary hands to durable ingestion. */
export interface IngestionRequest {
  /** Server-generated; never taken from a client header. */
  readonly requestId: string;
  /** The validated `Integration.id` from the URL. */
  readonly integrationId: string;
  /** Result of the Task 010 verifier. Downstream code uses this, not the body. */
  readonly envelope: VerifiedWebhookEnvelope;
  /**
   * The exact original request-body bytes, the same array that was passed
   * to the verifier. Must be treated as read-only. Downstream code must
   * not re-parse it to obtain event data.
   */
  readonly rawBody: Uint8Array;
  readonly receivedAt: Date;
  readonly metadata: IngestionMetadata;
}

/** Why a handoff answered UNAVAILABLE: a transient failure, or an outcome unknown after the commit boundary. */
export type UnavailableClassification = "TRANSIENT" | "COMMIT_UNKNOWN";

/** A permanently unstorable payload condition (Task 011, Rev 1.7 §8.4a). */
export type UnprocessableCondition = "P1_NUL_CHARACTER" | "P2_UNPAIRED_SURROGATE";

/**
 * `ACCEPTED` means the event has been durably accepted. Only a handoff
 * that has durably persisted the event may return it; the transport
 * boundary sends 2xx solely on this outcome. `eventId` is used only by
 * response-attempt telemetry (C-G4-2).
 *
 * `UNPROCESSABLE_PAYLOAD` (→ 422) and `INTEGRATION_INELIGIBLE` (→ 404)
 * are rejections decided before any write (Task 011, AR-1).
 *
 * `UNAVAILABLE` (→ 503) may carry the handoff's own classification
 * (Task 011 DEV-2, C-G4-2 as amended by FD-12). It never changes the
 * response; only the late-outcome record reads it.
 */
export type IngestionOutcome =
  | { readonly status: "ACCEPTED"; readonly eventId?: string }
  | { readonly status: "UNAVAILABLE"; readonly classification?: UnavailableClassification }
  | { readonly status: "UNPROCESSABLE_PAYLOAD"; readonly condition: UnprocessableCondition }
  | { readonly status: "INTEGRATION_INELIGIBLE" };

/** Injectable boundary to durable ingestion (Task 011). */
export interface IngestionHandoff {
  accept(request: IngestionRequest): Promise<IngestionOutcome>;
}

/**
 * Production handoff until Task 011 provides durable acceptance. It never
 * accepts: every verified delivery is answered 503, so no sender is told
 * an event was received when it was not stored.
 */
export function createUnavailableIngestionHandoff(): IngestionHandoff {
  return {
    accept(): Promise<IngestionOutcome> {
      return Promise.resolve({ status: "UNAVAILABLE" });
    },
  };
}
