**EPOPTEIA — FREELANCE ENGINEERING PRACTICE**

**INTEGRATION\
RELIABILITY SYSTEM**

*Master Product, Architecture & Engineering Specification*

> **Machine-readable companion — document authority note**
>
> This Markdown file was converted from `Integration_Reliability_System_Master_Specification_v1.0.docx` to make the approved V1.0 specification easier to search and read in code-assistant workflows. The DOCX remains the approved formatted reference for V1.0. Do not edit this Markdown independently. Any approved requirement change must be reconciled across both copies; if they disagree, stop and flag the discrepancy rather than choosing one silently.

Version 1.0 \| September 2026 \| Architecture baseline

Purpose: the authoritative specification used to guide research, architecture, implementation, testing, portfolio evidence, and controlled AI-assisted development.

# Document Control

| **Field**                          | **Value**                                             |
|------------------------------------|-------------------------------------------------------|
| Product                            | Integration Reliability System                        |
| Working client scenario            | Northstar Commerce (fictional)                        |
| Document role                      | Authoritative product and technical baseline          |
| Owner                              | Founder / System Architect                            |
| Implementation model               | Human-led, AI-assisted                                |
| Primary code assistant             | Claude                                                |
| Independent reviewer               | Gemini                                                |
| Architecture/research partner      | ChatGPT                                               |
| Actual coding environment          | Cursor / VS Code                                      |
| Source of truth for implementation | Git repository                                        |
| Status                             | Architecture baseline; implementation not yet started |
| Version                            | 1.0                                                   |
| Last updated                       | September 2026                                        |

# How This Document Is Used

This document is deliberately broader than a coding prompt. It describes why the product exists, what it is and is not, the business scenario, domain model, workflows, architecture, reliability rules, security boundaries, implementation roadmap, testing expectations, and AI collaboration protocol.

Claude is not the architect of this system. A Claude handoff will always reference this document as the governing context and will add one narrowly scoped task. Claude may propose implementation details, but proposals are not decisions until the architect accepts them.

Gemini is used as an independent technical challenger. Its findings are evidence for review, not automatic architectural changes.

The founder remains the final decision-maker. Code is manually integrated into Cursor/VS Code and committed to Git only after review and verification.

# Evidence & Decision Discipline

| **Term**      | **Meaning**                                                                           |
|---------------|---------------------------------------------------------------------------------------|
| FACT          | Established by the requirements, verified implementation, or cited external evidence. |
| ASSUMPTION    | Working belief used to design until verified.                                         |
| DECISION      | Architecturally accepted choice. Changes require explicit review.                     |
| PROPOSAL      | Suggested choice that has not yet been accepted.                                      |
| OPEN QUESTION | Material issue still requiring a decision or experiment.                              |
| DEFERRED      | Intentionally postponed.                                                              |
| SUPERSEDED    | Previously accepted decision replaced by a newer one.                                 |

This discipline is mandatory because AI-assisted development can otherwise cause gradual architecture drift. A model must not silently convert an assumption into a fact or a suggestion into an accepted architectural decision.

# 1. Executive Product Definition

The Integration Reliability System (IRS) is an operational reliability layer for businesses whose existing software systems must exchange information but do not always remain synchronized or recover cleanly when dependencies fail.

The system receives events, validates and persists them, processes integration operations asynchronously, classifies failures, applies safe recovery policies, exposes operational state to humans, and reconciles inconsistencies between connected systems.

IRS does not replace the business's core application, CRM, payment provider, or fulfillment system. It provides the control, evidence, recovery, and coordination layer between them.

## The core question

Can an engineer make several business systems behave like one reliable system, and when something fails, can the business prove what happened, recover safely, or escalate the problem without guessing?

## Product philosophy

Safe recovery over blind automation.

A failure is not automatically an instruction to retry. The system should determine whether the fault is transient, permanent, authentication-related, security-related, ambiguous, or a state-consistency problem, and then choose among retry, reconcile, or escalate.

## Why this is commercially relevant

Current freelance marketplace demand repeatedly includes API integrations, webhooks, OAuth, synchronization, duplicate prevention, retries, rate-limit handling, logging, monitoring, troubleshooting, and reconciliation. The opportunity is therefore not to sell a generic 'AI app' but to demonstrate the ability to make existing business systems reliable.

## External evidence that shaped the design

- GitHub recommends quick webhook acknowledgement and asynchronous processing for work that should not block the delivery response. It also recommends webhook secrets and signature validation.

- Microsoft's retry guidance emphasizes classifying transient faults, finite retries, exponential backoff/jitter, logging, and evaluating idempotency before retrying side-effecting operations.

- AWS's transactional outbox guidance addresses the database/event dual-write problem and emphasizes idempotent consumers because event delivery can occur more than once.

- BullMQ provides retries, backoff and job deduplication for Node.js worker workloads, supporting the selected queue design.

See the source register at the end of this document for direct links.

# 2. Business Scenario — Northstar Commerce

Northstar Commerce is a fictional mid-sized e-commerce business used only as a realistic demonstration environment. It has an existing core application and several external operational systems.

| **System**            | **Owns / provides**                         | **Relationship to IRS**                 |
|-----------------------|---------------------------------------------|-----------------------------------------|
| Northstar Core App    | Customers, orders, internal business state  | Primary internal source/business system |
| CRM                   | Customer/contact records and lifecycle data | External dependency                     |
| Payment Provider      | Payment transactions and webhook events     | External dependency                     |
| Fulfillment Provider  | Fulfillment/order status                    | External dependency                     |
| Notification Provider | Operational/customer notifications          | External dependency                     |

## The business problem

Northstar's initial integrations were assembled quickly. Over time they accumulated duplicated records, failed webhooks, authentication problems, rate limits, timeouts, partial failures, mismatched states, and poor visibility into what happened. Operators currently discover problems through customer complaints or manual checks.

## What Northstar hires an engineer to solve

1.  Make cross-system events durable and traceable.

2.  Prevent duplicate side effects.

3.  Recover from transient dependency failures.

4.  Handle ambiguous outcomes safely.

5.  Detect and reconcile state discrepancies.

6.  Give operators the ability to investigate, retry, replay, and resolve problems.

7.  Make integration health visible.

## What is intentionally out of scope

- Building a production e-commerce platform.

- Replacing the CRM, payment provider, or fulfillment provider.

- Building a generic Zapier/n8n clone.

- Building a generalized integration marketplace.

- Introducing AI into the core reliability path without a real requirement.

- Pretending that synthetic portfolio metrics are real client results.

# 3. Primary End-to-End Workflows

## 3.1 Customer synchronization

> Customer creates account\
> ↓\
> Northstar Core App\
> ↓\
> IRS event\
> ↓\
> Validate + persist\
> ↓\
> Queue\
> ↓\
> CRM adapter\
> ↓\
> CRM create/update\
> ↓\
> Record result\
> ↓\
> Sync relationship = SYNCED

The system must preserve enough evidence to reconstruct the operation after the fact.

## 3.2 Payment completed

> Payment Provider\
> ↓ payment.completed\
> IRS webhook endpoint\
> ↓\
> Authenticate\
> ↓\
> Validate\
> ↓\
> Persist event\
> ↓\
> Queue background processing\
> ↓\
> Mark order PAID\
> ↓\
> Request fulfillment\
> ↓\
> Update CRM\
> ↓\
> Notify

## 3.3 Duplicate event

The same provider event ID arrives twice. The second delivery is acknowledged but must not create another business side effect. The duplicate delivery remains visible in operational history.

## 3.4 Fulfillment failure after payment

Payment succeeds and the order becomes PAID, but fulfillment returns 503. IRS records the successful payment state and independently tracks fulfillment as RETRYING or FAILED. The product must not collapse the entire workflow into one binary transaction.

## 3.5 Ambiguous timeout

IRS sends a create request to fulfillment. The remote service may have processed it, but the response times out. IRS marks the outcome UNKNOWN rather than blindly sending another create. It checks remote state or idempotency evidence before deciding whether to reconcile or retry.

## 3.6 Reconciliation

IRS compares the current state of a resource across systems, identifies discrepancies, applies explicit safe rules, and escalates conflicts that should not be changed automatically.

# 4. Failure Model

| **Category**   | **Meaning**                                   | **Default response**                               |
|----------------|-----------------------------------------------|----------------------------------------------------|
| TRANSIENT      | Likely temporary dependency/network fault     | Retry with bounded backoff                         |
| RATE_LIMITED   | Remote system is throttling caller            | Respect retry delay; retry later                   |
| AUTHENTICATION | Credential is expired/invalid                 | Refresh/re-authenticate if safe; otherwise degrade |
| AUTHORIZATION  | Caller lacks permission                       | Do not blindly retry; escalate/configure           |
| VALIDATION     | Input/payload cannot be processed             | Reject; fix producer/data                          |
| NOT_FOUND      | Expected resource missing                     | Investigate/reconcile                              |
| CONFLICT       | Remote/local state cannot be applied cleanly  | Reconcile                                          |
| AMBIGUOUS      | Operation may have succeeded, outcome unknown | Verify/reconcile before replay                     |
| DATA_INTEGRITY | Systems disagree                              | Reconcile                                          |
| SECURITY       | Request or signature cannot be trusted        | Reject and record security signal                  |
| INTERNAL       | IRS implementation/infrastructure error       | Conservative failure handling + investigation      |
| UNKNOWN        | Unable to classify safely                     | Do not take destructive action automatically       |

## Recovery decision model

> Failure\
> ↓\
> Classify\
> ↓\
> ┌───────────────┬────────────────┬─────────────────┐\
> │ RETRY │ RECONCILE │ ESCALATE │\
> │ │ │ │\
> │ transient │ ambiguous │ unsafe action │\
> │ rate-limited │ conflict │ auth failure │\
> │ recoverable │ mismatch │ permanent fault │\
> └───────────────┴────────────────┴─────────────────┘

The three responses are not mutually exclusive in every workflow. Authentication failure, for example, may trigger a safe credential refresh attempt and then escalate if the refresh fails.

## Failure matrix

| **Scenario**                         | **Classification**           | **IRS response**                               | **Operator outcome**                        |
|--------------------------------------|------------------------------|------------------------------------------------|---------------------------------------------|
| HTTP 500/502/503                     | Transient                    | Retry with policy                              | None if recovered; investigate if exhausted |
| HTTP 429                             | Rate limited                 | Respect Retry-After if present; backoff        | Only if persistent                          |
| HTTP 401                             | Authentication               | Refresh credential if supported; retry         | Reconnect credential if refresh fails       |
| HTTP 403                             | Authorization                | Stop                                           | Fix permission/config                       |
| Malformed JSON/schema                | Validation                   | Reject + persist reason                        | Fix producer                                |
| Invalid webhook signature            | Security                     | Reject + record                                | Investigate if repeated                     |
| Duplicate event ID                   | Integrity                    | Deduplicate                                    | Usually none                                |
| Timeout after side-effecting request | Ambiguous                    | Verify remote state / idempotency before retry | Manual intervention if unresolved           |
| Retry budget exhausted               | Terminal for current attempt | Mark failed; surface incident                  | Retry/replay manually if appropriate        |
| Source/target mismatch               | Data integrity               | Run reconciliation                             | Auto-resolve only under explicit rule       |

# 5. Domain Model

The domain model separates facts about integrations, events, execution, consistency, and operations. This avoids using a single generic table to represent unrelated concepts.

## 5.1 Integration

Represents a configured external dependency. It carries identity and configuration state; operational health is tracked separately.

## 5.2 Integration Endpoint

Represents a specific operation/capability exposed by an integration, such as CREATE_CUSTOMER or CREATE_FULFILLMENT.

## 5.3 Credential

Represents authentication metadata and lifecycle. Secret material is not exposed through normal operational records.

## 5.4 Retry Policy

Represents bounded recovery behavior: eligible failure categories, max attempts, backoff, delay limits, jitter, and retry hints.

## 5.5 Event

Represents a meaningful occurrence received or emitted by the system. It has an IRS identity and preserves the external event identity when one exists.

## 5.6 Processing Attempt

Represents one execution of an operation triggered by an event. One event may have multiple attempts.

## 5.7 Operation

Represents a concrete action IRS performs against a target system. An event may produce several operations.

## 5.8 System Resource

Represents a business object in a connected system, e.g., Core.Order or CRM.Customer.

## 5.9 Sync Relationship

Maps a resource in one system to its corresponding resource in another system.

## 5.10 Reconciliation Run

Represents one explicit comparison operation over a resource scope.

## 5.11 Discrepancy

Represents a mismatch discovered during reconciliation.

## 5.12 Incident

Represents a condition that requires operator awareness/action, not merely a single failed request.

## 5.13 Operator Action

Represents a human action such as retry, replay, reconcile, disable, or resolve.

## 5.14 Audit Entry

Represents a material system/operator action required to reconstruct operational history.

# 6. State Model

## 6.1 Event state

> RECEIVED\
> ↓\
> VALIDATED\
> ↓\
> QUEUED\
> ↓\
> PROCESSING\
> ├──→ SUCCEEDED\
> ├──→ RETRYING → PROCESSING\
> ├──→ FAILED\
> └──→ UNKNOWN → RECONCILIATION_REQUIRED\
>
> RECEIVED → REJECTED\
> RECEIVED → DUPLICATE

## 6.2 Operation state

> PENDING → PROCESSING\
> PROCESSING → SUCCEEDED\
> PROCESSING → RETRYING\
> PROCESSING → FAILED\
> PROCESSING → UNKNOWN

## 6.3 Reconciliation and discrepancy state

> Reconciliation Run:\
> PENDING → RUNNING → COMPLETED\
>
> Discrepancy:\
> DETECTED → CLASSIFIED → AUTO_RESOLVING → RESOLVED\
> ↘ MANUAL_REVIEW → RESOLVED\
> ↘ UNRESOLVED

## 6.4 Incident state

> OPEN → RESOLVED → CLOSED

## 6.5 Integration configuration and health

Configuration state and health state remain separate dimensions.

| **Dimension** | **Values**                                                |
|---------------|-----------------------------------------------------------|
| Configuration | DRAFT, ACTIVE, DISABLED, DECOMMISSIONED                   |
| Health        | HEALTHY, DEGRADED, FAILING, AUTHENTICATION_ERROR, OFFLINE |

Example: an integration can be ACTIVE but FAILING. A disabled integration can still have a historical health state.

# 7. Repository & Runtime Architecture

## 7.1 Architectural style — accepted baseline

IRS will use a modular monolith plus a dedicated background worker. This is intentionally less complex than a microservice architecture while still demonstrating clear domain boundaries and asynchronous processing.

> ┌────────────────────┐\
> │ Next.js Operations │\
> │ UI │\
> └──────────┬─────────┘\
> │\
> ▼\
> ┌────────────────────┐\
> │ IRS API │\
> │ TypeScript/Fastify │\
> └──────┬───────┬─────┘\
> │ │\
> ▼ ▼\
> PostgreSQL Redis/BullMQ\
> Source of job transport\
> Truth │\
> ▼\
> Worker\
> │\
> ┌──────────────┼──────────────┐\
> ▼ ▼ ▼\
> CRM Payment Fulfillment

## 7.2 Why not microservices?

For this portfolio project, microservices would create service-to-service failure modes, deployment complexity, observability overhead, and testing burden without materially improving the engineering signal. The product's value is in reliability behavior and operational tooling, not in the number of deployed processes.

## 7.3 Proposed monorepo

> integration-reliability-system/\
> ├── apps/\
> │ ├── web/\
> │ ├── api/\
> │ ├── worker/\
> │ └── mock-providers/\
> ├── packages/\
> │ ├── domain/\
> │ ├── db/\
> │ ├── integrations/\
> │ ├── contracts/\
> │ ├── config/\
> │ └── testing/\
> ├── docs/\
> │ ├── architecture/\
> │ ├── decisions/\
> │ ├── workflows/\
> │ └── operations/\
> ├── tests/\
> │ ├── integration/\
> │ ├── e2e/\
> │ └── failure-scenarios/\
> ├── prisma/\
> ├── scripts/\
> ├── docker-compose.yml\
> ├── pnpm-workspace.yaml\
> ├── package.json\
> ├── tsconfig.base.json\
> ├── .env.example\
> └── README.md

## 7.4 Runtime responsibilities

| **Runtime**    | **Primary responsibility**                                             |
|----------------|------------------------------------------------------------------------|
| Web            | Operations console; no domain authority.                               |
| API            | HTTP, webhooks, authentication, validation, quick database operations. |
| Worker         | Long-running processing, retries, reconciliation, health jobs.         |
| Mock providers | Deterministic simulations of external dependencies and failures.       |
| PostgreSQL     | Durable domain/operational source of truth.                            |
| Redis/BullMQ   | Background execution transport and scheduling; not source of truth.    |

# 8. Technology Baseline

| **Area**             | **Baseline**       | **Reason**                                                    |
|----------------------|--------------------|---------------------------------------------------------------|
| Language             | TypeScript         | Strong type safety across web/API/worker/shared packages.     |
| Web                  | Next.js            | Suitable operations-console UI.                               |
| HTTP API             | Fastify (proposal) | Schema-oriented, TypeScript-friendly API boundary.            |
| Database             | PostgreSQL         | Durable relational source of truth.                           |
| ORM                  | Prisma             | Efficient schema/migration workflow for a solo engineer.      |
| Validation           | Zod (proposal)     | Runtime input validation with TypeScript inference.           |
| Queue                | BullMQ             | Node-native retries, delayed jobs, backoff and deduplication. |
| Queue store          | Redis              | BullMQ backend for background job state.                      |
| Infrastructure local | Docker Compose     | Reproducible PostgreSQL/Redis environment.                    |
| Package manager      | pnpm               | Simple workspace/monorepo support.                            |

Items explicitly marked proposal are not architectural facts until accepted during the repository-foundation pass.

## Technology exclusions for V1

| **Technology**       | **Decision**         | **Reason**                                                                                              |
|----------------------|----------------------|---------------------------------------------------------------------------------------------------------|
| Kafka                | Not used             | No need for distributed event streaming infrastructure at this scale.                                   |
| Kubernetes           | Not used             | Deployment orchestration adds complexity unrelated to portfolio objective.                              |
| GraphQL              | Not used             | REST is sufficient for the operational API.                                                             |
| Vector database      | Not used             | AI retrieval is not core to this product.                                                               |
| n8n in the core path | Not used             | Product 1 demonstrates engineered integration reliability; Product 2 will demonstrate workflow tooling. |
| Supabase             | Not used             | Would abstract away infrastructure we intentionally want to demonstrate.                                |
| AI agent             | Not used for core V1 | Reliability problem does not require an agent.                                                          |

# 9. Integration Adapter Architecture

Provider-specific logic must be isolated behind adapters. IRS domain/application logic should not contain arbitrary vendor URLs, vendor response parsing, or provider-specific retry rules.

> Integration Engine\
> │\
> ├── CRM Adapter\
> ├── Payment Adapter\
> ├── Fulfillment Adapter\
> └── Notification Adapter

## Adapter contract principles

- Expose capabilities rather than forcing every provider to implement every possible method.

- Keep provider-specific authentication, request shape, response mapping, and error normalization inside the adapter boundary.

- Map external errors into IRS's canonical failure taxonomy.

- Adapters must be testable without relying on live external services.

## Mock providers

| **Provider** | **Minimum capabilities**                | **Failure controls**                             |
|--------------|-----------------------------------------|--------------------------------------------------|
| CRM          | create/get/update/list customer         | 401, 403, 409, 429, 500, 503, latency, timeout   |
| Payment      | lookup transaction; emit payment events | failed payment, duplicate webhook, delayed event |
| Fulfillment  | create/get/update order                 | 409, 429, 500, 503, timeout, idempotency         |
| Notification | send notification                       | timeout, 500/503                                 |

## Deterministic failure injection

Mock providers should allow controlled, repeatable faults such as 'next two requests return 503' or 'next request times out'. Portfolio demonstrations must not depend on random failure.

# 10. Webhook Ingestion Architecture

> External Provider\
> ↓\
> POST /api/webhooks/:integrationKey\
> ↓\
> Identify integration\
> ↓\
> Verify signature\
> ↓\
> Validate envelope\
> ↓\
> Check duplicate identity\
> ↓\
> Persist event\
> ↓\
> Queue processing\
> ↓\
> Return 2xx\
> ↓\
> Background worker processes event

## Why asynchronous processing?

Webhook senders often expect a fast acknowledgement. GitHub documentation recommends a 2xx response within its timeout window and suggests queuing work for asynchronous processing. Stripe likewise recommends acknowledging webhook receipt before complex downstream processing.

## Inbound event requirements

8.  Each supported provider has an authentication/signature verification mechanism.

9.  The system validates the event envelope before processing.

10. An accepted event receives an internal IRS identity.

11. Provider event identity is preserved when available.

12. Duplicate provider events do not create duplicate business side effects.

13. The raw payload and safe metadata are persisted for investigation, subject to payload-size and sensitive-data rules.

14. The webhook path must not wait for multiple external API operations.

## Security constraint

Do not persist arbitrary HTTP headers. Persist only an allowlisted/sanitized metadata subset, and never expose secrets through logs or the operations console.

# 11. Idempotency & Ambiguous Outcomes

## 11.1 Three layers of idempotency

| **Layer**        | **Mechanism**                                      | **Purpose**                                                                |
|------------------|----------------------------------------------------|----------------------------------------------------------------------------|
| Inbound event    | Integration + externalEventId uniqueness           | Prevent accepting the same external event as a new event.                  |
| IRS operation    | Stable idempotency key + application checks        | Prevent duplicate internal side effects when processing repeats.           |
| Remote operation | Provider-supported idempotency key where available | Make safe retries possible when a remote write may already have succeeded. |

## 11.2 Ambiguous outcome flow

> Outbound write\
> ↓\
> Request sent\
> ↓\
> TIMEOUT\
> ↓\
> Outcome = UNKNOWN\
> ↓\
> Check idempotency evidence / remote state\
> ├── Found → reconcile as success\
> └── Not found → safe to retry?\
> ├── yes → retry\
> └── no → manual review

This behavior is mandatory for portfolio demonstration because it shows that the system understands the difference between 'no response' and 'operation definitely failed'. Microsoft's retry guidance explicitly warns that a timeout can occur after the server has already performed the operation.

## Remote idempotency simulation

The mock fulfillment provider should support an Idempotency-Key so the system can demonstrate safe retries of a side-effecting create request.

# 12. Retry & Resilience Architecture

## Retry policy

> maxAttempts: 4\
> strategy: exponential\
> baseDelayMs: 1000\
> maxDelayMs: 30000\
> jitter: true\
> respectRetryAfter: true

These values are demonstration defaults, not universal production recommendations. The policy will be configurable and subject to scenario-specific constraints.

## Retry eligibility

Retries are primarily eligible for transient faults and rate limiting. Authentication may retry after safe credential refresh. Validation, authorization, security faults, and unsafe ambiguous operations should not be blindly retried.

## Retry protection

- Finite attempts.

- Exponential backoff for background work, with jitter.

- Honor server retry hints such as Retry-After where present.

- Avoid nested retry loops that multiply traffic.

- Record every processing attempt.

- Treat a final exhausted attempt as a visible failure, not silent loss.

## Dependency health

V1 will use lightweight integration health/degradation signals rather than a large standalone circuit-breaker subsystem. The system should be able to reduce or defer pressure against a persistently failing dependency, but the first release should avoid building infrastructure whose main purpose is architectural theater.

# 13. Persistence Model — Proposed V1 Schema

The following schema is the current design proposal and will be validated before the first Prisma migration. Field names and exact types may change during implementation review.

| **Entity**          | **Current field proposal**                                                                                                                                  |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Integration         | id, name, provider, type, configStatus, environment, createdAt, updatedAt                                                                                   |
| IntegrationEndpoint | id, integrationId, name, method, path, operationType, enabled, retryPolicyId                                                                                |
| Credential          | id, integrationId, type, status, expiresAt, lastRefreshedAt                                                                                                 |
| RetryPolicy         | id, name, maxAttempts, backoffStrategy, baseDelayMs, maxDelayMs, jitter, respectRetryAfter                                                                  |
| Event               | id, integrationId, externalEventId, eventType, resourceType, resourceId, payload, metadata, occurredAt, receivedAt, status, schemaVersion, correlationId    |
| Operation           | id, eventId, integrationId, endpointId, operationType, resourceType, resourceId, idempotencyKey, status, createdAt, updatedAt                               |
| ProcessingAttempt   | id, eventId, operationId, attemptNumber, status, startedAt, completedAt, durationMs, failureCategory, errorCode, errorMessage, httpStatus, responseMetadata |
| SystemResource      | id, integrationId, resourceType, externalId, displayLabel, metadata                                                                                         |
| SyncRelationship    | id, sourceIntegrationId, sourceResourceType, sourceResourceId, targetIntegrationId, targetResourceType, targetResourceId, status, lastSyncedAt              |
| ReconciliationRun   | id, sourceIntegrationId, targetIntegrationId, resourceType, scope, status, startedAt, completedAt, itemsChecked, itemsMatched, itemsMismatched              |
| Discrepancy         | id, reconciliationRunId, resourceType, resourceId, sourceState, targetState, difference, severity, status, resolutionType, resolutionNotes, resolvedAt      |
| Incident            | id, integrationId, type, severity, status, title, description, detectedAt, resolvedAt, createdAt, updatedAt                                                 |
| OperatorAction      | id, incidentId, actorId, actionType, targetType, targetId, reason, result, createdAt                                                                        |
| AuditEntry          | id, actorType, actorId, action, entityType, entityId, metadata, createdAt                                                                                   |

## Deliberate non-entities for V1

- Job — BullMQ owns queue scheduling; durable execution history is represented by Operation and ProcessingAttempt.

- Failure — a failure is an outcome of an attempt; a separate table is not currently necessary.

- Standalone circuit-breaker entity — integration health/dependency policy is sufficient for V1.

## Payload strategy

Event payloads will initially use PostgreSQL JSONB because the portfolio workload assumes modest payload sizes and operational inspection is valuable. Larger payload/object-storage strategies are deferred.

# 14. Reconciliation Architecture

> Start reconciliation\
> ↓\
> Load sync relationships\
> ↓\
> Fetch current source state\
> ↓\
> Fetch current target state\
> ↓\
> Compare using explicit rules\
> ↓\
> Create discrepancies\
> ↓\
> Auto-resolve only safe cases\
> ↓\
> Escalate unsafe conflicts\
> ↓\
> Verify result\
> ↓\
> Complete reconciliation run

## Reconciliation principles

- Reconciliation is a verification activity, not merely a database equality check.

- Resource identity must be established before comparing state.

- Comparison rules must be explicit.

- Not every discrepancy is safe to repair automatically.

- A resolution is not successful until the resulting state is verified.

## Example rules

| **Core order** | **Fulfillment** | **Interpretation**                                     |
|----------------|-----------------|--------------------------------------------------------|
| PAID           | PROCESSING      | Expected/valid                                         |
| PAID           | SHIPPED         | Expected/valid                                         |
| PAID           | DELIVERED       | Expected/valid                                         |
| PAID           | CANCELLED       | High-risk discrepancy; manual review                   |
| PAID           | NOT_FOUND       | Verify remote state, then consider controlled recovery |
| CANCELLED      | SHIPPED         | Manual intervention required                           |

# 15. Operations Console

The operations console is an internal control surface, not a marketing site. It exists to make failures understandable and interventions controlled.

## Dashboard

- Integration health.

- Recent failures.

- Retrying operations.

- Open incidents.

- Reconciliation alerts.

## Event Explorer

- Filter by integration, event type, status, resource, and time.

- Open event details.

- View sanitized payload.

- View processing attempts.

- View timeline.

- Retry/replay where permitted.

## Integration detail

- Configuration status.

- Health.

- Endpoint capabilities.

- Recent failures.

- Last successful operation.

## Reconciliation

- Run history.

- Discrepancy list.

- Comparison details.

- Resolution action.

## Operator safety

Destructive or side-effecting controls should be explicit. The UI must distinguish Retry from Replay. A user should understand why a replay is allowed before clicking it.

# 16. API Surface — Initial Contract Map

| **Area**       | **Endpoint**                        | **Intent**                   |
|----------------|-------------------------------------|------------------------------|
| Webhooks       | POST /api/webhooks/:integrationKey  | Receive provider event       |
| Integrations   | GET /api/integrations               | List configured integrations |
| Integrations   | GET /api/integrations/:id           | Inspect integration          |
| Integrations   | POST /api/integrations              | Create integration           |
| Integrations   | PATCH /api/integrations/:id         | Update integration           |
| Integrations   | POST /api/integrations/:id/test     | Test integration             |
| Health         | GET /api/integrations/:id/health    | Inspect dependency health    |
| Events         | GET /api/events                     | Search events                |
| Events         | GET /api/events/:id                 | Inspect event                |
| Events         | POST /api/events/:id/retry          | Controlled retry             |
| Events         | POST /api/events/:id/replay         | Controlled replay            |
| Reconciliation | POST /api/reconciliation            | Start reconciliation         |
| Reconciliation | GET /api/reconciliation/:id         | Inspect run                  |
| Discrepancies  | GET /api/discrepancies              | Search discrepancies         |
| Discrepancies  | POST /api/discrepancies/:id/resolve | Resolve discrepancy          |
| Incidents      | GET /api/incidents                  | Search incidents             |
| Incidents      | GET /api/incidents/:id              | Inspect incident             |
| Incidents      | POST /api/incidents/:id/resolve     | Resolve incident             |

This is a contract map, not a final OpenAPI specification. Request/response shapes will be defined as implementation tasks reach the relevant boundary.

# 17. Observability & Audit

## Structured logging

Important technical operations should use structured logs containing timestamp, level, eventId, operationId, attemptId, integrationId, correlationId, message, and safe metadata.

## Correlation

A correlation ID allows one business workflow to be traced across webhook reception, processing, downstream operations, retries, reconciliation, and operator intervention.

## Timeline

The persistent operational timeline should tell the story of what happened without requiring the operator to reconstruct it from raw logs alone.

> 14:03:11 webhook received\
> 14:03:11 signature verified\
> 14:03:11 event persisted\
> 14:03:12 event queued\
> 14:03:13 fulfillment request sent\
> 14:03:17 timeout\
> 14:03:17 outcome UNKNOWN\
> 14:03:18 remote lookup\
> 14:03:19 remote resource found\
> 14:03:19 reconciliation completed

## Audit events

- EVENT_RECEIVED

- EVENT_REJECTED

- RETRY_SCHEDULED

- EVENT_REPLAYED

- RECONCILIATION_STARTED

- RECONCILIATION_RESOLVED

- INTEGRATION_DISABLED

- CREDENTIAL_REFRESHED

- OPERATOR_ACTION

# 18. Security Model

## Webhook security

15. Use HTTPS in deployed environments.

16. Verify provider signatures using a secret with adequate entropy.

17. Validate payload schema.

18. Do not trust inbound event data as authoritative until verification passes.

## Credentials

Credential metadata may be persisted; secret material should be kept in environment/secrets infrastructure appropriate to the deployment. No secrets in Git, logs, screenshots, or portfolio case studies.

## Operations console

V1 roles: OPERATOR and ADMIN. OPERATOR can investigate and perform allowed recovery actions. ADMIN can configure integrations and credentials.

## Logging hygiene

Sensitive values must be redacted. Raw authorization headers, tokens, webhook secrets, cookies, and similar sensitive data must never be logged.

## Security decisions that must be verified during implementation

- Exact session/auth mechanism.

- Exact role enforcement.

- CSRF considerations if cookie-based sessions are used.

- Rate limiting on operator and webhook endpoints.

- Input size limits.

- Replay-window behavior for signed webhooks, where applicable.

# 19. Testing Strategy

## Unit tests

- Failure classifier.

- Retry eligibility.

- Retry scheduling calculations.

- Event state transitions.

- Operation state transitions.

- Idempotency rules.

- Reconciliation rules.

## Integration tests

- Database transactions.

- Webhook persistence.

- Queue dispatch.

- Adapter behavior against mock providers.

- Credential refresh behavior.

## Failure tests

| **Test**                         | **Expected proof**                                                            |
|----------------------------------|-------------------------------------------------------------------------------|
| Duplicate webhook                | No duplicate business side effect; duplicate visible in history               |
| 500/503                          | Bounded retries with backoff; final failure surfaced                          |
| 429                              | Retry delay honored                                                           |
| 401                              | Credential refresh path exercised                                             |
| 403                              | No endless retry                                                              |
| Malformed payload                | Rejected safely                                                               |
| Invalid signature                | Rejected and recorded                                                         |
| Timeout after remote side effect | UNKNOWN then verify/reconcile, not blind duplicate create                     |
| Retry exhaustion                 | FAILED state + operator path                                                  |
| Manual replay                    | History preserved; new processing attempt recorded                            |
| State mismatch                   | Discrepancy produced; correct resolution path                                 |
| Out-of-order update              | Older state cannot silently overwrite newer state where ordering rule applies |

## End-to-end demonstrations

19. Normal customer synchronization.

20. Duplicate payment webhook.

21. Fulfillment 503 then recovery.

22. Fulfillment timeout with remote success.

23. Rate-limit recovery.

24. Expired authentication.

25. Malformed webhook.

26. Manual replay.

27. Reconciliation of mismatched states.

# 20. Reliability Metrics for the Portfolio

The project should generate its own repeatable measurements from synthetic workloads. We must never present these as client outcomes.

| **Metric**                    | **Meaning**                                                                    |
|-------------------------------|--------------------------------------------------------------------------------|
| Event processing success rate | Percent of accepted events eventually reaching successful processing.          |
| Retry recovery rate           | Percent of retryable failures that recover automatically.                      |
| Duplicate suppression rate    | Duplicate deliveries correctly prevented from creating duplicate side effects. |
| Median processing time        | Typical event-processing duration.                                             |
| p95 processing time           | Tail latency for processing.                                                   |
| Reconciliation match rate     | Resources whose source/target state agrees under defined rules.                |
| Manual intervention rate      | Share of scenarios requiring operator action.                                  |
| Failure detection time        | Time between fault occurrence and operational visibility.                      |

Metrics should be generated through scripts/tests and included in the final case study with clear labeling as synthetic benchmark results.

# 21. Repository Foundation Contract

Before feature implementation, the repository should establish a clean foundation. The first commit is not expected to contain the whole product.

## Initial files / directories

> apps/\
> packages/\
> docs/\
> tests/\
> scripts/\
> docker-compose.yml\
> package.json\
> pnpm-workspace.yaml\
> tsconfig.base.json\
> README.md\
> .env.example\
> .gitignore

## Git conventions

- main remains stable.

- Use focused feature branches for meaningful work.

- Commits should describe engineering intent: feat:, fix:, test:, docs:, refactor:.

- Do not commit secrets or machine-specific generated artifacts.

## Development infrastructure

Docker Compose initially provides PostgreSQL and Redis. Application runtimes may run directly on the host during development for faster debugging. Containerizing the application runtimes is a later deployment concern.

## README baseline

The initial README should explain the problem, architecture at a glance, prerequisites, local setup, environment variables, how to run the apps, and where the architecture decisions are documented.

# 22. Build Phases

| **Phase**                  | **Outcome**                                                               |
|----------------------------|---------------------------------------------------------------------------|
| 0 — Repository foundation  | Workspace, tooling, Docker infrastructure, docs baseline.                 |
| 1 — Persistence foundation | Prisma schema, migrations, constraints, indexes.                          |
| 2 — Domain foundation      | States, failure taxonomy, retry policy, idempotency rules.                |
| 3 — Webhook ingestion      | Signature verification, validation, persistence, duplicate handling.      |
| 4 — Worker processing      | BullMQ worker, operations, attempts, failure classification.              |
| 5 — Integration adapters   | CRM, payment, fulfillment, notification mock integrations.                |
| 6 — Reliability            | Retries, ambiguity, rate limits, auth refresh, health, failure injection. |
| 7 — Reconciliation         | Relationships, comparison rules, discrepancies, resolution.               |
| 8 — Operations console     | Dashboard, events, integrations, incidents, reconciliation controls.      |
| 9 — Security & testing     | Auth, authorization, redaction, unit/integration/e2e/failure tests.       |
| 10 — Portfolio hardening   | Deployment, reproducible demos, metrics, documentation, case study.       |

## Build rule

Do not start the next phase merely because the previous phase has code. A phase advances when its acceptance criteria are met and the behavior is verified.

# 23. AI-Assisted Engineering Protocol

## Human architect

The founder owns the system. The founder decides scope, architecture, stack, acceptance, and what code enters the repository.

## ChatGPT — architecture/research partner

- Research current market/technical evidence when needed.

- Turn requirements into specifications.

- Challenge assumptions.

- Design architecture and decision records.

- Review implementation against the specification.

- Maintain continuity and flag drift.

## Claude — implementation assistant

- Receive the master document as context.

- Receive one bounded task at a time.

- Implement only the requested scope.

- Do not silently refactor unrelated architecture.

- Return changed files, reasoning, tests, and any deviations.

## Gemini — independent challenger

- Review targeted architecture or code.

- Identify hidden failure modes, security issues, test gaps, and alternative approaches.

- Do not be treated as the automatic source of truth.

## Human integration loop

> Master spec\
> ↓\
> Specific task\
> ↓\
> Claude implementation\
> ↓\
> Human inspection\
> ↓\
> ChatGPT review\
> ↓\
> Gemini challenge\
> ↓\
> Reconcile findings\
> ↓\
> Human integrates code in Cursor / VS Code\
> ↓\
> Run tests\
> ↓\
> Commit to Git\
> ↓\
> Update decision record if necessary

# 24. Claude Handoff Contract

Every Claude task should include two things: (1) the Product 1 Master Specification as the governing context, and (2) a specific task that is narrow enough to review.

## Required wording / structure

> You are implementing one bounded task inside the Integration Reliability System.\
>
> AUTHORITATIVE CONTEXT\
> Read the attached Product 1 Master Specification first.\
> It is the governing product and architecture context for this repository.\
>
> TASK\
> \[One specific implementation task.\]\
>
> OBJECTIVE\
> \[What the task must accomplish.\]\
>
> IN SCOPE\
> \[Exact files/components/behavior.\]\
>
> OUT OF SCOPE\
> \[What must not be changed.\]\
>
> ARCHITECTURAL CONSTRAINTS\
> \[Relevant accepted decisions.\]\
>
> ACCEPTANCE CRITERIA\
> \[Observable conditions that prove completion.\]\
>
> TEST REQUIREMENTS\
> \[Exact tests to add/run.\]\
>
> OUTPUT\
> Return:\
> 1. summary of implementation\
> 2. files changed\
> 3. important decisions/assumptions\
> 4. tests added\
> 5. test results\
> 6. anything that conflicts with the master specification\
> 7. anything you believe should be reconsidered\
>
> DO NOT\
> - redesign the system\
> - change unrelated modules\
> - introduce new infrastructure without justification\
> - silently change accepted decisions\
> - claim tests passed if they were not run

This is the standard skeleton. Each actual task prompt will be written specifically for that task.

# 25. Initial Claude Task Queue

| **Task ID** | **Task**                  | **Purpose**                          | **Dependency** |
|-------------|---------------------------|--------------------------------------|----------------|
| 001         | Repository bootstrap      | Create monorepo skeleton and tooling | None           |
| 002         | Docker infrastructure     | PostgreSQL + Redis local services    | 001            |
| 003         | Configuration foundation  | Typed environment/config handling    | 001            |
| 004         | Prisma initialization     | Database client/migration foundation | 002            |
| 005         | Domain enums              | Shared status/failure types          | 001            |
| 006         | Initial schema            | Core configuration/event entities    | 004,005        |
| 007         | Event state machine       | Protect legal state transitions      | 005            |
| 008         | Retry policy model        | Represent bounded retry behavior     | 005            |
| 009         | Adapter contracts         | Define provider capability boundary  | 001            |
| 010         | Webhook verification      | Secure inbound webhook boundary      | 006,009        |
| 011         | Durable event ingestion   | Persist accepted events              | 006,010        |
| 012         | Queue dispatch            | Schedule background processing       | 002,011        |
| 013         | Worker foundation         | Consume jobs safely                  | 012            |
| 014         | Processing attempts       | Persist execution history            | 006,013        |
| 015         | Failure classifier        | Canonical recovery classification    | 005,014        |
| 016         | Retry engine              | Implement bounded retries/backoff    | 008,015        |
| 017         | Mock CRM                  | External system simulation           | 009            |
| 018         | Mock payment provider     | Events + lookup simulation           | 009            |
| 019         | Mock fulfillment provider | Idempotent create + failures         | 009            |
| 020         | Failure injection         | Deterministic provider faults        | 017–019        |

This queue is intentionally a roadmap, not a mandate to execute all tasks without review. We will generate the exact Claude handoff for each task only after the previous task is verified.

# 26. Decision Register

| **ID** | **Decision**                                                            | **Status** | **Notes**                                    |
|--------|-------------------------------------------------------------------------|------------|----------------------------------------------|
| D-001  | Product name = Integration Reliability System                           | ACCEPTED   | Locked                                       |
| D-002  | IRS is a reliability/orchestration layer, not business system of record | ACCEPTED   | Locked                                       |
| D-003  | Northstar Commerce is the fictional demonstration scenario              | ACCEPTED   | Synthetic                                    |
| D-004  | Modular monolith + dedicated worker                                     | ACCEPTED   | V1 architecture                              |
| D-005  | PostgreSQL is durable source of truth                                   | ACCEPTED   | Domain/operational state                     |
| D-006  | Redis/BullMQ handles background job transport/scheduling                | ACCEPTED   | Not source of truth                          |
| D-007  | Adapter pattern isolates provider-specific integration code             | ACCEPTED   | Capabilities over vendor leakage             |
| D-008  | Idempotency is required at inbound and processing levels                | ACCEPTED   | Remote support where available               |
| D-009  | Ambiguous outcomes require verification/reconciliation                  | ACCEPTED   | No blind retry                               |
| D-010  | Reconciliation is first-class                                           | ACCEPTED   | Explicit rules                               |
| D-011  | AI is not core V1                                                       | ACCEPTED   | Reliability first                            |
| D-012  | n8n is not core Product 1                                               | ACCEPTED   | Reserved for Product 2                       |
| D-013  | Supabase is not core Product 1                                          | ACCEPTED   | Avoid abstraction of intended infrastructure |

## Open questions

| **ID** | **Question**                            | **Decision point**           |
|--------|-----------------------------------------|------------------------------|
| O-001  | Fastify vs alternative HTTP framework   | Repository foundation review |
| O-002  | Exact Prisma field types/indexes        | Schema task                  |
| O-003  | Exact authentication/session library    | Security implementation      |
| O-004  | Exact retry jitter formula              | Retry task                   |
| O-005  | Exact integration-health thresholds     | Reliability phase            |
| O-006  | Exact reconciliation rules per resource | Reconciliation phase         |
| O-007  | Event ordering/version semantics        | Domain/task review           |
| O-008  | Deployment platform                     | Portfolio hardening          |
| O-009  | Retention/archival policy               | Operational hardening        |
| O-010  | Exact portfolio benchmark workload      | Testing/metrics phase        |

# 27. Portfolio Demonstration Plan

The finished product should be easy to demonstrate in a 5–10 minute screen recording and easy to inspect from the repository.

## Demo sequence

28. Show the architecture and the role of IRS.

29. Create a normal customer/order flow.

30. Open the event timeline and show successful processing.

31. Inject duplicate webhook delivery; show duplicate suppression.

32. Inject 503; show retries and eventual recovery.

33. Inject timeout after a remote side effect; show UNKNOWN → verification → reconciliation.

34. Inject 429; show backoff.

35. Break authentication; show degraded integration state.

36. Create a state mismatch; run reconciliation and show the discrepancy.

37. Perform a controlled manual replay.

## Evidence to capture

- Architecture diagram.

- Repository structure.

- Representative code snippets for idempotency/retry/reconciliation.

- Operations console screenshots.

- Failure-injection screenshots/video.

- Synthetic benchmark results.

- ADR excerpts showing engineering tradeoffs.

## Case-study framing

The public case study should present a problem, investigation, architecture, interventions, reliability behavior, and measured synthetic results. It must not imply that Northstar Commerce was a real client.

# 28. Source Register

| **Source**                                 | **Publisher**             | **Use in this specification**                                                         | **URL**                                                                                                                                             |
|--------------------------------------------|---------------------------|---------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| Microsoft — Retry pattern                  | Microsoft Learn           | Retry classification, bounded retries, backoff, logging, idempotency considerations.  | https://learn.microsoft.com/en-us/azure/architecture/patterns/retry                                                                                 |
| Microsoft — Transient Fault Handling       | Microsoft Learn           | Exponential backoff with jitter, Retry-After, concurrency/load considerations.        | https://learn.microsoft.com/en-us/azure/architecture/best-practices/transient-faults                                                                |
| AWS — Transactional Outbox pattern         | AWS Prescriptive Guidance | Database/event dual-write consistency, duplicate processing and idempotent consumers. | https://docs.aws.amazon.com/en_en/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html                                      |
| GitHub — Best practices for using webhooks | GitHub Docs               | Fast 2xx acknowledgement, asynchronous processing, webhook secrets/HTTPS.             | https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks                                                                |
| GitHub — Troubleshooting webhooks          | GitHub Docs               | Webhook timeouts and asynchronous queue recommendation.                               | https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks                                                   |
| BullMQ — Retrying failing jobs             | BullMQ Docs               | Worker retries and built-in fixed/exponential backoff.                                | https://docs.bullmq.io/guide/retrying-failing-jobs                                                                                                  |
| BullMQ — Deduplication                     | BullMQ Docs               | Job deduplication and preventing duplicate concurrent work.                           | https://docs.bullmq.io/guide/jobs/deduplication                                                                                                     |
| Stripe — Idempotent requests               | Stripe Docs               | Idempotency keys for safe retries of side-effecting requests.                         | https://docs.stripe.com/api/idempotent_requests                                                                                                     |
| Upwork — AI skills / hiring trends         | Upwork                    | Current market signal for AI integration and automation demand.                       | https://www.upwork.com/press/releases/upworks-in-demand-skills-2026-demand-for-top-ai-skills-more-than-doubles-as-ai-is-embedded-into-everyday-work |
| Upwork — Future Workforce Index 2026       | Upwork                    | AI-augmented professional work and value shifting toward complex implementation.      | https://www.upwork.com/research/research-future-workforce-index-2026                                                                                |

External marketplace observations are used to justify the commercial direction, while primary technical documentation is used to justify reliability and integration patterns.

# 29. Final Product Statement

**The Integration Reliability System is a controlled, portfolio-grade reliability layer for business integrations.**

It receives and verifies events, persists evidence, processes operations asynchronously, prevents duplicate side effects, classifies failures, applies safe retry policies, handles ambiguous outcomes, tracks integration health, reconciles divergent system states, and gives operators the evidence and controls needed to recover or escalate.

The project is intentionally designed as a disciplined engineering demonstration: realistic business problem, bounded architecture, meaningful failure behavior, explicit state transitions, durable evidence, and a human-led development process.

The strongest claim this project should make is not 'I can build an AI app.' It is: 'I can enter an existing business environment, understand how its systems interact, find where reliability breaks down, engineer a safer integration layer, and prove how the system behaves when things go wrong.'

# 30. Implementation Gate

Before any significant feature code is generated, the following must be true:

- □ Repository foundation decisions are accepted.

- □ Exact initial folder structure is accepted.

- □ Initial tooling is accepted.

- □ Initial database boundary is accepted.

- □ Environment/configuration conventions are accepted.

- □ Git conventions are accepted.

- □ The first Claude task is written with explicit in/out-of-scope boundaries.

- □ The master specification is supplied to Claude as governing context.

**END OF MASTER SPECIFICATION — V1.0**
