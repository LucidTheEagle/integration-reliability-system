-- CreateEnum
CREATE TYPE "DispatchAnomalyKind" AS ENUM ('COMPLETED_WHILE_QUEUED', 'FAILED_WHILE_QUEUED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "dispatchAnomalyAt" TIMESTAMPTZ(3),
ADD COLUMN     "dispatchAnomalyKind" "DispatchAnomalyKind",
ADD COLUMN     "lastPublishAckAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastPublishAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN     "publishAckedAt" TIMESTAMPTZ(3),
ADD COLUMN     "publishAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "queuedAt" TIMESTAMPTZ(3),
ADD COLUMN     "redispatchCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "redispatchRequestedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "Event_status_receivedAt_idx" ON "Event"("status", "receivedAt");

-- Task 012B (B1-2): the anomaly marker and its kind are both null or both set. Raw SQL, invisible to the
-- drift check (IRS-C-055); pinned by M1, M2 and readiness. Not duplicated in the trigger (B1-2 decision).
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_dispatchAnomaly_consistency_check"
  CHECK (("dispatchAnomalyAt" IS NULL) = ("dispatchAnomalyKind" IS NULL));

-- Task 012B (B1-4, ADD §3.3e): the dispatch-marker guard, rules T0-T3 (T4 is not refused; T5 is refused through T2).
-- SECURITY INVOKER, pinned search_path, schema-qualified. Each refusal has its own SQLSTATE; callers classify
-- by SQLSTATE, never by message. The owner is the role that runs migrations; nothing is granted here.
CREATE FUNCTION "public"."irs_event_dispatch_marker_guard"()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dispatchAnomalyAt" IS NOT NULL OR NEW."dispatchAnomalyKind" IS NOT NULL THEN
      RAISE EXCEPTION 'irs dispatch marker rule T0' USING ERRCODE = 'IRST0';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."dispatchAnomalyAt" IS NOT NULL
     AND (NEW."dispatchAnomalyAt" IS DISTINCT FROM OLD."dispatchAnomalyAt"
          OR NEW."dispatchAnomalyKind" IS DISTINCT FROM OLD."dispatchAnomalyKind") THEN
    RAISE EXCEPTION 'irs dispatch marker rule T2' USING ERRCODE = 'IRST2';
  END IF;
  IF OLD."dispatchAnomalyAt" IS NULL AND NEW."dispatchAnomalyAt" IS NOT NULL
     AND NOT (OLD."status" = 'QUEUED'::"public"."EventState"
              AND NEW."status" = 'QUEUED'::"public"."EventState"
              AND NEW."dispatchAnomalyKind" IS NOT NULL) THEN
    RAISE EXCEPTION 'irs dispatch marker rule T1' USING ERRCODE = 'IRST1';
  END IF;
  IF NEW."status" = 'PROCESSING'::"public"."EventState"
     AND (OLD."dispatchAnomalyAt" IS NOT NULL OR NEW."dispatchAnomalyAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'irs dispatch marker rule T3' USING ERRCODE = 'IRST3';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION "public"."irs_event_dispatch_marker_guard"() FROM PUBLIC;

CREATE TRIGGER "irs_event_dispatch_marker_guard"
  BEFORE INSERT OR UPDATE ON "public"."Event"
  FOR EACH ROW EXECUTE FUNCTION "public"."irs_event_dispatch_marker_guard"();
