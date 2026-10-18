import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

export function requestIdFor(req: FastifyRequest): string {
  const existing = (req as { requestId?: string }).requestId ?? req.id;
  if (typeof existing === "string" && existing.length > 0) return existing;
  return `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Standard rate-limit headers applied to /v1 responses (values filled by limit logic in Phase 3). */
export function setRateLimitHeaders(
  reply: { header: (k: string, v: string | number) => unknown },
  opts: {
    limitHour: number;
    remainingHour: number;
    limitDay: number;
    remainingDay: number;
    retryAfterSec?: number;
  },
): void {
  reply.header("X-RateLimit-Limit-Hour", opts.limitHour);
  reply.header("X-RateLimit-Remaining-Hour", Math.max(0, opts.remainingHour));
  reply.header("X-RateLimit-Limit-Day", opts.limitDay);
  reply.header("X-RateLimit-Remaining-Day", Math.max(0, opts.remainingDay));
  if (opts.retryAfterSec !== undefined) {
    reply.header("Retry-After", opts.retryAfterSec);
  }
}

export function registerRequestHooks(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    const rid = (req.headers["x-request-id"] as string | undefined)?.slice(0, 64);
    const requestId =
      rid && /^[A-Za-z0-9_-]{1,64}$/.test(rid)
        ? rid
        : `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    (req as { requestId?: string }).requestId = requestId;
    reply.header("X-Request-Id", requestId);
  });
}
