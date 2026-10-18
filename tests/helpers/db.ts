import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { resetEnvCache } from "../../src/config/env.js";

export interface TestDb {
  pool: Pool;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 55432;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function runMigrationFiles(pool: Pool): Promise<void> {
  const dir = join(process.cwd(), "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const run = async () => {
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      await pool.query(sql);
    }
  };
  return run();
}

/**
 * Real PostgreSQL for tests. Uses TEST_DATABASE_URL when provided (CI with
 * docker compose), otherwise boots an embedded postgres binary on a temp dir.
 * Either way this is genuine PostgreSQL — not a mock — so locking and
 * constraint behavior in tests matches production.
 */
export async function startTestDb(): Promise<TestDb> {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    resetEnvCache();
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await runMigrationFiles(pool);
    return { pool, stop: async () => pool.end() };
  }
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "sv-testpg-"));
  const pg = new EmbeddedPostgres({
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    databaseDir: join(dir, "db"),
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  const admin = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE soundverse_test`);
  await admin.end();
  const connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/soundverse_test`;
  process.env.DATABASE_URL = connectionString;
  resetEnvCache();
  const pool = new Pool({ connectionString });
  await runMigrationFiles(pool);
  return {
    pool,
    stop: async () => {
      await pool.end().catch(() => {});
      await pg.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Remove all tenant data between tests. Plans are seed data and are kept. */
export async function clearDb(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE audit_logs, api_keys, sessions, email_verification_tokens,
       generations, idempotency_records, usage_ledger, rate_counters,
       accounts, users, schema_meta CASCADE`,
  );
}
