import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .default("postgres://soundverse:soundverse@localhost:5432/soundverse"),
  // S3 / MinIO
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  // Public base URL minted into presigned download URLs. Defaults to
  // S3_ENDPOINT; set it separately when the data plane is only reachable
  // inside docker (e.g. S3_ENDPOINT=http://minio:9000 but browsers need
  // http://localhost:9000). The URL must be signed against the public host —
  // a post-sign string rewrite would invalidate the SigV4 signature.
  S3_PUBLIC_ENDPOINT: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("soundverse-audio"),
  S3_ACCESS_KEY: z.string().default("minioadmin"),
  S3_SECRET_KEY: z.string().default("minioadmin"),
  // NOTE: z.coerce.boolean() maps the string "false" to true; parse explicitly.
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1")
    .pipe(z.boolean()),
  AUDIO_URL_TTL_SEC: z.coerce.number().int().positive().default(900),

  // Auth / sessions
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-32chars"),
  // Spendable credits granted to every new account at signup (ledger 'grant').
  // Set to 0 to disable. Counts toward the same pool as plan allowance.
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().nonnegative().default(10_000),
  // Encrypts webhook signing secrets at rest (32-byte hex or utf8; documented in .env.example)
  WEBHOOK_CRYPT_KEY: z.string().min(16).default("dev-webhook-crypt-key-change-me!!"),

  // Music provider: mock by default. Real provider only when explicitly enabled.
  PROVIDER: z.enum(["mock", "elevenlabs"]).default("mock"),
  ELEVENLABS_API_KEY: z.string().optional().default(""),
  ELEVENLABS_BASE_URL: z.string().default("https://api.elevenlabs.io"),
  ELEVENLABS_MUSIC_MODEL: z.string().default("music-v1"),

  // Webhook dispatcher tuning
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  WEBHOOK_RETRY_BASE_SEC: z.coerce.number().positive().default(5),
  WEBHOOK_MAX_BYTES: z.coerce.number().int().positive().default(1_048_576),
  // Test/dev escape hatch for local stub receivers. NEVER enable in
  // production: it permits http + private/loopback destinations. The cloud
  // metadata range stays blocked regardless of this flag.
  WEBHOOK_ALLOW_PRIVATE_IPS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1")
    .pipe(z.boolean()),

  // Worker tuning
  WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
  WORKER_LEASE_SEC: z.coerce.number().int().positive().default(120),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(2000),
  // Dev/compose default: each mock generation sleeps a random 40-60s so the
  // async lifecycle (progress + webhooks) is observable. Set MAX to 0 to fall
  // back to the fixed MOCK_LATENCY_MS (e.g. for fast local iteration).
  MOCK_LATENCY_MIN_MS: z.coerce.number().int().nonnegative().default(40_000),
  MOCK_LATENCY_MAX_MS: z.coerce.number().int().nonnegative().default(60_000),
  MOCK_FAIL_RATE: z.coerce.number().min(0).max(1).default(0),

  APP_BASE_URL: z.string().default("http://localhost:3000"),
}).superRefine((env, ctx) => {
  if (env.MOCK_LATENCY_MAX_MS > 0 && env.MOCK_LATENCY_MIN_MS > env.MOCK_LATENCY_MAX_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MOCK_LATENCY_MIN_MS"],
      message: "MOCK_LATENCY_MIN_MS must be <= MOCK_LATENCY_MAX_MS (or set MAX to 0 to disable the range)",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: reset cached env so tests can re-parse with different inputs. */
export function resetEnvCache(): void {
  cached = null;
}
