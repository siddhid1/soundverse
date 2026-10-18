-- Phase 1 baseline: proves migration pipeline before concurrency-critical tables.
CREATE TABLE IF NOT EXISTS "schema_meta" (
  "id" text PRIMARY KEY,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
