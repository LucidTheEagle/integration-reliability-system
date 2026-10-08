import type { FailureClass } from "@irs/domain";

/**
 * How an EXPECTED provider-side failure crosses the adapter boundary.
 *
 * The adapter identifies and normalizes the failure; it does not decide
 * what to do about it. There is deliberately no RecoveryAction here:
 * retry / reconcile / escalate decisions belong to later tasks.
 *
 * Only provider-neutral information crosses the boundary. Not allowed
 * here: raw response bodies, SDK or vendor error objects, vendor error
 * codes, credentials, or vendor-specific retry logic. (Whether a
 * normalized error code belongs here is deferred to the task that
 * builds the attempt-recording boundary.)
 */
export interface AdapterFailure {
  /** Canonical IRS classification, chosen by the adapter (spec §9). */
  readonly failureClass: FailureClass;
  /**
   * Provider-neutral description that is safe to persist and display.
   * Must not contain credentials, secrets, or raw vendor payloads.
   */
  readonly message: string;
  /**
   * Status of the transport response, when the integration mechanism
   * is HTTP. Optional because not every mechanism is HTTP. Evidence to
   * be recorded (spec §13, ProcessingAttempt.httpStatus), not an input
   * to decisions: decisions use failureClass.
   */
  readonly httpStatus?: number;
  /**
   * Server-provided retry hint, normalized by the adapter to
   * milliseconds (for example from a Retry-After header). A hint only:
   * the adapter never decides to retry. Honoring it is the retry
   * engine's job (spec §12, RetryPolicy.respectRetryAfter).
   */
  readonly retryAfterMs?: number;
}

/**
 * Outcome of an adapter capability call.
 *
 * Use `ok: false` ONLY for expected operational/provider outcomes
 * (rejections, not-found, rate limiting, timeouts, ambiguous results).
 * Programming bugs, invariant violations, and unexpected internal errors
 * must NOT be converted into a failure result: let the returned promise
 * reject so they stay visible as defects.
 */
export type AdapterResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AdapterFailure };

/**
 * Request metadata that legitimately crosses the adapter boundary.
 * Both fields are optional.
 *  - idempotencyKey: passed to providers that support idempotent
 *    requests (spec §11.1). Only meaningful for state-changing calls.
 *  - correlationId: lets one workflow be traced across downstream
 *    operations (spec §17).
 */
export interface AdapterRequestContext {
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}