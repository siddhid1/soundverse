/**
 * Minimal console for the Soundverse API. Same-origin fetch through the Vite
 * dev proxy, so the session cookie flows untouched and no CORS is involved.
 * Bearer secrets live in page-scoped variables ONLY — never localStorage,
 * never cookies, never the URL.
 */

const $ = (id) => document.getElementById(id);
let apiKey = null; // pasted Bearer secret, page memory only
let currentJobId = null;
let currentJob = null; // last rendered job payload
let pollTimer = null;
let elapsedTimer = null;
let autoPoll = true;

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

/** Sessions ride the cookie jar (credentials: same-origin). */
async function sess(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data, res);
  return data;
}

/** Bearer-keyed developer API. */
async function dev(path, { method = "GET", body, idempotencyKey } = {}) {
  if (!apiKey) throw new Error("Paste an API key first (Generate tab).");
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data, res);
  return { data, replayed: res.headers.get("Idempotent-Replayed") === "true" };
}

function fail(data, res) {
  const e = data && data.error;
  throw new Error(
    e ? `${e.code} — ${e.message} (req ${e.request_id})` : `HTTP ${res.status}`,
  );
}

const apiKeyFor = () => {
  const v = $("gen-key").value.trim();
  if (v) apiKey = v; // adopt pasted key into page memory on any use
  if (!apiKey) throw new Error("Paste an API key first (Generate tab).");
  return apiKey;
};

/* ---------- shared formatting (used across tabs) ---------- */

/** Mirrors LICENSE_BASE_COST in the API (src/services/credits.ts). */
const LICENSE_COST = { royalty_free: 1, sync: 6, full_ownership: 14 };
const JOB_ACTIVE = ["queued", "running"];

/** credits = license_cost x ceil(duration_sec / 60) — same formula as the API. */
const costFor = (license, durationSec) =>
  (LICENSE_COST[license] ?? 0) * Math.ceil((Number(durationSec) || 0) / 60);

function fmtSecs(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const s = Math.max(0, Math.round(Number(n)));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const fmtClock = (d) =>
  d ? new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

function fmtWhen(d) {
  if (!d) return "—";
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? "—" : `${date.toLocaleDateString()} ${fmtClock(date)}`;
}

/** Seconds between two timestamps (null when either is missing). */
const secsBetween = (from, to) =>
  from && to ? Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000)) : null;

const signed = (n) => `${Number(n) > 0 ? "+" : ""}${n}`;

function progressBarHtml(pct, cls = "") {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="progress ${cls}"><div class="progress-fill" style="width:${p}%"></div></div>`;
}

const STATUS_BADGE = { succeeded: "ok", running: "info", queued: "info", failed: "bad", canceled: "warn" };
const statusBadge = (s) => `<span class="badge ${STATUS_BADGE[s] ?? ""}">${esc(s)}</span>`;

/** Audit actions are grouped by family so the money trail stands out. */
function actionBadge(action) {
  const fam = String(action).startsWith("credit.")
    ? "credit"
    : String(action).startsWith("key.")
      ? "key"
      : "user";
  return `<span class="badge ${fam}">${esc(action)}</span>`;
}

/** Credit audit rows read as a ledger: +grant, -charge, hold=reserved, +release. */
function creditAmountHtml(action, metadata) {
  const amount = Number(metadata?.amount);
  if (!Number.isFinite(amount)) return "";
  const cls = amount > 0 ? "good" : "bad";
  const label =
    action === "credit.reserved" ? " held" : action === "credit.released" ? " returned" : "";
  return `<span class="stat-value ${cls}" style="font-size:0.95rem">${signed(amount)}${esc(label)}</span>`;
}

/* ---------- tabs ---------- */
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll("main .tab").forEach((s) => s.classList.add("hidden"));
    $(`tab-${b.dataset.tab}`).classList.remove("hidden");
    // Lazy-load the data-heavy tabs so the console stays instant.
    if (!apiKey) return;
    if (b.dataset.tab === "monitoring") void loadMonitoring().catch(() => {});
    if (b.dataset.tab === "usage") void loadUsage().catch(() => {});
    if (b.dataset.tab === "webhooks") {
      void reloadEndpoints().catch(() => {});
      void loadWebhookHealth().catch(() => {});
    }
    if (b.dataset.tab === "keys") void reloadKeys().catch(() => {});
    if (b.dataset.tab === "generate") void reloadJobs().catch(() => {});
  }),
);

/* ---------- account ---------- */
$("form-signup").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await sess("/auth/signup", {
      method: "POST",
      body: { email: $("su-email").value.trim(), password: $("su-password").value },
    });
    toast("Signed up. Verification link was printed to the API server log — paste the token below.", true);
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("form-verify").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await sess(`/auth/verify?token=${encodeURIComponent($("verify-token").value.trim())}`);
    $("verify-out").textContent = `verified: ${r.verified} (user ${r.user_id})`;
    toast("Email verified. Log in next.", true);
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await sess("/auth/login", {
      method: "POST",
      body: { email: $("li-email").value.trim(), password: $("li-password").value },
    });
    $("me-out").textContent = `logged in as ${r.user.email}`;
    toast("Logged in (session cookie set).", true);
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("btn-logout").addEventListener("click", async () => {
  try {
    await sess("/auth/logout", { method: "POST" });
    $("me-out").textContent = "logged out";
    toast("Logged out.", true);
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("btn-me").addEventListener("click", async () => {
  try {
    const r = await sess("/auth/me");
    $("me-out").textContent = `${r.user.email} · plan ${r.account.plan_id}`;
  } catch (err) {
    toast(String(err.message || err));
  }
});

/* ---------- keys ---------- */
async function reloadKeys() {
  try {
    const { keys } = await sess("/keys");
    const active = keys.filter((k) => !k.revoked_at);
    $("keys-summary").textContent = `${keys.length} key(s), ${active.length} active. Billing and usage apply account-wide, across all keys.`;
    $("keys-rows").innerHTML = keys
      .map(
        (k) => `<tr><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.mode)}</td><td>${esc(k.scopes.join(","))}</td><td>${esc(k.revoked_at ?? "active")}</td><td>${esc(k.last_used_at ?? "never")}</td><td><button data-act="revoke" data-id="${esc(k.id)}">revoke</button> <button data-act="rotate" data-id="${esc(k.id)}">rotate</button></td></tr>`,
      )
      .join("");
  } catch (err) {
    toast(String(err.message || err));
  }
}

$("form-key").addEventListener("submit", async (e) => {
  e.preventDefault();
  const scopes = [...document.querySelectorAll(".key-scope:checked")].map((c) => c.value);
  try {
    const res = await fetch("/keys", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("key-name").value || undefined, scopes, mode: $("key-mode").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(data, res);
    $("key-secret-out").innerHTML =
      `<p><b>Secret (shown ONCE — copy it now, it is never retrievable again):</b></p>` +
      `<p class="secret"><code>${esc(data.secret)}</code></p>` +
      `<button id="btn-copy-secret">copy</button> ` +
      `<button id="btn-use-key">use this key for generation</button>`;
    $("btn-copy-secret").addEventListener("click", () => navigator.clipboard.writeText(data.secret).then(
      () => toast("Copied.", true),
      () => toast("Clipboard blocked — select and copy manually."),
    ));
    $("btn-use-key").addEventListener("click", () => {
      apiKey = data.secret;
      $("gen-key").value = "";
      toast("Key loaded into page memory for the Generate tab.", true);
    });
    await reloadKeys();
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("keys-rows").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  try {
    if (act === "revoke") {
      await sess(`/keys/${id}/revoke`, { method: "POST" });
      toast("Revoked — fails on its very next request.", true);
    } else {
      const res = await fetch(`/keys/${id}/rotate`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) fail(data, res);
      $("key-secret-out").innerHTML =
        `<p><b>Replacement secret (shown ONCE — old key still works until revoked):</b></p>` +
        `<p class="secret"><code>${esc(data.secret)}</code></p>`;
      toast("Rotated without downtime.", true);
    }
    await reloadKeys();
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("btn-keys-reload").addEventListener("click", reloadKeys);

/* ---------- generations ---------- */
$("gen-idem").value = crypto.randomUUID();
$("btn-gen-idem").addEventListener("click", () => {
  $("gen-idem").value = crypto.randomUUID();
});

$("form-gen").addEventListener("submit", async (e) => {
  e.preventDefault();
  apiKeyFor();
  const body = {
    prompt: $("gen-prompt").value,
    duration_sec: Number($("gen-duration").value),
    license: $("gen-license").value,
    instrumental: $("gen-instrumental").checked,
  };
  try {
    const { data, replayed } = await dev("/v1/generations", {
      method: "POST",
      body,
      idempotencyKey: $("gen-idem").value.trim(),
    });
    currentJobId = data.id;
    renderJob(data, replayed);
    toast(replayed ? "Idempotent replay — no second job, no second charge." : `Queued (held ${data.credits_reserved} credits).`, true);
    await reloadJobs();
    void refreshUsageQuiet(); // balance drops as the hold is taken
  } catch (err) {
    toast(String(err.message || err));
  }
});

async function reloadJobs() {
  try {
    apiKeyFor();
    const q = new URLSearchParams({ limit: "20", offset: "0" });
    const status = $("jobs-filter").value;
    if (status) q.set("status", status);
    const { data } = await dev(`/v1/generations?${q}`);
    // List endpoint wraps rows: { data: [...], pagination }. Fail loudly in
    // the toast (not a white screen) if the shape ever changes again.
    const jobs = data && Array.isArray(data.data) ? data.data : null;
    if (!jobs) throw new Error("Unexpected jobs response shape (expected { data: [...] }).");
    $("jobs-rows").innerHTML = jobs
      .map((j) => {
        const pct = j.status === "succeeded" ? 100 : Number(j.progress) || 0;
        return (
          `<tr data-id="${esc(j.id)}" style="cursor:pointer">` +
          `<td><code>${esc(j.id)}</code></td>` +
          `<td>${statusBadge(j.status)}</td>` +
          `<td>${progressBarHtml(pct, j.status)}${pct}%</td>` +
          `<td>${esc(j.license)}</td>` +
          `<td>${esc(j.credits_reserved)}</td>` +
          `<td>${esc(j.credits_charged ?? "—")}</td></tr>`
        );
      })
      .join("");
  } catch (err) {
    toast(String(err.message || err));
  }
}

$("btn-jobs-reload").addEventListener("click", reloadJobs);
$("jobs-filter").addEventListener("change", reloadJobs);
$("jobs-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  currentJobId = tr.dataset.id;
  currentJob = null;
  renderProgressCard();
  refreshJob();
});

/* ---------- job progress (dev renders take 40-60s) ---------- */

function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function phaseLabel(j) {
  const pct = Number(j.progress) || 0;
  switch (j.status) {
    case "queued":
      return j.cancel_requested ? "cancel requested" : "queued — waiting for a worker";
    case "running":
      return pct >= 75 ? "finishing up" : "rendering audio";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return j.status;
  }
}

function renderProgressCard() {
  const card = $("job-progress-card");
  if (!currentJob) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const j = currentJob;
  const pct = j.status === "succeeded" ? 100 : Number(j.progress) || 0;
  $("job-progress-pct").textContent = `${pct}%`;
  $("job-progress-phase").textContent = phaseLabel(j);
  $("job-progress-bar").innerHTML = progressBarHtml(
    pct,
    j.status === "succeeded" ? "done" : j.status === "failed" ? "failed" : j.status === "canceled" ? "canceled" : "big",
  );
  tickElapsed();
}

/** Elapsed runs live while queued/running, and freezes at the final duration. */
function tickElapsed() {
  if (!currentJob) return;
  const j = currentJob;
  const live = JOB_ACTIVE.includes(j.status);
  const secs = live
    ? secsBetween(j.created_at, new Date())
    : secsBetween(j.created_at, j.completed_at ?? j.updated_at);
  $("job-elapsed").textContent = live ? `elapsed ${fmtSecs(secs)}` : `took ${fmtSecs(secs)}`;
}

/** Auto-poll while the selected job is in flight; stops itself at terminal. */
function ensureAutoPoll() {
  stopPoll();
  if (!autoPoll || !currentJob || !JOB_ACTIVE.includes(currentJob.status)) return;
  pollTimer = setInterval(async () => {
    const status = await refreshJob(true);
    if (status === null || !JOB_ACTIVE.includes(status)) {
      stopPoll();
      await reloadJobs();
    }
  }, 3000);
  elapsedTimer = setInterval(tickElapsed, 1000);
}

function renderJob(j, replayed = false) {
  currentJob = j;
  const o = j.output;
  const took = secsBetween(j.created_at, j.completed_at);
  $("job-out").textContent =
    `id: ${j.id}\nstatus: ${j.status}${replayed ? " (idempotent replay)" : ""}\n` +
    `progress: ${j.status === "succeeded" ? 100 : Number(j.progress) || 0}%\n` +
    `license: ${j.license} · held: ${j.credits_reserved} · charged: ${j.credits_charged ?? "—"}\n` +
    `created: ${fmtWhen(j.created_at)}${j.completed_at ? ` · completed: ${fmtWhen(j.completed_at)}` : ""}` +
    `${took !== null ? ` · took ${fmtSecs(took)}` : ""}\n` +
    `provider: ${j.provider ?? "—"} · model: ${j.model ?? "—"}` +
    (j.cancel_requested ? " · cancel requested" : "") +
    (o && o.audio_url ? `\naudio: ${o.audio_url}\n(expires — download promptly)` : "\noutput: pending");
  const audio = $("job-audio");
  if (o && o.audio_url) {
    audio.src = o.audio_url;
    audio.classList.remove("hidden");
  } else {
    audio.removeAttribute("src");
    audio.classList.add("hidden");
  }
  renderProgressCard();
  ensureAutoPoll();
}

async function refreshJob(silent = false) {
  if (!currentJobId) {
    if (!silent) toast("No job selected. Create one, or click a row.");
    return null;
  }
  try {
    apiKeyFor();
    const { data } = await dev(`/v1/generations/${currentJobId}`);
    renderJob(data);
    return data.status;
  } catch (err) {
    if (!silent) toast(String(err.message || err));
    return null;
  }
}

$("btn-job-refresh").addEventListener("click", async () => {
  const status = await refreshJob();
  if (status && !JOB_ACTIVE.includes(status)) await reloadJobs();
});

$("btn-job-cancel").addEventListener("click", async () => {
  if (!currentJobId) return toast("No job selected.");
  try {
    apiKeyFor();
    const { data } = await dev(`/v1/generations/${currentJobId}/cancel`, { method: "POST" });
    renderJob(data);
    toast(
      data.status === "canceled"
        ? "Canceled (held credits released)."
        : "Cancel requested — the worker honors it at finalize (may take up to a minute).",
      true,
    );
    await reloadJobs();
    void refreshUsageQuiet();
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("btn-job-poll").addEventListener("click", () => {
  autoPoll = !autoPoll;
  $("btn-job-poll").textContent = autoPoll ? "Auto-poll ON" : "Auto-poll OFF";
  toast(autoPoll ? "Auto-poll on (every 3s while the job runs)." : "Auto-poll off.", true);
  if (autoPoll) ensureAutoPoll();
  else stopPoll();
});
$("btn-job-poll").textContent = "Auto-poll ON";

/** 3-minute public share link: anyone holding it streams for 180s, no account. */
$("btn-job-share").addEventListener("click", async () => {
  if (!currentJobId) return toast("No job selected.");
  try {
    apiKeyFor();
    const res = await fetch(`/v1/generations/${encodeURIComponent(currentJobId)}?expires_in=180`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(data, res);
    const url = data?.output?.audio_url;
    if (!url) return toast("Job has no audio yet — wait for succeeded.");
    await navigator.clipboard.writeText(url);
    toast("3-min share link copied — works for anyone, expires in 3 minutes.", true);
  } catch (err) {
    toast(String(err.message || err));
  }
});

/* ---------- cost preview ---------- */
function updateCostPreview() {
  const cost = costFor($("gen-license").value, $("gen-duration").value);
  const mins = Math.ceil((Number($("gen-duration").value) || 0) / 60);
  $("gen-cost").textContent = `This job holds ${cost} credit${cost === 1 ? "" : "s"} (${$("gen-license").value} × ${mins} started minute${mins === 1 ? "" : "s"}), taken from the balance at creation and settled when the render finishes.`;
}
["gen-license", "gen-duration"].forEach((id) => $(id).addEventListener("input", updateCostPreview));
updateCostPreview();

/* ---------- usage ---------- */
let usageAutoTimer = null;

/** Refresh quietly (e.g. after generating) — errors are not worth a toast. */
async function refreshUsageQuiet() {
  if (!$("usage-auto").checked || !apiKey) return;
  try {
    await loadUsage();
  } catch {
    /* keep the last known balance visible */
  }
}

function statTile(label, value, cls = "") {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value ${cls}">${esc(value)}</div></div>`;
}

async function loadUsage() {
  if (!apiKey && !$("gen-key").value.trim()) {
    $("usage-period").textContent = "—";
    $("usage-balance").innerHTML = `<p class="muted">Paste an API key on the Generate tab first — credits are pooled per account, across all keys.</p>`;
    $("usage-formula").textContent = "";
    $("usage-key-stats").innerHTML = `<p class="muted">No key loaded yet.</p>`;
    return null;
  }
  apiKeyFor();
  const { data: s } = await dev("/v1/usage");
  $("usage-period").textContent = s.period_start ?? "—";
  const remaining = Number(s.remaining_credits);
  $("usage-balance").innerHTML = [
    statTile("remaining", remaining, remaining > 0 ? "big good" : remaining === 0 ? "big warn" : "big bad"),
    statTile("plan allowance", s.allowance_credits),
    statTile("bonus granted", s.granted_credits, s.granted_credits > 0 ? "good" : ""),
    statTile("used", s.used_credits, s.used_credits > 0 ? "warn" : ""),
    statTile("pending (held)", s.pending_credits, s.pending_credits > 0 ? "warn" : ""),
    statTile("overage", s.overage_credits, s.overage_credits > 0 ? "bad" : ""),
    statTile("active jobs", s.active_jobs),
  ].join("");
  $("usage-formula").textContent =
    `remaining = allowance (${s.allowance_credits}) + bonus (${s.granted_credits}) − used (${s.used_credits}) − pending (${s.pending_credits}) = ${remaining} · overage policy: ${s.overage_policy}`;
  try {
    await loadKeyStats();
  } catch (err) {
    // Balance above is already rendered — per-key attribution is best-effort.
    $("usage-key-stats").innerHTML = `<p class="muted">Per-key stats unavailable (${esc(String(err.message || err))}). Balance above is still accurate.</p>`;
  }
  return s;
}

/** Per-key credit attribution via the session-scoped /keys/stats endpoint. */
async function loadKeyStats() {
  let res;
  try {
    res = await sess("/keys/stats");
  } catch (err) {
    throw new Error("key stats unavailable — sign in again on the Account tab");
  }
  const perKey = (res.per_key ?? []).filter((k) => k.credits_used > 0 || k.credits_pending > 0 || k.songs.total > 0);
  if (perKey.length === 0) {
    $("usage-key-stats").innerHTML = `<p class="muted">No credit usage yet — generate a song to see per-key attribution.</p>`;
    return;
  }
  $("usage-key-stats").innerHTML =
    `<table><thead><tr><th>key</th><th>mode</th><th>songs</th><th>credits used</th><th>pending</th></tr></thead><tbody>` +
    perKey
      .map(
        (k) =>
          `<tr><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.mode)}</td><td>${esc(k.songs.total)}</td>` +
          `<td>${esc(k.credits_used)}</td><td>${esc(k.credits_pending)}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`;
}

$("btn-usage-reload").addEventListener("click", async () => {
  try {
    await loadUsage();
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("usage-auto").addEventListener("change", () => {
  clearInterval(usageAutoTimer);
  usageAutoTimer = null;
  if ($("usage-auto").checked) {
    usageAutoTimer = setInterval(refreshUsageQuiet, 5000);
    refreshUsageQuiet();
  }
});

/* ---------- monitoring ---------- */
let monTimer = null;

async function loadMonitoring() {
  apiKeyFor();
  let m;
  try {
    ({ data: m } = await dev("/v1/monitoring"));
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes("404") || msg.includes("not_found") || msg.includes("HTTP 404")) {
      throw new Error("GET /v1/monitoring 404 — backend predates the monitoring build. Rebuild the api: docker compose up --build.");
    }
    throw err;
  }

  $("mon-period").textContent = `period ${m.account.period_start} · plan ${m.account.plan_id}`;
  const c = m.credits ?? {};
  $("mon-stats").innerHTML = [
    statTile("remaining", c.remaining_credits, Number(c.remaining_credits) > 0 ? "big good" : "big bad"),
    statTile("bonus granted", c.granted_credits),
    statTile("used", c.used_credits),
    statTile("pending", c.pending_credits),
    statTile("active jobs", m.active_jobs),
    statTile("jobs (all time)", Object.values(m.jobs_by_status ?? {}).reduce((a, b) => a + b, 0)),
  ].join("");

  $("mon-jobs-by-status").innerHTML = Object.entries(m.jobs_by_status ?? {})
    .sort()
    .map(([status, n]) => `<span class="chip">${statusBadge(status)} ${n}</span>`)
    .join("");

  // Per-key: songs, generation time and credits — the attribution view.
  const perKey = m.per_key ?? [];
  $("mon-per-key").innerHTML =
    perKey.length === 0
      ? `<p class="muted">No API keys yet.</p>`
      : `<table><thead><tr><th>key</th><th>mode</th><th>songs</th><th>ok</th><th>failed</th><th>avg time</th><th>max</th><th>credits</th><th>pending</th><th>last used</th></tr></thead><tbody>` +
        perKey
          .map(
            (k) =>
              `<tr><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.mode)}</td>` +
              `<td>${esc(k.songs.total)}</td><td>${esc(k.songs.succeeded)}</td><td>${esc(k.songs.failed)}</td>` +
              `<td>${esc(fmtSecs(k.generation_time.avg_seconds))}</td><td>${esc(fmtSecs(k.generation_time.max_seconds))}</td>` +
              `<td>${esc(k.credits_used)}</td><td>${esc(k.credits_pending)}</td><td>${esc(fmtWhen(k.last_used_at))}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`;

  const recent = m.recent_generations ?? [];
  $("mon-recent").innerHTML =
    recent.length === 0
      ? `<p class="muted">No generations yet.</p>`
      : `<table><thead><tr><th>id</th><th>status</th><th>progress</th><th>license</th><th>len</th><th>charged</th><th>took</th><th>created</th></tr></thead><tbody>` +
        recent
          .map((g) => {
            const pct = g.status === "succeeded" ? 100 : Number(g.progress) || 0;
            return (
              `<tr><td><code>${esc(g.id)}</code></td><td>${statusBadge(g.status)}</td>` +
              `<td>${progressBarHtml(pct, g.status)} ${pct}%</td><td>${esc(g.license)}</td><td>${esc(g.duration_sec)}s</td>` +
              `<td>${esc(g.credits_charged ?? "—")}</td><td>${esc(fmtSecs(g.generation_seconds))}</td><td>${esc(fmtWhen(g.created_at))}</td></tr>`
            );
          })
          .join("") +
        `</tbody></table>`;

  // 30-day rollup: bar height = songs that day.
  const daily = m.daily_usage_last_30_days ?? [];
  const maxSongs = Math.max(1, ...daily.map((d) => d.songs));
  $("mon-chart").innerHTML = daily.length === 0 ? "" : daily
    .slice()
    .reverse()
    .map(
      (d) =>
        `<div class="mini-col" title="${esc(d.day)}: ${d.songs} songs, ${d.used_credits} credits">` +
        `<div class="mini-bar" style="height:${Math.round((d.songs / maxSongs) * 100)}%"></div></div>`,
    )
    .join("");
  $("mon-daily").innerHTML =
    daily.length === 0
      ? `<p class="muted">No usage in the last 30 days.</p>`
      : `<p class="muted">${daily.length} active day(s) · tallest bar = ${maxSongs} songs · hover for detail.</p>`;

  const wh = m.webhooks ?? { endpoints: [], deliveries_last_24h: {} };
  const d = wh.deliveries_last_24h ?? {};
  $("mon-webhooks").innerHTML =
    `<div class="stats">` +
    statTile("endpoints", (wh.endpoints ?? []).length) +
    statTile("delivered 24h", d.delivered ?? 0, "good") +
    statTile("failed", d.failed ?? 0, d.failed ? "warn" : "") +
    statTile("dead", d.dead ?? 0, d.dead ? "bad" : "") +
    statTile("pending", d.pending ?? 0) +
    `</div>`;

  $("mon-audit").innerHTML = renderAuditTable(m.audit ?? [], 8);
  return m;
}

$("btn-mon-reload").addEventListener("click", async () => {
  try {
    await loadMonitoring();
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("mon-auto").addEventListener("change", () => {
  clearInterval(monTimer);
  monTimer = null;
  if ($("mon-auto").checked) monTimer = setInterval(() => void loadMonitoring().catch(() => {}), 10000);
});

/* ---------- webhooks ---------- */
const WH_URLS = {
  host: "http://127.0.0.1:9499/hook",
  docker: "http://host.docker.internal:9499/hook",
};
$("btn-wh-fill").addEventListener("click", () => {
  $("wh-url").value = WH_URLS[$("wh-target").value] ?? "";
});
$("btn-wh-copy-url").addEventListener("click", () => {
  const url = $("wh-url").value.trim() || WH_URLS[$("wh-target").value];
  navigator.clipboard
    .writeText(url)
    .then(() => toast("URL copied.", true), () => toast("Clipboard blocked — copy manually."));
});

$("form-wh").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    apiKeyFor();
    const { data } = await dev("/v1/webhook_endpoints", {
      method: "POST",
      body: { url: $("wh-url").value.trim() },
    });
    $("wh-secret-out").innerHTML =
      `<p><b>Signing secret (shown ONCE):</b></p><p class="secret"><code>${esc(data.signing_secret)}</code></p>` +
      `<p class="muted">Pass it to the receiver as WEBHOOK_SECRET. Deliveries carry sv-signature / sv-timestamp / sv-event-id.</p>`;
    toast("Endpoint registered.", true);
    await reloadEndpoints();
  } catch (err) {
    toast(String(err.message || err));
  }
});

async function reloadEndpoints() {
  try {
    apiKeyFor();
    const { data } = await dev("/v1/webhook_endpoints");
    $("wh-rows").innerHTML = data.endpoints
      .map(
        (w) => `<tr><td><code>${esc(w.url)}</code></td><td>${w.enabled}</td><td>${esc(fmtWhen(w.created_at))}</td><td><button data-id="${esc(w.id)}">delete</button></td></tr>`,
      )
      .join("");
  } catch (err) {
    toast(String(err.message || err));
  }
}

/** Delivery health piggybacks on /v1/monitoring (Bearer), so it is best-effort. */
async function loadWebhookHealth() {
  try {
    const { data: m } = await dev("/v1/monitoring");
    const d = m.webhooks?.deliveries_last_24h ?? {};
    $("wh-health").innerHTML =
      `<p class="muted">last 24h — delivered <b>${d.delivered ?? 0}</b> · failed <b>${d.failed ?? 0}</b> · dead <b>${d.dead ?? 0}</b> · pending <b>${d.pending ?? 0}</b></p>`;
  } catch {
    $("wh-health").innerHTML = "";
  }
}

$("btn-wh-reload").addEventListener("click", async () => {
  await reloadEndpoints();
  await loadWebhookHealth();
});
$("wh-rows").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  try {
    apiKeyFor();
    await dev(`/v1/webhook_endpoints/${btn.dataset.id}`, { method: "DELETE" });
    toast("Endpoint deleted.", true);
    await reloadEndpoints();
  } catch (err) {
    toast(String(err.message || err));
  }
});

/* ---------- audit ---------- */
let auditEntries = [];
let auditFamily = "";

const familyOf = (action) =>
  String(action).startsWith("credit.")
    ? "credit"
    : String(action).startsWith("key.")
      ? "key"
      : "user";

/** Credit rows read as a ledger; key/user rows show their metadata fields. */
function auditDetailHtml(a) {
  const m = a.metadata ?? {};
  if (familyOf(a.action) === "credit") {
    const parts = [creditAmountHtml(a.action, m)];
    if (m.generation_id) parts.push(`<code>${esc(m.generation_id)}</code>`);
    if (m.reason) parts.push(esc(m.reason));
    if (m.license) parts.push(`${esc(m.license)} ${esc(m.duration_sec ?? "")}s`.trim());
    return parts.filter(Boolean).join(" ");
  }
  if (m.from_prefix || m.to_prefix) return `${esc(m.from_prefix ?? "?")} → ${esc(m.to_prefix ?? "?")}`;
  if (m.prefix) return `<code>${esc(m.prefix)}</code>`;
  if (m.email) return esc(m.email);
  return "";
}

function renderAuditTable(entries, limit = 50) {
  const rows = entries.slice(0, limit);
  if (rows.length === 0) return `<p class="muted">No audit entries yet.</p>`;
  return (
    `<table><thead><tr><th>at</th><th>action</th><th>details</th><th>key</th></tr></thead><tbody>` +
    rows
      .map(
        (a) =>
          `<tr><td>${esc(fmtWhen(a.created_at))}</td><td>${actionBadge(a.action)}</td>` +
          `<td>${auditDetailHtml(a)}</td><td>${a.key_id ? `<code>${esc(String(a.key_id).slice(0, 8))}…</code>` : "—"}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

function applyAuditFilters() {
  const q = $("audit-search").value.trim().toLowerCase();
  const filtered = auditEntries.filter((a) => {
    if (auditFamily && familyOf(a.action) !== auditFamily) return false;
    if (!q) return true;
    const hay = `${a.action} ${a.metadata?.generation_id ?? ""} ${a.key_id ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
  $("audit-rows-wrap").innerHTML = renderAuditTable(filtered);
}

$("btn-audit-reload").addEventListener("click", async () => {
  try {
    const res = await sess("/audit-log");
    auditEntries = res.entries ?? [];
    applyAuditFilters();
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("audit-search").addEventListener("input", applyAuditFilters);

$("audit-filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#audit-filters .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  auditFamily = chip.dataset.family ?? "";
  applyAuditFilters();
});
