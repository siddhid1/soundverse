import type { FastifyInstance } from "fastify";
import { checkDb } from "../db/index.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok", service: "soundverse-api", version: "0.1.0" };
  });

  app.get("/ready", async (_req, reply) => {
    const db = await checkDb();
    const ok = db.ok;
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ready" : "not_ready",
      checks: { database: db.ok ? "up" : "down", latencyMs: db.latencyMs },
    });
  });
}
