/**
 * Domain representation of bounded retry behavior configuration.
 *
 * RetryPolicy = configuration describing bounded retry behavior.
 * This is explicitly not the retry engine (Task 016): this module
 * contains no scheduling, no timers, no delay calculation, no jitter
 * formula, and makes no decision about when or whether to retry a
 * specific failure. It only represents the configuration such a
 * decision would later consult.
 *
 * INFERENCE: deliberately excludes id / name / createdAt / updatedAt,
 * which the Task 006 Prisma RetryPolicy model carries. Those are
 * persistence-identity and audit concerns (which stored row is this,
 * when was it last changed) — not part of the bounded-retry-behavior
 * configuration itself. A future task wiring @irs/db to this domain
 * type would map a persisted row's six behavioral columns onto this
 * shape and handle id/name/timestamps at that layer. This is a
 * judgment call about the domain/persistence boundary, not something
 * the Master Specification states directly — flagged as such in the
 * implementation report, not presented as settled fact.
 */
export interface RetryPolicy {
    readonly maxAttempts: number;
    readonly backoffStrategy: string;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitter: boolean;
    readonly respectRetryAfter: boolean;
  }
  
  /**
   * Thrown by createRetryPolicy when one or more fields fail validation.
   * Reports every violated rule at once (not just the first), matching
   * @irs/config's ConfigValidationError precedent.
   */
  export class InvalidRetryPolicyError extends Error {
    public readonly issues: readonly string[];
  
    constructor(issues: readonly string[]) {
      super(`Invalid RetryPolicy:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
      this.name = "InvalidRetryPolicyError";
      this.issues = issues;
      Object.setPrototypeOf(this, InvalidRetryPolicyError.prototype);
    }
  }
  
  /**
   * Validates and returns a frozen, immutable RetryPolicy.
   *
   * Every field is required explicitly — there is no partial input with
   * implicit defaults applied here. "What the demonstration defaults
   * are" lives in one place only: the DEFAULT_RETRY_POLICY constant
   * below, as literal values, not as fallback logic duplicated inside
   * this function.
   *
   * Validation rules implemented, and why each is INFERENCE rather than
   * FACT (the Master Specification states none of these bounds
   * explicitly — each is a reasonable structural consequence of the
   * stated principles, not a quoted requirement):
   *   - maxAttempts must be a positive integer. The spec's own retry
   *     principles state "attempts must be finite" — a non-positive or
   *     fractional attempt count wouldn't represent a coherent bounded
   *     policy at all.
   *   - backoffStrategy must be a non-empty string. Task 008 explicitly
   *     forbids treating this as a closed enum, so this only rejects the
   *     degenerate empty case, not any particular set of names.
   *   - baseDelayMs and maxDelayMs must each be positive numbers, and
   *     baseDelayMs must not exceed maxDelayMs — a base delay larger
   *     than the maximum delay is internally contradictory for any
   *     backoff strategy, exponential or otherwise.
   *   - jitter and respectRetryAfter are plain booleans; TypeScript's
   *     type system already excludes any other value for a typed
   *     caller, so there is nothing further to validate at runtime.
   *
   * OPEN, not resolved by this function or anywhere in this task:
   * whether maxAttempts counts the initial attempt or only retries
   * beyond it. The Master Specification does not state this, and it
   * materially affects how Task 016's retry engine would consume the
   * value — flagging it rather than silently picking an interpretation.
   */
  export function createRetryPolicy(input: RetryPolicy): RetryPolicy {
    const issues: string[] = [];
  
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      issues.push("maxAttempts must be a positive integer");
    }
  
    if (input.backoffStrategy.trim().length === 0) {
      issues.push("backoffStrategy must not be empty");
    }
  
    if (!Number.isFinite(input.baseDelayMs) || input.baseDelayMs <= 0) {
      issues.push("baseDelayMs must be a positive number");
    }
  
    if (!Number.isFinite(input.maxDelayMs) || input.maxDelayMs <= 0) {
      issues.push("maxDelayMs must be a positive number");
    }
  
    if (
      Number.isFinite(input.baseDelayMs) &&
      Number.isFinite(input.maxDelayMs) &&
      input.baseDelayMs > input.maxDelayMs
    ) {
      issues.push("baseDelayMs must not exceed maxDelayMs");
    }
  
    if (issues.length > 0) {
      throw new InvalidRetryPolicyError(issues);
    }
  
    return Object.freeze({ ...input });
  }
  
  /**
   * The Master Specification's V1 demonstration defaults (§12). FACT —
   * these six values are stated directly, not inferred. The spec itself
   * describes them as "demonstration defaults, not universal production
   * recommendations": this constant represents exactly one concrete,
   * valid RetryPolicy value, not the only one the model can express (see
   * createRetryPolicy, which accepts any valid configuration).
   *
   * Routed through createRetryPolicy() rather than defined as a bare
   * object literal, so the default is checked against the same
   * validation every other policy value is, rather than trusted as
   * pre-valid by construction.
   */
  export const DEFAULT_RETRY_POLICY: RetryPolicy = createRetryPolicy({
    maxAttempts: 4,
    backoffStrategy: "exponential",
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: true,
    respectRetryAfter: true,
  });