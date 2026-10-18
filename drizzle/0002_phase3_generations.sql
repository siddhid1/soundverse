-- Phase 3: generations, idempotency, usage ledger, rate counters.
-- All money/access enforcement reads these tables inside one account-locked
-- transaction (see generations service). Constraints, not app code, are the
-- last line of defense.

CREATE TABLE IF NOT EXISTS "generations" (
  "id" text PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'queued'
    CHECK ("status" IN ('queued','running','succeeded','failed','canceled')),
  "prompt" text NOT NULL CHECK (char_length("prompt") BETWEEN 1 AND 2000),
  "duration_sec" integer NOT NULL CHECK ("duration_sec" BETWEEN 5 AND 300),
  "license" text NOT NULL CHECK ("license" IN ('royalty_free','sync','full_ownership')),
  "instrumental" boolean NOT NULL DEFAULT true,
  "metadata" jsonb,
  "reserved_credits" integer NOT NULL CHECK ("reserved_credits" >= 0),
  "charged_credits" integer CHECK ("charged_credits" IS NULL OR "charged_credits" >= 0),
  "provider" text,
  "model" text,
  "provider_job_id" text,
  "object_key" text,
  "output_duration_sec" double precision,
  "output_format" text,
  "error_code" text,
  "error_message" text,
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "claimed_at" timestamptz,
  "lease_expires_at" timestamptz,
  "cancel_requested_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "period_start" date NOT NULL
);
CREATE INDEX IF NOT EXISTS "generations_account_status_idx"
  ON "generations" ("account_id", "status");
CREATE INDEX IF NOT EXISTS "generations_account_created_idx"
  ON "generations" ("account_id", "created_at" DESC, "id" DESC);

-- Idempotency scope: one key namespace per account (documented in DECISIONS.md).
CREATE TABLE IF NOT EXISTS "idempotency_records" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL
    CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  "request_hash" text NOT NULL,
  "generation_id" text REFERENCES "generations"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  UNIQUE ("account_id", "idempotency_key")
);
CREATE INDEX IF NOT EXISTS "idempotency_records_expiry_idx"
  ON "idempotency_records" ("expires_at");

-- Append-only ledger. Rows are never updated or deleted. Semantics:
--   used_this_period    = SUM(charge) + SUM(overage_charge)
--   pending_reserved    = SUM(reservation) - SUM(release) - SUM(charge) - SUM(overage_charge)
-- Every reservation is finalized by exactly one terminal entry (charge,
-- release, or overage_charge) carrying the generation's original period_start,
-- so cross-month completion cannot strand pending balances.
CREATE TABLE IF NOT EXISTS "usage_ledger" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "generation_id" text REFERENCES "generations"("id") ON DELETE SET NULL,
  "type" text NOT NULL CHECK ("type" IN ('reservation','charge','release','overage_charge')),
  "amount" integer NOT NULL CHECK ("amount" >= 0),
  "period_start" date NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb
);
CREATE INDEX IF NOT EXISTS "ledger_account_period_idx"
  ON "usage_ledger" ("account_id", "period_start", "created_at");
CREATE INDEX IF NOT EXISTS "ledger_generation_idx"
  ON "usage_ledger" ("generation_id");

-- Fixed-window counters (UTC hour / UTC day). Incremented for every
-- non-replay POST /v1/generations attempt, including rejected ones, so
-- abusive clients cannot dodge the limiter by sending invalid requests.
CREATE TABLE IF NOT EXISTS "rate_counters" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "granularity" text NOT NULL CHECK ("granularity" IN ('hour','day')),
  "window_start" timestamptz NOT NULL,
  "count" integer NOT NULL DEFAULT 1 CHECK ("count" >= 0),
  PRIMARY KEY ("account_id", "granularity", "window_start")
);
