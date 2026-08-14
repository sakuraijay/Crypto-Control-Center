import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool, Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";

// ── Migration runner ────────────────────────────────────────────────────────
// Resolves the migrations directory relative to this file so it works
// regardless of where the package is invoked from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "../../migrations");

/**
 * Run all *.sql files from lib/db/migrations/ in lexicographic order.
 * Every SQL file uses IF NOT EXISTS / IF EXISTS guards so this is idempotent.
 * Call this once during API server startup before serving requests.
 */
export async function runMigrations(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL! });
  await client.connect();
  try {
    let files: string[];
    try {
      files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
    } catch {
      // Migrations directory does not exist yet — nothing to apply.
      return;
    }

    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
      console.log(`[db] migration applied: ${file}`);
    }
  } finally {
    await client.end();
  }
}
