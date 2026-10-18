-- Phase 5: durable webhook delivery records.
-- One row per (event, endpoint). The dispatcher owns the retry state machine;
-- a failed webhook NEVER rolls back the job or its billing (those committed
-- in the worker's transaction long before this row is touched).

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY,
  "event_id" text NOT NULL REFERENCES "outbox_events"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending','delivered','failed','dead')),
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_status_code" integer,
  "last_error" text,
  "last_attempt_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("event_id", "endpoint_id")
);
CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx"
  ON "webhook_deliveries" ("status", "next_attempt_at") WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "webhook_deliveries_event_idx"
  ON "webhook_deliveries" ("event_id");
