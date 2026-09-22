/**
 * Canonical domain-state and failure/recovery vocabulary for the
 * Integration Reliability System.
 *
 * Deliberately implemented as `as const` objects with a derived union
 * type, not TypeScript `enum` declarations. Two independent reasons:
 *
 * 1. `enum` requires actual runtime code generation, not just type
 *    erasure — Node.js's own docs list "Enum declarations" as one of
 *    the few TypeScript syntaxes that "require transformation" rather
 *    than simple stripping. An `as const` object needs no such
 *    transformation: it erases completely at the type level, leaving
 *    only a plain object literal at runtime.
 * 2. It satisfies "explicit stable string values, no implicit numeric
 *    values" as literally as possible: every value is a plain string
 *    literal, visible at both the type and the runtime level.
 *
 * Each vocabulary corresponds to a section of the Master Specification,
 * noted per group below. Do not collapse distinct vocabularies because
 * their values happen to overlap (e.g. EventState.FAILED,
 * OperationState.FAILED, and FailureClass.INTERNAL are three different
 * concepts that happen to share the word "failed"/"failure").
 */

// ---------------------------------------------------------------------
// Spec §6.1 — Event state
// ---------------------------------------------------------------------
//
// RESOLVED during Task 005 review: the spec's §6.1 diagram shows UNKNOWN
// flowing to a further node labeled RECONCILIATION_REQUIRED. That node is
// not an EventState value. It represents a reconciliation requirement
// triggered by an UNKNOWN event, modeled separately via the
// ReconciliationRun entity/state (§5.10) — not folded into this enum.
// EventState therefore has exactly the ten values below, deliberately.
export const EventState = {
    RECEIVED: "RECEIVED",
    VALIDATED: "VALIDATED",
    QUEUED: "QUEUED",
    PROCESSING: "PROCESSING",
    SUCCEEDED: "SUCCEEDED",
    RETRYING: "RETRYING",
    FAILED: "FAILED",
    UNKNOWN: "UNKNOWN",
    REJECTED: "REJECTED",
    DUPLICATE: "DUPLICATE",
  } as const;
  
  export type EventState = (typeof EventState)[keyof typeof EventState];
  
  // ---------------------------------------------------------------------
  // Spec §6.2 — Operation state
  // ---------------------------------------------------------------------
  export const OperationState = {
    PENDING: "PENDING",
    PROCESSING: "PROCESSING",
    SUCCEEDED: "SUCCEEDED",
    RETRYING: "RETRYING",
    FAILED: "FAILED",
    UNKNOWN: "UNKNOWN",
  } as const;
  
  export type OperationState = (typeof OperationState)[keyof typeof OperationState];
  
  // ---------------------------------------------------------------------
  // Spec §6.3 — Reconciliation run state and discrepancy state
  // ---------------------------------------------------------------------
  export const ReconciliationRunState = {
    PENDING: "PENDING",
    RUNNING: "RUNNING",
    COMPLETED: "COMPLETED",
  } as const;
  
  export type ReconciliationRunState =
    (typeof ReconciliationRunState)[keyof typeof ReconciliationRunState];
  
  export const DiscrepancyState = {
    DETECTED: "DETECTED",
    CLASSIFIED: "CLASSIFIED",
    AUTO_RESOLVING: "AUTO_RESOLVING",
    RESOLVED: "RESOLVED",
    MANUAL_REVIEW: "MANUAL_REVIEW",
    UNRESOLVED: "UNRESOLVED",
  } as const;
  
  export type DiscrepancyState = (typeof DiscrepancyState)[keyof typeof DiscrepancyState];
  
  // ---------------------------------------------------------------------
  // Spec §6.4 — Incident state
  // ---------------------------------------------------------------------
  export const IncidentState = {
    OPEN: "OPEN",
    RESOLVED: "RESOLVED",
    CLOSED: "CLOSED",
  } as const;
  
  export type IncidentState = (typeof IncidentState)[keyof typeof IncidentState];
  
  // ---------------------------------------------------------------------
  // Spec §6.5 — Integration configuration and health
  //
  // The spec is explicit that these are two separate dimensions, not one
  // combined state (an integration can be ACTIVE and FAILING at once).
  // Kept as two distinct exports for exactly that reason.
  // ---------------------------------------------------------------------
  export const IntegrationConfigState = {
    DRAFT: "DRAFT",
    ACTIVE: "ACTIVE",
    DISABLED: "DISABLED",
    DECOMMISSIONED: "DECOMMISSIONED",
  } as const;
  
  export type IntegrationConfigState =
    (typeof IntegrationConfigState)[keyof typeof IntegrationConfigState];
  
  export const IntegrationHealth = {
    HEALTHY: "HEALTHY",
    DEGRADED: "DEGRADED",
    FAILING: "FAILING",
    AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
    OFFLINE: "OFFLINE",
  } as const;
  
  export type IntegrationHealth = (typeof IntegrationHealth)[keyof typeof IntegrationHealth];
  
  // ---------------------------------------------------------------------
  // Spec §4 — Failure model and recovery decision model
  //
  // FailureClass describes *why* something failed. RecoveryAction
  // describes what IRS decided to do about it. They are related but not
  // interchangeable — retry is one possible recovery action, not a
  // synonym for recovery itself.
  // ---------------------------------------------------------------------
  export const FailureClass = {
    TRANSIENT: "TRANSIENT",
    RATE_LIMITED: "RATE_LIMITED",
    AUTHENTICATION: "AUTHENTICATION",
    AUTHORIZATION: "AUTHORIZATION",
    VALIDATION: "VALIDATION",
    NOT_FOUND: "NOT_FOUND",
    CONFLICT: "CONFLICT",
    AMBIGUOUS: "AMBIGUOUS",
    DATA_INTEGRITY: "DATA_INTEGRITY",
    SECURITY: "SECURITY",
    INTERNAL: "INTERNAL",
    UNKNOWN: "UNKNOWN",
  } as const;
  
  export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];
  
  export const RecoveryAction = {
    RETRY: "RETRY",
    RECONCILE: "RECONCILE",
    ESCALATE: "ESCALATE",
  } as const;
  
  export type RecoveryAction = (typeof RecoveryAction)[keyof typeof RecoveryAction];