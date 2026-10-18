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
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("soundverse-audio"),
  S3_ACCESS_KEY: z.string().default("minioadmin"),
  S3_SECRET_KEY: z.string().default("minioadmin"),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  AUDIO_URL_TTL_SEC: z.coerce.number().int().positive().default(900),

  // Auth / sessions
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-32chars"),
  // Encrypts webhook signing secrets at rest (32-byte hex or utf8; documented in .env.example)
  WEBHOOK_CRYPT_KEY: z.string().min(16).default("dev-webhook-crypt-key-change-me!!"),

  // Provider selection: mock by default. Real provider only when explicitly enabled.
  PROVIDER: z.enum(["mock", "elevenlabs"]).default("mock"),
  ELEVENLABS_API_KEY: z.string().optional().default(""),
  ELEVENLABS_MUSIC_MODEL: z.string().default("music-v1"),

  APP_BASE_URL: z.string().default("http://localhost:3000"),
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
