/**
 * SQL migration runner — pure Node.js ESM, no build step required.
 * Reads every *.sql file from lib/db/migrations/ in lexicographic order and
 * executes them against the database. Each file uses IF NOT EXISTS / IF EXISTS
 * guards so running the runner multiple times is safe.
 *
 * Usage:
 *   pnpm --filter @workspace/db run migrate
 */

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Client } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("[migrate] ERROR: DATABASE_URL is not set.");
  process.exit(1);
}

const migrationsDir = path.join(__dirname, "migrations");

async function runMigrations() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql"))
      .sort();                          // lexicographic = chronological

    if (files.length === 0) {
      console.log("[migrate] No migration files found.");
      return;
    }

    for (const file of files) {
      const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
      console.log(`[migrate] applying ${file} …`);
      await client.query(sql);
      console.log(`[migrate] ${file} — OK`);
    }

    console.log(`[migrate] ✓ ${files.length} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

runMigrations().catch(err => {
  console.error("[migrate] FAILED:", err.message);
  process.exit(1);
});
