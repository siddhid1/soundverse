import type { Pool } from "pg";
import { getPool } from "../db/index.js";
import { currentPeriodStart } from "./credits.js";
import { usageSummary, type UsageSummary } from "./generations.js";

export interface DayUsage {
  day: string;
  used_credits: number;
  pending_credits: number;
}

export interface KeyUsage {
  key_id: string | null;
  key_prefix: string | null;
  key_mode: string | null;
  used_credits: number;
  pending_credits: number;
}

export interface UsageBreakdown {
  summary: UsageSummary;
  per_day: DayUsage[];
  per_key: KeyUsage[];
}

/**
 * Dashboard usage rollups, read straight from the append-only ledger (the
 * same source the API's /v1/usage derives from — one source of truth).
 * Reservations count as pending until finalized, so in-flight jobs are
 * visible as held credit rather than silently missing.
 */
export async function usageBreakdown(
  pool: Pool = getPool(),
  opts: { accountId: string; planId: string },
): Promise<UsageBreakdown> {
  const summary = await usageSummary(pool, opts);
  const period = currentPeriodStart();
  const perDay = await pool.query(
    `SELECT created_at::date AS day,
       COALESCE(SUM(amount) FILTER (WHERE type IN ('charge','overage_charge')), 0)::int AS used,
       (COALESCE(SUM(amount) FILTER (WHERE type='reservation'), 0)
        - COALESCE(SUM(amount) FILTER (WHERE type IN ('release','charge','overage_charge')), 0))::int AS pending
     FROM usage_ledger
     WHERE account_id=$1 AND created_at > now() - interval '30 days'
     GROUP BY 1 ORDER BY 1 DESC`,
    [opts.accountId],
  );
  const perKey = await pool.query(
    `SELECT l.key_id, k.prefix AS key_prefix, k.mode AS key_mode,
       COALESCE(SUM(l.amount) FILTER (WHERE l.type IN ('charge','overage_charge')), 0)::int AS used,
       (COALESCE(SUM(l.amount) FILTER (WHERE l.type='reservation'), 0)
        - COALESCE(SUM(l.amount) FILTER (WHERE l.type IN ('release','charge','overage_charge')), 0))::int AS pending
     FROM usage_ledger l LEFT JOIN api_keys k ON k.id = l.key_id
     WHERE l.account_id=$1 AND l.period_start=$2
     GROUP BY l.key_id, k.prefix, k.mode ORDER BY used DESC`,
    [opts.accountId, period],
  );
  return {
    summary,
    per_day: (perDay.rows as { day: string; used: number; pending: number }[]).map((r) => ({
      day: typeof r.day === "string" ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10),
      used_credits: r.used,
      pending_credits: r.pending,
    })),
    per_key: (perKey.rows as { key_id: string | null; key_prefix: string | null; key_mode: string | null; used: number; pending: number }[]).map(
      (r) => ({
        key_id: r.key_id,
        key_prefix: r.key_prefix,
        key_mode: r.key_mode,
        used_credits: r.used,
        pending_credits: r.pending,
      }),
    ),
  };
}
