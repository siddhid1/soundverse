import type { FastifyInstance } from "fastify";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/index.js";
import { buildError } from "../lib/errors.js";
import { requestIdFor } from "../lib/request.js";
import { platformStats } from "../services/platform.js";

/**
 * Public platform aggregates. No authentication, no per-account data — every
 * number below is a platform-wide COUNT/SUM/AVG. Additive route: existing
 * auth behavior elsewhere is untouched.
 *
 * Guardrails: PLATFORM_STATS_ENABLED kill-switch (404 when off) plus a small
 * in-memory per-IP fixed window (60/min) with Retry-After. No DB writes, no
 * accounting side effects.
 */
const WINDOW_MS = 60_000;
const LIMIT = 60;
const hits = new Map<string, { count: number; resetAt: number }>();

export function checkPlatformRate(ip: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
  const cur = hits.get(ip);
  if (!cur || now >= cur.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  cur.count += 1;
  if (cur.count > LIMIT) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Test-only: reset the in-memory limiter. */
export function resetPlatformRate(): void {
  hits.clear();
}

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/platform/stats", async (req, reply) => {
    const requestId = requestIdFor(req);
    if (!getEnv().PLATFORM_STATS_ENABLED) {
      return reply
        .code(404)
        .send(buildError("not_found_error", "not_found", "Route not found.", requestId));
    }
    const ip = req.ip;
    const { allowed, retryAfterSec } = checkPlatformRate(ip);
    void reply.header("RateLimit-Limit", LIMIT);
    if (!allowed) {
      void reply.header("Retry-After", retryAfterSec);
      return reply
        .code(429)
        .send(
          buildError(
            "rate_limit_error",
            "platform_rate_limit",
            "Platform stats rate limit exceeded. Retry shortly.",
            requestId,
          ),
        );
    }
    const stats = await platformStats(getPool());
    return reply.send(stats);
  });
}
