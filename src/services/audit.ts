import { newId } from "../lib/crypto.js";
import type { Queryable } from "./generations.js";

export type AuditAction =
  | "key.created"
  | "key.revoked"
  | "key.rotated"
  | "user.signup"
  | "user.verified"
  | "credit.granted"
  | "credit.reserved"
  | "credit.charged"
  | "credit.released";

/** Append-only audit event. Never include secrets, hashes, or tokens.
 *  Accepts a Pool or a transaction Client so credit events can be written
 *  atomically with the ledger change they describe. */
export async function appendAudit(
  q: Queryable,
  event: {
    actorUserId?: string | null;
    accountId: string;
    action: AuditAction;
    keyId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs(id, actor_user_id, account_id, action, key_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      newId(),
      event.actorUserId ?? null,
      event.accountId,
      event.action,
      event.keyId ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
    ],
  );
}

export interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  account_id: string;
  action: string;
  key_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export async function listAudit(q: Queryable, accountId: string, limit = 100): Promise<AuditEntry[]> {
  const res = await q.query(
    `SELECT id, actor_user_id, account_id, action, key_id, created_at, metadata
     FROM audit_logs WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [accountId, limit],
  );
  return res.rows as AuditEntry[];
}
