import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** SHA-256 hex of a secret. Only the hash is ever persisted. */
export function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** High-entropy API secret: 36 random bytes (~288 bits), base64url. */
export function generateApiSecret(mode: "test" | "live"): { secret: string; prefix: string } {
  const rand = randomBytes(36).toString("base64url");
  const secret = `sv_${mode}_${rand}`;
  const prefix = `sv_${mode}_${rand.slice(0, 8)}`;
  return { secret, prefix };
}

/** Opaque session / verification token material (raw, never stored). */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
