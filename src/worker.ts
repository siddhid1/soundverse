import { getEnv } from "./config/env.js";
import { getPool } from "./db/index.js";
import { ElevenLabsMusicProvider } from "./providers/elevenlabs.js";
import { MockMusicProvider, type MockProviderOptions } from "./providers/mock.js";
import { s3StoreFromEnv } from "./storage/s3.js";
import { processOnce, recoverExpiredJobs, type EngineOptions } from "./worker/engine.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockOptions(env: ReturnType<typeof getEnv>): MockProviderOptions {
  const base = { latencyMs: env.MOCK_LATENCY_MS, failRate: env.MOCK_FAIL_RATE };
  if (env.MOCK_LATENCY_MAX_MS > 0) {
    return { ...base, latencyRangeMs: [env.MOCK_LATENCY_MIN_MS, env.MOCK_LATENCY_MAX_MS] };
  }
  return base;
}

async function main(): Promise<void> {
  const env = getEnv();
  if (env.PROVIDER === "elevenlabs" && !env.ELEVENLABS_API_KEY) {
    throw new Error("PROVIDER=elevenlabs requires ELEVENLABS_API_KEY to be set. Refusing to start.");
  }
  const pool = getPool();
  const eng: EngineOptions = {
    store: s3StoreFromEnv(),
    testProvider: new MockMusicProvider(mockOptions(env)),
    liveProvider:
      env.PROVIDER === "elevenlabs"
        ? new ElevenLabsMusicProvider({
            apiKey: env.ELEVENLABS_API_KEY,
            baseUrl: env.ELEVENLABS_BASE_URL,
            modelId: env.ELEVENLABS_MUSIC_MODEL,
          })
        : new MockMusicProvider(mockOptions(env)),
    leaseSec: env.WORKER_LEASE_SEC,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
  };
  let running = true;
  const stop = (sig: string) => () => {
    console.log(`[worker] ${sig} received, finishing current job...`);
    running = false;
  };
  process.on("SIGTERM", stop("SIGTERM"));
  process.on("SIGINT", stop("SIGINT"));
  const latencyDesc =
    env.MOCK_LATENCY_MAX_MS > 0
      ? `${env.MOCK_LATENCY_MIN_MS}-${env.MOCK_LATENCY_MAX_MS}ms random`
      : `${env.MOCK_LATENCY_MS}ms fixed`;
  console.log(
    `[worker] up (provider=${env.PROVIDER}, lease=${env.WORKER_LEASE_SEC}s, maxAttempts=${env.WORKER_MAX_ATTEMPTS}, mockLatency=${latencyDesc})`,
  );
  while (running) {
    try {
      const recovered = await recoverExpiredJobs(pool, eng);
      if (recovered > 0) console.log(`[worker] recovered ${recovered} expired job(s)`);
      const r = await processOnce(pool, eng);
      if (!r.claimed) await sleep(env.WORKER_POLL_MS);
    } catch (err) {
      console.error("[worker] loop error", err);
      await sleep(env.WORKER_POLL_MS);
    }
  }
  console.log("[worker] shutdown complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
