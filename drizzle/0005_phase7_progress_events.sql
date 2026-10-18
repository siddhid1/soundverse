-- Phase 7: live job progress + lifecycle webhook events.
--
-- progress: 0-100, set on claim (10), ticked by the provider during the render
-- (25/50/75), and forced to 100 on success. Purely informational — it never
-- affects billing, which settles from the requested song duration.
ALTER TABLE "generations"
  ADD COLUMN IF NOT EXISTS "progress" integer NOT NULL DEFAULT 0;
ALTER TABLE "generations"
  DROP CONSTRAINT IF EXISTS "generations_progress_check";
ALTER TABLE "generations"
  ADD CONSTRAINT "generations_progress_check" CHECK ("progress" BETWEEN 0 AND 100);

-- outbox_events.type gains the two non-terminal lifecycle events. Terminal
-- events still number exactly one per job; progress events are exempt from
-- that invariant (they are emitted outside the finalize transaction).
ALTER TABLE "outbox_events" DROP CONSTRAINT IF EXISTS "outbox_events_type_check";
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_type_check"
  CHECK ("type" IN (
    'generation.succeeded',
    'generation.failed',
    'generation.canceled',
    'generation.created',
    'generation.progress'
  ));
