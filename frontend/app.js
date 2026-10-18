/**
 * Minimal console for the Soundverse API. Same-origin fetch through the Vite
 * dev proxy, so the session cookie flows untouched and no CORS is involved.
 * Bearer secrets live in page-scoped variables ONLY — never localStorage,
 * never cookies, never the URL.
 */

const $ = (id) => document.getElementById(id);
let apiKey = null; // pasted Bearer secret, page memory only
let currentJobId = null;
let pollTimer = null;

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
const EVENT_TYPES = [
  "generation.created",
  "generation.progress",
  "generation.succeeded",
  "generation.failed",
  "generation.canceled",
];

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
      .map(
        (j) => `<tr data-id="${esc(j.id)}" style="cursor:pointer"><td><code>${esc(j.id)}</code></td><td>${esc(j.status)}</td><td>${esc(j.license)}</td><td>${esc(j.credits_reserved)}</td><td>${esc(j.credits_charged ?? "—")}</td></tr>`,
      )
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
  refreshJob();
});

function renderJob(j, replayed = false) {
  const o = j.output;
  $("job-out").textContent =
    `id: ${j.id}\nstatus: ${j.status}${replayed ? " (idempotent replay)" : ""}\n` +
    `license: ${j.license} · reserved: ${j.credits_reserved} · charged: ${j.credits_charged ?? "—"}\n` +
    `provider: ${j.provider ?? "—"} · model: ${j.model ?? "—"}\n` +
    (o && o.audio_url ? `audio: ${o.audio_url}\n(expires — download promptly)` : "output: pending");
  const audio = $("job-audio");
  if (o && o.audio_url) {
    audio.src = o.audio_url;
    audio.classList.remove("hidden");
  } else {
    audio.removeAttribute("src");
    audio.classList.add("hidden");
  }
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

$("btn-job-refresh").addEventListener("click", () => refreshJob());
$("btn-job-cancel").addEventListener("click", async () => {
  if (!currentJobId) return toast("No job selected.");
  try {
    apiKeyFor();
    const { data } = await dev(`/v1/generations/${currentJobId}/cancel`, { method: "POST" });
    renderJob(data);
    toast(data.status === "canceled" ? "Canceled (held credits released)." : "Cancel requested (worker will honor it).", true);
    await reloadJobs();
    void refreshUsageQuiet();
  } catch (err) {
    toast(String(err.message || err));
  }
});

$("btn-job-poll").addEventListener("click", () => {
  clearInterval(pollTimer);
  toast("Polling every 2s until terminal state…", true);
  pollTimer = setInterval(async () => {
    const status = await refreshJob(true);
    if (status === null || !["queued", "running"].includes(status)) {
      clearInterval(pollTimer);
      await reloadJobs();
    }
  }, 2000);
});

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
  await loadKeyStats();
  return s;
}

/** Per-key credit attribution via the session-scoped /keys/stats endpoint. */
async function loadKeyStats() {
  const res = await sess("/keys/stats");
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

/* ---------- webhooks ---------- */
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
      `<p class="muted">Deliveries carry sv-signature / sv-timestamp / sv-event-id headers.</p>`;
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
        (w) => `<tr><td><code>${esc(w.url)}</code></td><td>${w.enabled}</td><td>${esc(w.created_at)}</td><td><button data-id="${esc(w.id)}">delete</button></td></tr>`,
      )
      .join("");
  } catch (err) {
    toast(String(err.message || err));
  }
}

$("btn-wh-reload").addEventListener("click", reloadEndpoints);
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
$("btn-audit-reload").addEventListener("click", async () => {
  try {
    const res = await fetch("/audit-log", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(data, res);
    $("audit-rows").innerHTML = data.entries
      .map((a) => `<tr><td>${esc(a.created_at)}</td><td>${esc(a.action)}</td><td>${esc(a.key_id ?? "—")}</td></tr>`)
      .join("");
  } catch (err) {
    toast(String(err.message || err));
  }
});
