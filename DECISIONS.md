# DECISIONS.md — judgment calls, trade-offs, and cuts

## D1. One stack, one database: PostgreSQL is the queue

Options: (a) Postgres-backed job table, (b) Redis/BullMQ + Postgres.
Choice: (a). Every money/access invariant is a row lock or constraint
(`SELECT … FOR UPDATE`, `FOR UPDATE SKIP LOCKED`, unique indexes, advisory
locks). A separate broker would split the atomic unit (reserve + enqueue)
across two systems and force distributed-transaction reasoning for exactly the
guarantees this assignment grades. Cost: one worker process polls (500ms;
fine at this scale), and throughput tops out where a single row-lock allows —
acceptable for an 8-hour enterprise-API core.
Change my mind: sustained >100 generations/sec, or multiple worker fleets
needing fair scheduling — then introduce a broker *behind* the same claim
semantics, keeping Postgres as the settlement ledger.

## D2. Reject at the parallel limit (429), don't queue

Options: reject vs silently queue. Choice: reject with
`parallel_limit_reached` + rate-limit headers, no `Retry-After` (unknown wait).
Queueing hides latency and books liability for work the customer didn't agree
to wait for; rejection is explicit, billable-state-free, and matches the
acceptance scenario (20 concurrent on Starter → 3×202 + 17×429).
Change my mind: a product decision that customers prefer backpressure to
errors — then add an explicit queued-behind-capacity state with position
headers, never silent queueing.

## D3. Idempotency-Key is required, account-scoped, replay-free

The brief allowed documenting a deviation; we require the header (400
`idempotency_key_required`) because "a client retry never creates or bills
twice" is only provable if retries carry an identity. Same key + canonical
body (stable-stringified *validated* payload) replays the original job without
touching quotas, ledger, or provider — free by design, including mid-flight
(the second request waits out the first via advisory lock + unique backstop).
Same key + different body → 409, no second job. Scope is per-account
(deliberate: one integration's key namespace shouldn't collide with another's,
but two keys on the same account share it — documented, tested).
Racing inserts serialize on `pg_advisory_xact_lock('idem:'||account||key)`;
the 23505 catch is a backstop that also deletes the loser's orphan job +
reservation. Retention 24h with per-account opportunistic cleanup.

## D4. Ledger: append-only, reservation → exactly one terminal entry

Entry types: `reservation` (pending hold), `charge`, `overage_charge`,
`release`. `used = Σcharge + Σoverage_charge`; `pending = Σreservation −
Σrelease − Σcharge − Σoverage_charge`; `remaining = allowance − used − pending`.
Every reservation is finalized by exactly one terminal entry carrying the
job's *original* period, so cross-month completion can't strand or double
count. The formula is intentionally strict: test scaffolding once inserted a
bare charge without its reservation and pending went negative — we fixed the
scaffolding, not the formula. Test keys write no ledger rows at all
(reserved 0). Growth overage is recorded as `overage_charge`, never as a
silent extra `charge`.

## D5. Rate limits: exact, in-transaction, POST-only

Limits apply to `POST /v1/generations` only — not to polls/reads. (The brief's
poll-every-second scenario would otherwise 429 legitimate polling within
minutes on Starter.) Fixed UTC hour/day windows, enforced by atomic
`UPDATE … SET count=count+1 … WHERE count < limit` inside the account lock:
exactly N concurrent requests consume N units, the (limit+1)-th is rejected —
no over-admission, no over-rejection. Rejected attempts roll back without
consuming budget (a spamming key only slows its own account, which shares one
lock anyway). An earlier pre-increment design over-rejected under concurrency;
a test caught it (see AI_USAGE.md).

## D6. Billing period = UTC calendar month; downgrades apply to new work

Allowance resets by construction (all sums filter `period_start`); nothing
rolls over. Downgrade preserves history and applies immediately to new
requests; in-flight jobs finalize under the *current* plan with any excess
recorded as overage (a job that ran while overage was allowed isn't rewritten
as free). If prior usage already exceeds the new allowance, new live jobs get
429 `allowance_exceeded`; queued jobs are untouched, nothing is retro-cancelled.
Sandbox = test keys only (live keys get 403 `live_not_allowed`). New accounts
start on **starter** (not sandbox) so the signup bonus is actually spendable
with a live key; sandbox remains the test-key playground (see D13).

## D7. Cancel: queued cancels cleanly, running cancels by request

Queued → `canceled` + single `release`, repeat is idempotent. Running jobs
can't be un-run, so cancel only records `cancel_requested_at`; the worker
checks the flag before finalizing and a cancel *wins over delivery* (canceled
+ release, no charge for undelivered output — provider-side cost is ours).
Terminal jobs conflict (409), except already-canceled (200). The row lock
serializes cancel against worker finalization and recovery, so the release
happens exactly once on every path.

## D8. Provider: mock-first, one real adapter, no failover on purpose

Tests and test keys use only the mock (latency/failure knobs, deterministic
WAV fixture). The ElevenLabs adapter exists, is tested against a local stub
(HTTP shape, auth header, 5xx→retryable, hang→timeout), and is selected only
for `PROVIDER=elevenlabs` + live keys — test keys can never reach it (worker
selection, not request data). Total real-model spend: $0. Failover is an
explicit non-goal: silently swapping models can change the rights a customer
bought, which is worse than a visible failure with bounded retries. Ambiguous
outcomes (timeout after the provider may have rendered) are treated as
failures and retried; the duplicate-generation risk is documented, not wished
away.

## D9. Storage: tenant-scoped keys, presigned expiring URLs, private bucket

Object key `audio/<accountId>/<genId>.<ext>` makes cross-tenant access
structurally impossible; reads additionally re-verify the scope embedded in
the key after the tenant-scoped SQL lookup. URLs are presigned (15 min
default); signing is local HMAC, no request-path I/O. Verified end to end
against an S3-compatible server (real bytes downloaded, valid RIFF).

## D10. Webhooks: outbox, at-least-once, signed, SSRF-guarded

The worker commits domain events in the same transaction that finalizes the
job; the dispatcher fans out one delivery per enabled endpoint and retries
with bounded exponential backoff + jitter (10 tries, then dead-letter). A
failed webhook never rolls back billing. Deliveries carry stable event ids,
`sv-timestamp`, and `sv-signature = HMAC(secret, "<ts>.<raw body>")`;
receivers must enforce the 300s tolerance and dedupe ids (signature alone
doesn't stop replays — enforced in our verifier, documented for receivers).
Registration and every delivery attempt re-resolve DNS and reject non-public
addresses; metadata IPs are blocked in all modes; https is required in
production; redirects are never followed. `WEBHOOK_ALLOW_PRIVATE_IPS` exists
for local stub receivers only. Residual: validation is resolve-time, not
connect-time (see SECURITY.md).

## D11. Auth: sessions for humans, hash-only secrets for machines

API secrets are 288-bit random, shown once, stored as SHA-256; listing never
returns secrets or hashes. No auth cache anywhere: revocation is a DB flag
checked on every request, so a revoked key fails on its very next request
(tested). Rotation creates the replacement first; the old key stays valid
until explicitly revoked (hitless, tested end to end). Login burns a full
Argon2 verify even for unknown emails (no enumeration oracle). Signup races
on the same email collapse to one 201 + one 409 via the unique index backstop.

## D12. Tests run against real PostgreSQL, or they don't count

Unit tests cover pure logic (pricing, IP classification, signature math).
Everything touching money/access/rights runs against real PostgreSQL 18
(embedded binary locally, `TEST_DATABASE_URL` in CI): concurrency tests fire
genuinely overlapping requests and assert final DB + ledger state. Sequential
"concurrency" tests were rejected during review. The suite is green at 73
tests; two full runs back-to-back show zero flakes except one transient
teardown race (fixed: pool `error` listeners instead of unhandled throws).

## D13. Signup bonus is a ledger grant, not a mutable balance

Every new account (which now starts on **starter**, so a live key can actually
spend) receives `SIGNUP_BONUS_CREDITS` (default 10,000) as an append-only
`usage_ledger` row of type `grant`, written in the same transaction that
creates the account. Spendable pool = plan allowance + Σ grants; the four
ledger formulas (`used`, `pending`, remaining) were updated in lockstep, and
the grant is excluded from the per-day/per-key *consumption* charts so it never
looks like usage. Why a ledger row and not an `accounts.balance` column: the
same append-only auditability the rest of billing has — every credit's origin
is provable, and a "grant" can never be silently mutated. Grants are
period-scoped like allowances (no rollover), and every grant/reserve/charge/
release is mirrored into `audit_logs` (`credit.*`) with `key_id` + `generation_id`
so per-key spend is attributable. Tests pin `SIGNUP_BONUS_CREDITS=0` for the
billing-mechanics suites and re-enable it in the dedicated bonus suite.

## D14. Lifecycle webhooks: exactly-one-terminal, best-effort progress

`generation.created` is emitted in the acceptance transaction (atomic with the
202 and its reservation), so a committed job can never lack its event.
`generation.progress` events are written in their own short transaction,
guarded on `status='running'`, and are deliberately **exempt** from the
"exactly one terminal event per job" invariant (D5) — a lost progress tick is
cosmetic, never correctness, and a tick that loses the race with cancel/finalize
is a no-op. Receivers dedupe on the stable `sv-event-id`; there is no
per-endpoint event-type filter yet (every enabled endpoint gets every event).
The mock reports 25/50/75% only for realistic (≥1s) renders, so millisecond
test doubles stay quiet.

## Ambiguity log → chosen behavior (acceptance scenarios)

1. Secret re-retrieval → impossible by construction (hash-only storage); tested at DB + API level.
2. Revoked key → 401 `invalid_key` on next request; no cache anywhere.
3. Rotation → new-first, overlap indefinite until revoke; combined e2e test.
4. Starter × 20 concurrent → exactly 3 accepted, 17×`parallel_limit_reached`.
5. 5 credits + 10 concurrent → exactly 5 accepted (parallel raised in-test to isolate the allowance race, then restored).
6. Same key ×3 mid-flight → 1 job/1 reservation; different body → 409, no new job.
7. Provider timeout mid-job → `failed` + release + bounded retry; ambiguous outcomes documented (D8).
8. Cross-tenant job access → 404 (never 403, no existence leak).
9. Test-key quickstart → verified end to end (signup→key→202→poll→real WAV bytes + signed webhook delivery).
10. Webhook down 10 min → retries deliver on recovery with the same event id; day-old captured payload → `stale_timestamp` rejection.
11. `http://169.254.169.254/...` → 400 `webhook_url_blocked`, even in dev mode.
12. Growth→Starter downgrade → history intact, new live jobs 429, queued job untouched, mid-flight finalize recorded as overage.
13. Starter + `full_ownership` → 403 before any job/ledger row exists.
14. Polling at the parallel cap → reads stay 200 (limits apply to POST only).

## D15. Public platform aggregates are additive and aggregate-only

`GET /v1/platform/stats` exposes platform-wide COUNT/SUM/AVG numbers with no
authentication. The safety case is structural, not promised: the SELECT lists
contain no email, prompt, metadata, hash, secret, or per-account/per-key row,
so the handler cannot leak what it never selects — enforced by a test that
fails the build if any forbidden field appears. Cross-account visibility
without per-account auth was a conscious trade: the endpoint answers only
questions that are already answerable in aggregate, and `PLATFORM_STATS_ENABLED`
(default on) 404s the route without a redeploy. A narrow per-IP limiter
(60/min, `Retry-After`) replaces the account-level quota machinery, which
cannot apply without an account. The `:5174` operator console consumes it
with zero credentials; its key-watch view (client-side totals over pasted
keys) predates the endpoint and stays as the per-account drill-down. No
existing route, auth check, or limit was modified for this — purely new
files plus one registration line and one additive env key.
Change my mind: per-account rows, PII, or write actions on this surface —
any of those reopens the admin-auth question (D-teams/roles cut).

## Explicit cuts (not built)

Redis/Kafka (D1), Stripe overage billing, team members/roles, provider
failover (D8), MCP server, SDKs, admin plan UI (plans are SQL-editable data),
login brute-force throttle, session/outbox/retention pruning, dashboard
polish. Each cut is honest in README's status table; none is claimed done.
