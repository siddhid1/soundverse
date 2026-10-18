import type { Pool } from "pg";
import { getPool } from "../db/index.js";
import { decryptSecret } from "./crypto.js";
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signDelivery,
} from "./sign.js";
import { SsrfError, assertUrlAllowed } from "./ssrf.js";

export interface DispatchOptions {
  allowPrivate: boolean;
  timeoutMs: number;
  maxAttempts: number;
  /** Base of the exponential backoff (seconds); attempt n waits ~base*2^(n-1), capped at 300s. */
  retryBaseSec: number;
  maxBytes: number;
  cryptKey: string;
  batchSize: number;
}

export interface DispatchSummary {
  eventsFannedOut: number;
  attempted: number;
  delivered: number;
  failed: number;
  dead: number;
}

/**
 * Fan-out: claim unpublished outbox events and create one delivery row per
 * currently-enabled endpoint. Endpoints registered later do not receive older
 * events (subscription starts at registration). Events with zero endpoints are
 * still marked published — there is nothing to do.
 */
export async function fanOut(pool: Pool, batchSize: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const claimed = await client.query(
        `WITH next AS (
           SELECT id FROM outbox_events WHERE published_at IS NULL
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE outbox_events e SET published_at=now() FROM next
         WHERE e.id = next.id RETURNING e.id, e.account_id`,
        [batchSize],
      );
      for (const row of claimed.rows as { id: string; account_id: string }[]) {
        // gen_random_uuid() per row: one INSERT...SELECT fans out to N
        // endpoints, and each delivery needs its own primary key.
        await client.query(
          `INSERT INTO webhook_deliveries(id, event_id, endpoint_id, account_id)
           SELECT gen_random_uuid(), $1, we.id, $2 FROM webhook_endpoints we
           WHERE we.account_id=$2 AND we.enabled
           ON CONFLICT (event_id, endpoint_id) DO NOTHING`,
          [row.id, row.account_id],
        );
      }
      await client.query("COMMIT");
      return claimed.rowCount ?? 0;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}

interface DueDelivery {
  id: string;
  event_id: string;
  endpoint_id: string;
  account_id: string;
  attempts: number;
  event_type: string;
  event_payload: Record<string, unknown>;
  event_created_at: string;
  endpoint_url: string;
  secret_enc: string;
}

async function claimDue(pool: Pool, batchSize: number): Promise<DueDelivery[]> {
  const res = await pool.query(
    `WITH next AS (
       SELECT d.id FROM webhook_deliveries d
       JOIN webhook_endpoints we ON we.id = d.endpoint_id AND we.enabled
       WHERE d.status='pending' AND d.next_attempt_at <= now()
       ORDER BY d.next_attempt_at, d.id FOR UPDATE OF d SKIP LOCKED LIMIT $1
     )
     SELECT d.id, d.event_id, d.endpoint_id, d.account_id, d.attempts,
            e.type AS event_type, e.payload AS event_payload, e.created_at AS event_created_at,
            we.url AS endpoint_url, we.secret_enc
     FROM webhook_deliveries d
     JOIN next ON next.id = d.id
     JOIN outbox_events e ON e.id = d.event_id
     JOIN webhook_endpoints we ON we.id = d.endpoint_id`,
    [batchSize],
  );
  return res.rows as DueDelivery[];
}

export function backoffSec(attemptsAfterThisTry: number, baseSec: number): number {
  const exp = Math.min(300, baseSec * 2 ** Math.max(0, attemptsAfterThisTry - 1));
  const jitter = exp * (0.9 + Math.random() * 0.2);
  return Math.min(300, jitter);
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > cap) {
    throw new Error(`Response body exceeds ${cap} bytes.`);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response body exceeds ${cap} bytes.`);
    }
    chunks.push(value);
  }
  for (const c of chunks) text += decoder.decode(c, { stream: true });
  return text + decoder.decode();
}

/** Deliver one attempt. Network happens outside any DB transaction; the result
 *  is recorded afterwards, so a crash between send and record safely retries
 *  (at-least-once; receivers dedupe on the stable event id). */
async function attemptDelivery(pool: Pool, d: DueDelivery, opts: DispatchOptions): Promise<"delivered" | "failed" | "dead"> {
  let sendError: string | null = null;
  let statusCode: number | null = null;
  try {
    // Re-validate on every attempt: DNS may have changed since registration.
    const checked = await assertUrlAllowed(d.endpoint_url, { allowPrivate: opts.allowPrivate });
    const secret = decryptSecret(d.secret_enc, opts.cryptKey);
    const timestamp = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: d.event_id,
      type: d.event_type,
      account_id: d.account_id,
      data: d.event_payload,
      created_at: d.event_created_at,
    });
    const res = await fetch(checked.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signDelivery(secret, timestamp, rawBody),
        [TIMESTAMP_HEADER]: String(timestamp),
        [EVENT_ID_HEADER]: d.event_id,
      },
      body: rawBody,
      redirect: "manual", // never follow redirects to unvalidated destinations
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    statusCode = res.status;
    await readCapped(res, opts.maxBytes);
    if (res.status >= 200 && res.status < 300) {
      await pool.query(
        `UPDATE webhook_deliveries SET status='delivered', attempts=attempts+1,
           last_status_code=$2, last_error=NULL, last_attempt_at=now(), updated_at=now() WHERE id=$1`,
        [d.id, res.status],
      );
      return "delivered";
    }
    sendError = `Unexpected HTTP status ${res.status}.`;
  } catch (err) {
    if (err instanceof SsrfError) sendError = err.message;
    else if ((err as Error).name === "TimeoutError") sendError = `Delivery timed out after ${opts.timeoutMs}ms.`;
    else sendError = (err as Error).message.slice(0, 500);
  }
  const attempts = d.attempts + 1;
  if (attempts >= opts.maxAttempts) {
    await pool.query(
      `UPDATE webhook_deliveries SET status='dead', attempts=$2,
         last_status_code=$3, last_error=$4, last_attempt_at=now(), updated_at=now() WHERE id=$1`,
      [d.id, attempts, statusCode, sendError],
    );
    return "dead";
  }
  const waitSec = backoffSec(attempts, opts.retryBaseSec);
  await pool.query(
    `UPDATE webhook_deliveries SET attempts=$2, next_attempt_at=now() + make_interval(secs => $3),
       last_status_code=$4, last_error=$5, last_attempt_at=now(), updated_at=now() WHERE id=$1`,
    [d.id, attempts, waitSec, statusCode, sendError],
  );
  return "failed";
}

/** One dispatcher cycle: fan out new events, then attempt due deliveries. */
export async function dispatchOnce(pool: Pool = getPool(), opts: DispatchOptions): Promise<DispatchSummary> {
  const summary: DispatchSummary = { eventsFannedOut: 0, attempted: 0, delivered: 0, failed: 0, dead: 0 };
  summary.eventsFannedOut = await fanOut(pool, opts.batchSize);
  const due = await claimDue(pool, opts.batchSize);
  for (const d of due) {
    summary.attempted += 1;
    const outcome = await attemptDelivery(pool, d, opts);
    if (outcome === "delivered") summary.delivered += 1;
    else if (outcome === "dead") summary.dead += 1;
    else summary.failed += 1;
  }
  return summary;
}
