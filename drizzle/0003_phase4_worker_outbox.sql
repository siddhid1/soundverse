-- Phase 4: worker recovery support + durable outbox.
-- webhook_deliveries arrive in Phase 5 with the dispatcher.

-- Fast path for the recovery scan: only running jobs past their lease.
CREATE INDEX IF NOT EXISTS "generations_recovery_idx"
  ON "generations" ("status", "lease_expires_at");

-- Webhook endpoints (CRUD routes in Phase 5). Secrets are stored encrypted;
-- the plaintext secret is never persisted or returned by list calls.
CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "secret_enc" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "webhook_endpoints_account_idx"
  ON "webhook_endpoints" ("account_id");

-- Durable outbox: the worker commits domain events in the SAME transaction
-- that finalizes the job, so event emission is atomic with billing. The
-- Phase 5 dispatcher delivers them and marks published_at.
CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" text PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "type" text NOT NULL CHECK ("type" IN ('generation.succeeded','generation.failed','generation.canceled')),
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "outbox_unpublished_idx"
  ON "outbox_events" ("created_at") WHERE "published_at" IS NULL;
