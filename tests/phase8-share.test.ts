import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDb, startTestDb, type TestDb } from "./helpers/db.js";

let app: FastifyInstance;
let db: TestDb;
let emailSeq = 0;

const uniqEmail = () => `phase8s_${Date.now()}_${emailSeq++}@example.com`;

function sessionCookieFrom(loginRes: { headers: Record<string, unknown> }): string {
  const setCookie = loginRes.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "");
  return first!.split(";")[0]!;
}

async function signupLoginKey() {
  const email = uniqEmail();
  const password = "correct-horse-12";
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password } });
  expect(signup.statusCode).toBe(201);
  const body = signup.json() as { verification_token: string; account: { id: string } };
  const verify = await app.inject({ method: "GET", url: `/auth/verify?token=${body.verification_token}` });
  expect(verify.statusCode).toBe(200);
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(login.statusCode).toBe(200);
  const cookie = sessionCookieFrom(login);
  const created = await app.inject({
    method: "POST",
    url: "/keys",
    headers: { cookie },
    payload: { scopes: ["generations:write", "generations:read"], mode: "test" },
  });
  expect(created.statusCode).toBe(201);
  return {
    accountId: body.account.id,
    secret: (created.json() as { secret: string }).secret,
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

describe("share links (?expires_in=, 60–900s)", () => {
  it("rejects out-of-range values with 400 before lookup", async () => {
    const { secret } = await signupLoginKey();
    for (const bad of ["10", "59", "901", "99999", "0", "-5", "abc", "1.5"]) {
      const r = await app.inject({
        method: "GET",
        url: `/v1/generations/gen_missing?expires_in=${bad}`,
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
    // Boundary values parse (then 404 on the missing job — proving validation passed).
    for (const good of ["60", "180", "900"]) {
      const r = await app.inject({
        method: "GET",
        url: `/v1/generations/gen_missing?expires_in=${good}`,
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(r.statusCode).toBe(404);
    }
  });

  it("mints 180s share links; default stays 900; tenant check first", async () => {
    const a = await signupLoginKey();
    const b = await signupLoginKey();
    // Succeeded job with stored audio, inserted directly (worker not running in tests).
    await db.pool.query(
      `INSERT INTO generations(id, account_id, status, prompt, duration_sec, license, reserved_credits,
        object_key, output_duration_sec, output_format, completed_at, period_start)
       VALUES ('gen_share1', $1, 'succeeded', 'share test', 30, 'royalty_free', 0,
        $2, 30, 'audio/wav', now(), CURRENT_DATE)`,
      [a.accountId, `audio/${a.accountId}/gen_share1.wav`],
    );
    const d180 = await app.inject({
      method: "GET",
      url: `/v1/generations/gen_share1?expires_in=180`,
      headers: { authorization: `Bearer ${a.secret}` },
    });
    expect(d180.statusCode).toBe(200);
    const url180 = (d180.json() as { output: { audio_url: string } }).output.audio_url;
    expect(url180).toContain("X-Amz-Expires=180");

    const dflt = await app.inject({
      method: "GET",
      url: `/v1/generations/gen_share1`,
      headers: { authorization: `Bearer ${a.secret}` },
    });
    expect(dflt.statusCode).toBe(200);
    expect((dflt.json() as { output: { audio_url: string } }).output.audio_url).toContain("X-Amz-Expires=900");

    // Other tenant cannot mint (404, no leak) even with a valid expires_in.
    const cross = await app.inject({
      method: "GET",
      url: `/v1/generations/gen_share1?expires_in=180`,
      headers: { authorization: `Bearer ${b.secret}` },
    });
    expect(cross.statusCode).toBe(404);
  });
});
