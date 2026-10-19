/**
 * Operator platform console. No backend changes: for each pasted Bearer key it
 * calls the existing account-scoped GET /v1/monitoring and aggregates the
 * reports client-side. Keys live in page memory only — never localStorage,
 * never cookies, never the URL.
 */

const $ = (id) => document.getElementById(id);
const keys = []; // { secret, label, report?, error? }
let timer = null;

function esc(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function toast(msg, ok = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("ok", ok);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 6000);
}

function statTile(label, value, cls = "") {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value ${cls}">${esc(value)}</div></div>`;
}

async function fetchReport(secret) {
  const res = await fetch("/v1/monitoring", { headers: { Authorization: `Bearer ${secret}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data && data.error;
    throw new Error(e ? `${e.code} — ${e.message}` : `HTTP ${res.status}`);
  }
  return data;
}

function shortSecret(s) {
  if (!s) return "—";
  const prefix = s.startsWith("sv_live_") ? s.slice(0, 15) : s.slice(0, 15);
  return `${prefix}…`;
}

async function reloadOne(entry) {
  try {
    entry.report = await fetchReport(entry.secret);
    entry.error = null;
  } catch (err) {
    entry.report = null;
    entry.error = String((err && err.message) || err);
  }
}

async function reloadAll() {
  await Promise.all(keys.map(reloadOne));
  render();
}

function totals() {
  const t = {
    accounts: 0, ok: 0, failed: 0,
    allowance: 0, granted: 0, used: 0, pending: 0, overage: 0, activeJobs: 0,
    jobs: {}, songs: 0, succeeded: 0, failedJobs: 0, canceled: 0,
    delivered: 0, whFailed: 0, dead: 0, whPending: 0,
    daily: new Map(),
  };
  for (const k of keys) {
    if (!k.report) { t.failed++; continue; }
    t.ok++;
    const m = k.report;
    t.allowance += Number(m.credits?.allowance_credits) || 0;
    t.granted += Number(m.credits?.granted_credits) || 0;
    t.used += Number(m.credits?.used_credits) || 0;
    t.pending += Number(m.credits?.pending_credits) || 0;
    t.overage += Number(m.credits?.overage_credits) || 0;
    t.activeJobs += Number(m.active_jobs) || 0;
    for (const [st, n] of Object.entries(m.jobs_by_status ?? {})) t.jobs[st] = (t.jobs[st] || 0) + Number(n);
    for (const p of m.per_key ?? []) {
      t.songs += Number(p.songs?.total) || 0;
      t.succeeded += Number(p.songs?.succeeded) || 0;
      t.failedJobs += Number(p.songs?.failed) || 0;
      t.canceled += Number(p.songs?.canceled) || 0;
    }
    const d = m.webhooks?.deliveries_last_24h ?? {};
    t.delivered += Number(d.delivered) || 0;
    t.whFailed += Number(d.failed) || 0;
    t.dead += Number(d.dead) || 0;
    t.whPending += Number(d.pending) || 0;
    for (const day of m.daily_usage_last_30_days ?? []) {
      const cur = t.daily.get(day.day) || { day: day.day, used_credits: 0, pending_credits: 0, songs: 0 };
      cur.used_credits += Number(day.used_credits) || 0;
      cur.pending_credits += Number(day.pending_credits) || 0;
      cur.songs += Number(day.songs) || 0;
      t.daily.set(day.day, cur);
    }
  }
  t.accounts = keys.length;
  return t;
}

function render() {
  $("op-keys-note").textContent =
    keys.length === 0
      ? "No accounts added yet. Paste a key to fetch its monitoring report."
      : `${keys.length} account(s) under watch. Keys live in page memory only — reload forgets them.`;
  $("op-rows").innerHTML = keys
    .map(
      (k, i) =>
        `<tr><td><code>${esc(k.report?.account?.id?.slice(0, 8) ?? "—")}…</code></td>` +
        `<td>${esc(k.report?.account?.plan_id ?? "—")}</td>` +
        `<td>${esc(k.report?.account?.period_start ?? "—")}</td>` +
        `<td>${k.report ? `<span class="badge ok">ok</span>` : `<span class="badge bad" title="${esc(k.error)}">error</span>`}</td>` +
        `<td><button data-i="${i}">forget</button></td></tr>`,
    )
    .join("");

  if (keys.length === 0) {
    $("op-fresh").textContent = "—";
    $("op-totals").innerHTML = "";
    $("op-jobs").innerHTML = "";
    $("op-formula").textContent = "";
    $("op-per-account").innerHTML = `<p class="muted">Add an account above.</p>`;
    $("op-chart").innerHTML = "";
    $("op-daily").innerHTML = `<p class="muted">Add an account above.</p>`;
    $("op-webhooks").innerHTML = `<p class="muted">Add an account above.</p>`;
    return;
  }

  const t = totals();
  const remaining = t.allowance + t.granted - t.used - t.pending;
  $("op-fresh").textContent = `across ${t.ok}/${t.accounts} reachable account(s) · ${new Date().toLocaleTimeString()}`;
  $("op-totals").innerHTML = [
    statTile("accounts", t.accounts),
    statTile("remaining", remaining, remaining > 0 ? "big good" : "big bad"),
    statTile("used", t.used, t.used > 0 ? "warn" : ""),
    statTile("pending", t.pending, t.pending > 0 ? "warn" : ""),
    statTile("overage", t.overage, t.overage > 0 ? "bad" : ""),
    statTile("songs", t.songs),
    statTile("active jobs", t.activeJobs),
  ].join("");
  $("op-jobs").innerHTML = Object.entries(t.jobs)
    .sort()
    .map(([st, n]) => `<span class="chip">${esc(st)} ${n}</span>`)
    .join("");
  $("op-formula").textContent =
    `remaining = allowance (${t.allowance}) + bonus (${t.granted}) − used (${t.used}) − pending (${t.pending}) = ${remaining}`;

  $("op-per-account").innerHTML =
    `<table><thead><tr><th>account</th><th>plan</th><th>remaining</th><th>used</th><th>pending</th><th>songs ok</th><th>active</th></tr></thead><tbody>` +
    keys
      .map((k) => {
        if (!k.report) return `<tr><td><code>unreachable</code></td><td colspan="6">${esc(k.error)}</td></tr>`;
        const c = k.report.credits ?? {};
        const okSongs = (k.report.per_key ?? []).reduce((a, p) => a + (Number(p.songs?.succeeded) || 0), 0);
        const rem = (Number(c.allowance_credits) || 0) + (Number(c.granted_credits) || 0) - (Number(c.used_credits) || 0) - (Number(c.pending_credits) || 0);
        return (
          `<tr><td><code>${esc((k.report.account?.id || "").slice(0, 8))}…</code></td>` +
          `<td>${esc(k.report.account?.plan_id)}</td><td>${esc(rem)}</td>` +
          `<td>${esc(c.used_credits ?? "—")}</td><td>${esc(c.pending_credits ?? "—")}</td>` +
          `<td>${esc(okSongs)}</td><td>${esc(k.report.active_jobs ?? 0)}</td></tr>`
        );
      })
      .join("") +
    `</tbody></table>`;

  const daily = [...t.daily.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const maxSongs = Math.max(1, ...daily.map((d) => d.songs));
  $("op-chart").innerHTML = daily
    .slice()
    .reverse()
    .map(
      (d) =>
        `<div class="mini-col" title="${esc(d.day)}: ${d.songs} songs, ${d.used_credits} credits">` +
        `<div class="mini-bar" style="height:${Math.round((d.songs / maxSongs) * 100)}%"></div></div>`,
    )
    .join("");
  $("op-daily").innerHTML =
    daily.length === 0
      ? `<p class="muted">No usage in the last 30 days.</p>`
      : `<p class="muted">${daily.length} active day(s) · tallest bar = ${maxSongs} songs · hover for detail.</p>`;

  $("op-webhooks").innerHTML =
    `<div class="stats">` +
    statTile("delivered 24h", t.delivered, "good") +
    statTile("failed", t.whFailed, t.whFailed ? "warn" : "") +
    statTile("dead", t.dead, t.dead ? "bad" : "") +
    statTile("pending", t.whPending) +
    `</div>`;
}

function ensureAuto() {
  clearInterval(timer);
  timer = null;
  // The endpoint check rides the same timer so the section populates on its
  // own after an API rebuild — no page reload needed.
  if ($("op-auto").checked) {
    timer = setInterval(() => {
      void reloadEndpoint().catch(() => {});
      if (keys.length > 0) void reloadAll().catch(() => {});
    }, 30000);
  }
}

/* ---------- platform endpoint (no keys) ---------- */

async function reloadEndpoint() {
  try {
    const res = await fetch("/v1/platform/stats");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const code = body?.error?.code;
      // A 404 here is ambiguous by design: the API build may predate the
      // route (old image) or the route may be kill-switched off — both
      // answer identically, and this console must not claim to know which.
      $("ep-note").textContent =
        res.status === 404
          ? "Platform endpoint unavailable (404) — either this API build predates it " +
            "(rebuild: sudo docker compose up --build) or PLATFORM_STATS_ENABLED=false. " +
            "Meanwhile, add keys below: the watch builds the same totals locally."
          : `Unavailable (${res.status}${code ? ` ${code}` : ""}) — the watch below is unaffected.`;
      $("ep-totals").innerHTML = "";
      $("ep-jobs").innerHTML = "";
      $("ep-license").innerHTML = "";
      $("ep-fresh").textContent = "—";
      return false;
    }
    const s = await res.json();
    $("ep-note").textContent = "";
    $("ep-fresh").textContent = `period ${s.period_start} · generated ${new Date(s.generated_at).toLocaleTimeString()}`;
    const c = s.credits ?? {};
    $("ep-totals").innerHTML = [
      statTile("accounts", s.accounts?.total ?? 0),
      statTile("remaining", c.remaining ?? 0, Number(c.remaining) > 0 ? "big good" : "big bad"),
      statTile("used", c.used ?? 0),
      statTile("songs (30d)", (s.usage_30d ?? []).reduce((a, d) => a + (Number(d.songs) || 0), 0)),
      statTile("active jobs", s.jobs?.active ?? 0),
      statTile("live keys", s.keys?.active ?? 0),
    ].join("");
    $("ep-jobs").innerHTML = Object.entries(s.jobs?.by_status ?? {})
      .sort()
      .map(([st, n]) => `<span class="chip">${esc(st)} ${n}</span>`)
      .join("");
    const lic = s.credits?.by_license ?? {};
    $("ep-license").innerHTML =
      Object.keys(lic).length === 0
        ? `<p class="muted">No generations yet.</p>`
        : `<table><thead><tr><th>license</th><th>songs</th><th>credits</th></tr></thead><tbody>` +
          Object.entries(lic)
            .sort()
            .map(([l, v]) => `<tr><td>${esc(l)}</td><td>${esc(v.songs)}</td><td>${esc(v.credits)}</td></tr>`)
            .join("") +
          `</tbody></table>`;
  } catch (err) {
    $("ep-note").textContent = `Unavailable (${esc(String((err && err.message) || err))}) — the watch below is unaffected.`;
    return false;
  }
  return true;
}

$("btn-ep-reload").addEventListener("click", reloadEndpoint);
void reloadEndpoint();
ensureAuto();

$("btn-add").addEventListener("click", async () => {
  const secret = $("op-key").value.trim();
  if (!secret) return toast("Paste a Bearer key first.");
  if (keys.some((k) => k.secret === secret)) return toast("That key is already watched.");
  const entry = { secret, label: shortSecret(secret), report: null, error: null };
  keys.push(entry);
  $("op-key").value = "";
  await reloadOne(entry);
  toast(entry.report ? "Account added." : `Key rejected: ${entry.error}`, !!entry.report);
  render();
  ensureAuto();
});

$("btn-reload").addEventListener("click", async () => {
  if (keys.length === 0) return toast("Add an account first.");
  await reloadAll();
  toast("Reloaded.", true);
});

$("btn-clear").addEventListener("click", () => {
  keys.length = 0;
  render();
  ensureAuto();
  toast("All keys forgotten (page memory cleared).", true);
});

$("op-rows").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-i]");
  if (!btn) return;
  keys.splice(Number(btn.dataset.i), 1);
  render();
  ensureAuto();
});

$("op-auto").addEventListener("change", ensureAuto);
