import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";
import { MockMusicProvider } from "../src/providers/mock.js";
import { ProviderError, type MusicProvider } from "../src/providers/types.js";
import { currentPeriodStart } from "../src/services/credits.js";
import { claimNextJob, processOnce, type EngineOptions } from "../src/worker/engine.js";
import { InMemoryStore } from "../src/storage/store.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 20000;

const uniqEmail = () => `phase6_${Date.now()}_${emailSeq++}@example.com`;

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

async function newAccount(plan = "starter") {
  const email = uniqEmail();
  const password = "correct-horse-12";
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password } });
  const token = (signup.json() as { verification_token: string }).verification_token;
  await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = sessionCookieFrom(login);
  const accountId = (signup.json() as { account: { id: string } }).account.id;
  await db.pool.query(`UPDATE accounts SET plan_id=$1 WHERE id=$2`, [plan, accountId]);
  return { cookie, accountId };
}

async function makeKey(cookie: string, mode: "live" | "test" = "live", scopes: string[] = ["generations:write", "generations:read"]) {
  const created = await app.inject({
    method: "POST", url: "/keys", headers: { cookie }, payload: { scopes, mode },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { secret: string; id: string }).secret;
}

function eng(live: MusicProvider): EngineOptions {
  return {
    store: new InMemoryStore(),
    testProvider: new MockMusicProvider({ latencyMs: 5, failRate: 0 }),
    liveProvider: live,
    leaseSec: 30, maxAttempts: 3, providerTimeoutMs: 5000,
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

describe("acceptance gaps", () => {
  it("daily quota is enforced account-wide across keys", async () => {
    const { cookie } = await newAccount("starter");
    await db.pool.query(`UPDATE plans SET parallel_generations=20, requests_per_day=5 WHERE id='starter'`);
    try {
      const k1 = await makeKey(cookie);
      const k2 = await makeKey(cookie);
      const bodies = [0, 1, 2].map((i) => ({ key: k1, idem: `day-a-${i}` }));
      const more = [0, 1, 2].map((i) => ({ key: k2, idem: `day-b-${i}` }));
      const results = await Promise.all(
        [...bodies, ...more].map(({ key, idem }) =>
          app.inject({
            method: "POST", url: "/v1/generations",
            headers: { authorization: `Bearer ${key}`, "idempotency-key": idem },
            payload: { prompt: "daily quota song", duration_sec: 30, license: "royalty_free" },
          }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 202)).toHaveLength(5);
      const rejected = results.filter((r) => r.statusCode === 429);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.json().error.code).toBe("daily_rate_limit");
      expect(rejected[0]!.headers["retry-after"]).toBeDefined();
    } finally {
      await db.pool.query(`UPDATE plans SET parallel_generations=3, requests_per_day=3000 WHERE id='starter'`);
    }
  });

  it("started-60s rounding applies end to end (61s sync reserves and charges 12)", async () => {
    const { cookie, accountId } = await newAccount("starter");
    const secret = await makeKey(cookie);
    const created = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "round-1" },
      payload: { prompt: "long song", duration_sec: 61, license: "sync" },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ credits_reserved: 12 });
    const jobId = (created.json() as { id: string }).id;
    expect(await processOnce(db.pool, eng(new MockMusicProvider({ latencyMs: 5, failRate: 0 })))).toMatchObject({
      outcome: "succeeded",
    });
    const row = await db.pool.query(`SELECT charged_credits FROM generations WHERE id=$1`, [jobId]);
    expect(row.rows[0].charged_credits).toBe(12);
    const sums = await db.pool.query(
      `SELECT SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 AND type='charge'`, [accountId],
    );
    expect(sums.rows[0].n).toBe(12);
  });

  it("claiming skips jobs another worker already took (conditional claim)", async () => {
    const { cookie } = await newAccount("starter");
    const secret = await makeKey(cookie);
    await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "claim-1" },
      payload: { prompt: "claim guard", duration_sec: 30, license: "royalty_free" },
    });
    const first = await claimNextJob(db.pool, 30);
    expect(first?.status).toBe("running");
    expect(await claimNextJob(db.pool, 30)).toBeNull();
  });

  it("rotation is hitless end to end: old works, both work, old revoked, new works", async () => {
    const { cookie } = await newAccount("starter");
    const created = await app.inject({
      method: "POST", url: "/keys", headers: { cookie },
      payload: { scopes: ["generations:read"], mode: "live" },
    });
    const oldSecret = (created.json() as { secret: string; id: string }).secret;
    const oldId = (created.json() as { id: string }).id;
    const ping = (s: string) =>
      app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: `Bearer ${s}` } });
    expect((await ping(oldSecret)).statusCode).toBe(200);

    const rotated = await app.inject({ method: "POST", url: `/keys/${oldId}/rotate`, headers: { cookie }, payload: {} });
    expect(rotated.statusCode).toBe(201);
    const newSecret = (rotated.json() as { secret: string }).secret;
    expect((await ping(oldSecret)).statusCode).toBe(200);
    expect((await ping(newSecret)).statusCode).toBe(200);

    await app.inject({ method: "POST", url: `/keys/${oldId}/revoke`, headers: { cookie } });
    expect((await ping(oldSecret)).statusCode).toBe(401);
    expect((await ping(newSecret)).statusCode).toBe(200);
  });

  it("test-key jobs always use the mock, even when the live provider would explode", async () => {
    const { cookie } = await newAccount("starter");
    const testSecret = await makeKey(cookie, "test");
    const liveSecret = await makeKey(cookie, "live");
    const boom: MusicProvider = {
      name: "live-boom",
      async generate() {
        throw new ProviderError("provider_error", "live provider must not be called for test keys");
      },
    };
    const testJob = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${testSecret}`, "idempotency-key": "sel-test" },
      payload: { prompt: "test routing", duration_sec: 30, license: "royalty_free" },
    });
    expect(testJob.statusCode).toBe(202);
    expect(await processOnce(db.pool, eng(boom))).toMatchObject({ claimed: true, outcome: "succeeded" });
    const liveJob = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${liveSecret}`, "idempotency-key": "sel-live" },
      payload: { prompt: "live routing", duration_sec: 30, license: "royalty_free" },
    });
    expect(liveJob.statusCode).toBe(202);
    // Bounded retries first: requeued, requeued, then failed — never delivered.
    expect(await processOnce(db.pool, eng(boom))).toMatchObject({ claimed: true, outcome: "requeued" });
    expect(await processOnce(db.pool, eng(boom))).toMatchObject({ claimed: true, outcome: "requeued" });
    expect(await processOnce(db.pool, eng(boom))).toMatchObject({ claimed: true, outcome: "failed" });
  });

  it("polling a running job every second works at the parallel limit (reads are free)", async () => {
    const { cookie } = await newAccount("starter");
    const writeSecret = await makeKey(cookie);
    const readSecret = await makeKey(cookie, "live", ["generations:read"]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST", url: "/v1/generations",
        headers: { authorization: `Bearer ${writeSecret}`, "idempotency-key": `poll-fill-${i}` },
        payload: { prompt: `fill ${i}`, duration_sec: 30, license: "royalty_free" },
      });
      expect(r.statusCode).toBe(202);
      ids.push((r.json() as { id: string }).id);
    }
    // One slot is now running (claimed by a worker); the account is at its cap.
    const claimed = await claimNextJob(db.pool, 120);
    expect(claimed?.id).toBe(ids[0]);

    for (let i = 0; i < 20; i++) {
      const poll = await app.inject({
        method: "GET", url: `/v1/generations/${ids[0]}`,
        headers: { authorization: `Bearer ${readSecret}` },
      });
      expect(poll.statusCode).toBe(200);
      expect(poll.json()).toMatchObject({ id: ids[0], status: "running" });
    }
    // ...while new billable work is still capped.
    const extra = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${writeSecret}`, "idempotency-key": "poll-extra" },
      payload: { prompt: "extra", duration_sec: 30, license: "royalty_free" },
    });
    expect(extra.statusCode).toBe(429);
    expect(extra.json().error.code).toBe("parallel_limit_reached");
  });

  it("unresolvable webhook hosts fail closed", async () => {    const { cookie } = await newAccount("starter");
    const secret = await makeKey(cookie);
    const res = await app.inject({
      method: "POST", url: "/v1/webhook_endpoints",
      headers: { authorization: `Bearer ${secret}` },
      payload: { url: "https://does-not-exist-xyz.invalid/hook" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("webhook_url_invalid");
  });

  it("every error uses one shape and echoes the request id", async () => {
    const { cookie } = await newAccount("starter");
    const secret = await makeKey(cookie);
    const cases: { status: number; type: string; code: string; res: unknown }[] = [];
    const noKey = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}` },
      payload: { prompt: "x", duration_sec: 30, license: "royalty_free" },
    });
    cases.push({ status: 400, type: "validation_error", code: "idempotency_key_required", res: noKey });
    const badKey = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: "Bearer nope" } });
    cases.push({ status: 401, type: "authentication_error", code: "invalid_key", res: badKey });
    const license = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "shape-lic" },
      payload: { prompt: "x", duration_sec: 30, license: "full_ownership" },
    });
    cases.push({ status: 403, type: "authorization_error", code: "license_not_allowed", res: license });
    const missing = await app.inject({
      method: "GET", url: "/v1/generations/gen_doesnotexist",
      headers: { authorization: `Bearer ${secret}` },
    });
    cases.push({ status: 404, type: "not_found_error", code: "generation_not_found", res: missing });
    for (const c of cases) {
      const r = c.res as { statusCode: number; json(): unknown; headers: Record<string, string | undefined> };
      expect(r.statusCode).toBe(c.status);
      const body = r.json() as { error: { type: string; code: string; message: string; request_id: string } };
      expect(body.error.type).toBe(c.type);
      expect(body.error.code).toBe(c.code);
      expect(typeof body.error.message).toBe("string");
      expect(typeof body.error.request_id).toBe("string");
      expect(r.headers["x-request-id"]).toBe(body.error.request_id);
    }
  });

  it("concurrent duplicate signups: one account, one clean 409", async () => {
    const email = uniqEmail();
    const results = await Promise.all(
      [0, 1].map(() =>
        app.inject({ method: "POST", url: "/auth/signup", payload: { email, password: "correct-horse-12" } }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe("email_taken");
    const users = await db.pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE email=$1`, [email]);
    expect(users.rows[0].n).toBe(1);
  });

  it("idempotency keys are scoped per account", async () => {
    const a = await newAccount("starter");
    const b = await newAccount("starter");
    const keyA = await makeKey(a.cookie);
    const keyB = await makeKey(b.cookie);
    const body = { prompt: "same key both tenants", duration_sec: 30, license: "royalty_free" as const };
    const ra = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${keyA}`, "idempotency-key": "shared-key" },
      payload: body,
    });
    const rb = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${keyB}`, "idempotency-key": "shared-key" },
      payload: body,
    });
    expect(ra.statusCode).toBe(202);
    expect(rb.statusCode).toBe(202);
    expect((ra.json() as { id: string }).id).not.toBe((rb.json() as { id: string }).id);
  });

  it("downgrade mid-flight finalizes honestly: overage recorded, never double-charged", async () => {
    const { cookie, accountId } = await newAccount("growth");
    await db.pool.query(
      `INSERT INTO usage_ledger(id, account_id, type, amount, period_start) VALUES
         (gen_random_uuid(), $1, 'reservation', 2000, $2),
         (gen_random_uuid(), $1, 'charge', 2000, $2)`,
      [accountId, currentPeriodStart()],
    );
    const secret = await makeKey(cookie);
    const created = await app.inject({
      method: "POST", url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "midflight-1" },
      payload: { prompt: "mid flight", duration_sec: 30, license: "royalty_free" },
    });
    expect(created.statusCode).toBe(202);
    await db.pool.query(`UPDATE accounts SET plan_id='starter' WHERE id=$1`, [accountId]);
    expect(await processOnce(db.pool, eng(new MockMusicProvider({ latencyMs: 5, failRate: 0 })))).toMatchObject({
      outcome: "succeeded",
    });
    const sums = await db.pool.query(
      `SELECT type, SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 GROUP BY type`,
      [accountId],
    );
    expect(Object.fromEntries(sums.rows.map((r) => [r.type, r.n]))).toEqual({
      reservation: 2001,
      charge: 2000,
      overage_charge: 1,
    });
  });
});
