import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "sv-signature";
export const TIMESTAMP_HEADER = "sv-timestamp";
export const EVENT_ID_HEADER = "sv-event-id";
/** Receivers must reject deliveries older/newer than this (replay control). */
export const TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * Signature over the exact raw bytes delivered: HMAC-SHA256(secret, "<ts>.<body>").
 * The timestamp binds the signature to a moment; the stable event id (header)
 * lets receivers deduplicate retries. Signature verification alone does NOT
 * stop replays — receivers must ALSO enforce timestamp tolerance and dedupe
 * event ids (see verifyWebhook, enforced by default).
 */
export function signDelivery(secret: string, timestampSec: number, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`, "utf8").digest("hex")}`;
}

export interface VerifyResult {
  ok: boolean;
  reason?: "bad_signature" | "stale_timestamp" | "future_timestamp";
}

/** Constant-time signature comparison plus timestamp tolerance. */
export function verifyWebhook(
  secret: string,
  timestampSec: number,
  rawBody: string,
  signatureHeader: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = TIMESTAMP_TOLERANCE_SEC,
): VerifyResult {
  const expected = signDelivery(secret, timestampSec, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  const age = nowSec - timestampSec;
  if (age > toleranceSec) return { ok: false, reason: "stale_timestamp" };
  if (age < -toleranceSec) return { ok: false, reason: "future_timestamp" };
  return { ok: true };
}
