// Phase 7 features: signup bonus grants, credit audit trail, live progress
// events and the consolidated monitoring endpoint. Runs with the real signup
// bonus enabled (vitest.config pins it to 0 for the billing-mechanics suites).
process.env.SIGNUP_BONUS_CREDITS = "10000";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";
import { MockMusicProvider } from "../src/providers/mock.js";
import { processOnce, type EngineOptions } from "../src/worker/engine.js";
import { InMemoryStore } from "../src/storage/store.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 30000;

const uniqEmail = () => `phase7_${Date.now()}_${emailSeq++}@example.com`;
const VALID_BODY = { prompt: "a phase seven test melody", duration_sec: 60, license: "sync", instrumental: true };

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

async function newAccount() {
  const email = uniqEmail();
  const password = "correct-horse-12";
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password } });
  expect(signup.statusCode).toBe(201);
  const token = (signup.json() as { verification_token: string }).verification_token;
  await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  return {
    cookie: sessionCookieFrom(login),
    accountId: (signup.json() as { account: { id: string } }).account.id,
  };
}

async function liveKey(cookie: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/keys",
    headers: { cookie },
    payload: { scopes: ["generations:write", "generations:read"], mode: "live" },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { secret: string }).secret;
}

async function createJob(secret: string, key: string, body: Record<string, unknown> = VALID_BODY): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/generations",
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": key },
    payload: body,
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { id: string }).id;
}

function engineFor(live: MockMusicProvider): EngineOptions {
  return {
    store: new InMemoryStore(),
    testProvider: new MockMusicProvider({ latencyMs: 0, failRate: 0 }),
    liveProvider: live,
    leaseSec: 30,
    maxAttempts: 3,
    providerTimeoutMs: 5000,
  };
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

describe("signup bonus grant", () => {
  it("new accounts start on starter with 10,000 granted credits visible in usage + dashboard", async () => {
    const { cookie } = await newAccount();
    const secret = await liveKey(cookie);

    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${secret}` } });
    expect(usage.json()).toMatchObject({
      plan_id: "starter",
      allowance_credits: 200,
      granted_credits: 10000,
      used_credits: 0,
      remaining_credits: 10200,
    });

    const dash = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    expect(dash.body).toContain("Bonus granted:");
    expect(dash.body).toContain("10200");
  });

  it("credits are deducted as songs are generated and the grant is spendable above the plan allowance", async () => {
    const { cookie } = await newAccount();
    const secret = await liveKey(cookie);
    await createJob(secret, "p7-billing");

    // Reserved at creation → held as pending, remaining already reduced.
    const before = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${secret}` } });
    expect(before.json()).toMatchObject({ pending_credits: 6, used_credits: 0, remaining_credits: 10194 });

    await processOnce(db.pool, engineFor(new MockMusicProvider({ latencyMs: 0, failRate: 0 })));

    const after = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${secret}` } });
    expect(after.json()).toMatchObject({ pending_credits: 0, used_credits: 6, remaining_credits: 10194 });
  });
});

describe("credit audit trail", () => {
  it("records granted, reserved and charged with the originating key", async () => {
    const { cookie } = await newAccount();
    const secret = await liveKey(cookie);
    const jobId = await createJob(secret, "p7-audit");
    await processOnce(db.pool, engineFor(new MockMusicProvider({ latencyMs: 0, failRate: 0 })));

    const audit = await app.inject({ method: "GET", url: "/audit-log", headers: { cookie } });
    const entries = (audit.json() as { entries: { action: string; key_id: string | null; metadata: Record<string, unknown> | null }[] }).entries;
    const byAction = Object.fromEntries(entries.map((e) => [e.action, e]));

    expect(byAction["credit.granted"]?.metadata).toMatchObject({ amount: 10000, reason: "signup_bonus" });
    expect(byAction["credit.reserved"]?.metadata).toMatchObject({ amount: 6, generation_id: jobId, license: "sync" });
    expect(byAction["credit.reserved"]?.key_id).not.toBeNull();
    expect(byAction["credit.charged"]?.metadata).toMatchObject({ amount: 6, generation_id: jobId });
    expect(byAction["credit.charged"]?.key_id).not.toBeNull();
  });

  it("records credit.released when a queued job is canceled", async () => {
    const { cookie } = await newAccount();
    const secret = await liveKey(cookie);
    const jobId = await createJob(secret, "p7-cancel");
    await app.inject({ method: "POST", url: `/v1/generations/${jobId}/cancel`, headers: { authorization: `Bearer ${secret}` } });

    const audit = await app.inject({ method: "GET", url: "/audit-log", headers: { cookie } });
    const released = (audit.json() as { entries: { action: string; metadata: Record<string, unknown> | null }[] }).entries.find(
      (e) => e.action === "credit.released",
    );
    expect(released?.metadata).toMatchObject({ amount: 6, reason: "cancel" });
  });
});

describe("per-key tracking", () => {
  it("/keys/stats and /v1/monitoring attribute songs, time and credits per key", async () => {
    const { cookie, accountId } = await newAccount();
    const keyA = await liveKey(cookie);
    const keyB = await liveKey(cookie);

    const jobA = await createJob(keyA, "p7-keyA");
    await createJob(keyB, "p7-keyB1");
    await createJob(keyB, "p7-keyB2");
    const eng = engineFor(new MockMusicProvider({ latencyMs: 20, failRate: 0 }));
    for (let i = 0; i < 3; i++) await processOnce(db.pool, eng);

    const stats = await app.inject({ method: "GET", url: "/keys/stats", headers: { cookie } });
    expect(stats.statusCode).toBe(200);
    const perKey = (stats.json() as { per_key: { key_id: string; songs: { total: number; succeeded: number }; credits_used: number; generation_time: { avg_seconds: number; total_seconds: number } }[] }).per_key;
    const a = perKey.find((k) => k.key_id && k.credits_used === 6);
    const b = perKey.find((k) => k.key_id && k.credits_used === 12);
    expect(a?.songs).toMatchObject({ total: 1, succeeded: 1 });
    expect(b?.songs).toMatchObject({ total: 2, succeeded: 2 });
    expect(a!.generation_time.avg_seconds).toBeGreaterThan(0);
    expect(b!.generation_time.total_seconds).toBeGreaterThan(0);

    const mon = await app.inject({ method: "GET", url: "/v1/monitoring", headers: { authorization: `Bearer ${keyA}` } });
    expect(mon.statusCode).toBe(200);
    const report = mon.json() as {
      account: { id: string; plan_id: string };
      credits: { used_credits: number; granted_credits: number };
      jobs_by_status: Record<string, number>;
      active_jobs: number;
      per_key: unknown[];
      recent_generations: { id: string; generation_seconds: number | null }[];
      daily_usage_last_30_days: unknown[];
      audit: unknown[];
      webhooks: { endpoints: unknown[]; deliveries_last_24h: Record<string, number> };
    };
    expect(report.account).toMatchObject({ id: accountId, plan_id: "starter" });
    expect(report.credits).toMatchObject({ used_credits: 18, granted_credits: 10000 });
    expect(report.jobs_by_status.succeeded).toBe(3);
    expect(report.active_jobs).toBe(0);
    expect(report.per_key).toHaveLength(2);
    expect(report.recent_generations).toHaveLength(3);
    const jobEntry = report.recent_generations.find((j) => j.id === jobA);
    expect(jobEntry?.generation_seconds).toBeGreaterThan(0);
    expect(report.daily_usage_last_30_days).toHaveLength(1);
    expect(report.audit.length).toBeGreaterThan(0);
    expect(report.webhooks.endpoints).toEqual([]);
    expect(report.webhooks.deliveries_last_24h).toMatchObject({ delivered: 0, failed: 0, dead: 0, pending: 0 });
  });

  it("/v1/monitoring requires an authenticated key", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/monitoring" });
    expect(res.statusCode).toBe(401);
  });
});

describe("live progress", () => {
  it("emits created + progress + succeeded events for a long render and exposes progress", async () => {
    const { cookie, accountId } = await newAccount();
    const secret = await liveKey(cookie);
    const jobId = await createJob(secret, "p7-progress");

    // A realistic (>=1s) mock render reports 25/50/75% mid-flight.
    await processOnce(db.pool, engineFor(new MockMusicProvider({ latencyMs: 1200, failRate: 0 })));
    // Progress ticks are fire-and-forget; give the writes a moment to land.
    for (let i = 0; i < 20; i++) {
      const n = await db.pool.query(
        `SELECT COUNT(*)::int AS n FROM outbox_events WHERE payload->>'generation_id'=$1 AND type='generation.progress'`,
        [jobId],
      );
      if (n.rows[0].n >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const events = await db.pool.query(
      `SELECT type, payload->>'progress' AS progress FROM outbox_events
       WHERE account_id=$1 ORDER BY created_at, id`,
      [accountId],
    );
    const types = (events.rows as { type: string }[]).map((r) => r.type);
    expect(types.filter((t) => t === "generation.created")).toHaveLength(1);
    expect(types.filter((t) => t === "generation.progress").length).toBeGreaterThanOrEqual(3);
    expect(types.filter((t) => t === "generation.succeeded")).toHaveLength(1);

    const progressValues = (events.rows as { type: string; progress: string | null }[])
      .filter((r) => r.type === "generation.progress")
      .map((r) => Number(r.progress));
    expect(progressValues).toEqual([25, 50, 75]);

    const got = await app.inject({ method: "GET", url: `/v1/generations/${jobId}`, headers: { authorization: `Bearer ${secret}` } });
    expect(got.json()).toMatchObject({ status: "succeeded", progress: 100 });
  });

  it("emits exactly one generation.created and none on idempotent replay", async () => {
    const { cookie, accountId } = await newAccount();
    const secret = await liveKey(cookie);
    await createJob(secret, "p7-created");
    const replay = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "p7-created" },
      payload: VALID_BODY,
    });
    expect(replay.statusCode).toBe(200);
    const created = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM outbox_events WHERE account_id=$1 AND type='generation.created'`,
      [accountId],
    );
    expect(created.rows[0].n).toBe(1);
  });
});
