import { getEnv } from "./config/env.js";
import { getPool } from "./db/index.js";
import { dispatchOnce } from "./webhooks/dispatch.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const env = getEnv();
  const pool = getPool();
  let running = true;
  const stop = (sig: string) => () => {
    console.log(`[webhooks] ${sig} received, finishing cycle...`);
    running = false;
  };
  process.on("SIGTERM", stop("SIGTERM"));
  process.on("SIGINT", stop("SIGINT"));
  console.log(
    `[webhooks] dispatcher up (maxAttempts=${env.WEBHOOK_MAX_ATTEMPTS}, allowPrivate=${env.WEBHOOK_ALLOW_PRIVATE_IPS})`,
  );
  while (running) {
    try {
      const s = await dispatchOnce(pool, {
        allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_IPS,
        timeoutMs: env.WEBHOOK_TIMEOUT_MS,
        maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
        retryBaseSec: env.WEBHOOK_RETRY_BASE_SEC,
        maxBytes: env.WEBHOOK_MAX_BYTES,
        cryptKey: env.WEBHOOK_CRYPT_KEY,
        batchSize: 20,
      });
      if (s.attempted > 0 || s.eventsFannedOut > 0) console.log(`[webhooks] ${JSON.stringify(s)}`);
      await sleep(1000);
    } catch (err) {
      console.error("[webhooks] loop error", err);
      await sleep(1000);
    }
  }
  console.log("[webhooks] shutdown complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
