-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EventState" AS ENUM ('RECEIVED', 'VALIDATED', 'QUEUED', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'UNKNOWN', 'REJECTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "OperationState" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReconciliationRunState" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "DiscrepancyState" AS ENUM ('DETECTED', 'CLASSIFIED', 'AUTO_RESOLVING', 'RESOLVED', 'MANUAL_REVIEW', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "IncidentState" AS ENUM ('OPEN', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IntegrationConfigState" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "IntegrationHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'FAILING', 'AUTHENTICATION_ERROR', 'OFFLINE');

-- CreateEnum
CREATE TYPE "FailureClass" AS ENUM ('TRANSIENT', 'RATE_LIMITED', 'AUTHENTICATION', 'AUTHORIZATION', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'AMBIGUOUS', 'DATA_INTEGRITY', 'SECURITY', 'INTERNAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RecoveryAction" AS ENUM ('RETRY', 'RECONCILE', 'ESCALATE');

-- CreateTable
CREATE TABLE "Integration" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "configStatus" "IntegrationConfigState" NOT NULL,
    "health" "IntegrationHealth",
    "environment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEndpoint" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "retryPolicyId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetryPolicy" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "maxAttempts" INTEGER NOT NULL DEFAULT 4,
    "backoffStrategy" TEXT NOT NULL DEFAULT 'exponential',
    "baseDelayMs" INTEGER NOT NULL DEFAULT 1000,
    "maxDelayMs" INTEGER NOT NULL DEFAULT 30000,
    "jitter" BOOLEAN NOT NULL DEFAULT true,
    "respectRetryAfter" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EventState" NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "correlationId" TEXT,
    "rawBody" BYTEA NOT NULL,
    "rawBodySha256" TEXT NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "operationType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OperationState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingAttempt" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "failureCategory" "FailureClass",
    "recoveryAction" "RecoveryAction",
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "httpStatus" INTEGER,
    "responseMetadata" JSONB,

    CONSTRAINT "ProcessingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemResource" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayLabel" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRelationship" (
    "id" UUID NOT NULL,
    "sourceIntegrationId" UUID NOT NULL,
    "sourceResourceType" TEXT NOT NULL,
    "sourceResourceId" TEXT NOT NULL,
    "targetIntegrationId" UUID NOT NULL,
    "targetResourceType" TEXT NOT NULL,
    "targetResourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" UUID NOT NULL,
    "sourceIntegrationId" UUID NOT NULL,
    "targetIntegrationId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" "ReconciliationRunState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "itemsChecked" INTEGER NOT NULL DEFAULT 0,
    "itemsMatched" INTEGER NOT NULL DEFAULT 0,
    "itemsMismatched" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discrepancy" (
    "id" UUID NOT NULL,
    "reconciliationRunId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "sourceState" JSONB NOT NULL,
    "targetState" JSONB NOT NULL,
    "difference" JSONB NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "DiscrepancyState" NOT NULL,
    "resolutionType" TEXT,
    "resolutionNotes" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "IncidentState" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorAction" (
    "id" UUID NOT NULL,
    "incidentId" UUID,
    "actorId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" UUID NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Integration_configStatus_idx" ON "Integration"("configStatus");

-- CreateIndex
CREATE INDEX "Integration_health_idx" ON "Integration"("health");

-- CreateIndex
CREATE INDEX "IntegrationEndpoint_retryPolicyId_idx" ON "IntegrationEndpoint"("retryPolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationEndpoint_integrationId_method_path_key" ON "IntegrationEndpoint"("integrationId", "method", "path");

-- CreateIndex
CREATE INDEX "Credential_integrationId_idx" ON "Credential"("integrationId");

-- CreateIndex
CREATE INDEX "Event_status_idx" ON "Event"("status");

-- CreateIndex
CREATE INDEX "Event_receivedAt_idx" ON "Event"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Event_integrationId_externalEventId_key" ON "Event"("integrationId", "externalEventId");

-- CreateIndex
CREATE INDEX "Operation_endpointId_idx" ON "Operation"("endpointId");

-- CreateIndex
CREATE INDEX "Operation_status_idx" ON "Operation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_eventId_endpointId_idempotencyKey_key" ON "Operation"("eventId", "endpointId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ProcessingAttempt_status_idx" ON "ProcessingAttempt"("status");

-- CreateIndex
CREATE INDEX "ProcessingAttempt_failureCategory_idx" ON "ProcessingAttempt"("failureCategory");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingAttempt_operationId_attemptNumber_key" ON "ProcessingAttempt"("operationId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SystemResource_integrationId_resourceType_externalId_key" ON "SystemResource"("integrationId", "resourceType", "externalId");

-- CreateIndex
CREATE INDEX "SyncRelationship_targetIntegrationId_idx" ON "SyncRelationship"("targetIntegrationId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncRelationship_sourceIntegrationId_sourceResourceType_sou_key" ON "SyncRelationship"("sourceIntegrationId", "sourceResourceType", "sourceResourceId", "targetIntegrationId", "targetResourceType", "targetResourceId");

-- CreateIndex
CREATE INDEX "ReconciliationRun_sourceIntegrationId_idx" ON "ReconciliationRun"("sourceIntegrationId");

-- CreateIndex
CREATE INDEX "ReconciliationRun_targetIntegrationId_idx" ON "ReconciliationRun"("targetIntegrationId");

-- CreateIndex
CREATE INDEX "ReconciliationRun_status_idx" ON "ReconciliationRun"("status");

-- CreateIndex
CREATE INDEX "Discrepancy_reconciliationRunId_idx" ON "Discrepancy"("reconciliationRunId");

-- CreateIndex
CREATE INDEX "Discrepancy_status_idx" ON "Discrepancy"("status");

-- CreateIndex
CREATE INDEX "Incident_integrationId_idx" ON "Incident"("integrationId");

-- CreateIndex
CREATE INDEX "Incident_status_idx" ON "Incident"("status");

-- CreateIndex
CREATE INDEX "OperatorAction_incidentId_idx" ON "OperatorAction"("incidentId");

-- CreateIndex
CREATE INDEX "OperatorAction_targetType_targetId_idx" ON "OperatorAction"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditEntry_entityType_entityId_idx" ON "AuditEntry"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEntry_createdAt_idx" ON "AuditEntry"("createdAt");

-- AddForeignKey
ALTER TABLE "IntegrationEndpoint" ADD CONSTRAINT "IntegrationEndpoint_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEndpoint" ADD CONSTRAINT "IntegrationEndpoint_retryPolicyId_fkey" FOREIGN KEY ("retryPolicyId") REFERENCES "RetryPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "IntegrationEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingAttempt" ADD CONSTRAINT "ProcessingAttempt_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemResource" ADD CONSTRAINT "SystemResource_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRelationship" ADD CONSTRAINT "SyncRelationship_sourceIntegrationId_fkey" FOREIGN KEY ("sourceIntegrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRelationship" ADD CONSTRAINT "SyncRelationship_targetIntegrationId_fkey" FOREIGN KEY ("targetIntegrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_sourceIntegrationId_fkey" FOREIGN KEY ("sourceIntegrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_targetIntegrationId_fkey" FOREIGN KEY ("targetIntegrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discrepancy" ADD CONSTRAINT "Discrepancy_reconciliationRunId_fkey" FOREIGN KEY ("reconciliationRunId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorAction" ADD CONSTRAINT "OperatorAction_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- TD-3 CHECKs (raw SQL, Task 011). Expressions verbatim from Rev 1.7 §10.2;
-- constraint names by founder decision FD-3 (2026-10-17).
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_rawBody_length_check" CHECK (octet_length("rawBody") BETWEEN 1 AND 1048576);

ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_rawBodySha256_format_check" CHECK ("rawBodySha256" ~ '^[0-9a-f]{64}$');

-- VPF-3a status check (raw SQL, Task 011), exactly as specified. The owner and
-- the EXECUTE grant are set by role provisioning, never by this migration.
CREATE FUNCTION "public"."irs_integration_config_status_for_share"(p_integration_id uuid)
  RETURNS "public"."IntegrationConfigState"
  LANGUAGE sql
  VOLATILE                      -- a locking clause is not allowed in a non-volatile function
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT "configStatus" FROM "public"."Integration" WHERE "id" = p_integration_id FOR SHARE
$$;
REVOKE ALL ON FUNCTION "public"."irs_integration_config_status_for_share"(uuid) FROM PUBLIC;
