import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";
import { ElevenLabsMusicProvider } from "../src/providers/elevenlabs.js";
import { MockMusicProvider } from "../src/providers/mock.js";
import { ProviderError, type MusicProvider } from "../src/providers/types.js";
import {
  claimNextJob,
  processOnce,
  recoverExpiredJobs,
  type EngineOptions,
} from "../src/worker/engine.js";
import { accountIdFromAudioKey, audioKey, InMemoryStore } from "../src/storage/store.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 5000;

const uniqEmail = () => `phase4_${Date.now()}_${emailSeq++}@example.com`;
const VALID_BODY = { prompt: "phase4 test groove", duration_sec: 30, license: "royalty_free", instrumental: true } as const;

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

async function newLiveKey(plan: "starter" | "growth" = "starter", mode: "live" | "test" = "live") {
  const email = uniqEmail();
  const password = "correct-horse-12";
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password } });
  const token = (signup.json() as { verification_token: string }).verification_token;
  await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = sessionCookieFrom(login);
  const accountId = (signup.json() as { account: { id: string } }).account.id;
  await db.pool.query(`UPDATE accounts SET plan_id=$1 WHERE id=$2`, [plan, accountId]);
  const created = await app.inject({
    method: "POST", url: "/keys", headers: { cookie },
    payload: { scopes: ["generations:write", "generations:read"], mode },
  });
  return { accountId, secret: (created.json() as { secret: string }).secret };
}

async function createJob(secret: string, key: string, body: Record<string, unknown> = { ...VALID_BODY }) {
  const res = await app.inject({
    method: "POST", url: "/v1/generations",
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": key },
    payload: body,
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { id: string }).id;
}

function engineFor(store: InMemoryStore, live: MusicProvider, overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    store,
    testProvider: new MockMusicProvider({ latencyMs: 10, failRate: 0 }),
    liveProvider: live,
    leaseSec: 30,
    maxAttempts: 3,
    providerTimeoutMs: 5000,
    ...overrides,
  };
}

const okMock = () => new MockMusicProvider({ latencyMs: 10, failRate: 0 });

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

describe("mock provider", () => {
  it("is deterministic per prompt and honors failure injection", async () => {
    const p = new MockMusicProvider({ latencyMs: 0, failRate: 0 });
    const a = await p.generate({ prompt: "aaa", durationSec: 30, instrumental: true, providerRequestId: "1" }, { timeoutMs: 1000 });
    const b = await p.generate({ prompt: "aaa", durationSec: 30, instrumental: true, providerRequestId: "2" }, { timeoutMs: 1000 });
    expect(createHash("sha256").update(a.audio).digest("hex")).toBe(
      createHash("sha256").update(b.audio).digest("hex"),
    );
    const c = await p.generate({ prompt: "bbb", durationSec: 30, instrumental: true, providerRequestId: "3" }, { timeoutMs: 1000 });
    expect(createHash("sha256").update(c.audio).digest("hex")).not.toBe(
      createHash("sha256").update(a.audio).digest("hex"),
    );
    expect(a.format).toBe("wav");

    const failing = new MockMusicProvider({ latencyMs: 0, failRate: 1 });
    await expect(
      failing.generate({ prompt: "x", durationSec: 30, instrumental: true, providerRequestId: "4" }, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "provider_error" });

    const slow = new MockMusicProvider({ latencyMs: 5000, failRate: 0 });
    await expect(
      slow.generate({ prompt: "x", durationSec: 30, instrumental: true, providerRequestId: "5" }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "provider_timeout" });
  });
});

describe("worker happy path", () => {
  it("live job succeeds: audio stored, charged once, outbox emitted, signed url served", async () => {
    const { accountId, secret } = await newLiveKey();
    const store = new InMemoryStore();
    const jobId = await createJob(secret, "w-happy");
    const out = await processOnce(db.pool, engineFor(store, okMock()));
    expect(out).toMatchObject({ claimed: true, jobId, outcome: "succeeded" });

    const row = await db.pool.query(`SELECT * FROM generations WHERE id=$1`, [jobId]);
    expect(row.rows[0]).toMatchObject({ status: "succeeded", charged_credits: 1, provider: "mock", model: "mock/music-1", output_format: "wav" });
    expect(store.objects.has(`audio/${accountId}/${jobId}.wav`)).toBe(true);

    const sums = await db.pool.query(
      `SELECT type, SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 GROUP BY type ORDER BY type`,
      [accountId],
    );
    expect(Object.fromEntries(sums.rows.map((r) => [r.type, r.n]))).toEqual({ charge: 1, reservation: 1 });

    const events = await db.pool.query(`SELECT type FROM outbox_events WHERE account_id=$1`, [accountId]);
    expect(events.rows).toEqual([{ type: "generation.succeeded" }]);

    const got = await app.inject({ method: "GET", url: `/v1/generations/${jobId}`, headers: { authorization: `Bearer ${secret}` } });
    expect(got.statusCode).toBe(200);
    const output = (got.json() as { output: { audio_url: string; format: string } }).output;
    expect(output.format).toBe("wav");
    expect(output.audio_url).toContain(`${jobId}.wav`);
    expect(output.audio_url).toMatch(/X-Amz-Expires=900/);
  });

  it("test-key job succeeds with no ledger rows", async () => {
    const { secret } = await newLiveKey("starter", "test");
    const store = new InMemoryStore();
    const jobId = await createJob(secret, "w-test");
    const out = await processOnce(db.pool, engineFor(store, okMock()));
    expect(out).toMatchObject({ claimed: true, outcome: "succeeded" });
    const led = await db.pool.query(`SELECT COUNT(*)::int AS n FROM usage_ledger`);
    expect(led.rows[0].n).toBe(0);
    const row = await db.pool.query(`SELECT charged_credits, provider FROM generations WHERE id=$1`, [jobId]);
    expect(row.rows[0]).toMatchObject({ charged_credits: 0, provider: "mock" });
  });

  it("cross-tenant audio urls stay unreachable (404)", async () => {
    const a = await newLiveKey();
    const b = await newLiveKey();
    const store = new InMemoryStore();
    const jobId = await createJob(a.secret, "w-iso");
    await processOnce(db.pool, engineFor(store, okMock()));
    const cross = await app.inject({ method: "GET", url: `/v1/generations/${jobId}`, headers: { authorization: `Bearer ${b.secret}` } });
    expect(cross.statusCode).toBe(404);
  });
});

describe("failures, retries, recovery", () => {
  it("failing provider requeues then fails with release exactly once", async () => {
    const { accountId, secret } = await newLiveKey();
    const store = new InMemoryStore();
    const failing = engineFor(store, new MockMusicProvider({ latencyMs: 0, failRate: 1 }));
    const jobId = await createJob(secret, "w-fail");
    expect(await processOnce(db.pool, failing)).toMatchObject({ outcome: "requeued" });
    expect(await processOnce(db.pool, failing)).toMatchObject({ outcome: "requeued" });
    expect(await processOnce(db.pool, failing)).toMatchObject({ outcome: "failed" });

    const row = await db.pool.query(`SELECT status, attempts FROM generations WHERE id=$1`, [jobId]);
    expect(row.rows[0]).toMatchObject({ status: "failed", attempts: 3 });
    const sums = await db.pool.query(
      `SELECT type, SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 GROUP BY type`,
      [accountId],
    );
    expect(Object.fromEntries(sums.rows.map((r) => [r.type, r.n]))).toEqual({ release: 1, reservation: 1 });
    const events = await db.pool.query(`SELECT type FROM outbox_events WHERE account_id=$1`, [accountId]);
    expect(events.rows).toEqual([{ type: "generation.failed" }]);
  });

  it("provider timeout is retryable; slow-then-fast proves no double billing", async () => {
    const { accountId, secret } = await newLiveKey();
    const store = new InMemoryStore();
    const jobId = await createJob(secret, "w-timeout");
    const tight = engineFor(store, new MockMusicProvider({ latencyMs: 300, failRate: 0 }), { providerTimeoutMs: 40 });
    expect(await processOnce(db.pool, tight)).toMatchObject({ outcome: "requeued" });
    expect(await processOnce(db.pool, engineFor(store, okMock()))).toMatchObject({ outcome: "succeeded" });
    const row = await db.pool.query(`SELECT status, charged_credits FROM generations WHERE id=$1`, [jobId]);
    expect(row.rows[0]).toMatchObject({ status: "succeeded", charged_credits: 1 });
    const sums = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM usage_ledger WHERE account_id=$1 AND type IN ('charge','overage_charge')`,
      [accountId],
    );
    expect(sums.rows[0].n).toBe(1);
  });

  it("crashed worker lease expires, recovers, and completes exactly once", async () => {
    const { accountId, secret } = await newLiveKey();
    const store = new InMemoryStore();
    const eng = engineFor(store, okMock());
    const jobId = await createJob(secret, "w-crash");
    const claimed = await claimNextJob(db.pool, 30);
    expect(claimed?.id).toBe(jobId);
    // Simulate crash: lease expires with the worker gone.
    await db.pool.query(`UPDATE generations SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [jobId]);
    expect(await recoverExpiredJobs(db.pool, eng)).toBe(1);
    expect(await processOnce(db.pool, eng)).toMatchObject({ outcome: "succeeded" });
    const sums = await db.pool.query(
      `SELECT type, SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 GROUP BY type`,
      [accountId],
    );
    expect(Object.fromEntries(sums.rows.map((r) => [r.type, r.n]))).toEqual({ charge: 1, reservation: 1 });
  });

  it("expired lease past retry budget fails with release (no infinite retries)", async () => {
    const { secret } = await newLiveKey();
    const store = new InMemoryStore();
    const eng = engineFor(store, okMock());
    const jobId = await createJob(secret, "w-budget");
    await claimNextJob(db.pool, 30);
    await db.pool.query(
      `UPDATE generations SET attempts=3, lease_expires_at = now() - interval '1 second' WHERE id=$1`,
      [jobId],
    );
    expect(await recoverExpiredJobs(db.pool, eng)).toBe(1);
    const row = await db.pool.query(`SELECT status FROM generations WHERE id=$1`, [jobId]);
    expect(row.rows[0].status).toBe("failed");
  });

  it("cancel during a run wins over delivery: canceled plus release, no charge", async () => {
    const { accountId, secret } = await newLiveKey();
    const store = new InMemoryStore();
    let poolRef: typeof db.pool | null = null;
    const cancellingProvider: MusicProvider = {
      name: "cancel-race-mock",
      async generate() {
        // The user cancels while the provider call is in flight.
        await poolRef!.query(`UPDATE generations SET cancel_requested_at=now() WHERE status='running'`);
        return { audio: Buffer.from("fake"), format: "wav", durationSec: 30, model: "cancel-race-mock" };
      },
    };
    poolRef = db.pool;
    const eng = engineFor(store, cancellingProvider);
    const jobId = await createJob(secret, "w-cancelrace");
    expect(await processOnce(db.pool, eng)).toMatchObject({ claimed: true, jobId, outcome: "canceled" });
    const sums = await db.pool.query(
      `SELECT type, SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 GROUP BY type`,
      [accountId],
    );
    expect(Object.fromEntries(sums.rows.map((r) => [r.type, r.n]))).toEqual({ release: 1, reservation: 1 });
    const events = await db.pool.query(`SELECT type FROM outbox_events WHERE account_id=$1`, [accountId]);
    expect(events.rows).toEqual([{ type: "generation.canceled" }]);
  });

  it("recovery honors a pending cancel request", async () => {
    const { accountId, secret } = await newLiveKey();
    const store = new InMemoryStore();
    const jobId = await createJob(secret, "w-reccancel");
    await claimNextJob(db.pool, 30);
    await app.inject({ method: "POST", url: `/v1/generations/${jobId}/cancel`, headers: { authorization: `Bearer ${secret}` } });
    await db.pool.query(`UPDATE generations SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [jobId]);
    expect(await recoverExpiredJobs(db.pool, engineFor(store, okMock()))).toBe(1);
    const row = await db.pool.query(`SELECT status FROM generations WHERE id=$1`, [jobId]);
    expect(row.rows[0].status).toBe("canceled");
    const n = await db.pool.query(`SELECT COUNT(*)::int AS n FROM usage_ledger WHERE account_id=$1 AND type='release'`, [accountId]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe("storage keys", () => {
  it("keys are tenant-scoped and parseable", () => {
    const accountId = "123e4567-e89b-12d3-a456-426614174000";
    const key = audioKey(accountId, "gen_abc123", "wav");
    expect(key).toBe(`audio/${accountId}/gen_abc123.wav`);
    expect(accountIdFromAudioKey(key)).toBe(accountId);
    expect(accountIdFromAudioKey("audio/other/gen_abc.wav")).toBeNull();
    expect(accountIdFromAudioKey("audio/../../etc/passwd")).toBeNull();
    expect(audioKey(accountId, "gen_x", "../../evil")).toContain(".bin");
  });

  it("memory store round-trips and signs with expiry", async () => {
    const store = new InMemoryStore();
    await store.put("audio/a/b.wav", Buffer.from("data"), "audio/wav");
    const url = await store.presignedGet("audio/a/b.wav", 900);
    const expires = Number(new URL(url).searchParams.get("expires"));
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000) + 800);
    await expect(store.presignedGet("audio/a/missing.wav", 900)).rejects.toThrow();
  });
});

describe("elevenlabs adapter (local stub, zero spend)", () => {
  let server: Server;
  let baseUrl = "";
  let mode: "ok" | "error" | "slow" = "ok";
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  let lastBody = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastHeaders = req.headers;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastBody = body;
        if (req.url !== "/v1/music") {
          res.writeHead(404).end("nope");
        } else if (mode === "error") {
          res.writeHead(500).end("vendor exploded");
        } else if (mode === "slow") {
          setTimeout(() => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.from("mp3bytes")), 300);
        } else {
          res.writeHead(200, { "Content-Type": "audio/mpeg", "request-id": "req_stub_1" }).end(Buffer.from("mp3bytes"));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends auth, maps success, classifies errors and timeouts", async () => {
    const adapter = new ElevenLabsMusicProvider({ apiKey: "test-key", baseUrl, modelId: "music-v1" });
    mode = "ok";
    const ok = await adapter.generate(
      { prompt: "p", durationSec: 30, instrumental: true, providerRequestId: "gen_1" },
      { timeoutMs: 2000 },
    );
    expect(ok).toMatchObject({ audio: Buffer.from("mp3bytes"), format: "mp3", model: "music-v1", providerJobId: "req_stub_1" });
    expect(lastHeaders["xi-api-key"]).toBe("test-key");
    expect(JSON.parse(lastBody)).toMatchObject({ prompt: "p", music_length_ms: 30000, model_id: "music-v1" });

    mode = "error";
    const err = await adapter
      .generate({ prompt: "p", durationSec: 30, instrumental: true, providerRequestId: "gen_2" }, { timeoutMs: 2000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "provider_error", retryable: true });

    mode = "slow";
    const slow = await adapter
      .generate({ prompt: "p", durationSec: 30, instrumental: true, providerRequestId: "gen_3" }, { timeoutMs: 50 })
      .catch((e) => e);
    expect(slow).toMatchObject({ code: "provider_timeout" });
  });
});
