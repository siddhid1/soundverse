import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "../config/env.js";
import type { ObjectStore } from "./store.js";

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /** Signing is local (HMAC) — no network call, safe to use in request path. */
  async presignedGet(key: string, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSec },
    );
  }
}

let cached: S3ObjectStore | null = null;

/** Process-wide S3 store from environment. Bucket must already exist and be private. */
export function s3StoreFromEnv(): S3ObjectStore {
  if (cached) return cached;
  const env = getEnv();
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  cached = new S3ObjectStore(client, env.S3_BUCKET);
  return cached;
}

/** Test-only: drop the cached client so env changes take effect. */
export function resetS3Cache(): void {
  cached = null;
}
