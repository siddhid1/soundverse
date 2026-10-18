import type { Pool } from "pg";
import { newId } from "../lib/crypto.js";

export type AuditAction =
  | "key.created"
  | "key.revoked"
  | "key.rotated"
  | "user.signup"
  | "user.verified";

/** Append-only audit event. Never include secrets, hashes, or tokens. */
export async function appendAudit(
  pool: Pool,
  event: {
    actorUserId?: string | null;
    accountId: string;
    action: AuditAction;
    keyId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
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

export async function listAudit(pool: Pool, accountId: string, limit = 100): Promise<AuditEntry[]> {
  const res = await pool.query(
    `SELECT id, actor_user_id, account_id, action, key_id, created_at, metadata
     FROM audit_logs WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [accountId, limit],
  );
  return res.rows as AuditEntry[];
}
