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
| Generations + limits + metering | ⬜ missing (Phase 3) |
| Worker / provider / storage | ⬜ stub only (Phase 4) |
| Webhooks | ⬜ stub only (Phase 5) |
| Docs / dashboard | 🟡 partial: minimal dashboard HTML + OpenAPI skeleton (full in Phase 7) |

Tests: `npm test` boots real PostgreSQL automatically (embedded binary when
`TEST_DATABASE_URL` is unset; uses it when set, e.g. CI with compose).

See `IMPLEMENTATION_BRIEF.md` for the full contract and `openapi/openapi.yaml` for the spec skeleton.
