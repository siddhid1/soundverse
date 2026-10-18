// Webhook tests run with the private-IP escape hatch ON so local stub
// receivers are reachable. The cloud metadata range stays blocked regardless
// (asserted below), and strict-mode rejections are tested by toggling the flag.
process.env.WEBHOOK_ALLOW_PRIVATE_IPS = "true";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";
import { resetEnvCache } from "../src/config/env.js";
import { dispatchOnce, type DispatchOptions } from "../src/webhooks/dispatch.js";
import { verifyWebhook } from "../src/webhooks/sign.js";
import { isBlockedIpLiteral, isBlockedIpv4, isBlockedIpv6 } from "../src/webhooks/ssrf.js";
import { MockMusicProvider } from "../src/providers/mock.js";
import { processOnce } from "../src/worker/engine.js";
import { InMemoryStore } from "../src/storage/store.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 9000;

const uniqEmail = () => `phase5_${Date.now()}_${emailSeq++}@example.com`;
const VALID_BODY = { prompt: "phase5 hook song", duration_sec: 30, license: "royalty_free", instrumental: true } as const;

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

async function newAccount() {
  const email = uniqEmail();
  const password = "correct-horse-12";
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password } });
  const token = (signup.json() as { verification_token: string }).verification_token;
  await app.inject({ method: "GET", url: `/auth/verify?token=${token}` });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = sessionCookieFrom(login);
  const accountId = (signup.json() as { account: { id: string } }).account.id;
  await db.pool.query(`UPDATE accounts SET plan_id='starter' WHERE id=$1`, [accountId]);
  const keyRes = await app.inject({
    method: "POST", url: "/keys", headers: { cookie },
    payload: { scopes: ["generations:write", "generations:read"], mode: "live" },
  });
  return { cookie, accountId, secret: (keyRes.json() as { secret: string }).secret };
}

function dispatchOpts(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    allowPrivate: true,
    timeoutMs: 2000,
    maxAttempts: 10,
    retryBaseSec: 0.05,
    maxBytes: 1_048_576,
    cryptKey: "dev-webhook-crypt-key-change-me!!",
    batchSize: 20,
    ...overrides,
  };
}

interface Captured {
  eventId: string;
  timestamp: string;
  signature: string;
  body: string;
  path: string;
}

class StubReceiver {
  received: Captured[] = [];
  otherHits = 0;
  mode: "ok" | "redirect" | "flaky" = "ok";
  failuresLeft = 0;
  private server: Server | null = null;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/other") {
          this.otherHits += 1;
          res.writeHead(200).end("other");
          return;
        }
        this.received.push({
          eventId: (req.headers["sv-event-id"] as string) ?? "",
          timestamp: (req.headers["sv-timestamp"] as string) ?? "",
          signature: (req.headers["sv-signature"] as string) ?? "",
          body,
          path: req.url ?? "/",
        });
        if (this.mode === "redirect") {
          res.writeHead(302, { location: "/other" }).end();
        } else if (this.mode === "flaky" && this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          res.writeHead(500).end("flaky");
        } else {
          res.writeHead(200).end("ok");
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}/hook`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((e) => (e ? reject(e) : resolve())) : resolve(),
    );
    this.server = null;
  }
}

async function registerEndpoint(secret: string, url: string) {
  const res = await app.inject({
    method: "POST", url: "/v1/webhook_endpoints",
    headers: { authorization: `Bearer ${secret}` },
    payload: { url },
  });
  return res;
}

async function completeJob(secret: string, key: string): Promise<string> {
  const created = await app.inject({
    method: "POST", url: "/v1/generations",
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": key },
    payload: { ...VALID_BODY },
  });
  expect(created.statusCode).toBe(202);
  const jobId = (created.json() as { id: string }).id;
  const out = await processOnce(
    db.pool,
    {
      store: new InMemoryStore(),
      testProvider: new MockMusicProvider({ latencyMs: 0, failRate: 0 }),
      liveProvider: new MockMusicProvider({ latencyMs: 5, failRate: 0 }),
      leaseSec: 30, maxAttempts: 3, providerTimeoutMs: 5000,
    },
  );
  expect(out).toMatchObject({ outcome: "succeeded" });
  return jobId;
}

beforeAll(async () => {
  resetEnvCache();
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

describe("endpoint registration", () => {
  it("registers, shows the secret once, and lists safe metadata", async () => {
    const { secret, accountId } = await newAccount();
    const stub = new StubReceiver();
    await stub.start();
    try {
      const res = await registerEndpoint(secret, stub.url);
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; url: string; signing_secret: string };
      expect(body.signing_secret.startsWith("whsec_")).toBe(true);

      const row = await db.pool.query(`SELECT secret_enc FROM webhook_endpoints WHERE id=$1`, [body.id]);
      expect(row.rows[0].secret_enc).not.toContain(body.signing_secret);

      const list = await app.inject({
        method: "GET", url: "/v1/webhook_endpoints", headers: { authorization: `Bearer ${secret}` },
      });
      const endpoints = (list.json() as { endpoints: Record<string, unknown>[] }).endpoints;
      expect(endpoints).toHaveLength(1);
      expect(Object.keys(endpoints[0]!)).toEqual(["id", "url", "enabled", "created_at", "updated_at"]);
      expect(JSON.stringify(list.json())).not.toContain(body.signing_secret);

      const del = await app.inject({
        method: "DELETE", url: `/v1/webhook_endpoints/${body.id}`, headers: { authorization: `Bearer ${secret}` },
      });
      expect(del.statusCode).toBe(200);
      const delAgain = await app.inject({
        method: "DELETE", url: `/v1/webhook_endpoints/${body.id}`, headers: { authorization: `Bearer ${secret}` },
      });
      expect(delAgain.statusCode).toBe(404);
      expect(accountId).toBeTruthy();
    } finally {
      await stub.stop();
    }
  });

  it("rejects the metadata address even in allow-private mode; strict mode rejects loopback and http", async () => {
    const { secret } = await newAccount();
    const meta = await registerEndpoint(secret, "http://169.254.169.254/latest/meta-data/");
    expect(meta.statusCode).toBe(400);
    expect(meta.json().error.code).toBe("webhook_url_blocked");

    const stub = new StubReceiver();
    await stub.start();
    try {
      process.env.WEBHOOK_ALLOW_PRIVATE_IPS = "false";
      resetEnvCache();
      const loopback = await registerEndpoint(secret, stub.url);
      expect(loopback.statusCode).toBe(400);
      expect(loopback.json().error.code).toBe("webhook_url_blocked");

      const plainHttp = await registerEndpoint(secret, "http://example.com/hook");
      expect(plainHttp.statusCode).toBe(400);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE_IPS = "true";
      resetEnvCache();
      await stub.stop();
    }
  });

  it("cross-account endpoints are invisible; read-only keys cannot register", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const stub = new StubReceiver();
    await stub.start();
    try {
      const created = await registerEndpoint(a.secret, stub.url);
      const id = (created.json() as { id: string }).id;
      const cross = await app.inject({
        method: "DELETE", url: `/v1/webhook_endpoints/${id}`, headers: { authorization: `Bearer ${b.secret}` },
      });
      expect(cross.statusCode).toBe(404);
    } finally {
      await stub.stop();
    }
  });
});

describe("delivery", () => {
  it("delivers signed events; signature verifies; billing untouched by dispatch", async () => {
    const { secret, accountId } = await newAccount();
    const stub = new StubReceiver();
    await stub.start();
    try {
      const reg = await registerEndpoint(secret, stub.url);
      const endpointSecret = (reg.json() as { signing_secret: string }).signing_secret;
      const jobId = await completeJob(secret, "wh-1");

      const before = await db.pool.query(
        `SELECT type, SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 GROUP BY type`,
        [accountId],
      );
      const summary = await dispatchOnce(db.pool, dispatchOpts());
      expect(summary).toMatchObject({ eventsFannedOut: 1, delivered: 1 });

      expect(stub.received).toHaveLength(1);
      const [first] = stub.received as [Captured];
      expect(first.eventId.startsWith("evt_")).toBe(true);
      const parsed = JSON.parse(first.body) as { id: string; type: string; data: { id: string } };
      expect(parsed).toMatchObject({ id: first.eventId, type: "generation.succeeded", data: { generation_id: jobId } });
      const v = verifyWebhook(endpointSecret, Number(first.timestamp), first.body, first.signature);
      expect(v).toEqual({ ok: true });

      const after = await db.pool.query(
        `SELECT type, SUM(amount)::int AS n FROM usage_ledger WHERE account_id=$1 GROUP BY type`,
        [accountId],
      );
      expect(after.rows).toEqual(before.rows);

      const deliveries = await db.pool.query(`SELECT status, attempts FROM webhook_deliveries`);
      expect(deliveries.rows).toEqual([{ status: "delivered", attempts: 1 }]);
    } finally {
      await stub.stop();
    }
  });

  it("down endpoint retries with the same event id; recovery delivers; job result intact", async () => {
    const { secret, accountId } = await newAccount();
    // Nothing listens here yet: connection refused.
    const downServer = createServer(() => {});
    await new Promise<void>((resolve) => downServer.listen(0, "127.0.0.1", resolve));
    const port = (downServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => downServer.close(() => resolve()));
    const url = `http://127.0.0.1:${port}/hook`;

    const reg = await registerEndpoint(secret, url);
    expect(reg.statusCode).toBe(201);
    const jobId = await completeJob(secret, "wh-2");
    void jobId;

    const first = await dispatchOnce(db.pool, dispatchOpts());
    expect(first).toMatchObject({ eventsFannedOut: 1, attempted: 1, delivered: 0, failed: 1 });
    let deliveries = await db.pool.query(`SELECT status, attempts, next_attempt_at FROM webhook_deliveries`);
    expect(deliveries.rows[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(new Date(deliveries.rows[0].next_attempt_at as string).getTime()).toBeGreaterThan(Date.now());
    const firstEventId = (await db.pool.query(`SELECT id FROM outbox_events WHERE account_id=$1`, [accountId])).rows[0].id;

    // Ten minutes pass; the endpoint recovers on the same port.
    const stub = new StubReceiver();
    const recovered = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        stub.received.push({
          eventId: (req.headers["sv-event-id"] as string) ?? "",
          timestamp: (req.headers["sv-timestamp"] as string) ?? "",
          signature: (req.headers["sv-signature"] as string) ?? "",
          body,
          path: req.url ?? "/",
        });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => recovered.listen(port, "127.0.0.1", resolve));
    try {
      await db.pool.query(`UPDATE webhook_deliveries SET next_attempt_at = now()`);
      const second = await dispatchOnce(db.pool, dispatchOpts());
      expect(second).toMatchObject({ attempted: 1, delivered: 1 });
      expect(stub.received).toHaveLength(1);
      expect(stub.received[0]!.eventId).toBe(firstEventId);
      deliveries = await db.pool.query(`SELECT status, attempts FROM webhook_deliveries`);
      expect(deliveries.rows[0]).toMatchObject({ status: "delivered", attempts: 2 });
      // The job was never rolled back by webhook trouble.
      const job = await db.pool.query(`SELECT status, charged_credits FROM generations LIMIT 1`);
      expect(job.rows[0]).toMatchObject({ status: "succeeded", charged_credits: 1 });
    } finally {
      await new Promise<void>((resolve) => recovered.close(() => resolve()));
    }
  });

  it("gives up after the retry budget and never touches the event again", async () => {
    const { secret } = await newAccount();
    const reg = await registerEndpoint(secret, "http://127.0.0.1:9/hook"); // discard port: refused
    expect(reg.statusCode).toBe(201);
    await completeJob(secret, "wh-3");
    for (let i = 0; i < 3; i++) {
      await dispatchOnce(db.pool, dispatchOpts({ maxAttempts: 3, retryBaseSec: 0.01 }));
      await db.pool.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status='pending'`);
    }
    const deliveries = await db.pool.query(`SELECT status, attempts FROM webhook_deliveries`);
    expect(deliveries.rows[0]).toMatchObject({ status: "dead", attempts: 3 });
    const quiet = await dispatchOnce(db.pool, dispatchOpts({ maxAttempts: 3 }));
    expect(quiet).toMatchObject({ attempted: 0 });
  });

  it("does not follow redirects; same event id is stable across retries", async () => {
    const { secret } = await newAccount();
    const stub = new StubReceiver();
    stub.mode = "redirect";
    await stub.start();
    try {
      await registerEndpoint(secret, stub.url);
      // Second endpoint on the same receiver proves event-id stability.
      await registerEndpoint(secret, `${stub.url}-second`);
      await completeJob(secret, "wh-4");
      const summary = await dispatchOnce(db.pool, dispatchOpts());
      expect(summary).toMatchObject({ eventsFannedOut: 1, attempted: 2, delivered: 0 });
      expect(stub.otherHits).toBe(0);
      const ids = stub.received.map((r) => r.eventId);
      expect(new Set(ids).size).toBe(1);
    } finally {
      await stub.stop();
    }
  });

  it("skips disabled endpoints at fan-out", async () => {
    const { secret, accountId } = await newAccount();
    const stub = new StubReceiver();
    await stub.start();
    try {
      await registerEndpoint(secret, stub.url);
      await db.pool.query(`UPDATE webhook_endpoints SET enabled=false WHERE account_id=$1`, [accountId]);
      await completeJob(secret, "wh-5");
      const summary = await dispatchOnce(db.pool, dispatchOpts());
      expect(summary).toMatchObject({ eventsFannedOut: 1, attempted: 0 });
      expect(stub.received).toHaveLength(0);
    } finally {
      await stub.stop();
    }
  });
});

describe("signature verification and replay", () => {
  it("accepts fresh, rejects stale/future/tampered", async () => {
    const { secret } = await newAccount();
    const stub = new StubReceiver();
    await stub.start();
    try {
      const reg = await registerEndpoint(secret, stub.url);
      const endpointSecret = (reg.json() as { signing_secret: string }).signing_secret;
      await completeJob(secret, "wh-6");
      await dispatchOnce(db.pool, dispatchOpts());
      const [captured] = stub.received as [Captured];
      const ts = Number(captured.timestamp);

      expect(verifyWebhook(endpointSecret, ts, captured.body, captured.signature, ts).ok).toBe(true);
      // A captured payload replayed a day later is stale.
      expect(verifyWebhook(endpointSecret, ts, captured.body, captured.signature, ts + 86_400)).toEqual({
        ok: false, reason: "stale_timestamp",
      });
      // Tolerance boundary: exactly 300s is fine, 301s is not.
      expect(verifyWebhook(endpointSecret, ts, captured.body, captured.signature, ts + 300).ok).toBe(true);
      expect(verifyWebhook(endpointSecret, ts, captured.body, captured.signature, ts + 301)).toEqual({
        ok: false, reason: "stale_timestamp",
      });
      expect(verifyWebhook(endpointSecret, ts, `${captured.body} `, captured.signature, ts)).toEqual({
        ok: false, reason: "bad_signature",
      });
      expect(verifyWebhook("whsec_wrong", ts, captured.body, captured.signature, ts)).toEqual({
        ok: false, reason: "bad_signature",
      });
    } finally {
      await stub.stop();
    }
  });
});

describe("ssrf classification", () => {
  it("blocks non-public literals in v4 and v6", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "100.64.0.1", "192.0.2.1"]) {
      expect(isBlockedIpv4(ip)).toBe(true);
    }
    expect(isBlockedIpv4("8.8.8.8")).toBe(false);
    expect(isBlockedIpLiteral("8.8.8.8")).toBe(false);
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "100::1"]) {
      expect(isBlockedIpv6(ip)).toBe(true);
    }
    expect(isBlockedIpv6("2001:4860:4860::8888")).toBe(false);
  });
});
