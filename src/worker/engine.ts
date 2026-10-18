import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/index.js";
import { newId } from "../lib/crypto.js";
import { ProviderError, type MusicProvider } from "../providers/types.js";
import { getPlan, JOB_COLS, type GenerationRow, type Queryable } from "../services/generations.js";
import { emitOutbox, jobEventPayload } from "../services/outbox.js";
import { audioKey, type ObjectStore } from "../storage/store.js";

export interface EngineOptions {
  store: ObjectStore;
  /** Always the mock (or a test double). Test-key jobs can never touch paid models. */
  testProvider: MusicProvider;
  /** Mock by default; the real adapter only when explicitly enabled. */
  liveProvider: MusicProvider;
  leaseSec: number;
  maxAttempts: number;
  providerTimeoutMs: number;
}

export type ProcessOutcome =
  | { claimed: false }
  | { claimed: true; jobId: string; outcome: "succeeded" | "failed" | "requeued" | "canceled" | "lost" };

/**
 * Persist an in-flight progress tick and emit its webhook event in ONE short
 * transaction. Guarded on status='running', so a tick that loses the race with
 * cancel/finalize is a no-op (never resurrects a settled job). These events are
 * deliberately exempt from the "exactly one terminal event" invariant — that
 * rule covers succeeded/failed/canceled only.
 */
export async function reportProgress(pool: Pool, jobId: string, progress: number): Promise<void> {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const upd = await client.query(
        `UPDATE generations SET progress=$2, updated_at=now() WHERE id=$1 AND status='running' RETURNING ${JOB_COLS}`,
        [jobId, pct],
      );
      if ((upd.rowCount ?? 0) > 0) {
        const live = upd.rows[0] as GenerationRow;
        await emitOutbox(client, { accountId: live.account_id, type: "generation.progress", payload: jobEventPayload(live) });
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}

function contentTypeFor(format: string): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "wav") return "audio/wav";
  return "application/octet-stream";
}

/**
 * Claim one queued job atomically. `FOR UPDATE SKIP LOCKED` lets many worker
 * processes poll without blocking each other; the conditional status guard is
 * a backstop. The transaction commits BEFORE any network call — a crash after
 * this point leaves a running job with a lease, recovered by recoverExpiredJobs.
 */
export async function claimNextJob(q: Queryable, leaseSec: number): Promise<GenerationRow | null> {
  const res = await q.query(
    `WITH next AS (
       SELECT id AS nid FROM generations WHERE status='queued'
       ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE generations g
     SET status='running', attempts=g.attempts+1, claimed_at=now(), progress=10,
         lease_expires_at=now() + make_interval(secs => $1), updated_at=now()
     FROM next WHERE g.id=next.nid AND g.status='queued'
     RETURNING ${JOB_COLS}`,
    [leaseSec],
  );
  return ((res.rowCount ?? 0) > 0 ? (res.rows[0] as GenerationRow) : null);
}

/** Heartbeat for long provider calls. Failure to renew is non-fatal: the
 *  recovery scan will requeue the job and exactly-once finalize still holds. */
export async function renewLease(q: Queryable, jobId: string, leaseSec: number): Promise<boolean> {
  const res = await q.query(
    `UPDATE generations SET lease_expires_at=now() + make_interval(secs => $2), updated_at=now()
     WHERE id=$1 AND status='running'`,
    [jobId, leaseSec],
  );
  return (res.rowCount ?? 0) > 0;
}

async function keyMode(q: Queryable, keyId: string | null): Promise<"test" | "live"> {
  if (!keyId) return "live";
  const res = await q.query(`SELECT mode FROM api_keys WHERE id=$1`, [keyId]);
  if ((res.rowCount ?? 0) === 0) return "live";
  return (res.rows[0] as { mode: string }).mode === "test" ? "test" : "live";
}

/**
 * Recover jobs whose lease expired (crashed worker, hung provider, lost
 * heartbeat). Cancel-requested jobs finalize as canceled; jobs past the retry
 * budget fail with their reservation released; the rest requeue. Batched in one
 * transaction, serialized against cancel/finalize by the row lock.
 */
export async function recoverExpiredJobs(pool: Pool = getPool(), eng: EngineOptions): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const res = await client.query(
        `SELECT ${JOB_COLS} FROM generations
         WHERE status='running' AND lease_expires_at < now()
         ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 100`,
      );
      for (const raw of res.rows as GenerationRow[]) {
        if (raw.cancel_requested_at) {
          await transitionToCanceled(client, raw);
        } else if (raw.attempts >= eng.maxAttempts) {
          await transitionToFailed(client, raw, "worker_recovery", "Job exceeded retry budget after worker loss.");
        } else {
          await client.query(
            `UPDATE generations SET status='queued', claimed_at=NULL, lease_expires_at=NULL, progress=0, updated_at=now()
             WHERE id=$1`,
            [raw.id],
          );
        }
      }
      await client.query("COMMIT");
      return res.rowCount ?? 0;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}

async function releaseReservation(
  client: PoolClient,
  job: GenerationRow,
  reason: string,
): Promise<void> {
  if (job.reserved_credits <= 0) return;
  await client.query(
    `INSERT INTO usage_ledger(id, account_id, key_id, generation_id, type, amount, period_start, metadata)
     VALUES ($1,$2,$3,$4,'release',$5,$6,$7)`,
    [newId(), job.account_id, job.key_id, job.id, job.reserved_credits, job.period_start, JSON.stringify({ reason })],
  );
}

async function transitionToCanceled(client: PoolClient, job: GenerationRow): Promise<void> {
  const upd = await client.query(
    `UPDATE generations SET status='canceled', completed_at=now(), lease_expires_at=NULL, updated_at=now()
     WHERE id=$1 AND status='running' RETURNING ${JOB_COLS}`,
    [job.id],
  );
  if ((upd.rowCount ?? 0) === 0) return; // someone else finalized first; their tx owns the ledger
  await releaseReservation(client, upd.rows[0] as GenerationRow, "cancel");
  const done = upd.rows[0] as GenerationRow;
  await emitOutbox(client, { accountId: done.account_id, type: "generation.canceled", payload: jobEventPayload(done) });
}

async function transitionToFailed(
  client: PoolClient,
  job: GenerationRow,
  code: string,
  message: string,
): Promise<void> {
  const upd = await client.query(
    `UPDATE generations SET status='failed', completed_at=now(), lease_expires_at=NULL,
       error_code=$2, error_message=$3, updated_at=now()
     WHERE id=$1 AND status='running' RETURNING ${JOB_COLS}`,
    [job.id, code, message.slice(0, 500)],
  );
  if ((upd.rowCount ?? 0) === 0) return;
  await releaseReservation(client, upd.rows[0] as GenerationRow, "failure");
  const done = upd.rows[0] as GenerationRow;
  await emitOutbox(client, {
    accountId: done.account_id,
    type: "generation.failed",
    payload: jobEventPayload(done, { error_code: code, error_message: message.slice(0, 500) }),
  });
}

/**
 * Claim one job and drive it to a terminal (or requeued) state. Safe to call
 * concurrently from many processes and after restarts: claiming is atomic,
 * finalization is conditional on status='running' under a row lock, and every
 * terminal path writes exactly one ledger settlement + one outbox event.
 */
export async function processOnce(pool: Pool = getPool(), eng: EngineOptions): Promise<ProcessOutcome> {
  const job = await claimNextJob(pool, eng.leaseSec);
  if (!job) return { claimed: false };

  const mode = await keyMode(pool, job.key_id);
  const provider = mode === "test" ? eng.testProvider : eng.liveProvider;

  // Lease heartbeat while the provider call is in flight.
  const beatMs = Math.max(1000, Math.floor((eng.leaseSec * 1000) / 3));
  const beat = setInterval(() => {
    void renewLease(pool, job.id, eng.leaseSec).catch(() => {});
  }, beatMs);
  let result: { audio: Buffer; format: string; durationSec: number; model: string; providerJobId?: string } | null = null;
  let failure: ProviderError | null = null;
  try {
    result = await provider.generate(
      {
        prompt: job.prompt,
        durationSec: job.duration_sec,
        instrumental: job.instrumental,
        providerRequestId: job.id,
      },
      {
        timeoutMs: eng.providerTimeoutMs,
        onProgress: (pct) => {
          // Fire-and-forget: a lost tick is cosmetic, never correctness.
          void reportProgress(pool, job.id, pct).catch(() => {});
        },
      },
    );
  } catch (err) {
    failure = err instanceof ProviderError ? err : new ProviderError("provider_error", (err as Error).message);
  } finally {
    clearInterval(beat);
  }

  if (result && !failure) {
    // Upload before finalizing. If finalization loses its race the object is
    // orphaned (never referenced, tenant-scoped key); storage GC, not billing,
    // owns that cleanup — the ledger is untouched until the conditional commit.
    const objectKey = audioKey(job.account_id, job.id, result.format);
    try {
      await eng.store.put(objectKey, result.audio, contentTypeFor(result.format));
    } catch (err) {
      failure = new ProviderError("provider_error", `Audio upload failed: ${(err as Error).message}`);
    }
    if (!failure) return finalizeSuccess(pool, eng, job, { ...result, objectKey }, provider.name);
  }
  return finalizeFailure(pool, eng, job, failure ?? new ProviderError("provider_error", "Unknown provider failure."));
}

async function finalizeSuccess(
  pool: Pool,
  eng: EngineOptions,
  job: GenerationRow,
  result: { audio: Buffer; format: string; durationSec: number; model: string; providerJobId?: string | undefined; objectKey: string },
  providerName: string,
): Promise<ProcessOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const cur = await client.query(`SELECT ${JOB_COLS} FROM generations WHERE id=$1 FOR UPDATE`, [job.id]);
      if ((cur.rowCount ?? 0) === 0 || (cur.rows[0] as GenerationRow).status !== "running") {
        await client.query("ROLLBACK");
        return { claimed: true, jobId: job.id, outcome: "lost" };
      }
      const live = cur.rows[0] as GenerationRow;
      // A cancel that landed mid-run wins over delivery: the user asked to
      // stop, so the result is discarded (release, no charge for undelivered
      // output). Provider-side cost is ours; documented in DECISIONS.
      if (live.cancel_requested_at) {
        await transitionToCanceled(client, live);
        await client.query("COMMIT");
        return { claimed: true, jobId: job.id, outcome: "canceled" };
      }
      // Settle billing: split the reservation into charge vs overage against
      // the CURRENT plan and the job's ORIGINAL period (cross-month completion
      // cannot strand or double-count). Test jobs (reserved 0) skip the ledger.
      let charged = 0;
      if (live.reserved_credits > 0) {
        const acct = await client.query(`SELECT plan_id FROM accounts WHERE id=$1`, [live.account_id]);
        const plan = await getPlan(client, (acct.rows[0] as { plan_id: string }).plan_id);
        const sums = await client.query(
          `SELECT
             COALESCE(SUM(amount) FILTER (WHERE type IN ('charge','overage_charge')), 0)::int AS used,
             COALESCE(SUM(amount) FILTER (WHERE type='grant'), 0)::int AS granted,
             (COALESCE(SUM(amount) FILTER (WHERE type='reservation'), 0)
              - COALESCE(SUM(amount) FILTER (WHERE type IN ('release','charge','overage_charge')), 0))::int AS pending
           FROM usage_ledger WHERE account_id=$1 AND period_start=$2`,
          [live.account_id, live.period_start],
        );
        const used = (sums.rows[0] as { used: number }).used;
        const granted = (sums.rows[0] as { granted: number }).granted;
        const pendingExcl = (sums.rows[0] as { pending: number }).pending - live.reserved_credits;
        // Spendable pool = plan allowance + signup grants.
        const covered = Math.max(0, Math.min(live.reserved_credits, plan.monthlyAllowanceCredits + granted - used - pendingExcl));
        charged = live.reserved_credits;
        if (covered > 0) {
          await client.query(
            `INSERT INTO usage_ledger(id, account_id, key_id, generation_id, type, amount, period_start)
             VALUES ($1,$2,$3,$4,'charge',$5,$6)`,
            [newId(), live.account_id, live.key_id, live.id, covered, live.period_start],
          );
        }
        if (live.reserved_credits - covered > 0) {
          await client.query(
            `INSERT INTO usage_ledger(id, account_id, key_id, generation_id, type, amount, period_start, metadata)
             VALUES ($1,$2,$3,$4,'overage_charge',$5,$6,$7)`,
            [newId(), live.account_id, live.key_id, live.id, live.reserved_credits - covered, live.period_start, JSON.stringify({ reason: "beyond_allowance" })],
          );
        }
      }
      const upd = await client.query(
        `UPDATE generations SET status='succeeded', progress=100, charged_credits=$2, provider=$3, model=$4,
           provider_job_id=$5, object_key=$6, output_duration_sec=$7, output_format=$8,
           completed_at=now(), lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='running' RETURNING ${JOB_COLS}`,
        [live.id, charged, providerName, result.model, result.providerJobId ?? null, result.objectKey, result.durationSec, result.format],
      );
      if ((upd.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { claimed: true, jobId: job.id, outcome: "lost" };
      }
      const done = upd.rows[0] as GenerationRow;
      await emitOutbox(client, { accountId: done.account_id, type: "generation.succeeded", payload: jobEventPayload(done) });
      await client.query("COMMIT");
      return { claimed: true, jobId: job.id, outcome: "succeeded" };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}

async function finalizeFailure(pool: Pool, eng: EngineOptions, job: GenerationRow, err: ProviderError): Promise<ProcessOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const cur = await client.query(`SELECT ${JOB_COLS} FROM generations WHERE id=$1 FOR UPDATE`, [job.id]);
      if ((cur.rowCount ?? 0) === 0 || (cur.rows[0] as GenerationRow).status !== "running") {
        await client.query("ROLLBACK");
        return { claimed: true, jobId: job.id, outcome: "lost" };
      }
      const live = cur.rows[0] as GenerationRow;
      if (live.cancel_requested_at) {
        await transitionToCanceled(client, live);
        await client.query("COMMIT");
        return { claimed: true, jobId: job.id, outcome: "canceled" };
      }
      if (live.attempts < eng.maxAttempts) {
        await client.query(
          `UPDATE generations SET status='queued', claimed_at=NULL, lease_expires_at=NULL, progress=0,
             error_code=$2, error_message=$3, updated_at=now() WHERE id=$1`,
          [live.id, err.code, err.message.slice(0, 500)],
        );
        await client.query("COMMIT");
        return { claimed: true, jobId: job.id, outcome: "requeued" };
      }
      await transitionToFailed(client, live, err.code, err.message);
      await client.query("COMMIT");
      return { claimed: true, jobId: job.id, outcome: "failed" };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}
