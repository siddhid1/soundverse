import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "../config/env.js";
import * as schema from "./schema.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const env = getEnv();
  pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
  // A dead idle backend (DB restart, deploy, test teardown) surfaces here.
  // The pool already evicted it and keeps serving; log instead of crashing
  // the process via an unhandled 'error' event.
  pool.on("error", (err) => {
    console.error(`[db] pool idle-client error: ${(err as Error).message}`);
  });
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

/** Lightweight connectivity probe used by /ready. Never throws. */
export async function checkDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const p = getPool();
    await p.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/** Test-only: close pool between test files. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
