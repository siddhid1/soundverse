import type { FastifyInstance } from "fastify";
import { getPool } from "../db/index.js";
import { sessionAuth } from "../middleware/auth.js";
import { listApiKeys } from "../services/apiKeys.js";
import { listAudit } from "../services/audit.js";
import { usageBreakdown } from "../services/usage.js";
import { keyStats } from "../services/monitoring.js";

/** Minimal dashboard (server-rendered). Fancy UI is out of scope; data correctness is not. */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", { preHandler: sessionAuth }, async (req, reply) => {
    const pool = getPool();
    const { user, account } = req.sessionAuth!;
    const [keys, audit, usage, perKey] = await Promise.all([
      listApiKeys(pool, account.id),
      listAudit(pool, account.id, 30),
      usageBreakdown(pool, { accountId: account.id, planId: account.plan_id }),
      keyStats(pool, account.id),
    ]);
    const planRes = await pool.query(`SELECT * FROM plans WHERE id=$1`, [account.plan_id]);
    const plan = planRes.rows[0] as Record<string, unknown>;
    const esc = (s: unknown) => String(s ?? "").replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const rows = keys
      .map(
        (k) =>
          `<tr><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.mode)}</td><td>${esc(k.scopes.join(","))}</td><td>${esc(k.revoked_at ?? "active")}</td><td>${esc(k.last_used_at ?? "never")}</td></tr>`,
      )
      .join("");
    const auditRows = audit
      .map((a) => `<tr><td>${esc(a.created_at)}</td><td>${esc(a.action)}</td><td>${esc(a.key_id ?? "—")}</td></tr>`)
      .join("");
    const s = usage.summary;
    const dayRows = usage.per_day
      .map((d) => `<tr><td>${esc(d.day)}</td><td>${esc(d.used_credits)}</td><td>${esc(d.pending_credits)}</td></tr>`)
      .join("");
    const keyRows = perKey
      .map(
        (k) =>
          `<tr><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.mode)}</td><td>${esc(k.songs.total)}</td><td>${esc(k.songs.succeeded)}</td><td>${esc(k.generation_time.avg_seconds)}s</td><td>${esc(k.credits_used)}</td><td>${esc(k.credits_pending)}</td></tr>`,
      )
      .join("");
    void reply.type("text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Soundverse API — Dashboard</title></head>
<body style="font-family:system-ui;max-width:900px;margin:2rem auto">
<h1>Soundverse API</h1>
<p>Signed in as <b>${esc(user.email)}</b> · account <code>${esc(account.id)}</code></p>
<h2>Plan: ${esc(plan.display_name)} (${esc(account.plan_id)})</h2>
<ul>
<li>Monthly allowance: ${esc(plan.monthly_allowance_credits)} credits</li>
<li>Parallel generations: ${esc(plan.parallel_generations)}</li>
<li>Requests/hour: ${esc(plan.requests_per_hour)} · Requests/day: ${esc(plan.requests_per_day)}</li>
</ul>
<h2>API keys</h2>
<table border="1" cellpadding="6"><tr><th>prefix</th><th>mode</th><th>scopes</th><th>status</th><th>last used</th></tr>${rows}</table>
<p>Manage keys via the JSON API: <code>POST /keys</code>, <code>GET /keys</code>, <code>POST /keys/:id/revoke</code>, <code>POST /keys/:id/rotate</code> (session cookie required).</p>
<h2>Usage — period starting ${esc(s.period_start)}</h2>
<ul>
<li>Allowance: ${esc(s.allowance_credits)} · Bonus granted: ${esc(s.granted_credits)} · Used: ${esc(s.used_credits)} (overage ${esc(s.overage_credits)}) · Pending: ${esc(s.pending_credits)} · <b>Remaining: ${esc(s.remaining_credits)}</b></li>
<li>Overage policy: ${esc(s.overage_policy)} · Active jobs: ${esc(s.active_jobs)}</li>
</ul>
<h3>Per key (current period)</h3>
<table border="1" cellpadding="6"><tr><th>key</th><th>mode</th><th>songs</th><th>succeeded</th><th>avg time</th><th>credits used</th><th>pending</th></tr>${keyRows}</table>
<h3>Per day (last 30 days)</h3>
<table border="1" cellpadding="6"><tr><th>day</th><th>used</th><th>pending</th></tr>${dayRows}</table>
<h2>Recent audit</h2>
<table border="1" cellpadding="6"><tr><th>at</th><th>action</th><th>key</th></tr>${auditRows}</table>
</body></html>`);
  });
}
