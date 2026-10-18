import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creditsFor, currentPeriodStart } from "../src/services/credits.js";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 1000;

const uniqEmail = () => `phase3_${Date.now()}_${emailSeq++}@example.com`;
const VALID_BODY = {
  prompt: "uplifting acoustic pop for a travel vlog, warm guitars",
  duration_sec: 30,
  license: "royalty_free",
  instrumental: true,
} as const;

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

interface Ctx {
  cookie: string;
  accountId: string;
  keyByMode: (mode: "live" | "test", scopes?: string[]) => Promise<string>;
}

async function newAccount(plan = "starter"): Promise<Ctx> {
  const email = uniqEmail();
  const password = "correct-horse-12";
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password } });
  expect(signup.statusCode).toBe(201);
  const token = (signup.json() as { verification_token: string }).verification_token;
  await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = sessionCookieFrom(login);
  const accountId = (signup.json() as { account: { id: string } }).account.id;
  await db.pool.query(`UPDATE accounts SET plan_id=$1 WHERE id=$2`, [plan, accountId]);
  return {
    cookie,
    accountId,
    keyByMode: async (mode, scopes = ["generations:write", "generations:read"]) => {
      const created = await app.inject({
        method: "POST",
        url: "/keys",
        headers: { cookie },
        payload: { scopes, mode },
      });
      expect(created.statusCode).toBe(201);
      return (created.json() as { secret: string }).secret;
    },
  };
}

async function ledgerSums(accountId: string, period = currentPeriodStart()) {
  const res = await db.pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='reservation'),0)::int AS reservation,
       COALESCE(SUM(amount) FILTER (WHERE type='charge'),0)::int AS charge,
       COALESCE(SUM(amount) FILTER (WHERE type='overage_charge'),0)::int AS overage_charge,
       COALESCE(SUM(amount) FILTER (WHERE type='release'),0)::int AS release,
       COUNT(*)::int AS rows
     FROM usage_ledger WHERE account_id=$1 AND period_start=$2`,
    [accountId, period],
  );
  return res.rows[0] as { reservation: number; charge: number; overage_charge: number; release: number; rows: number };
}

async function precharge(accountId: string, amount: number, period = currentPeriodStart()) {
  // Simulate completed spend the way production creates it: every charge
  // finalizes exactly one reservation, so the pair keeps pending at zero.
  // (Inserting a bare charge would violate the ledger invariant and drive
  // pending negative — the formula is strict on purpose.)
  await db.pool.query(
    `INSERT INTO usage_ledger(id, account_id, type, amount, period_start) VALUES
       (gen_random_uuid(), $1, 'reservation', $2, $3),
       (gen_random_uuid(), $1, 'charge', $2, $3)`,
    [accountId, amount, period],
  );
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

describe("credit pricing", () => {
  it("charges license_cost * started 60s segments", () => {
    expect(creditsFor("royalty_free", 30)).toBe(1);
    expect(creditsFor("royalty_free", 60)).toBe(1);
    expect(creditsFor("royalty_free", 61)).toBe(2);
    expect(creditsFor("sync", 30)).toBe(6);
    expect(creditsFor("sync", 61)).toBe(12);
    expect(creditsFor("full_ownership", 30)).toBe(14);
    expect(creditsFor("full_ownership", 61)).toBe(28);
    expect(creditsFor("full_ownership", 120)).toBe(28);
    expect(creditsFor("full_ownership", 300)).toBe(70);
  });
});

describe("generation happy path", () => {
  it("creates a queued job with reservation, headers, and readable status", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    const res = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "happy-1" },
      payload: { ...VALID_BODY },
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers["x-ratelimit-limit-hour"]).toBe("300");
    expect(res.headers["x-ratelimit-remaining-day"]).toBeDefined();
    const job = res.json() as { id: string; status: string; credits_reserved: number };
    expect(job.id.startsWith("gen_")).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.credits_reserved).toBe(1);

    const sums = await ledgerSums(ctx.accountId);
    expect(sums).toMatchObject({ reservation: 1, charge: 0, release: 0, rows: 1 });

    const got = await app.inject({
      method: "GET",
      url: `/v1/generations/${job.id}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: job.id, status: "queued" });

    const usage = await app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({
      plan_id: "starter",
      allowance_credits: 200,
      used_credits: 0,
      pending_credits: 1,
      remaining_credits: 199,
    });
  });

  it("lists jobs with pagination and status filter", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/generations",
        headers: { authorization: `Bearer ${secret}`, "idempotency-key": `list-${i}` },
        payload: { ...VALID_BODY },
      });
      expect(r.statusCode).toBe(202);
    }
    const p1 = await app.inject({
      method: "GET",
      url: "/v1/generations?limit=2&offset=0",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(p1.json().pagination).toMatchObject({ limit: 2, offset: 0, total: 3 });
    expect((p1.json() as { data: unknown[] }).data).toHaveLength(2);
    const p2 = await app.inject({
      method: "GET",
      url: "/v1/generations?limit=2&offset=2&status=queued",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect((p2.json() as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe("rejections leave no billable trace", () => {
  it("missing Idempotency-Key is 400", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    const res = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}` },
      payload: { ...VALID_BODY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it("starter + full_ownership is 403 with no job and no ledger entry", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    const res = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "lic-1" },
      payload: { ...VALID_BODY, license: "full_ownership" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("license_not_allowed");
    const jobs = await db.pool.query(`SELECT COUNT(*)::int AS n FROM generations WHERE account_id=$1`, [ctx.accountId]);
    expect(jobs.rows[0].n).toBe(0);
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ rows: 0 });
  });

  it("sandbox live keys are rejected; test keys reserve nothing and ledger nothing", async () => {
    const ctx = await newAccount("sandbox");
    const live = await ctx.keyByMode("live");
    const denied = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${live}`, "idempotency-key": "sbx-1" },
      payload: { ...VALID_BODY },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("live_not_allowed");

    const test = await ctx.keyByMode("test");
    const ok = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${test}`, "idempotency-key": "sbx-2" },
      payload: { ...VALID_BODY },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ credits_reserved: 0 });
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ rows: 0 });
  });

  it("account B cannot read account A's job (404, no leak)", async () => {
    const a = await newAccount("starter");
    const b = await newAccount("starter");
    const secretA = await a.keyByMode("live");
    const created = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secretA}`, "idempotency-key": "iso-1" },
      payload: { ...VALID_BODY },
    });
    const jobId = (created.json() as { id: string }).id;
    const secretB = await b.keyByMode("live");
    const cross = await app.inject({
      method: "GET",
      url: `/v1/generations/${jobId}`,
      headers: { authorization: `Bearer ${secretB}` },
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error.code).toBe("generation_not_found");
  });

  it("write scope required to create, read scope required to read", async () => {
    const ctx = await newAccount("starter");
    const readOnly = await ctx.keyByMode("live", ["generations:read"]);
    const denied = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${readOnly}`, "idempotency-key": "scope-1" },
      payload: { ...VALID_BODY },
    });
    expect(denied.statusCode).toBe(403);

    const writeOnly = await ctx.keyByMode("live", ["generations:write"]);
    const deniedRead = await app.inject({
      method: "GET",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${writeOnly}` },
    });
    expect(deniedRead.statusCode).toBe(403);
  });
});

describe("concurrency invariants (real PostgreSQL)", () => {
  it("starter fires 20 at once: exactly 3 accepted, 17 parallel-limit 429s", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/v1/generations",
          headers: { authorization: `Bearer ${secret}`, "idempotency-key": `burst-${i}` },
          payload: { ...VALID_BODY },
        }),
      ),
    );
    const accepted = results.filter((r) => r.statusCode === 202);
    const rejected = results.filter((r) => r.statusCode === 429);
    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(17);
    for (const r of rejected) {
      expect(r.json().error.code).toBe("parallel_limit_reached");
      expect(r.headers["retry-after"]).toBeUndefined();
      expect(r.headers["x-ratelimit-limit-hour"]).toBe("300");
    }
    // Final DB state is the real assertion: no overshoot, no double ledger.
    const jobs = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM generations WHERE account_id=$1 AND status='queued'`,
      [ctx.accountId],
    );
    expect(jobs.rows[0].n).toBe(3);
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ reservation: 3, rows: 3 });
  });

  it("starter with 5 credits left, 10 concurrent: exactly 5 accepted", async () => {
    const ctx = await newAccount("starter");
    await precharge(ctx.accountId, 195);
    // Isolate the allowance race from the parallel cap for this test only.
    await db.pool.query(`UPDATE plans SET parallel_generations=20 WHERE id='starter'`);
    try {
      const secret = await ctx.keyByMode("live");
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/v1/generations",
            headers: { authorization: `Bearer ${secret}`, "idempotency-key": `allow-${i}` },
            payload: { ...VALID_BODY },
          }),
        ),
      );
      const accepted = results.filter((r) => r.statusCode === 202);
      const rejected = results.filter((r) => r.statusCode === 429);
      expect(accepted).toHaveLength(5);
      expect(rejected).toHaveLength(5);
      for (const r of rejected) expect(r.json().error.code).toBe("allowance_exceeded");
      // 195 completed (reservation+charge pair) + 5 new pending reservations.
      expect(await ledgerSums(ctx.accountId)).toMatchObject({ reservation: 200, charge: 195, rows: 7 });
    } finally {
      await db.pool.query(`UPDATE plans SET parallel_generations=3 WHERE id='starter'`);
    }
  });

  it("same Idempotency-Key x3 concurrently: one job, one reservation; reuse with other body is 409", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        app.inject({
          method: "POST",
          url: "/v1/generations",
          headers: { authorization: `Bearer ${secret}`, "idempotency-key": "idem-race" },
          payload: { ...VALID_BODY },
        }),
      ),
    );
    const ids = results.map((r) => (r.json() as { id: string }).id);
    expect(new Set(ids).size).toBe(1);
    // First writer gets 202; losers of the insert race replay the winner (200).
    expect(results.filter((r) => r.statusCode === 202).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.statusCode === 200 || r.statusCode === 202)).toBe(true);
    const jobs = await db.pool.query(`SELECT COUNT(*)::int AS n FROM generations WHERE account_id=$1`, [ctx.accountId]);
    expect(jobs.rows[0].n).toBe(1);
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ reservation: 1, rows: 1 });

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "idem-race" },
      payload: { ...VALID_BODY, prompt: "a completely different song" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_key_reuse");
    const jobsAfter = await db.pool.query(`SELECT COUNT(*)::int AS n FROM generations WHERE account_id=$1`, [ctx.accountId]);
    expect(jobsAfter.rows[0].n).toBe(1);
  });

  it("hourly quota is enforced account-wide across keys", async () => {
    const ctx = await newAccount("starter");
    // Parallel raised so the hourly cap is what trips, not the parallel cap.
    await db.pool.query(`UPDATE plans SET parallel_generations=20, requests_per_hour=5 WHERE id='starter'`);
    try {
      const k1 = await ctx.keyByMode("live");
      const k2 = await ctx.keyByMode("live");
      // Rejected attempts roll back without consuming quota, so all five of
      // these must succeed to consume the budget.
      for (const [key, tag] of [[k1, "a"], [k1, "b"], [k1, "c"], [k2, "d"], [k2, "e"]] as const) {
        const r = await app.inject({
          method: "POST",
          url: "/v1/generations",
          headers: { authorization: `Bearer ${key}`, "idempotency-key": `q-${tag}` },
          payload: { ...VALID_BODY },
        });
        expect(r.statusCode).toBe(202);
      }
      const sixth = await app.inject({
        method: "POST",
        url: "/v1/generations",
        headers: { authorization: `Bearer ${k2}`, "idempotency-key": "q-f" },
        payload: { ...VALID_BODY },
      });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json().error.code).toBe("hourly_rate_limit");
      expect(sixth.headers["retry-after"]).toBeDefined();
      expect(sixth.headers["x-ratelimit-remaining-hour"]).toBe("0");
    } finally {
      await db.pool.query(`UPDATE plans SET parallel_generations=3, requests_per_hour=300 WHERE id='starter'`);
    }
  });
});

describe("allowance boundaries and plan changes", () => {
  it("prior-period charges do not count toward this period", async () => {
    const ctx = await newAccount("starter");
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
    const lastPeriod = currentPeriodStart(lastMonth);
    await precharge(ctx.accountId, 200, lastPeriod);
    const secret = await ctx.keyByMode("live");
    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${secret}` } });
    expect(usage.json()).toMatchObject({ used_credits: 0, remaining_credits: 200 });
  });

  it("growth overage is allowed and flagged; downgrade to starter blocks with history intact", async () => {
    const ctx = await newAccount("growth");
    await precharge(ctx.accountId, 2000);
    const secret = await ctx.keyByMode("live");
    const over = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "over-1" },
      payload: { ...VALID_BODY },
    });
    expect(over.statusCode).toBe(202);
    const meta = await db.pool.query(
      `SELECT metadata FROM usage_ledger WHERE account_id=$1 AND type='reservation' AND generation_id IS NOT NULL`,
      [ctx.accountId],
    );
    expect(meta.rows[0].metadata).toMatchObject({ overage_expected: true });

    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${secret}` } });
    expect(usage.json()).toMatchObject({ used_credits: 2000, pending_credits: 1, remaining_credits: -1 });

    // Downgrade mid-month: history preserved, new live jobs blocked, old queued job untouched.
    await db.pool.query(`UPDATE accounts SET plan_id='starter' WHERE id=$1`, [ctx.accountId]);
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "over-2" },
      payload: { ...VALID_BODY },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("allowance_exceeded");
    // History preserved: 2000 completed + 1 pending overage reservation.
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ reservation: 2001, charge: 2000, rows: 3 });
    const job = await db.pool.query(`SELECT status FROM generations WHERE account_id=$1`, [ctx.accountId]);
    expect(job.rows[0].status).toBe("queued");
  });
});

describe("cancel", () => {
  it("queued cancel releases the reservation exactly once; repeat is idempotent", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    const created = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "cx-1" },
      payload: { ...VALID_BODY },
    });
    const jobId = (created.json() as { id: string }).id;
    const cancel = await app.inject({
      method: "POST",
      url: `/v1/generations/${jobId}/cancel`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ status: "canceled" });
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ reservation: 1, release: 1, rows: 2 });

    const again = await app.inject({
      method: "POST",
      url: `/v1/generations/${jobId}/cancel`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(again.statusCode).toBe(200);
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ rows: 2 });
  });

  it("running cancel records the request without releasing (worker resolves it)", async () => {
    const ctx = await newAccount("starter");
    const secret = await ctx.keyByMode("live");
    const created = await app.inject({
      method: "POST",
      url: "/v1/generations",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": "cx-2" },
      payload: { ...VALID_BODY },
    });
    const jobId = (created.json() as { id: string }).id;
    await db.pool.query(`UPDATE generations SET status='running' WHERE id=$1`, [jobId]);
    const cancel = await app.inject({
      method: "POST",
      url: `/v1/generations/${jobId}/cancel`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ status: "running", cancel_requested: true });
    expect(await ledgerSums(ctx.accountId)).toMatchObject({ rows: 1 });
  });
});
