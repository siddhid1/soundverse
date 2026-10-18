import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts per-endpoint webhook signing secrets at rest (AES-256-GCM).
 * Key derivation: a 64-hex-char env value is used as raw 32 bytes; anything
 * else is hashed with SHA-256. Either way the env value needs real entropy in
 * production — a default placeholder only exists for local development.
 */
function kekFromEnv(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptSecret(plaintext: string, envKey: string): string {
  const kek = kekFromEnv(envKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${nonce.toString("base64")}:${Buffer.concat([tag, ct]).toString("base64")}`;
}

export function decryptSecret(stored: string, envKey: string): string {
  const kek = kekFromEnv(envKey);
  const [version, nonceB64, payloadB64] = stored.split(":");
  if (version !== "v1" || !nonceB64 || !payloadB64) throw new Error("Unknown secret encoding.");
  const nonce = Buffer.from(nonceB64, "base64");
  const payload = Buffer.from(payloadB64, "base64");
  const tag = payload.subarray(0, 16);
  const ct = payload.subarray(16);
  const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** High-entropy per-endpoint signing secret (shown once at registration). */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}
