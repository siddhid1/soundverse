import { randomUUID } from "node:crypto";

/** Canonical error shape used by every API response. */
export interface ApiErrorBody {
  error: {
    type: string;
    code: string;
    message: string;
    request_id: string;
  };
}

export type ErrorType =
  | "authentication_error"
  | "authorization_error"
  | "validation_error"
  | "not_found_error"
  | "conflict_error"
  | "rate_limit_error"
  | "quota_error"
  | "provider_error"
  | "internal_error";

export function newRequestId(prefix = "req"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function buildError(
  type: ErrorType,
  code: string,
  message: string,
  requestId: string,
): ApiErrorBody {
  return { error: { type, code, message, request_id: requestId } };
}

/** Map internal error codes to HTTP status codes. Documented in OpenAPI. */
export const codeToStatus: Record<string, number> = {
  // 400
  validation_failed: 400,
  idempotency_key_required: 400,
  invalid_scope: 400,
  invalid_mode: 400,
  invalid_or_expired_token: 400,
  webhook_url_blocked: 400,
  webhook_url_invalid: 400,
  // 401
  invalid_key: 401,
  missing_auth: 401,
  invalid_credentials: 401,
  session_expired: 401,
  // 403
  insufficient_scope: 403,
  license_not_allowed: 403,
  live_not_allowed: 403,
  email_not_verified: 403,
  // 404
  not_found: 404,
  key_not_found: 404,
  generation_not_found: 404,
  // 409
  email_taken: 409,
  key_revoked: 409,
  idempotency_key_reuse: 409,
  state_conflict: 409,
  // 429
  parallel_limit_reached: 429,
  hourly_rate_limit: 429,
  daily_rate_limit: 429,
  allowance_exceeded: 429,
  platform_rate_limit: 429,
  // 5xx
  provider_error: 502,
  provider_timeout: 504,
};

export function statusForCode(code: string, fallback = 500): number {
  return codeToStatus[code] ?? fallback;
}

/** Status for a known error code, or undefined when unknown. */
export function knownStatus(code: string): number | undefined {
  return codeToStatus[code];
}
