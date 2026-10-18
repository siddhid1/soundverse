import type { Pool } from "pg";
import { getPool } from "../db/index.js";
import { generateOpaqueToken, newId, sha256Hex } from "../lib/crypto.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { appendAudit } from "./audit.js";

export const SESSION_COOKIE = "sv_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export interface PublicUser {
  id: string;
  email: string;
  email_verified_at: string | null;
  created_at: string;
}

export interface SignupResult {
  user: PublicUser;
  account: { id: string; plan_id: string };
  verification: { expires_at: string };
  /** Raw token echoed ONLY in test env so automated tests can verify without email. */
  verificationTokenRaw?: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function signup(
  pool: Pool = getPool(),
  input: { email: string; password: string },
  opts: { exposeRawToken?: boolean } = {},
): Promise<SignupResult> {
  const email = normalizeEmail(input.email);
  const userId = newId();
  const accountId = newId();
  const passwordHash = await hashPassword(input.password);
  const rawToken = generateOpaqueToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email]);
    if ((existing.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      const err = new Error("Email already registered.") as Error & { code: string };
      err.code = "email_taken";
      throw err;
    }
    const userRes = await client.query(
      `INSERT INTO users(id, email, password_hash) VALUES ($1,$2,$3)
       RETURNING id, email, email_verified_at, created_at`,
      [userId, email, passwordHash],
    );
    await client.query(`INSERT INTO accounts(id, owner_user_id, plan_id) VALUES ($1,$2,'sandbox')`, [
      accountId,
      userId,
    ]);
    const tokenRes = await client.query(
      `INSERT INTO email_verification_tokens(id, user_id, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + make_interval(secs => $4))
       RETURNING expires_at`,
      [newId(), userId, sha256Hex(rawToken), VERIFY_TTL_MS / 1000],
    );
    await client.query(
      `INSERT INTO audit_logs(id, actor_user_id, account_id, action, metadata)
       VALUES ($1,$2,$3,'user.signup',$4)`,
      [newId(), userId, accountId, JSON.stringify({ email })],
    );
    await client.query("COMMIT");
    const user = userRes.rows[0] as PublicUser;
    const expiresAt = (tokenRes.rows[0] as { expires_at: string }).expires_at;
    // Verification link is logged, never stored raw. Operators copy it from server logs.
    console.log(
      `[auth] verify email for ${email}: /auth/verify?token=${rawToken} (expires ${expiresAt})`,
    );
    return {
      user,
      account: { id: accountId, plan_id: "sandbox" },
      verification: { expires_at: expiresAt },
      ...(opts.exposeRawToken || process.env.NODE_ENV === "test" ? { verificationTokenRaw: rawToken } : {}),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Consume a verification token exactly once (conditional UPDATE wins races). */
export async function verifyEmail(
  pool: Pool = getPool(),
  rawToken: string,
): Promise<{ user_id: string }> {
  const res = await pool.query(
    `UPDATE email_verification_tokens
     SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sha256Hex(rawToken)],
  );
  if ((res.rowCount ?? 0) === 0) {
    const err = new Error("Verification token is invalid or expired.") as Error & { code: string };
    err.code = "invalid_or_expired_token";
    throw err;
  }
  const userId = (res.rows[0] as { user_id: string }).user_id;
  const userRes = await pool.query(
    `UPDATE users SET email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
     WHERE id=$1 RETURNING id`,
    [userId],
  );
  if ((userRes.rowCount ?? 0) === 0) {
    const err = new Error("Verification token is invalid or expired.") as Error & { code: string };
    err.code = "invalid_or_expired_token";
    throw err;
  }
  const acct = await pool.query(`SELECT id FROM accounts WHERE owner_user_id=$1`, [userId]);
  if ((acct.rowCount ?? 0) > 0) {
    await appendAudit(pool, {
      actorUserId: userId,
      accountId: (acct.rows[0] as { id: string }).id,
      action: "user.verified",
    }).catch(() => {});
  }
  return { user_id: userId };
}

export interface LoginResult {
  user: PublicUser;
  sessionToken: string;
  expiresAt: Date;
}

export async function login(
  pool: Pool = getPool(),
  input: { email: string; password: string },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const res = await pool.query(`SELECT id, email, password_hash, email_verified_at, created_at FROM users WHERE lower(email)=lower($1)`, [
    email,
  ]);
  const fail = () => {
    const err = new Error("Invalid email or password.") as Error & { code: string };
    err.code = "invalid_credentials";
    throw err;
  };
  if ((res.rowCount ?? 0) === 0) fail();
  const row = res.rows[0] as {
    id: string;
    email: string;
    password_hash: string;
    email_verified_at: string | null;
    created_at: string;
  };
  if (!(await verifyPassword(row.password_hash, input.password))) fail();
  if (!row.email_verified_at) {
    const err = new Error("Email address is not verified.") as Error & { code: string };
    err.code = "email_not_verified";
    throw err;
  }
  const raw = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions(id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [newId(), row.id, sha256Hex(raw), expiresAt.toISOString()],
  );
  return {
    user: { id: row.id, email: row.email, email_verified_at: row.email_verified_at, created_at: row.created_at },
    sessionToken: raw,
    expiresAt,
  };
}

export async function logout(pool: Pool = getPool(), rawToken: string): Promise<void> {
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash=$1 AND revoked_at IS NULL`, [
    sha256Hex(rawToken),
  ]);
}

/** Resolve a session cookie to its user+account. Null when missing/expired/revoked. */
export async function resolveSession(
  pool: Pool = getPool(),
  rawToken: string | undefined,
): Promise<{ user: PublicUser; account: { id: string; plan_id: string } } | null> {
  if (!rawToken) return null;
  const res = await pool.query(
    `SELECT u.id, u.email, u.email_verified_at, u.created_at, a.id AS account_id, a.plan_id
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN accounts a ON a.owner_user_id = u.id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(rawToken)],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0] as {
    id: string;
    email: string;
    email_verified_at: string | null;
    created_at: string;
    account_id: string;
    plan_id: string;
  };
  return {
    user: { id: row.id, email: row.email, email_verified_at: row.email_verified_at, created_at: row.created_at },
    account: { id: row.account_id, plan_id: row.plan_id },
  };
}
