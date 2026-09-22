import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EventState,
  OperationState,
  ReconciliationRunState,
  DiscrepancyState,
  IncidentState,
  IntegrationConfigState,
  IntegrationHealth,
  FailureClass,
  RecoveryAction,
} from "./index.js";

/**
 * Shared assertion for every canonical vocabulary in this package:
 * confirms the object's values are exactly the expected set (no more,
 * no fewer), every value is a string (never a numeric enum value),
 * and every value is identical to its own key — the stable, explicit,
 * persisted representation the task requires.
 */
function assertCanonicalVocabulary(
  name: string,
  vocabulary: Record<string, string>,
  expectedValues: readonly string[],
): void {
  describe(name, () => {
    it("exposes exactly the canonical values, no more and no fewer", () => {
      assert.deepStrictEqual(
        Object.values(vocabulary).sort(),
        [...expectedValues].sort(),
      );
    });

    it("uses only string values", () => {
      for (const value of Object.values(vocabulary)) {
        assert.equal(typeof value, "string");
      }
    });

    it("keeps each value identical to its own key", () => {
      for (const [key, value] of Object.entries(vocabulary)) {
        assert.equal(value, key);
      }
    });
  });
}

assertCanonicalVocabulary("EventState", EventState, [
  "RECEIVED",
  "VALIDATED",
  "QUEUED",
  "PROCESSING",
  "SUCCEEDED",
  "RETRYING",
  "FAILED",
  "UNKNOWN",
  "REJECTED",
  "DUPLICATE",
]);

assertCanonicalVocabulary("OperationState", OperationState, [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "RETRYING",
  "FAILED",
  "UNKNOWN",
]);

assertCanonicalVocabulary("ReconciliationRunState", ReconciliationRunState, [
  "PENDING",
  "RUNNING",
  "COMPLETED",
]);

assertCanonicalVocabulary("DiscrepancyState", DiscrepancyState, [
  "DETECTED",
  "CLASSIFIED",
  "AUTO_RESOLVING",
  "RESOLVED",
  "MANUAL_REVIEW",
  "UNRESOLVED",
]);

assertCanonicalVocabulary("IncidentState", IncidentState, [
  "OPEN",
  "RESOLVED",
  "CLOSED",
]);

assertCanonicalVocabulary("IntegrationConfigState", IntegrationConfigState, [
  "DRAFT",
  "ACTIVE",
  "DISABLED",
  "DECOMMISSIONED",
]);

assertCanonicalVocabulary("IntegrationHealth", IntegrationHealth, [
  "HEALTHY",
  "DEGRADED",
  "FAILING",
  "AUTHENTICATION_ERROR",
  "OFFLINE",
]);

assertCanonicalVocabulary("FailureClass", FailureClass, [
  "TRANSIENT",
  "RATE_LIMITED",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
  "AMBIGUOUS",
  "DATA_INTEGRITY",
  "SECURITY",
  "INTERNAL",
  "UNKNOWN",
]);

assertCanonicalVocabulary("RecoveryAction", RecoveryAction, [
  "RETRY",
  "RECONCILE",
  "ESCALATE",
]);

describe("@irs/domain public entry point", () => {
  it("exports every canonical vocabulary", () => {
    const exported: Record<string, unknown> = {
      EventState,
      OperationState,
      ReconciliationRunState,
      DiscrepancyState,
      IncidentState,
      IntegrationConfigState,
      IntegrationHealth,
      FailureClass,
      RecoveryAction,
    };
    for (const [name, value] of Object.entries(exported)) {
      assert.notEqual(value, undefined, `${name} should be exported`);
    }
  });
});