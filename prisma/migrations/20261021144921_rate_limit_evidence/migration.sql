-- CreateTable
CREATE TABLE "RateLimitEvidence" (
    "id" UUID NOT NULL,
    "limiterInstanceId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "gapReason" TEXT,
    "firstSequence" INTEGER,
    "lastSequence" INTEGER,
    "missingFrom" INTEGER,
    "missingTo" INTEGER,
    "payload" JSONB NOT NULL,
    "recordSha256" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitEvidence_scope_kind_idx" ON "RateLimitEvidence"("scope", "kind");

-- CreateIndex
CREATE INDEX "RateLimitEvidence_limiterInstanceId_idx" ON "RateLimitEvidence"("limiterInstanceId");

CREATE UNIQUE INDEX rle_instance_lifecycle_uq ON "RateLimitEvidence" ("limiterInstanceId", "kind")
  WHERE "kind" IN ('INSTANCE_STARTED', 'INSTANCE_CLOSED');
CREATE UNIQUE INDEX rle_summary_range_uq ON "RateLimitEvidence" ("limiterInstanceId", "firstSequence", "lastSequence")
  WHERE "kind" = 'SUMMARY';
CREATE UNIQUE INDEX rle_gap_discontinuity_uq ON "RateLimitEvidence" ("limiterInstanceId", "missingFrom", "missingTo")
  WHERE "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'SEQUENCE_DISCONTINUITY';
CREATE UNIQUE INDEX rle_gap_unclean_uq ON "RateLimitEvidence" ("limiterInstanceId")
  WHERE "kind" = 'EVIDENCE_GAP' AND "gapReason" = 'UNCLEAN_TERMINATION';
ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_kind_ck
  CHECK ("kind" IN ('INSTANCE_STARTED','SUMMARY','EVIDENCE_GAP','INSTANCE_CLOSED'));
ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_summary_shape_ck
  CHECK ("kind" <> 'SUMMARY'
         OR ("firstSequence" IS NOT NULL AND "lastSequence" IS NOT NULL
             AND "firstSequence" >= 1 AND "lastSequence" >= "firstSequence"));
ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_gap_shape_ck
  CHECK ("kind" <> 'EVIDENCE_GAP' OR "gapReason" IS DISTINCT FROM 'SEQUENCE_DISCONTINUITY'
         OR ("missingFrom" IS NOT NULL AND "missingTo" IS NOT NULL
             AND "missingFrom" >= 1 AND "missingTo" >= "missingFrom"));   -- no null, inverted or empty gaps
ALTER TABLE "RateLimitEvidence" ADD CONSTRAINT rle_gap_reason_ck
  CHECK ("kind" <> 'EVIDENCE_GAP'
         OR ("gapReason" IS NOT NULL AND "gapReason" IN ('SEQUENCE_DISCONTINUITY', 'UNCLEAN_TERMINATION')));
-- PostgreSQL accepts a row when a CHECK expression evaluates to NULL; the explicit IS NOT NULL predicates make
-- each constraint evaluate to FALSE (and reject the row) whenever a constrained field is missing.
