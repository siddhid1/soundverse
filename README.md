# Soundverse Enterprise Music API

Self-serve developer API for AI music generation: sign up, verify email, create
secret API keys, submit async generation jobs, poll or receive webhooks, and get
billed from an append-only ledger. TypeScript + Fastify + PostgreSQL + MinIO.

## One-command startup

```bash
cp .env.example .env        # never commit real secrets or provider keys
docker compose up --build  # api :3000, worker, webhook-dispatcher, postgres, minio
```

Then open the browser console (`cd frontend && npm run dev`) — signup to first
song in minutes with a test key (no spend, no payment).

Local development without Docker:

```bash
npm install
npm run db:migrate          # needs DATABASE_URL reachable
npm run dev                 # api on http://localhost:3000
node dist/worker.js         # build first (npm run build)
node dist/webhooks.js
npm test                    # full suite (real PostgreSQL booted automatically)
npm run test:acceptance     # the 14 acceptance scenarios as a checklist
npm run verify              # build + lint + spec + acceptance + full suite
```

Browser console (no curl needed):

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173
```

The static UI talks to the API through a dev-server proxy (`/auth`, `/keys`,
`/audit-log`, `/v1` → `http://localhost:3000`), so sessions work with zero
backend changes. Bearer keys live in page memory only. See `frontend/README.md`
for the click-through checklist.

Watch webhooks locally (verifies signatures, dedupes by `sv-event-id`, filters
by event type):

```bash
npm run hooks:receiver 9499 -- --events generation.succeeded,generation.progress
```

Set `WEBHOOK_SECRET` to the endpoint's signing secret to enable verification
(without it the receiver logs but does not verify). `--fail` answers 500 on
purpose, to demo retries → dead-letter. Register the endpoint as
`http://host.docker.internal:9499/hook` when the dispatcher runs in docker;
`http://127.0.0.1:9499/hook` is enough when it runs on the host.


## Architecture

```
                ┌─────────────┐
  developer ──▶ │  API (3000) │──▶ PostgreSQL (accounts, keys, jobs,
                └─────────────┘    idempotency, ledger, counters, outbox)
                        │                ▲            │
                        │ jobs           │ claim      │ outbox events
                        ▼                │ (SKIP      ▼
                ┌─────────────┐   LOCKED) │   ┌──────────────────┐
                │   worker    │───────────┘   │ webhook-dispatcher│──▶ receivers
                └──────┬──────┘               └──────────────────┘   (signed)
                       │ S3 PutObject (private bucket)
                       ▼
                ┌─────────────┐
                │ MinIO / S3  │── presigned GET (15 min) ──▶ developer
                └─────────────┘
```

- **API** handles dashboard sessions, Bearer-key auth, and the one atomic
  acceptance transaction: idempotency check → account lock → license →
  allowance/overage → hourly/daily quotas → parallel count → reserve → job +
  ledger + idempotency row → `202`. It never waits for rendering.
- **Worker** claims queued jobs (`FOR UPDATE SKIP LOCKED`), calls the mock or
  real provider (test keys always mock), uploads audio to tenant-scoped storage
  keys, and finalizes with a conditional `status='running'` update plus exactly
  one ledger settlement and one outbox event. Leases + heartbeat + recovery
  survive restarts.
- **Webhook dispatcher** fans outbox events to endpoints and delivers them
  signed (HMAC-SHA256, timestamp, stable event id) with bounded exponential
  retries and a dead-letter state. Job results never depend on delivery.
- **PostgreSQL** is the source of truth for everything, including the queue —
  no Redis/Kafka (see DECISIONS.md). **MinIO** (S3-compatible) stores audio;
  URLs are presigned and expire.

Key invariants live in SQL (unique/foreign-key/check constraints) and in
short, explicit transactions — not in application-level checks. Every
concurrency-sensitive path has a test that fails without its lock.

## Tests

```bash
npm test
```

Integration tests boot a **real PostgreSQL 18** automatically (embedded binary
in a temp dir; set `TEST_DATABASE_URL` to use your own, e.g. CI with compose).
Concurrency tests synchronize real parallel requests (`Promise.all`) and assert
final database + ledger state, not just response codes. 73 tests, all green.

## Status (honest)

| Area | State |
|---|---|
| Foundation (config, health/ready, compose, migrate) | ✅ working |
| Accounts (signup → starter, verify via server-log link, login/logout, sessions) | ✅ working |
| 10,000-credit signup bonus (append-only ledger grant, shown on dashboard) | ✅ working, tested |
| API keys (secret-once, safe list, revoke, rotation, test/live, scopes) | ✅ working |
| Audit log (key lifecycle + credit grant/reserve/charge/release) | ✅ working |
| Generations (create/get/list/cancel), usage, auth-check ping | ✅ working |
| Limits (allowance+grant+overage, parallel, hourly/daily, licenses) in one locked tx | ✅ working, concurrency-tested |
| Idempotency-Key (required, free replays, 409 on reuse, race-safe) | ✅ working, concurrency-tested |
| Append-only usage ledger; dashboard per-key/per-day views | ✅ working |
| Worker (leases, heartbeat, recovery, bounded retries, conditional finalize) | ✅ working, tested |
| Providers (mock w/ 40-60s random latency + failure controls; ElevenLabs env-gated, $0 spent) | ✅ working |
| Live progress (progress column + `generation.progress` events during a render) | ✅ working, tested |
| Storage (tenant-scoped keys, presigned expiring URLs) | ✅ working, e2e-verified |
| Webhooks (created/progress/succeeded/failed/canceled, HMAC, retries, dead-letter, SSRF guards) | ✅ working, tested |
| Monitoring (`GET /v1/monitoring`, `/keys/stats`: per-key songs, time, credits) | ✅ working, tested |
| Docs (OpenAPI 3.1 matching behavior, DECISIONS/AI_USAGE/SECURITY) | ✅ this repo |

### Known limitations (see DECISIONS.md / SECURITY.md for the full lists)

- No provider failover (deliberate: silent model swaps change license rights).
- No team members/roles, no Stripe overage billing, no MCP server, no SDK, no
  admin UI (plans are data — change them with SQL, no deploy needed).
- Rate limits apply to `POST /v1/generations` only; reads are unthrottled.
- Webhook SSRF validation is resolve-time, not connect-time (documented residual).
- No login brute-force throttle; no session/outbox retention pruning yet.

## Further reading

- [openapi/openapi.yaml](openapi/openapi.yaml) — the full contract
- [DECISIONS.md](DECISIONS.md) — what we chose, what we cut, and why
- [SECURITY.md](SECURITY.md) — one-page threat model
- [AI_USAGE.md](AI_USAGE.md) — how AI assistance was used and reviewed
