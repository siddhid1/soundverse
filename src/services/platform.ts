import type { Pool } from "pg";
import { getPool } from "../db/index.js";
import { currentPeriodStart } from "./credits.js";

export interface PlatformStats {
  period_start: string;
  generated_at: string;
  accounts: { total: number; by_plan: Record<string, number> };
  jobs: {
    by_status: Record<string, number>;
    active: number;
    generation_time: { avg_seconds: number; max_seconds: number };
  };
  credits: {
    allowance: number;
    granted: number;
    used: number;
    pending: number;
    overage: number;
    remaining: number;
    by_license: Record<string, { songs: number; credits: number }>;
  };
  keys: { total: number; active: number };
  usage_30d: { day: string; songs: number; used_credits: number }[];
  webhooks: {
    endpoints: number;
    deliveries_last_24h: { delivered: number; failed: number; dead: number; pending: number };
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Platform-wide aggregates. Every query is COUNT/SUM/AVG … GROUP BY — the
 * SELECT lists contain no email, no prompt, no metadata, no hash, no secret,
 * no per-account or per-key rows. Read-only; no side effects.
 */
export async function platformStats(pool: Pool = getPool()): Promise<PlatformStats> {
  const period = currentPeriodStart();
  const [
    accountsRes,
    jobsRes,
    renderRes,
    ledgerRes,
    licenseRes,
    keysRes,
    songsPerDayRes,
    creditsPerDayRes,
    endpointsRes,
    deliveriesRes,
  ] = await Promise.all([
    pool.query(`SELECT plan_id, COUNT(*)::int AS n FROM accounts GROUP BY plan_id`),
    pool.query(`SELECT status, COUNT(*)::int AS n FROM generations GROUP BY status`),
    pool.query(
      `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))
         FILTER (WHERE status='succeeded'), 0)::float AS avg_seconds,
        COALESCE(MAX(EXTRACT(EPOCH FROM (completed_at - created_at)))
         FILTER (WHERE status='succeeded'), 0)::float AS max_seconds
       FROM generations`,
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='grant'), 0)::int AS granted,
         COALESCE(SUM(amount) FILTER (WHERE type IN ('charge','overage_charge')), 0)::int AS used,
         COALESCE(SUM(amount) FILTER (WHERE type IN ('overage_charge')), 0)::int AS overage,
         (COALESCE(SUM(amount) FILTER (WHERE type='reservation'), 0)
          - COALESCE(SUM(amount) FILTER (WHERE type IN ('release','charge','overage_charge')), 0))::int AS pending
       FROM usage_ledger WHERE period_start=$1`,
      [period],
    ),
    pool.query(
      `SELECT g.license,
         COUNT(*)::int AS songs,
         COALESCE(SUM(g.charged_credits) FILTER (WHERE g.status='succeeded'), 0)::int AS credits
       FROM generations g GROUP BY g.license`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS active
       FROM api_keys`,
    ),
    pool.query(
      `SELECT created_at::date AS day, COUNT(*)::int AS songs
       FROM generations WHERE created_at > now() - interval '30 days' GROUP BY 1`,
    ),
    pool.query(
      `SELECT created_at::date AS day,
         COALESCE(SUM(amount) FILTER (WHERE type IN ('charge','overage_charge')), 0)::int AS used
       FROM usage_ledger
       WHERE created_at > now() - interval '30 days' AND type <> 'grant' GROUP BY 1`,
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM webhook_endpoints`),
    pool.query(
      `SELECT status, COUNT(*)::int AS n FROM webhook_deliveries
       WHERE created_at > now() - interval '24 hours' GROUP BY status`,
    ),
  ]);

  const allowanceRes = await pool.query(
    `SELECT COALESCE(SUM(p.monthly_allowance_credits), 0)::int AS allowance
     FROM accounts a JOIN plans p ON p.id = a.plan_id`,
  );

  const byPlan: Record<string, number> = {};
  let accountTotal = 0;
  for (const r of accountsRes.rows as { plan_id: string; n: number }[]) {
    byPlan[r.plan_id] = r.n;
    accountTotal += r.n;
  }

  const byStatus: Record<string, number> = {};
  let active = 0;
  for (const r of jobsRes.rows as { status: string; n: number }[]) {
    byStatus[r.status] = r.n;
    if (r.status === "queued" || r.status === "running") active += r.n;
  }

  const ledger = ledgerRes.rows[0] as { granted: number; used: number; overage: number; pending: number };
  const allowance = (allowanceRes.rows[0] as { allowance: number }).allowance;

  const byLicense: Record<string, { songs: number; credits: number }> = {};
  for (const r of licenseRes.rows as { license: string; songs: number; credits: number }[]) {
    byLicense[r.license] = { songs: r.songs, credits: r.credits };
  }

  const dayKey = (d: unknown): string =>
    typeof d === "string" ? d.slice(0, 10) : new Date(d as string).toISOString().slice(0, 10);
  const days = new Map<string, { day: string; songs: number; used_credits: number }>();
  for (const r of creditsPerDayRes.rows as { day: unknown; used: number }[]) {
    const k = dayKey(r.day);
    days.set(k, { day: k, songs: 0, used_credits: r.used });
  }
  for (const r of songsPerDayRes.rows as { day: unknown; songs: number }[]) {
    const k = dayKey(r.day);
    const cur = days.get(k);
    if (cur) cur.songs = r.songs;
    else days.set(k, { day: k, songs: r.songs, used_credits: 0 });
  }
  const usage30d = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));

  const deliveries = { delivered: 0, failed: 0, dead: 0, pending: 0 };
  for (const r of deliveriesRes.rows as { status: string; n: number }[]) {
    if (r.status in deliveries) deliveries[r.status as keyof typeof deliveries] = r.n;
  }

  const render = renderRes.rows[0] as { avg_seconds: number; max_seconds: number };
  const keyRow = keysRes.rows[0] as { total: number; active: number };

  return {
    period_start: period,
    generated_at: new Date().toISOString(),
    accounts: { total: accountTotal, by_plan: byPlan },
    jobs: {
      by_status: byStatus,
      active,
      generation_time: { avg_seconds: round2(render.avg_seconds), max_seconds: round2(render.max_seconds) },
    },
    credits: {
      allowance,
      granted: ledger.granted,
      used: ledger.used,
      pending: ledger.pending,
      overage: ledger.overage,
      remaining: allowance + ledger.granted - ledger.used - ledger.pending,
      by_license: byLicense,
    },
    keys: { total: keyRow.total, active: keyRow.active },
    usage_30d: usage30d,
    webhooks: {
      endpoints: (endpointsRes.rows[0] as { n: number }).n,
      deliveries_last_24h: deliveries,
    },
  };
}
