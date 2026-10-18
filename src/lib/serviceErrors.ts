import type { FastifyReply } from "fastify";
import { buildError, knownStatus } from "./errors.js";
import { requestIdFor } from "./request.js";

/** Service-layer errors carry `.code`; translate to the canonical shape. */
const typeForStatus = (status: number): string => {
  if (status === 401) return "authentication_error";
  if (status === 403) return "authorization_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "internal_error";
  return "validation_error";
};

/** Extra service codes beyond the base codeToStatus map. */
const extraStatuses: Record<string, number> = {
  email_taken: 409,
  invalid_credentials: 401,
  email_not_verified: 403,
  invalid_or_expired_token: 400,
  key_not_found: 404,
  key_revoked: 409,
  invalid_scope: 400,
  invalid_mode: 400,
  session_expired: 401,
};

export function sendServiceError(reply: FastifyReply, err: unknown, fallbackRequestId?: string): void {
  const requestId =
    fallbackRequestId ?? requestIdFor(reply.request as never as Parameters<typeof requestIdFor>[0]);
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string" && (knownStatus(code) !== undefined || extraStatuses[code] !== undefined)) {
    const status = knownStatus(code) ?? extraStatuses[code]!;
    const message = (err as Error).message || "Request failed.";
    void reply.code(status).send(buildError(typeForStatus(status) as never, code, message, requestId));
    return;
  }
  void reply.code(500).send(buildError("internal_error", "internal", "Internal server error.", requestId));
}
