/**
 * Phase 5 placeholder. The webhook dispatcher (outbox poll, HMAC signing,
 * retries, SSRF-safe delivery) is implemented in Phase 5.
 */
import { getEnv } from "./config/env.js";

async function main(): Promise<void> {
  const env = getEnv();
  // eslint-disable-next-line no-console
  console.log(`[webhooks] standby (NODE_ENV=${env.NODE_ENV}). Phase 5 implements dispatch.`);
  setInterval(() => {}, 60_000);
}

void main();
