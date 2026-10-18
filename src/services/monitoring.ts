import type { Pool } from "pg";
import { getPool } from "../db/index.js";
import { listAudit, type AuditEntry } from "./audit.js";
import { currentPeriodStart } from "./credits.js";
import { usageSummary, type UsageSummary } from "./generations.js";

export interface KeySongStats {
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  running: number;
  queued: number;
}

export interface KeyStats {
  key_id: string;
  prefix: string;
  mode: string;
  scopes: string[];
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  songs: KeySongStats;
  credits_used: number;
  credits_pending: number;
  generation_time: {
    avg_seconds: number;
    max_seconds: number;
    total_seconds: number;
  };
}

export interface RecentGeneration {
  id: string;
  status: string;
  key_id: string | null;
  license: string;
  duration_sec: number;
  progress: number;
  credits_reserved: number;
  credits_charged: number | null;
  created_at: string;
  completed_at: string | null;
  generation_seconds: number | null;
}

export interface DailyUsage {
  day: string;
  used_credits: number;
  pending_credits: number;
  songs: number;
}

export interface WebhookEndpointSummary {
  id: string;
  url: string;
  enabled: boolean;
  created_at: string;
}

export interface MonitoringReport {
  account: { id: string; plan_id: string; period_start: string };
  credits: UsageSummary;
  jobs_by_status: Record<string, number>;
  active_jobs: number;
  per_key: KeyStats[];
  recent_generations: RecentGeneration[];
  daily_usage_last_30_days: DailyUsage[];
  audit: AuditEntry[];
  webhooks: {
    endpoints: WebhookEndpointSummary[];
    deliveries_last_24h: { delivered: number; failed: number; dead: number; pending: number };
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Per-API-key operational stats for the current period: how many songs each
 * key drove, how long those renders took, and how many credits it consumed.
 * Everything is derived from existing rows (generations.key_id + usage_ledger)
 * — no new tables, and no per-key quota of its own (billing is account-wide;
 * keys are the attribution lens).
 */
export async function keyStats(
  pool: Pool = getPool(),
  accountId: string,
  period: string = currentPeriodStart(),
): Promise<KeyStats[]> {
  const keysRes = await pool.query(
    `SELECT id, prefix, mode, scopes, name, created_at, last_used_at, revoked_at
     FROM api_keys WHERE account_id=$1 ORDER BY created_at`,
    [accountId],
  );
  const genRes = await pool.query(
    `SELECT key_id,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status='succeeded')::int AS succeeded,
       COUNT(*) FILTER (WHERE status='failed')::int AS failed,
       COUNT(*) FILTER (WHERE status='canceled')::int AS canceled,
       COUNT(*) FILTER (WHERE status='running')::int AS running,
       COUNT(*) FILTER (WHERE status='queued')::int AS queued,
       COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))
         FILTER (WHERE status='succeeded'), 0)::float AS avg_seconds,
       COALESCE(MAX(EXTRACT(EPOCH FROM (completed_at - created_at)))
         FILTER (WHERE status='succeeded'), 0)::float AS max_seconds,
       COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - created_at)))
         FILTER (WHERE status='succeeded'), 0)::float AS total_seconds
     FROM generations WHERE account_id=$1 GROUP BY key_id`,
    [accountId],
  );
  const creditRes = await pool.query(
    `SELECT key_id,
       COALESCE(SUM(amount) FILTER (WHERE type IN ('charge','overage_charge')), 0)::int AS used,
       (COALESCE(SUM(amount) FILTER (WHERE type='reservation'), 0)
        - COALESCE(SUM(amount) FILTER (WHERE type IN ('release','charge','overage_charge')), 0))::int AS pending
     FROM usage_ledger WHERE account_id=$1 AND period_start=$2 AND type <> 'grant'
     GROUP BY key_id`,
    [accountId, period],
  );

  type KeyRow = {
    id: string; prefix: string; mode: string; scopes: unknown; name: string | null;
    created_at: string; last_used_at: string | null; revoked_at: string | null;
  };
  type GenRow = {
    key_id: string | null; total: number; succeeded: number; failed: number; canceled: number;
    running: number; queued: number; avg_seconds: number; max_seconds: number; total_seconds: number;
  };
  const genByKey = new Map<string | null, GenRow>();
  for (const r of genRes.rows as GenRow[]) genByKey.set(r.key_id, r);
  const creditByKey = new Map<string | null, { used: number; pending: number }>();
  for (const r of creditRes.rows as { key_id: string | null; used: number; pending: number }[]) {
    creditByKey.set(r.key_id, { used: r.used, pending: r.pending });
  }

  return (keysRes.rows as KeyRow[]).map((k) => {
    const g = genByKey.get(k.id);
    const c = creditByKey.get(k.id) ?? { used: 0, pending: 0 };
    return {
      key_id: k.id,
      prefix: k.prefix,
      mode: k.mode,
      scopes: Array.isArray(k.scopes) ? (k.scopes as string[]) : [],
      name: k.name,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
      revoked_at: k.revoked_at,
      songs: {
        total: g?.total ?? 0,
        succeeded: g?.succeeded ?? 0,
        failed: g?.failed ?? 0,
        canceled: g?.canceled ?? 0,
        running: g?.running ?? 0,
        queued: g?.queued ?? 0,
      },
      credits_used: c.used,
      credits_pending: c.pending,
      generation_time: {
        avg_seconds: round2(g?.avg_seconds ?? 0),
        max_seconds: round2(g?.max_seconds ?? 0),
        total_seconds: round2(g?.total_seconds ?? 0),
      },
    };
  });
}

/** One consolidated, read-only operational picture of the account. */
export async function monitoringReport(
  pool: Pool = getPool(),
  opts: { accountId: string; planId: string },
): Promise<MonitoringReport> {
  const period = currentPeriodStart();
  const [credits, perKey, byStatus, recent, perDay, songsPerDay, audit, endpoints, deliveryHealth] =
    await Promise.all([
      usageSummary(pool, opts),
      keyStats(pool, opts.accountId, period),
      pool.query(
        `SELECT status, COUNT(*)::int AS n FROM generations WHERE account_id=$1 GROUP BY status`,
        [opts.accountId],
      ),
      pool.query(
        `SELECT id, status, key_id, license, duration_sec, progress, reserved_credits, charged_credits,
                created_at, completed_at,
                EXTRACT(EPOCH FROM (completed_at - created_at))::float AS generation_seconds
         FROM generations WHERE account_id=$1 ORDER BY created_at DESC, id DESC LIMIT 20`,
        [opts.accountId],
      ),
      pool.query(
        `SELECT created_at::date AS day,
           COALESCE(SUM(amount) FILTER (WHERE type IN ('charge','overage_charge')), 0)::int AS used,
           (COALESCE(SUM(amount) FILTER (WHERE type='reservation'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE type IN ('release','charge','overage_charge')), 0))::int AS pending
         FROM usage_ledger
         WHERE account_id=$1 AND created_at > now() - interval '30 days' AND type <> 'grant'
         GROUP BY 1`,
        [opts.accountId],
      ),
      pool.query(
        `SELECT created_at::date AS day, COUNT(*)::int AS songs
         FROM generations WHERE account_id=$1 AND created_at > now() - interval '30 days' GROUP BY 1`,
        [opts.accountId],
      ),
      listAudit(pool, opts.accountId, 50),
      pool.query(
        `SELECT id, url, enabled, created_at FROM webhook_endpoints WHERE account_id=$1 ORDER BY created_at`,
        [opts.accountId],
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS n FROM webhook_deliveries
         WHERE account_id=$1 AND created_at > now() - interval '24 hours' GROUP BY status`,
        [opts.accountId],
      ),
    ]);

  const jobsByStatus: Record<string, number> = {};
  let activeJobs = 0;
  for (const r of byStatus.rows as { status: string; n: number }[]) {
    jobsByStatus[r.status] = r.n;
    if (r.status === "queued" || r.status === "running") activeJobs += r.n;
  }

  const dayKey = (d: unknown): string =>
    typeof d === "string" ? d.slice(0, 10) : new Date(d as string).toISOString().slice(0, 10);
  const days = new Map<string, DailyUsage>();
  for (const r of perDay.rows as { day: unknown; used: number; pending: number }[]) {
    days.set(dayKey(r.day), { day: dayKey(r.day), used_credits: r.used, pending_credits: r.pending, songs: 0 });
  }
  for (const r of songsPerDay.rows as { day: unknown; songs: number }[]) {
    const key = dayKey(r.day);
    const existing = days.get(key);
    if (existing) existing.songs = r.songs;
    else days.set(key, { day: key, used_credits: 0, pending_credits: 0, songs: r.songs });
  }
  const daily = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));

  const delivery = { delivered: 0, failed: 0, dead: 0, pending: 0 };
  for (const r of deliveryHealth.rows as { status: string; n: number }[]) {
    if (r.status in delivery) delivery[r.status as keyof typeof delivery] = r.n;
  }

  return {
    account: { id: opts.accountId, plan_id: opts.planId, period_start: period },
    credits,
    jobs_by_status: jobsByStatus,
    active_jobs: activeJobs,
    per_key: perKey,
    recent_generations: (recent.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      status: r.status as string,
      key_id: (r.key_id as string | null) ?? null,
      license: r.license as string,
      duration_sec: Number(r.duration_sec),
      progress: Number(r.progress),
      credits_reserved: Number(r.reserved_credits),
      credits_charged: r.charged_credits === null ? null : Number(r.charged_credits),
      created_at: r.created_at as string,
      completed_at: (r.completed_at as string | null) ?? null,
      generation_seconds: r.generation_seconds === null ? null : round2(Number(r.generation_seconds)),
    })),
    daily_usage_last_30_days: daily,
    audit,
    webhooks: {
      endpoints: (endpoints.rows as WebhookEndpointSummary[]).map((e) => ({
        id: e.id,
        url: e.url,
        enabled: e.enabled,
        created_at: e.created_at,
      })),
      deliveries_last_24h: delivery,
    },
  };
}
