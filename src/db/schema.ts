import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Phase 1 placeholder schema.
 * Real entities (users, accounts, plans, api_keys, generations, ledger,
 * idempotency, webhooks, outbox, audit) land in Phase 2/3/5.
 * This table exists so `drizzle-kit generate` + migrate works from day one
 * and proves the migration pipeline before concurrency-critical tables arrive.
 */
export const schemaMeta = pgTable("schema_meta", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
