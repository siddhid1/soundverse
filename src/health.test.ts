import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("health", () => {
  it("GET /health returns ok", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });

  it("unknown route uses canonical error shape", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as {
      error: { type: string; code: string; message: string; request_id: string };
    };
    expect(body.error.type).toBe("not_found_error");
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.request_id).toBe("string");
    expect(res.headers["x-request-id"]).toBe(body.error.request_id);
    await app.close();
  });
});
