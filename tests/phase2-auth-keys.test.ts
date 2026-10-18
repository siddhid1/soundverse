import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/crypto.js";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 0;

const uniqEmail = () => `phase2_${Date.now()}_${emailSeq++}@example.com`;

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

async function signupAndLogin(password = "correct-horse-12") {
  const email = uniqEmail();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password },
  });
  expect(signup.statusCode).toBe(201);
  const body = signup.json() as { verification_token?: string; account: { id: string } };
  expect(typeof body.verification_token).toBe("string");

  // Login must be rejected before email verification.
  const early = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(early.statusCode).toBe(403);
  expect(early.json().error.code).toBe("email_not_verified");

  const verify = await app.inject({ method: "GET", url: `/auth/verify?token=${body.verification_token}` });
  expect(verify.statusCode).toBe(200);

  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(login.statusCode).toBe(200);
  return { email, password, cookie: sessionCookieFrom(login), accountId: body.account.id };
}

beforeAll(async () => {
  db = await startTestDb();
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
}, 120_000);

afterAll(async () => {
  await app?.close();
  const { closePool } = await import("../src/db/index.js");
  await closePool();
  await db?.stop();
});

beforeEach(async () => {
  await clearDb(db.pool);
});

describe("accounts", () => {
  it("signup creates user + starter account; duplicate email is 409", async () => {
    const email = uniqEmail();
    const res = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password: "correct-horse-12" } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { account: { plan_id: string } };
    expect(body.account.plan_id).toBe("starter");

    const dup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password: "correct-horse-12" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("email_taken");
  });

  it("verification token is single-use and expiry is enforced", async () => {
    const email = uniqEmail();
    const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password: "correct-horse-12" } });
    const token = (signup.json() as { verification_token: string }).verification_token;

    const first = await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ verified: true });

    // Same token reused → rejected, never creates a second verification.
    const second = await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe("invalid_or_expired_token");

    // Expired token → rejected.
    const userRow = await db.pool.query(`SELECT id FROM users WHERE email=$1`, [email]);
    const expiredRaw = `expired_${Date.now()}`;
    await db.pool.query(
      `INSERT INTO email_verification_tokens(id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() - interval '1 hour')`,
      [userRow.rows[0].id, sha256Hex(expiredRaw)],
    );
    const expired = await app.inject({ method: "GET", url: `/auth/verify?token=${expiredRaw}` });
    expect(expired.statusCode).toBe(400);
  });

  it("login/logout/me session lifecycle", async () => {
    const { cookie } = await signupAndLogin();
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().account.plan_id).toBe("starter");

    // Wrong password does not reveal whether the email exists.
    const bad = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "nobody@example.com", password: "wrong-password-1" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("invalid_credentials");

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const meAfter = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(meAfter.statusCode).toBe(401);
  });
});

describe("api keys", () => {
  it("secret is shown once; database stores only its hash; listing never leaks", async () => {
    const { cookie } = await signupAndLogin();
    const created = await app.inject({
      method: "POST",
      url: "/keys",
      headers: { cookie },
      payload: { name: "ci", scopes: ["generations:write", "generations:read"], mode: "live" },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json() as { id: string; secret: string; prefix: string };
    expect(key.secret.startsWith("sv_live_")).toBe(true);

    // DB row: hash matches, no secret column anywhere.
    const rows = await db.pool.query(`SELECT * FROM api_keys WHERE id=$1`, [key.id]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].key_hash).toBe(sha256Hex(key.secret));
    expect("secret" in rows.rows[0]).toBe(false);

    const list = await app.inject({ method: "GET", url: "/keys", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const keys = (list.json() as { keys: Record<string, unknown>[] }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.prefix).toBe(key.prefix);
    expect("secret" in keys[0]!).toBe(false);
    expect("key_hash" in keys[0]!).toBe(false);
  });

  it("revoked key fails on its very next request (no auth cache)", async () => {
    const { cookie } = await signupAndLogin();
    const created = await app.inject({
      method: "POST",
      url: "/keys",
      headers: { cookie },
      payload: { scopes: ["generations:read"], mode: "live" },
    });
    const secret = (created.json() as { secret: string }).secret;

    const before = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: `Bearer ${secret}` } });
    expect(before.statusCode).toBe(200);

    const keyId = (created.json() as { id: string }).id;
    const revoke = await app.inject({ method: "POST", url: `/keys/${keyId}/revoke`, headers: { cookie } });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: `Bearer ${secret}` } });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("invalid_key");
  });

  it("rotation yields a working replacement while the old key keeps working", async () => {
    const { cookie } = await signupAndLogin();
    const created = await app.inject({
      method: "POST",
      url: "/keys",
      headers: { cookie },
      payload: { scopes: ["generations:read"], mode: "live" },
    });
    const oldSecret = (created.json() as { secret: string; id: string }).secret;
    const oldId = (created.json() as { id: string }).id;

    const rotated = await app.inject({
      method: "POST",
      url: `/keys/${oldId}/rotate`,
      headers: { cookie },
      payload: {},
    });
    expect(rotated.statusCode).toBe(201);
    const fresh = rotated.json() as { secret: string; id: string; rotated_from_key_id: string };
    expect(fresh.secret).not.toBe(oldSecret);
    expect(fresh.rotated_from_key_id).toBe(oldId);

    // Zero-downtime: both work until the old one is explicitly revoked.
    for (const s of [oldSecret, fresh.secret]) {
      const ping = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: `Bearer ${s}` } });
      expect(ping.statusCode).toBe(200);
    }

    const audit = await app.inject({ method: "GET", url: "/audit-log", headers: { cookie } });
    const actions = (audit.json() as { entries: { action: string; metadata: unknown }[] }).entries.map((e) => e.action);
    expect(actions).toContain("key.created");
    expect(actions).toContain("key.rotated");
    const serialized = JSON.stringify(audit.json());
    expect(serialized).not.toContain(oldSecret);
    expect(serialized).not.toContain(fresh.secret);
  });

  it("scope enforcement and auth failure modes use the canonical error shape", async () => {
    const { cookie } = await signupAndLogin();
    const writeOnly = await app.inject({
      method: "POST",
      url: "/keys",
      headers: { cookie },
      payload: { scopes: ["generations:write"], mode: "test" },
    });
    const secret = (writeOnly.json() as { secret: string }).secret;

    const forbidden = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: `Bearer ${secret}` } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toMatchObject({ type: "authorization_error", code: "insufficient_scope" });

    const missing = await app.inject({ method: "GET", url: "/v1/ping" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("missing_auth");

    const bogus = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: "Bearer sv_live_bogus" } });
    expect(bogus.statusCode).toBe(401);
    expect(bogus.json().error.code).toBe("invalid_key");
  });

  it("cross-account keys are invisible (404, no existence leak)", async () => {
    const a = await signupAndLogin();
    const b = await signupAndLogin();
    const created = await app.inject({
      method: "POST",
      url: "/keys",
      headers: { cookie: a.cookie },
      payload: { scopes: ["generations:read"], mode: "live" },
    });
    const keyId = (created.json() as { id: string }).id;

    const cross = await app.inject({ method: "GET", url: `/keys/${keyId}`, headers: { cookie: b.cookie } });
    expect(cross.statusCode).toBe(404);
    const crossRevoke = await app.inject({ method: "POST", url: `/keys/${keyId}/revoke`, headers: { cookie: b.cookie } });
    expect(crossRevoke.statusCode).toBe(404);
  });

  it("last_used_at is recorded after a successful request", async () => {
    const { cookie } = await signupAndLogin();
    const created = await app.inject({
      method: "POST",
      url: "/keys",
      headers: { cookie },
      payload: { scopes: ["generations:read"], mode: "test" },
    });
    const { id, secret } = created.json() as { id: string; secret: string };
    await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: `Bearer ${secret}` } });
    let seen: string | null = null;
    for (let i = 0; i < 50 && !seen; i++) {
      const row = await db.pool.query(`SELECT last_used_at FROM api_keys WHERE id=$1`, [id]);
      seen = (row.rows[0] as { last_used_at: string | null }).last_used_at;
      if (!seen) await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).not.toBeNull();
  });
});
