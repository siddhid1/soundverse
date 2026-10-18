import type { FastifyReply, FastifyRequest } from "fastify";
import { getPool } from "../db/index.js";
import { buildError } from "../lib/errors.js";
import { requestIdFor } from "../lib/request.js";
import { authenticateApiKey, requireScope, type AuthContext, type Scope } from "../services/apiKeys.js";
import { resolveSession } from "../services/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    apiAuth?: AuthContext;
    sessionAuth?: {
      user: { id: string; email: string; email_verified_at: string | null; created_at: string };
      account: { id: string; plan_id: string };
    };
  }
}

/** Dashboard session guard (cookie). */
export async function sessionAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.["sv_session" as never] as string | undefined;
  const ctx = await resolveSession(getPool(), token);
  if (!ctx) {
    const requestId = requestIdFor(req);
    void reply
      .code(401)
      .send(buildError("authentication_error", "session_expired", "Session is missing or expired.", requestId));
    return;
  }
  req.sessionAuth = ctx;
}

/** Developer API guard: Authorization: Bearer <secret>. No cache — DB on every request. */
export async function apiKeyAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const requestId = requestIdFor(req);
  if (!header || !header.startsWith("Bearer ")) {
    void reply
      .code(401)
      .send(buildError("authentication_error", "missing_auth", "Missing Authorization: Bearer <key>.", requestId));
    return;
  }
  const secret = header.slice("Bearer ".length).trim();
  if (!secret) {
    void reply
      .code(401)
      .send(buildError("authentication_error", "invalid_key", "API key is invalid or revoked.", requestId));
    return;
  }
  const ctx = await authenticateApiKey(getPool(), secret);
  if (!ctx) {
    void reply
      .code(401)
      .send(buildError("authentication_error", "invalid_key", "API key is invalid or revoked.", requestId));
    return;
  }
  req.apiAuth = ctx;
}

export function withScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.apiAuth) return;
    try {
      requireScope(req.apiAuth, scope);
    } catch (err) {
      const requestId = requestIdFor(req);
      void reply
        .code(403)
        .send(
          buildError(
            "authorization_error",
            "insufficient_scope",
            (err as Error).message,
            requestId,
          ),
        );
    }
  };
}
