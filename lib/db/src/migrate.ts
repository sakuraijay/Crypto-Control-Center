/**
 * Simple SQL migration runner.
 * Reads every *.sql file from lib/db/migrations/ in lexicographic order and
 * executes them against the database. Each file is idempotent (uses
 * IF NOT EXISTS / IF EXISTS guards) so running the runner multiple times is safe.
 *
 * Usage:
 *   pnpm --filter @workspace/db run migrate
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — cannot run migrations.");
}

const migrationsDir = path.join(__dirname, "../migrations");

async function runMigrations() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql"))
      .sort();                          // lexicographic = chronological

    for (const file of files) {
      const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
      console.log(`[migrate] applying ${file} …`);
      await client.query(sql);
      console.log(`[migrate] ${file} — done`);
    }

    console.log(`[migrate] all ${files.length} migration(s) applied successfully.`);
  } finally {
    await client.end();
  }
}

runMigrations().catch(err => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
