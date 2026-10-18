import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../config/env.js";
import { resetS3Cache, s3StoreFromEnv } from "./s3.js";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://u:p@localhost:1/db",
  S3_ENDPOINT: "http://internal:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "b",
  S3_ACCESS_KEY: "ak",
  S3_SECRET_KEY: "sk",
  S3_FORCE_PATH_STYLE: "true",
} as const;

function setEnv(extra: Record<string, string>): void {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  resetEnvCache();
  resetS3Cache();
}

afterEach(() => {
  resetEnvCache();
  resetS3Cache();
});

describe("s3 presigned urls", () => {
  it("mints download urls against the public endpoint when split-horizon is configured", async () => {
    setEnv({ S3_PUBLIC_ENDPOINT: "http://public:9000" });
    const url = await s3StoreFromEnv().presignedGet("audio/a/b.wav", 900);
    expect(url.startsWith("http://public:9000/b/audio/a/b.wav?")).toBe(true);
    expect(url).toContain("X-Amz-Expires=900");
  });

  it("falls back to the data endpoint when no public override is set", async () => {
    setEnv({ S3_PUBLIC_ENDPOINT: "" });
    const url = await s3StoreFromEnv().presignedGet("audio/a/b.wav", 900);
    expect(url.startsWith("http://internal:9000/b/audio/a/b.wav?")).toBe(true);
  });
});
