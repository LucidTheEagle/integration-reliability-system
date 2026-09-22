/**
 * @irs/domain
 *
 * Core domain types, invariants, state transitions,
 * and business rules for the Integration Reliability System.
 *
 * Domain logic must remain independent of frameworks,
 * databases, queues, and external providers.
 */

export {
    EventState,
    OperationState,
    ReconciliationRunState,
    DiscrepancyState,
    IncidentState,
    IntegrationConfigState,
    IntegrationHealth,
    FailureClass,
    RecoveryAction,
  } from "./enums.js";