/**
 * Object storage abstraction. Production uses S3-compatible storage (MinIO
 * locally); tests use the in-memory implementation. Audio objects are written
 * to non-public keys and served ONLY through short-lived signed URLs that the
 * API mints after checking tenant ownership — the bucket is never public.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Short-lived download URL for a key the caller has already authorized. */
  presignedGet(key: string, ttlSec: number): Promise<string>;
}

/** Storage key layout: tenant-scoped prefix so cross-account access is
 *  structurally impossible and ownership is re-checkable from the key. */
export function audioKey(accountId: string, generationId: string, ext: string): string {
  const safeExt = /^[a-z0-9]{2,5}$/.test(ext) ? ext : "bin";
  return `audio/${accountId}/${generationId}.${safeExt}`;
}

/** Extract and validate the account scope embedded in a storage key. */
export function accountIdFromAudioKey(key: string): string | null {
  const m = /^audio\/([0-9a-f-]{36})\/gen_[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/.exec(key);
  return m ? m[1]! : null;
}

export class InMemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async presignedGet(key: string, ttlSec: number): Promise<string> {
    if (!this.objects.has(key)) throw new Error(`object not found: ${key}`);
    const expires = Math.floor(Date.now() / 1000) + ttlSec;
    return `memory://test-bucket/${key}?expires=${expires}`;
  }
}
