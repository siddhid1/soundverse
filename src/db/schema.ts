import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  date,
} from "drizzle-orm/pg-core";

/**
 * Canonical schema. DDL source of truth is drizzle/*.sql (hand-written so
 * critical constraints are explicit); this file mirrors it for typed queries.
 */

export const schemaMeta = pgTable("schema_meta", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  monthlyAllowanceCredits: integer("monthly_allowance_credits").notNull(),
  parallelGenerations: integer("parallel_generations").notNull(),
  requestsPerHour: integer("requests_per_hour").notNull(),
  requestsPerDay: integer("requests_per_day").notNull(),
  allowedLicenses: jsonb("allowed_licenses").notNull(),
  overagePolicy: text("overage_policy").notNull(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "restrict" }),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  name: text("name"),
  scopes: jsonb("scopes").notNull(),
  mode: text("mode").notNull(),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  rotatedFromKeyId: uuid("rotated_from_key_id"),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey(),
  actorUserId: uuid("actor_user_id"),
  accountId: uuid("account_id").notNull(),
  action: text("action").notNull(),
  keyId: uuid("key_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata"),
});

/**
 * Phase 3 entities. See drizzle/0002_phase3_generations.sql for constraints
 * and the ledger accounting semantics; this mirrors it for typed queries.
 */
export const generations = pgTable("generations", {
  id: text("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  keyId: uuid("key_id"),
  status: text("status").notNull().default("queued"),
  prompt: text("prompt").notNull(),
  durationSec: integer("duration_sec").notNull(),
  license: text("license").notNull(),
  instrumental: boolean("instrumental").notNull().default(true),
  metadata: jsonb("metadata"),
  reservedCredits: integer("reserved_credits").notNull(),
  chargedCredits: integer("charged_credits"),
  provider: text("provider"),
  model: text("model"),
  providerJobId: text("provider_job_id"),
  objectKey: text("object_key"),
  outputDurationSec: doublePrecision("output_duration_sec"),
  outputFormat: text("output_format"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  periodStart: date("period_start").notNull(),
});

export const idempotencyRecords = pgTable("idempotency_records", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  generationId: text("generation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const usageLedger = pgTable("usage_ledger", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  keyId: uuid("key_id"),
  generationId: text("generation_id"),
  type: text("type").notNull(),
  amount: integer("amount").notNull(),
  periodStart: date("period_start").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata"),
});

export const rateCounters = pgTable("rate_counters", {
  accountId: uuid("account_id").notNull(),
  granularity: text("granularity").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(1),
});

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: text("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey(),
  eventId: text("event_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  accountId: uuid("account_id").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
