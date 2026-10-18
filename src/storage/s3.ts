import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "../config/env.js";
import type { ObjectStore } from "./store.js";

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    /**
     * Client used ONLY for presigning download URLs. Signing is local (HMAC)
     * so this client never performs network I/O — but the endpoint it points
     * at becomes the URL's host. In docker-compose the data plane must use the
     * internal `http://minio:9000` (unresolvable outside the network) while
     * humans need `http://localhost:9000`; SigV4 signs the host header, so the
     * URL must be minted against the public endpoint, not string-rewritten.
     */
    private readonly presignClient?: S3Client,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /** Signing is local (HMAC) — no network call, safe to use in request path. */
  async presignedGet(key: string, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.presignClient ?? this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSec },
    );
  }
}

let cached: S3ObjectStore | null = null;

function makeClient(env: {
  S3_REGION: string;
  S3_ENDPOINT: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
}): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
}

/** Process-wide S3 store from environment. Bucket must already exist and be private. */
export function s3StoreFromEnv(): S3ObjectStore {
  if (cached) return cached;
  const env = getEnv();
  const client = makeClient(env);
  const presignClient =
    env.S3_PUBLIC_ENDPOINT && env.S3_PUBLIC_ENDPOINT !== env.S3_ENDPOINT
      ? makeClient({ ...env, S3_ENDPOINT: env.S3_PUBLIC_ENDPOINT })
      : undefined;
  cached = new S3ObjectStore(client, env.S3_BUCKET, presignClient);
  return cached;
}

/** Test-only: drop the cached client so env changes take effect. */
export function resetS3Cache(): void {
  cached = null;
}
