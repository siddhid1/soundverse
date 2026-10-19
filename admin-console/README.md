# Soundverse Operator Console (admin-console/)

Platform-monitoring UI on a **separate origin** (`http://localhost:5174`) so
operator and user (`:5173`) browsing contexts never collide: separate cookies,
separate page-memory keys, separate deployments.

## Run it

```bash
cd admin-console
npm install
npm run dev     # opens http://localhost:5174
```

The API must be running (`docker compose up` or `npm run dev` in the repo
root). The Vite dev server proxies `/auth`, `/keys`, `/audit-log` and `/v1`
to `http://localhost:3000` (override with `SOUNDVERSE_API=http://host:port`).
**The backend is unchanged** — no new endpoints, no new auth.

## How aggregation works (read this before operating it)

There is **no cross-account endpoint** in the API (tenant isolation is
enforced per query, by design). This console calls the existing
account-scoped `GET /v1/monitoring` once per pasted Bearer key and totals the
reports **client-side, in page memory only**:

- Paste one key per account you operate → its monitoring report is fetched.
- Platform cards show summed credits (`allowance + bonus − used − pending`),
  jobs by status, songs, active jobs, merged 30-day daily usage, and summed
  24h webhook delivery health, plus a per-account table.
- A key that 401s/fails is marked `error` and excluded from totals — one bad
  key never breaks the view. Reloading the page forgets every key.

## Security notes (mirror the API contract)

- Bearer secrets live in JS variables for the page lifetime only. Nothing is
  written to `localStorage`, `sessionStorage`, cookies, or the URL.
- Only aggregate counts/sums are displayed — the page never renders prompts,
  emails, hashes, or secrets (the underlying API never returns them either).
- Anyone holding an account's key sees that account's monitoring — same
  visibility as the user console's Monitoring tab. This console adds no
  privilege; it only totals what its keys can already read.

## Limits (honest)

- You need **one key per account** — there is no server-side "all accounts"
  query. True server-side platform analytics would require a backend change
  (new endpoint + auth model), which was deliberately not done here.
- Per-account `recent_generations` are capped at 20 by the underlying
  endpoint; license-level splits across full history are not shown.
- Auto-refresh (30s, on by default) re-fetches all watched accounts; turn it
  off for large key sets.
