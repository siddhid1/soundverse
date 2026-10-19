import type { Pool } from "pg";
import { getPool } from "../db/index.js";
import { generateApiSecret, newId, sha256Hex } from "../lib/crypto.js";
import { appendAudit } from "./audit.js";

export const ALL_SCOPES = ["generations:write", "generations:read"] as const;
export type Scope = (typeof ALL_SCOPES)[number];
export type KeyMode = "test" | "live";

export interface ApiKeyRecord {
  id: string;
  account_id: string;
  prefix: string;
  name: string | null;
  scopes: Scope[];
  mode: KeyMode;
  created_by_user_id: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  rotated_from_key_id: string | null;
}

export interface CreateKeyResult {
  key: ApiKeyRecord;
  /** Full secret — returned exactly once. Never persisted, never logged. */
  secret: string;
}

function validateScopes(scopes: unknown): Scope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw coded("invalid_scope", "At least one scope is required.");
  }
  for (const s of scopes) {
    if (!(ALL_SCOPES as readonly string[]).includes(s as string)) {
      throw coded("invalid_scope", `Unknown scope: ${String(s)}.`);
    }
  }
  return [...new Set(scopes)] as Scope[];
}

function coded(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function rowToRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    prefix: row.prefix as string,
    name: (row.name as string | null) ?? null,
    scopes: row.scopes as Scope[],
    mode: row.mode as KeyMode,
    created_by_user_id: (row.created_by_user_id as string | null) ?? null,
    created_at: row.created_at as string,
    revoked_at: (row.revoked_at as string | null) ?? null,
    last_used_at: (row.last_used_at as string | null) ?? null,
    rotated_from_key_id: (row.rotated_from_key_id as string | null) ?? null,
  };
}

const SELECT_COLS = `id, account_id, prefix, name, scopes, mode, created_by_user_id, created_at, revoked_at, last_used_at, rotated_from_key_id`;

export async function createApiKey(
  pool: Pool = getPool(),
  input: {
    accountId: string;
    createdByUserId: string;
    name?: string | undefined;
    scopes: unknown;
    mode: unknown;
  },
): Promise<CreateKeyResult> {
  const scopes = validateScopes(input.scopes);
  if (input.mode !== "test" && input.mode !== "live") {
    throw coded("invalid_mode", `Mode must be "test" or "live".`);
  }
  if (input.mode === "live") {
    // Defense-in-depth: login already requires verification, but live keys are
    // billable so re-check explicitly — an unverified account must never mint
    // a key that can spend the signup bonus on the real provider.
    const owner = await pool.query(
      `SELECT u.email_verified_at FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id=$1`,
      [input.accountId],
    );
    if ((owner.rowCount ?? 0) === 0 || !(owner.rows[0] as { email_verified_at: string | null }).email_verified_at) {
      throw coded("email_not_verified", "Verify your email before creating a live key.");
    }
  }
  const { secret, prefix } = generateApiSecret(input.mode);
  const id = newId();
  const res = await pool.query(
    `INSERT INTO api_keys(id, account_id, key_hash, prefix, name, scopes, mode, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT_COLS}`,
    [id, input.accountId, sha256Hex(secret), prefix, input.name?.slice(0, 80) ?? null, JSON.stringify(scopes), input.mode, input.createdByUserId],
  );
  const key = rowToRecord(res.rows[0] as Record<string, unknown>);
  await appendAudit(pool, {
    actorUserId: input.createdByUserId,
    accountId: input.accountId,
    action: "key.created",
    keyId: id,
    metadata: { prefix, mode: input.mode, scopes },
  });
  return { key, secret };
}

export async function listApiKeys(pool: Pool = getPool(), accountId: string): Promise<ApiKeyRecord[]> {
  const res = await pool.query(`SELECT ${SELECT_COLS} FROM api_keys WHERE account_id=$1 ORDER BY created_at DESC`, [
    accountId,
  ]);
  return (res.rows as Record<string, unknown>[]).map(rowToRecord);
}

export async function getApiKey(
  pool: Pool = getPool(),
  accountId: string,
  keyId: string,
): Promise<ApiKeyRecord | null> {
  const res = await pool.query(`SELECT ${SELECT_COLS} FROM api_keys WHERE id=$1 AND account_id=$2`, [
    keyId,
    accountId,
  ]);
  if ((res.rowCount ?? 0) === 0) return null;
  return rowToRecord(res.rows[0] as Record<string, unknown>);
}

/** Revoke is idempotent (safe to retry); revoked keys fail auth immediately. */
export async function revokeApiKey(
  pool: Pool = getPool(),
  input: { accountId: string; keyId: string; actorUserId: string },
): Promise<ApiKeyRecord> {
  const res = await pool.query(
    `UPDATE api_keys SET revoked_at = coalesce(revoked_at, now())
     WHERE id=$1 AND account_id=$2
     RETURNING ${SELECT_COLS}`,
    [input.keyId, input.accountId],
  );
  if ((res.rowCount ?? 0) === 0) throw coded("key_not_found", "API key not found.");
  const key = rowToRecord(res.rows[0] as Record<string, unknown>);
  await appendAudit(pool, {
    actorUserId: input.actorUserId,
    accountId: input.accountId,
    action: "key.revoked",
    keyId: key.id,
    metadata: { prefix: key.prefix },
  });
  return key;
}

/**
 * Rotation creates a fully working replacement BEFORE the old key is touched.
 * The old key stays valid until explicitly revoked — no forced overlap expiry,
 * so integrations can swap without failed requests. The linkage is audited.
 */
export async function rotateApiKey(
  pool: Pool = getPool(),
  input: { accountId: string; keyId: string; actorUserId: string; name?: string | undefined },
): Promise<CreateKeyResult> {
  const oldKey = await getApiKey(pool, input.accountId, input.keyId);
  if (!oldKey) throw coded("key_not_found", "API key not found.");
  if (oldKey.revoked_at) throw coded("key_revoked", "Cannot rotate a revoked key.");
  const created = await createApiKey(pool, {
    accountId: input.accountId,
    createdByUserId: input.actorUserId,
    name: input.name ?? oldKey.name ?? undefined,
    scopes: oldKey.scopes,
    mode: oldKey.mode,
  });
  await pool.query(`UPDATE api_keys SET rotated_from_key_id=$1 WHERE id=$2`, [oldKey.id, created.key.id]);
  created.key.rotated_from_key_id = oldKey.id;
  await appendAudit(pool, {
    actorUserId: input.actorUserId,
    accountId: input.accountId,
    action: "key.rotated",
    keyId: created.key.id,
    metadata: { from_prefix: oldKey.prefix, to_prefix: created.key.prefix },
  });
  return created;
}

export interface AuthContext {
  key: ApiKeyRecord;
  accountId: string;
  planId: string;
}

/**
 * Authenticate a raw Bearer secret. No cache: a revoked key fails on its very
 * next request because every check hits the database. last_used_at is updated
 * best-effort (fire-and-forget) so the auth path never blocks on bookkeeping.
 */
export async function authenticateApiKey(
  pool: Pool = getPool(),
  rawSecret: string,
): Promise<AuthContext | null> {
  const res = await pool.query(
    `SELECT k.${SELECT_COLS.replaceAll(", ", ", k.")}, a.plan_id
     FROM api_keys k JOIN accounts a ON a.id = k.account_id
     WHERE k.key_hash=$1 AND k.revoked_at IS NULL`,
    [sha256Hex(rawSecret)],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0] as Record<string, unknown> & { plan_id: string };
  const key = rowToRecord(row);
  // Best-effort bookkeeping: must never fail or delay authentication.
  void pool
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id=$1`, [key.id])
    .catch(() => {});
  return { key, accountId: key.account_id, planId: row.plan_id };
}

export function requireScope(ctx: AuthContext, scope: Scope): void {
  if (!ctx.key.scopes.includes(scope)) {
    throw coded("insufficient_scope", `This key is missing the "${scope}" scope.`);
  }
}
