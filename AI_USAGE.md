# AI_USAGE.md — how AI assistance was used and reviewed

## Tools and setup

All implementation was done by an AI coding assistant (agentic harness,
TypeScript/Node stack) directed by the candidate in strict sequential phases
(Foundation → Accounts/Keys → Generation core → Worker/Storage → Webhooks →
Acceptance → Docs), one milestone at a time with a local git commit per
logical step. No code was pushed anywhere during the build; review happened
locally before every commit.

## What was delegated to the AI

- Scaffolding and boilerplate: project layout, Fastify wiring, Drizzle schema
  mirroring, Docker Compose services, env validation, route shells.
- First drafts of services, workers, and the full test suite (including the
  concurrency tests).
- Mechanical chores: migration SQL, OpenAPI drafting from the implemented
  routes, doc assembly.

## What was reviewed line by line (and why)

- **Every SQL transaction**: the acceptance tx, claim/finalize/recovery, fan-out
  and dispatcher updates. Concurrency correctness can't be delegated.
- **The SSRF validator** (IP parsing, CIDR ranges, DNS flow) and the webhook
  signing code — reviewed character by character against the threat model.
- **Ledger math** (used/pending/remaining, charge splitting, period handling).
- **Every test failure**: never fixed by weakening the test. Each failure was
  investigated to a root cause in either product code or test scaffolding.

## Cases where the AI was wrong (and how it was caught)

1. **Rate limiter over-rejected under concurrency.** The first design bumped
   fixed-window counters *before* the money transaction, then checked the
   post-bump total inside it. With 6 concurrent requests against a limit of 5,
   all six bumps landed before anyone checked, so only 1 passed instead of 5.
   Caught by the daily-quota concurrency test (expected 5+1, got 1+5);
   fixed with atomic `UPDATE … WHERE count < limit` inside the lock. A
   sequential test suite would never have seen this.
2. **Idempotency race handler poisoned its own transaction.** The 23505 catch
   block ran further queries in the same Postgres transaction, but Postgres
   aborts a tx after a unique violation — every loser got a 500 ("current
   transaction is aborted"). Caught by the 3×-same-key race test; fixed with
   `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`.
3. **Idempotency losers created orphan jobs.** The original order inserted the
   generation *before* the idempotency record, so losing racers left queued
   jobs with real credit reservations behind while replaying the winner
   (3 jobs from 1 key). Caught by asserting final row counts, not just
   response codes; fixed with a per-key advisory lock plus orphan cleanup in
   the 23505 backstop.
4. **Fan-out generated one delivery id in JS for an N-row INSERT…SELECT.**
   With two endpoints the second row violated the deliveries PK. Caught the
   moment a multi-endpoint test ran; fixed with per-row `gen_random_uuid()`.
5. **Sloppy shell hygiene.** Early `pkill -f` patterns matched the tool's own
   command line and killed the wrapping shell; a `git add -A && commit` chain
   masked a build failure because `tail` swallowed the exit code. Fixed with
   PID-based kills and `set -o pipefail` on every verification command.
6. **Truncated OpenAPI write.** A long file write was cut mid-document; the
   follow-up structural check (`sv-signature` missing) caught it before commit.

## What the AI did not do for us

It did not choose the semantics (reject-vs-queue, required idempotency keys,
POST-only rate limits, cancel-wins-over-delivery, no failover, resolve-time
SSRF). Those were explicit human decisions, written down in DECISIONS.md with
trade-offs *before* the corresponding code was accepted. The AI is fast at
scaffolding; it is the tests-plus-review loop that made the money paths
trustworthy.
