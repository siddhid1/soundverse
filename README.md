# Soundverse Enterprise Music API

Self-serve developer API for AI music generation (TypeScript + Fastify + PostgreSQL + MinIO).

> Phase 1 foundation. Full quickstart + usage docs arrive in Phase 7.

## One-command startup

```bash
cp .env.example .env        # fill secrets; never commit real keys
docker compose up --build  # api :3000, worker, webhook-dispatcher, postgres, minio
```

Local dev without Docker:

```bash
npm install
npm run db:migrate          # needs DATABASE_URL reachable
npm run dev                 # api on http://localhost:3000
npm test                    # vitest suite
```

## Probes

- `GET /health` → `{status:"ok"}` (liveness)
- `GET /ready` → DB connectivity (`200` ready / `503` not ready)

## Status (honest, updated per phase)

| Area | State |
|---|---|
| Foundation (config, health, errors, compose, migrate) | ✅ working |
| Accounts (signup, verify via server-log link, login/logout, sessions) | ✅ working |
| API keys (create secret-once, list safe metadata, revoke, rotate, test/live, scopes) | ✅ working |
| Audit log (key created/revoked/rotated) | ✅ working |
| Auth check (`GET /v1/ping`, Bearer, no cache) | ✅ working |
| Generations (create 202, get, list w/ pagination+filter, cancel) | ✅ working |
| Limits (allowance+overage, parallel, hourly/daily, licenses) — enforced in one account-locked tx | ✅ working, concurrency-tested |
| Idempotency-Key (required, replay free, 409 on reuse, race-safe) | ✅ working, concurrency-tested |
| Usage ledger (append-only; usage derived from it) | ✅ working |
| Worker (claim via SKIP LOCKED, leases + heartbeat + recovery, conditional finalize) | ✅ working, tested |
| Provider (mock w/ latency + failure controls; ElevenLabs adapter behind flag) | ✅ working (mock tested live; adapter tested vs local stub, $0 spend) |
| Storage (S3 presigned expiring URLs, tenant-scoped keys, memory store for tests) | ✅ working, tested |
| Webhooks (endpoint CRUD, HMAC-signed delivery, outbox + retries + dead-letter, SSRF guards) | ✅ working, tested |
| Docs (OpenAPI full spec, quickstart, DECISIONS/AI_USAGE/SECURITY) | 🟡 OpenAPI skeleton + this status table (full docs in Phase 7) |
| Dashboard usage view (per-key/per-day) + audit surfacing | 🟡 audit API exists; dashboard rollup in Phase 7 if time |
| Docs / dashboard | 🟡 partial: minimal dashboard HTML + OpenAPI skeleton (full in Phase 7) |

Rate limits apply to `POST /v1/generations` only in this sprint (polling/reads
are unthrottled — see DECISIONS.md when it lands in Phase 7).

Tests: `npm test` boots real PostgreSQL automatically (embedded binary when
`TEST_DATABASE_URL` is unset; uses it when set, e.g. CI with compose).

See `IMPLEMENTATION_BRIEF.md` for the full contract and `openapi/openapi.yaml` for the spec skeleton.
