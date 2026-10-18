-- Phase 2: accounts, plans, API keys, sessions, audit.
-- Conventions: app generates UUIDs (no DB default); emails normalized lowercase in app.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "email_verified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_uidx" ON "users" (lower("email"));

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "email_verification_tokens_user_idx" ON "email_verification_tokens" ("user_id");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "plans" (
  "id" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "monthly_allowance_credits" integer NOT NULL CHECK ("monthly_allowance_credits" >= 0),
  "parallel_generations" integer NOT NULL CHECK ("parallel_generations" >= 1),
  "requests_per_hour" integer NOT NULL CHECK ("requests_per_hour" >= 0),
  "requests_per_day" integer NOT NULL CHECK ("requests_per_day" >= 0),
  "allowed_licenses" jsonb NOT NULL,
  "overage_policy" text NOT NULL CHECK ("overage_policy" IN ('none','hard_stop','overage'))
);

-- Plan values are data, not code: changeable without a deploy.
INSERT INTO "plans" ("id","display_name","monthly_allowance_credits","parallel_generations","requests_per_hour","requests_per_day","allowed_licenses","overage_policy") VALUES
  ('sandbox','Sandbox',0,1,60,500,'["royalty_free"]','none'),
  ('starter','Starter',200,3,300,3000,'["royalty_free","sync"]','hard_stop'),
  ('growth','Growth',2000,10,2000,30000,'["royalty_free","sync","full_ownership"]','overage')
ON CONFLICT ("id") DO UPDATE SET
  "display_name"=EXCLUDED."display_name",
  "monthly_allowance_credits"=EXCLUDED."monthly_allowance_credits",
  "parallel_generations"=EXCLUDED."parallel_generations",
  "requests_per_hour"=EXCLUDED."requests_per_hour",
  "requests_per_day"=EXCLUDED."requests_per_day",
  "allowed_licenses"=EXCLUDED."allowed_licenses",
  "overage_policy"=EXCLUDED."overage_policy";

CREATE TABLE IF NOT EXISTS "accounts" (
  "id" uuid PRIMARY KEY,
  "owner_user_id" uuid NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT,
  "plan_id" text NOT NULL REFERENCES "plans"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "key_hash" text NOT NULL UNIQUE,
  "prefix" text NOT NULL,
  "name" text,
  "scopes" jsonb NOT NULL,
  "mode" text NOT NULL CHECK ("mode" IN ('test','live')),
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "last_used_at" timestamptz,
  "rotated_from_key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  CONSTRAINT "api_keys_scopes_nonempty" CHECK (jsonb_array_length("scopes") >= 1)
);
CREATE INDEX IF NOT EXISTS "api_keys_account_idx" ON "api_keys" ("account_id");

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb
);
CREATE INDEX IF NOT EXISTS "audit_logs_account_idx" ON "audit_logs" ("account_id", "created_at" DESC);
