/**
 * Phase 4 placeholder. The durable PostgreSQL worker (SKIP LOCKED claim,
 * lease renewal, provider calls, MinIO upload, conditional finalization)
 * is implemented in Phase 4. This stub keeps `docker-compose worker`
 * and `npm run start:worker` valid from Phase 1.
 */
import { getEnv } from "./config/env.js";

async function main(): Promise<void> {
  const env = getEnv();
  // eslint-disable-next-line no-console
  console.log(`[worker] standby (NODE_ENV=${env.NODE_ENV}). Phase 4 implements job claiming.`);
  // Keep process alive so compose healthchecks pass; real poll loop replaces this.
  setInterval(() => {}, 60_000);
}

void main();
