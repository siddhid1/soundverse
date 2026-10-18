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
    toast(replayed ? "Idempotent replay — no second job, no second charge." : `Queued (reserved ${data.credits_reserved}).`, true);
    await reloadJobs();
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
    $("jobs-rows").innerHTML = data
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
    toast(data.status === "canceled" ? "Canceled (reservation released)." : "Cancel requested (worker will honor it).", true);
    await reloadJobs();
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
$("btn-usage-reload").addEventListener("click", async () => {
  try {
    apiKeyFor();
    const { data: s } = await dev("/v1/usage");
    $("usage-out").textContent =
      `plan: ${s.plan_id} (period ${s.period_start})\n` +
      `allowance ${s.allowance_credits} · used ${s.used_credits} (overage ${s.overage_credits}) · pending ${s.pending_credits}\n` +
      `REMAINING: ${s.remaining_credits}  ·  overage policy: ${s.overage_policy}  ·  active jobs: ${s.active_jobs}\n\n` +
      `Per-key and per-day breakdowns are on the server dashboard (/dashboard, same session) —\n` +
      `this API view reports account totals only.`;
  } catch (err) {
    toast(String(err.message || err));
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
