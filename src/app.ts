import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { getEnv } from "./config/env.js";
import { buildError, statusForCode } from "./lib/errors.js";
import { registerRequestHooks, requestIdFor } from "./lib/request.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { healthRoutes } from "./routes/health.js";
import { keyRoutes } from "./routes/keys.js";
import { v1PingRoutes } from "./routes/v1ping.js";

export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();
  const app = Fastify({
    logger:
      env.NODE_ENV === "test"
        ? false
        : {
            level: env.NODE_ENV === "production" ? "info" : "debug",
          },
    // Fastify generates its own req.id; we normalize to req.requestId in the hook.
    requestIdHeader: "x-request-id",
  });

  registerRequestHooks(app);
  await app.register(cookie);

  // Uniform error shape for validation failures.
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as { statusCode?: number; validation?: unknown; code?: string; message?: string };
    const requestId = requestIdFor(req);
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (err.validation) {
      app.log.warn({ requestId, validation: err.validation }, "validation failed");
      return reply
        .code(400)
        .send(buildError("validation_error", "validation_failed", "Request failed validation.", requestId));
    }
    if (status >= 500) {
      app.log.error({ err, requestId }, "unhandled error");
      return reply
        .code(500)
        .send(buildError("internal_error", "internal", "Internal server error.", requestId));
    }
    const code = (err as { code?: string }).code ?? "request_failed";
    return reply
      .code(status)
      .send(buildError("validation_error", code, err.message ?? "Request failed.", requestId));
  });

  app.setNotFoundHandler((req, reply) => {
    const requestId = requestIdFor(req);
    return reply
      .code(404)
      .send(buildError("not_found_error", "not_found", "Route not found.", requestId));
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(keyRoutes);
  await app.register(dashboardRoutes);
  await app.register(v1PingRoutes);
  // Phase 3: generations, usage, idempotency, ledger.
  // Phase 5: webhook endpoints + dispatcher.

  // Helper used by future modules to send canonical errors.
  app.decorate("apiError", (reply: unknown, code: string, message: string, requestId: string) => {
    const r = reply as { code: (n: number) => { send: (b: unknown) => unknown } };
    const type =
      statusForCode(code, 500) === 401
        ? "authentication_error"
        : statusForCode(code, 500) === 403
          ? "authorization_error"
          : statusForCode(code, 500) === 404
            ? "not_found_error"
            : statusForCode(code, 500) === 409
              ? "conflict_error"
              : statusForCode(code, 500) === 429
                ? "rate_limit_error"
                : statusForCode(code, 500) >= 500
                  ? "internal_error"
                  : "validation_error";
    return r.code(statusForCode(code)).send(buildError(type as never, code, message, requestId));
  });

  return app;
}
