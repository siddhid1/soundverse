import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/index.js";
import { canonicalHash } from "../lib/canonical.js";
import type { AuthContext } from "./apiKeys.js";
import { creditsFor, currentPeriodStart, type GenerationInput, type License } from "./credits.js";
import { emitOutbox, jobEventPayload } from "./outbox.js";
import { newId } from "../lib/crypto.js";

export type Queryable = Pool | PoolClient;

export interface ServiceFailure extends Error {
  code: string;
  retryAfterSec?: number;
}

export function fail(code: string, message: string, retryAfterSec?: number): ServiceFailure {
  const err = new Error(message) as ServiceFailure;
  err.code = code;
  if (retryAfterSec !== undefined) err.retryAfterSec = retryAfterSec;
  return err;
}

export function newGenerationId(): string {
  return `gen_${randomBytes(16).toString("base64url")}`;
}

export interface PlanLimits {
  id: string;
  monthlyAllowanceCredits: number;
  parallelGenerations: number;
  requestsPerHour: number;
  requestsPerDay: number;
  allowedLicenses: string[];
  overagePolicy: "none" | "hard_stop" | "overage";
}

export interface GenerationRow {
  id: string;
  account_id: string;
  key_id: string | null;
  status: string;
  prompt: string;
  duration_sec: number;
  license: string;
  instrumental: boolean;
  metadata: Record<string, unknown> | null;
  reserved_credits: number;
  charged_credits: number | null;
  progress: number;
  provider: string | null;
  model: string | null;
  provider_job_id: string | null;
  object_key: string | null;
  output_duration_sec: number | null;
  output_format: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  period_start: string;
}

/** Column list shared with the worker engine (single source of truth for job reads). */
export const JOB_COLS = `id, account_id, key_id, status, prompt, duration_sec, license, instrumental, metadata,
  reserved_credits, charged_credits, progress, provider, model, provider_job_id, object_key,
  output_duration_sec, output_format, error_code, error_message, attempts,
  cancel_requested_at, created_at, updated_at, completed_at, period_start`;

function mapPlanRow(r: Record<string, unknown>): PlanLimits {
  return {
    id: r.id as string,
    monthlyAllowanceCredits: Number(r.monthly_allowance_credits),
    parallelGenerations: Number(r.parallel_generations),
    requestsPerHour: Number(r.requests_per_hour),
    requestsPerDay: Number(r.requests_per_day),
    allowedLicenses: (r.allowed_licenses ?? []) as string[],
    overagePolicy: r.overage_policy as PlanLimits["overagePolicy"],
  };
}

export async function getPlan(q: Queryable, planId: string): Promise<PlanLimits> {
  const res = await q.query(
    `SELECT id, monthly_allowance_credits, parallel_generations, requests_per_hour,
            requests_per_day, allowed_licenses, overage_policy
     FROM plans WHERE id=$1`,
    [planId],
  );
  if ((res.rowCount ?? 0) === 0) throw fail("internal", "Account plan is misconfigured.");
  return mapPlanRow(res.rows[0] as Record<string, unknown>);
}

export interface RateCounts {
  hour: number;
  day: number;
  hourResetSec: number;
  dayResetSec: number;
}

function resetSecs(): { hourResetSec: number; dayResetSec: number } {
  const now = Date.now();
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);
  const hourResetSec = Math.max(1, Math.ceil((nextHour.getTime() + 3600_000 - now) / 1000));
  const nextDay = new Date(Date.UTC(nextHour.getUTCFullYear(), nextHour.getUTCMonth(), nextHour.getUTCDate() + 1));
  const dayResetSec = Math.max(1, Math.ceil((nextDay.getTime() - now) / 1000));
  return { hourResetSec, dayResetSec };
}

/**
 * Atomic check-and-increment for the fixed windows. The UPDATE both tests the
 * cap and consumes one unit while holding the row lock, so N concurrent
 * requests consume exactly N units and the (limit+1)-th is rejected — no
 * over-admission and no over-rejection. Runs inside the account-locked
 * transaction, so rejected attempts roll back without consuming budget or
 * ledger (a client spamming invalid requests only slows its own account,
 * which shares one lock anyway — documented residual, not a cross-tenant issue).
 */
async function takeRateQuota(client: PoolClient, accountId: string, plan: PlanLimits): Promise<RateCounts> {
  await client.query(
    `INSERT INTO rate_counters(account_id, granularity, window_start, count)
     VALUES ($1,'hour',date_trunc('hour', now()),0), ($1,'day',date_trunc('day', now()),0)
     ON CONFLICT (account_id, granularity, window_start) DO NOTHING`,
    [accountId],
  );
  // Prune dead windows while we are here.
  await client.query(`DELETE FROM rate_counters WHERE account_id=$1 AND window_start < now() - interval '48 hours'`, [
    accountId,
  ]);
  const hour = await client.query(
    `UPDATE rate_counters SET count = count + 1
     WHERE account_id=$1 AND granularity='hour' AND window_start=date_trunc('hour', now()) AND count < $2
     RETURNING count`,
    [accountId, plan.requestsPerHour],
  );
  if ((hour.rowCount ?? 0) === 0) {
    const { hourResetSec } = resetSecs();
    throw fail("hourly_rate_limit", `Hourly request limit (${plan.requestsPerHour}) exceeded.`, hourResetSec);
  }
  const day = await client.query(
    `UPDATE rate_counters SET count = count + 1
     WHERE account_id=$1 AND granularity='day' AND window_start=date_trunc('day', now()) AND count < $2
     RETURNING count`,
    [accountId, plan.requestsPerDay],
  );
  if ((day.rowCount ?? 0) === 0) {
    const { dayResetSec } = resetSecs();
    throw fail("daily_rate_limit", `Daily request limit (${plan.requestsPerDay}) exceeded.`, dayResetSec);
  }
  const { hourResetSec, dayResetSec } = resetSecs();
  return {
    hour: Number((hour.rows[0] as { count: number }).count),
    day: Number((day.rows[0] as { count: number }).count),
    hourResetSec,
    dayResetSec,
  };
}

export async function readRateCounters(q: Queryable, accountId: string): Promise<RateCounts> {
  const res = await q.query(
    `SELECT granularity, count FROM rate_counters
     WHERE account_id=$1 AND ((granularity='hour' AND window_start=date_trunc('hour', now()))
       OR (granularity='day' AND window_start=date_trunc('day', now())))`,
    [accountId],
  );
  let hour = 0;
  let day = 0;
  for (const row of res.rows as { granularity: string; count: number }[]) {
    if (row.granularity === "hour") hour = Number(row.count);
    else day = Number(row.count);
  }
  const now = Date.now();
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);
  const hourResetSec = Math.max(1, Math.ceil((nextHour.getTime() + 3600_000 - now) / 1000));
  const nextDay = new Date(Date.UTC(nextHour.getUTCFullYear(), nextHour.getUTCMonth(), nextHour.getUTCDate() + 1));
  const dayResetSec = Math.max(1, Math.ceil((nextDay.getTime() - now) / 1000));
  return { hour, day, hourResetSec, dayResetSec };
}

interface IdemRecord {
  request_hash: string;
  generation_id: string | null;
}

async function findIdem(q: Queryable, accountId: string, key: string): Promise<IdemRecord | null> {
  const res = await q.query(
    `SELECT request_hash, generation_id FROM idempotency_records
     WHERE account_id=$1 AND idempotency_key=$2`,
    [accountId, key],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  return res.rows[0] as IdemRecord;
}

export async function getGenerationById(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<GenerationRow> {
  const res = await q.query(`SELECT ${JOB_COLS} FROM generations WHERE id=$1 AND account_id=$2`, [
    id,
    accountId,
  ]);
  if ((res.rowCount ?? 0) === 0) throw fail("generation_not_found", "Generation not found.");
  return res.rows[0] as GenerationRow;
}

export interface CreateResult {
  job: GenerationRow;
  replayed: boolean;
  rate: RateCounts;
}

/**
 * The acceptance transaction. Holds an account-level lock (SELECT ... FOR
 * UPDATE) while it: re-checks idempotency, checks license, checks allowance /
 * overage, checks the parallel-job count, reserves credits, inserts the job,
 * writes the reservation ledger entry, and stores the idempotency record.
 * Every limit is enforced inside the lock, so concurrent requests cannot
 * overspend, over-parallelize, or double-bill. Error paths roll everything back.
 */
export async function createGeneration(
  pool: Pool = getPool(),
  opts: { auth: AuthContext; idempotencyKey?: string | undefined; input: GenerationInput },
): Promise<CreateResult> {
  const { auth, input } = opts;
  const rawKey = opts.idempotencyKey?.trim() ?? "";
  if (!rawKey || rawKey.length > 128) {
    throw fail("idempotency_key_required", "Idempotency-Key header (1-128 chars) is required.");
  }
  const requestHash = canonicalHash(input);

  // Replays are free: no quota consumed, no ledger touched.
  const fastHit = await findIdem(pool, auth.accountId, rawKey);
  if (fastHit) {
    if (fastHit.request_hash !== requestHash) {
      throw fail("idempotency_key_reuse", "Idempotency-Key was already used with a different payload.");
    }
    if (!fastHit.generation_id) throw fail("internal", "Idempotency record is incomplete.");
    const rate = await readRateCounters(pool, auth.accountId);
    return { job: await getGenerationById(pool, auth.accountId, fastHit.generation_id), replayed: true, rate };
  }

  const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        // Serialize concurrent POSTs sharing one Idempotency-Key. All txns
        // for the same (account, key) queue here; the first inserts, the rest
        // observe the winner via innerHit below and replay it. Lock scope is
        // the idempotency key (not the account), so unrelated keys proceed in
        // parallel. hashtext collisions only cause extra waiting, never
        // incorrectness. The 23505 catch further down stays as a backstop.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('idem:' || $1 || ':' || $2))`, [
          auth.accountId,
          rawKey,
        ]);
        // Re-check under no row lock first: another request may have committed
        // between our fast-path read and now.
        const innerHit = await findIdem(client, auth.accountId, rawKey);
      if (innerHit) {
        if (innerHit.request_hash !== requestHash) {
          throw fail("idempotency_key_reuse", "Idempotency-Key was already used with a different payload.");
        }
        if (!innerHit.generation_id) throw fail("internal", "Idempotency record is incomplete.");
        const job = await getGenerationById(client, auth.accountId, innerHit.generation_id);
        const rate = await readRateCounters(client, auth.accountId);
        await client.query("COMMIT");
        return { job, replayed: true, rate };
      }

      // The one lock that makes all limits race-safe. The plan is re-read
      // here (not from the pre-lock snapshot) so a mid-flight plan change
      // applies to this request, not the next one.
      const locked = await client.query(
        `SELECT p.id AS id, p.monthly_allowance_credits, p.parallel_generations,
                p.requests_per_hour, p.requests_per_day, p.allowed_licenses, p.overage_policy
         FROM accounts a JOIN plans p ON p.id = a.plan_id
         WHERE a.id=$1 FOR UPDATE`,
        [auth.accountId],
      );
      if ((locked.rowCount ?? 0) === 0) throw fail("internal", "Account no longer exists.");
      const plan = mapPlanRow(locked.rows[0] as Record<string, unknown>);

      // Exact, race-free quota consumption (see takeRateQuota).
      const rate = await takeRateQuota(client, auth.accountId, plan);

      if (!plan.allowedLicenses.includes(input.license)) {
        throw fail(
          "license_not_allowed",
          `License "${input.license}" is not available on the ${plan.id} plan.`,
        );
      }
      if (plan.id === "sandbox" && auth.key.mode === "live") {
        throw fail("live_not_allowed", "The sandbox plan accepts test keys only.");
      }

      const period = currentPeriodStart();
      let reserved = 0;
      let overageExpected = false;
      if (auth.key.mode === "live") {
        const cost = creditsFor(input.license as License, input.duration_sec);
        const sums = await client.query(
          `SELECT
             COALESCE(SUM(amount) FILTER (WHERE type IN ('charge','overage_charge')), 0) AS used,
             COALESCE(SUM(amount) FILTER (WHERE type = 'grant'), 0) AS granted,
             COALESCE(SUM(amount) FILTER (WHERE type = 'reservation'), 0)
               - COALESCE(SUM(amount) FILTER (WHERE type IN ('release','charge','overage_charge')), 0) AS pending
           FROM usage_ledger WHERE account_id=$1 AND period_start=$2`,
          [auth.accountId, period],
        );
        const used = Number((sums.rows[0] as { used: string }).used);
        const granted = Number((sums.rows[0] as { granted: string }).granted);
        const pending = Number((sums.rows[0] as { pending: string }).pending);
        if (used + pending + cost > plan.monthlyAllowanceCredits + granted) {
          if (plan.overagePolicy === "overage") {
            overageExpected = true;
          } else {
            throw fail(
              "allowance_exceeded",
              "Monthly credit allowance is exhausted. Upgrade or wait for the next billing period.",
            );
          }
        }
        reserved = cost;
      }

      const active = await client.query(
        `SELECT COUNT(*)::int AS n FROM generations
         WHERE account_id=$1 AND status IN ('queued','running')`,
        [auth.accountId],
      );
      if ((active.rows[0] as { n: number }).n >= plan.parallelGenerations) {
        throw fail(
          "parallel_limit_reached",
          `The account has reached its parallel generation limit (${plan.parallelGenerations}).`,
        );
      }

      const jobId = newGenerationId();
      const jobRes = await client.query(
        `INSERT INTO generations(id, account_id, key_id, status, prompt, duration_sec, license,
           instrumental, metadata, reserved_credits, provider, period_start)
         VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9,'mock',$10)
         RETURNING ${JOB_COLS}`,
        [
          jobId,
          auth.accountId,
          auth.key.id,
          input.prompt,
          input.duration_sec,
          input.license,
          input.instrumental ?? true,
          input.metadata ? JSON.stringify(input.metadata) : null,
          reserved,
          period,
        ],
      );

      // Test keys: no ledger entries, no allowance consumed, mock provider only.
      if (reserved > 0) {
        await client.query(
          `INSERT INTO usage_ledger(id, account_id, key_id, generation_id, type, amount, period_start, metadata)
           VALUES ($1,$2,$3,$4,'reservation',$5,$6,$7)`,
          [
            newId(),
            auth.accountId,
            auth.key.id,
            jobId,
            reserved,
            period,
            JSON.stringify(overageExpected ? { overage_expected: true } : {}),
          ],
        );
      }

      // The insert race: another request committed the same key first.
      // Uses a savepoint because a unique violation aborts the whole
      // transaction in Postgres — without it every later statement in this
      // tx would fail with "current transaction is aborted".
      await client.query("SAVEPOINT idem_insert");
      try {
        await client.query(
          `INSERT INTO idempotency_records(id, account_id, idempotency_key, request_hash, generation_id, expires_at)
           VALUES ($1,$2,$3,$4,$5, now() + interval '24 hours')`,
          [newId(), auth.accountId, rawKey, requestHash, jobId],
        );
        await client.query("RELEASE SAVEPOINT idem_insert");
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT idem_insert");
        // Lost the insert race: the winner committed first. Our uncommitted
        // job + reservation must be removed so the retry creates neither a
        // duplicate job nor a duplicate charge — then replay the winner.
        if ((e as { code?: string }).code !== "23505") throw e;
        await client.query(`DELETE FROM usage_ledger WHERE generation_id=$1`, [jobId]);
        await client.query(`DELETE FROM generations WHERE id=$1`, [jobId]);
        const winner = await findIdem(client, auth.accountId, rawKey);
        if (!winner?.generation_id) throw fail("internal", "Idempotency record is incomplete.");
        if (winner.request_hash !== requestHash) {
          throw fail("idempotency_key_reuse", "Idempotency-Key was already used with a different payload.");
        }
        const job = await getGenerationById(client, auth.accountId, winner.generation_id);
        await client.query("COMMIT");
        return { job, replayed: true, rate };
      }

      // Lifecycle event: acceptance is atomic with the job row, so a 202 and
      // its event can never diverge. Replays returned above emit nothing, and
      // this sits after the savepoint so a lost idem-race rollback drops it too.
      await emitOutbox(client, {
        accountId: auth.accountId,
        type: "generation.created",
        payload: jobEventPayload(jobRes.rows[0] as GenerationRow),
      });

      // Opportunistic expiry cleanup (24h retention) scoped to this account.
      await client.query(`DELETE FROM idempotency_records WHERE account_id=$1 AND expires_at < now()`, [
        auth.accountId,
      ]);

      await client.query("COMMIT");
      return { job: jobRes.rows[0] as GenerationRow, replayed: false, rate };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}

export interface ListResult {
  data: GenerationRow[];
  total: number;
}

export async function listGenerations(
  pool: Pool = getPool(),
  opts: { accountId: string; status?: string | undefined; limit: number; offset: number },
): Promise<ListResult> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const offset = Math.max(opts.offset, 0);
  const params: unknown[] = [opts.accountId];
  let statusClause = "";
  if (opts.status) {
    params.push(opts.status);
    statusClause = `AND status=$${params.length}`;
  }
  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM generations WHERE account_id=$1 ${statusClause}`,
    params,
  );
  const dataRes = await pool.query(
    `SELECT ${JOB_COLS} FROM generations WHERE account_id=$1 ${statusClause}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { data: dataRes.rows as GenerationRow[], total: (totalRes.rows[0] as { n: number }).n };
}

/**
 * Queued jobs cancel atomically with a single release of their reservation.
 * Running jobs only record the request; the worker (Phase 4) honors it and
 * finalizes exactly once. Terminal jobs conflict, except canceled which is
 * idempotent. The row lock serializes cancel against worker finalization.
 */
export async function cancelGeneration(
  pool: Pool = getPool(),
  opts: { auth: AuthContext; id: string },
): Promise<{ job: GenerationRow; wasAlreadyCanceled: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const res = await client.query(`SELECT ${JOB_COLS} FROM generations WHERE id=$1 AND account_id=$2 FOR UPDATE`, [
        opts.id,
        opts.auth.accountId,
      ]);
      if ((res.rowCount ?? 0) === 0) throw fail("generation_not_found", "Generation not found.");
      const job = res.rows[0] as GenerationRow;
      if (job.status === "canceled") {
        await client.query("COMMIT");
        return { job, wasAlreadyCanceled: true };
      }
      if (job.status !== "queued" && job.status !== "running") {
        throw fail("state_conflict", `Cannot cancel a ${job.status} generation.`);
      }
      if (job.status === "running") {
        const upd = await client.query(
          `UPDATE generations SET cancel_requested_at=coalesce(cancel_requested_at, now()), updated_at=now()
           WHERE id=$1 RETURNING ${JOB_COLS}`,
          [job.id],
        );
        await client.query("COMMIT");
        return { job: upd.rows[0] as GenerationRow, wasAlreadyCanceled: false };
      }
      const upd = await client.query(
        `UPDATE generations SET status='canceled', completed_at=now(), updated_at=now()
         WHERE id=$1 AND status='queued' RETURNING ${JOB_COLS}`,
        [job.id],
      );
      if ((upd.rowCount ?? 0) === 0) throw fail("state_conflict", "Generation changed state during cancel.");
      if (job.reserved_credits > 0) {
        await client.query(
          `INSERT INTO usage_ledger(id, account_id, key_id, generation_id, type, amount, period_start, metadata)
           VALUES ($1,$2,$3,$4,'release',$5,$6,$7)`,
          [newId(), opts.auth.accountId, opts.auth.key.id, job.id, job.reserved_credits, job.period_start, JSON.stringify({ reason: "cancel" })],
        );
      }
      await client.query("COMMIT");
      return { job: upd.rows[0] as GenerationRow, wasAlreadyCanceled: false };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}

export interface UsageSummary {
  plan_id: string;
  period_start: string;
  allowance_credits: number;
  granted_credits: number;
  used_credits: number;
  pending_credits: number;
  remaining_credits: number;
  overage_credits: number;
  overage_policy: string;
  active_jobs: number;
}

export async function usageSummary(
  pool: Pool = getPool(),
  opts: { accountId: string; planId: string },
): Promise<UsageSummary> {
  const plan = await getPlan(pool, opts.planId);
  const period = currentPeriodStart();
  const sums = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='charge'), 0)::int AS charge,
       COALESCE(SUM(amount) FILTER (WHERE type='overage_charge'), 0)::int AS overage,
       COALESCE(SUM(amount) FILTER (WHERE type='grant'), 0)::int AS granted,
       (COALESCE(SUM(amount) FILTER (WHERE type='reservation'), 0)
        - COALESCE(SUM(amount) FILTER (WHERE type IN ('release','charge','overage_charge')), 0))::int AS pending
     FROM usage_ledger WHERE account_id=$1 AND period_start=$2`,
    [opts.accountId, period],
  );
  const row = sums.rows[0] as { charge: number; overage: number; granted: number; pending: number };
  const active = await pool.query(
    `SELECT COUNT(*)::int AS n FROM generations WHERE account_id=$1 AND status IN ('queued','running')`,
    [opts.accountId],
  );
  const used = row.charge + row.overage;
  const granted = row.granted;
  return {
    plan_id: plan.id,
    period_start: period,
    allowance_credits: plan.monthlyAllowanceCredits,
    granted_credits: granted,
    used_credits: used,
    pending_credits: row.pending,
    remaining_credits: plan.monthlyAllowanceCredits + granted - used - row.pending,
    overage_credits: row.overage,
    overage_policy: plan.overagePolicy,
    active_jobs: (active.rows[0] as { n: number }).n,
  };
}

/** Public API shape for a job. audio_url arrives with storage in Phase 4. */
export function toPublicJob(row: GenerationRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    license: row.license,
    prompt: row.prompt,
    duration_sec: row.duration_sec,
    instrumental: row.instrumental,
    metadata: row.metadata ?? null,
    credits_reserved: row.reserved_credits,
    credits_charged: row.charged_credits,
    progress: row.progress,
    cancel_requested: row.cancel_requested_at !== null,
    output:
      row.status === "succeeded" && row.object_key
        ? { audio_url: null, duration_sec: row.output_duration_sec, format: row.output_format }
        : null,
    provider: row.provider,
    model: row.model,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}
