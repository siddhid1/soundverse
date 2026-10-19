# SECURITY.md — one-page threat model

## Assets

API secrets (bill to others if leaked), session cookies, password hashes,
webhook signing secrets, generated audio (license rights), the usage ledger
(money), plan configuration, email-verification tokens.

## Trust boundaries

Internet → API (authenticates Bearer keys / session cookies) → PostgreSQL +
S3. Worker and dispatcher are trusted internal processes holding provider keys
and the webhook encryption key. Receivers are untrusted (must verify).

## Threats and controls

- **Key theft / enumeration**: 288-bit secrets, SHA-256-only storage, secret
  shown once, no auth cache (revocation immediate), uniform 401s, login timing
  equalized with a dummy Argon2 verify, single-flight signup race → 409.
- **Tenant escape**: every `/v1` query scopes by `account_id`; cross-tenant
  reads/cancels return 404 (no existence oracle); storage keys embed the
  account and are re-checked before signing URLs.
- **Overspend races**: one account-locked transaction covers idempotency,
  license, allowance, quotas, parallel count, reservation and job insert;
  atomic check-and-increment quotas; ledger is append-only; finalize takes the
  account lock for its charge split. Proven by concurrent-request tests.
- **Replay / forgery (webhooks)**: HMAC-SHA256 over exact raw bytes +
  timestamp, constant-time compare, 300s tolerance, stable event ids for
  receiver-side dedupe; signing secrets encrypted at rest (AES-256-GCM).
- **SSRF via webhook URLs**: https-only in production, no userinfo, fail-closed
  DNS, reject on any non-public resolved address, metadata range blocked in all
  modes, no redirect following, 5s timeout, 1MB cap, re-validation per attempt.
- **Provider confusion**: no failover — a failure never silently swaps models
  (license rights); test keys are pinned to the mock in worker code, not by
  request data; real adapter needs explicit env + key or the worker refuses
  to start.
- **Secrets handling**: env-only config, `.env.example` with placeholders, no
  secrets in logs (verification links are tokens by design), responses, or the
  repo; error shape never leaks internals.
- **Signup bonus abuse**: new accounts start on `starter` with a 10,000-credit
  ledger grant. Live keys require a verified email (login rejects unverified,
  and live key creation re-checks `email_verified_at`), so an unverified
  address cannot mint a spendable key. A verified address can still spend the
  bonus on the real provider when `PROVIDER=elevenlabs` — treat the bonus size
  as a business decision and review before enabling paid models.

## Residual risks and explicit non-goals

- SSRF validation is **resolve-time, not connect-time** (no TLS-SNI-preserving
  IP pinning); a per-query-flapping resolver is not fully contained.
- No login brute-force throttle; dashboard CSRF relies on SameSite cookies.
- No retention pruning (sessions, outbox, deliveries, rate windows beyond 48h
  pruning) — unbounded growth over very long horizons.
- `WEBHOOK_ALLOW_PRIVATE_IPS` is a loaded footgun if ever set in production;
  compose enables it for local dev only.
- The mock provider's audio is a fixture, not music; license labels on mock
  output carry no real-world rights meaning (documented in the adapter notes).
