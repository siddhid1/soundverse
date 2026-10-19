import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../src/config/env.js";
import { resetPlatformRate } from "../src/routes/platform.js";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 0;

const uniqEmail = () => `phase8_${Date.now()}_${emailSeq++}@example.com`;

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

async function signupLoginKey(mode: "test" | "live") {
  const email = uniqEmail();
  const password = "correct-horse-12";
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password } });
  expect(signup.statusCode).toBe(201);
  const token = (signup.json() as { verification_token: string }).verification_token;
  const verify = await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
  expect(verify.statusCode).toBe(200);
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(login.statusCode).toBe(200);
  const cookie = sessionCookieFrom(login);
  const created = await app.inject({
    method: "POST",
    url: "/keys",
    headers: { cookie },
    payload: { scopes: ["generations:write", "generations:read"], mode },
  });
  expect(created.statusCode).toBe(201);
  return { email, cookie, secret: (created.json() as { secret: string }).secret };
}

function allKeysDeep(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) allKeysDeep(v, acc);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(k);
      allKeysDeep(v, acc);
    }
  }
  return acc;
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
  resetPlatformRate();
});

describe("platform stats (public, aggregate-only)", () => {
  it("responds 200 with no auth and an exact, PII-free shape", async () => {
    await signupLoginKey("test");
    const res = await app.inject({ method: "GET", url: "/v1/platform/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["accounts", "credits", "generated_at", "jobs", "keys", "period_start", "usage_30d", "webhooks"].sort(),
    );
    const forbidden = new Set([
      "email", "password_hash", "password", "key_hash", "secret", "signing_secret",
      "secret_enc", "token", "prompt", "metadata", "user_id", "account_id",
      "key_id", "generation_id", "prefix", "object_key",
    ]);
    const leaked = allKeysDeep(body).filter((k) => forbidden.has(k));
    expect(leaked).toEqual([]);
    // No PII values either (the only account email must not appear anywhere).
    expect(JSON.stringify(body)).not.toMatch(/phase8_.*@example\.com/);
  });

  it("aggregates two accounts exactly (by_plan, jobs, ledger, license, keys)", async () => {
    const a = await signupLoginKey("live");
    const gen = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${a.secret}`, "idempotency-key": "phase8-a1" },
      payload: { prompt: "platform math", duration_sec: 30, license: "royalty_free", instrumental: true },
    });
    expect(gen.statusCode).toBe(202);
    expect((gen.json() as { credits_reserved: number }).credits_reserved).toBe(1);

    // Second account, promoted to growth so by_plan has two buckets.
    const b = await signupLoginKey("test");
    const acctB = (await db.pool.query(`SELECT id FROM accounts ORDER BY created_at DESC LIMIT 1`)).rows[0] as { id: string };
    void b;
    await db.pool.query(`UPDATE accounts SET plan_id='growth' WHERE id=$1`, [acctB.id]);

    const res = await app.inject({ method: "GET", url: "/v1/platform/stats" });
    expect(res.statusCode).toBe(200);
    const s = res.json() as {
      accounts: { total: number; by_plan: Record<string, number> };
      jobs: { by_status: Record<string, number>; active: number };
      credits: { allowance: number; granted: number; used: number; pending: number; overage: number; remaining: number; by_license: Record<string, { songs: number; credits: number }> };
      keys: { total: number; active: number };
      usage_30d: { day: string; songs: number; used_credits: number }[];
    };
    expect(s.accounts).toEqual({ total: 2, by_plan: { starter: 1, growth: 1 } });
    expect(s.jobs.by_status).toEqual({ queued: 1 });
    expect(s.jobs.active).toBe(1);
    // Starter 200 + growth 2000 allowance; bonus pinned to 0 in tests.
    expect(s.credits.allowance).toBe(2200);
    expect(s.credits.granted).toBe(0);
    expect(s.credits.used).toBe(0);
    expect(s.credits.pending).toBe(1);
    expect(s.credits.overage).toBe(0);
    expect(s.credits.remaining).toBe(2199);
    expect(s.credits.by_license).toEqual({ royalty_free: { songs: 1, credits: 0 } });
    expect(s.keys).toEqual({ total: 2, active: 2 });
    expect(s.usage_30d).toHaveLength(1);
    expect(s.usage_30d[0]).toMatchObject({ songs: 1, used_credits: 0 });
  });

  it("rate-limits per IP with Retry-After and leaves accounting untouched", async () => {
    for (let i = 0; i < 60; i++) {
      const r = await app.inject({ method: "GET", url: "/v1/platform/stats" });
      expect(r.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/v1/platform/stats" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("platform_rate_limit");
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("404s when PLATFORM_STATS_ENABLED=false, recovers when re-enabled", async () => {
    process.env.PLATFORM_STATS_ENABLED = "false";
    resetEnvCache();
    try {
      const off = await app.inject({ method: "GET", url: "/v1/platform/stats" });
      expect(off.statusCode).toBe(404);
    } finally {
      process.env.PLATFORM_STATS_ENABLED = "true";
      resetEnvCache();
    }
    const on = await app.inject({ method: "GET", url: "/v1/platform/stats" });
    expect(on.statusCode).toBe(200);
  });
});
