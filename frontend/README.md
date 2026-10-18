# Soundverse Console (frontend/)

Minimal browser UI for the whole quickstart flow. Vanilla JS, no framework,
no build step for development beyond the Vite dev server.

## Run it

```bash
cd frontend
npm install
npm run dev     # opens http://localhost:5173
```

The API must be running (`docker compose up` or `npm run dev` in the repo
root). The Vite dev server proxies `/auth`, `/keys`, `/audit-log` and `/v1`
to `http://localhost:3000` (override with `SOUNDVERSE_API=http://host:port`),
so the browser stays same-origin: the session cookie flows untouched and no
CORS is involved. **The backend needs zero changes.**

## Click-through checklist (verify after any change)

1. Account: sign up → copy the verification token from the API server log →
   verify → log in → "Who am I?" shows email + plan.
2. Keys: create a test key → secret shown once with copy button → list shows
   metadata only → rotate (new secret shown once, old still works) →
   revoke (old key 401s on next use).
3. Generate: paste a key (page memory only — never stored) → create with an
   auto-generated Idempotency-Key → re-submit unchanged (free replay banner) →
   poll to `succeeded` → audio plays in the embedded player → cancel a queued
   job (reservation released).
4. Usage: remaining/used/pending match `GET /v1/usage`; pricing table matches
   `LICENSE_BASE_COST`.
5. Webhooks: register an endpoint (secret shown once) → trigger a generation
   → receiver gets a signed event; delete the endpoint.
6. Audit: table matches `GET /audit-log`.

## Security notes (mirror the API contract)

- Bearer secrets live in JS variables for the page lifetime only. Nothing is
  written to `localStorage`, `sessionStorage`, cookies, or the URL.
- The per-key *credit* split has no JSON endpoint (it lives in the
  server-rendered `/dashboard`), so the Usage tab links out to it instead of
  inventing numbers.
- Signup/login go through the same session-cookie flow as the API; the UI
  never sees password hashes, key hashes, or webhook signing secrets except
  at the one-time reveal the API itself performs.
