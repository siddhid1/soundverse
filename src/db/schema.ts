import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
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
