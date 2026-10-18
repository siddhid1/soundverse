import { randomBytes } from "node:crypto";
import type { GenerationRow, Queryable } from "./generations.js";

/**
 * Durable outbox helpers. Events are written in the SAME transaction as the
 * state change they describe (job acceptance, terminal settlement), so a
 * committed job can never lack its event and vice versa. Progress events are
 * the one exception: they are non-terminal and written in their own tiny txn.
 */
export type OutboxEventType =
  | "generation.created"
  | "generation.progress"
  | "generation.succeeded"
  | "generation.failed"
  | "generation.canceled";

export function newEventId(): string {
  return `evt_${randomBytes(12).toString("base64url")}`;
}

export async function emitOutbox(
  q: Queryable,
  event: { accountId: string; type: OutboxEventType; payload: Record<string, unknown> },
): Promise<void> {
  await q.query(`INSERT INTO outbox_events(id, account_id, type, payload) VALUES ($1,$2,$3,$4)`, [
    newEventId(),
    event.accountId,
    event.type,
    JSON.stringify(event.payload),
  ]);
}

/** Uniform webhook payload across every lifecycle event. */
export function jobEventPayload(job: GenerationRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generation_id: job.id,
    account_id: job.account_id,
    status: job.status,
    progress: job.progress,
    license: job.license,
    duration_sec: job.duration_sec,
    credits_reserved: job.reserved_credits,
    credits_charged: job.charged_credits,
    provider: job.provider,
    model: job.model,
    output_format: job.output_format,
    completed_at: job.completed_at,
    ...extra,
  };
}
