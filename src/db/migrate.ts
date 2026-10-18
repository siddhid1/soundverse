/** Migration runner: `npm run db:migrate`. Uses drizzle-kit SQL in ./drizzle. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { getEnv } from "../config/env.js";

async function main(): Promise<void> {
  const env = getEnv();
  const dir = join(process.cwd(), "drizzle");
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    console.log("No drizzle/ directory yet — nothing to migrate.");
    return;
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    for (const f of files) {
      const done = await pool.query(`SELECT 1 FROM __drizzle_migrations WHERE name=$1`, [f]);
      if ((done.rowCount ?? 0) > 0) {
        console.log(`skip ${f} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(dir, f), "utf8");
      console.log(`apply ${f}...`);
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query(`INSERT INTO __drizzle_migrations(name) VALUES($1)`, [f]);
        await pool.query("COMMIT");
        console.log(`applied ${f}`);
      } catch (err) {
        await pool.query("ROLLBACK");
        throw err;
      }
    }
    console.log("migrations complete");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
