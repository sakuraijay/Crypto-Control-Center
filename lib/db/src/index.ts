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
// SQL is embedded directly in code so the bundle can run it without any
// file-system path resolution (the dist/ directory has no migrations/ sibling).
// Each statement uses IF NOT EXISTS so re-running on startup is always safe.

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_gmx_trade_fields",
    sql: `
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS gmx_market_address text,
        ADD COLUMN IF NOT EXISTS collateral_token    text DEFAULT 'USDC',
        ADD COLUMN IF NOT EXISTS size_in_usd         numeric(18,4);
    `,
  },
  {
    name: "0002_ai_full_json",
    sql: `ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS full_json text;`,
  },
  // Add future migrations here in chronological order.
];

/**
 * Apply all embedded migrations against the database.
 * Every statement is idempotent — safe to run on every API server startup.
 * If any migration fails the error propagates and the caller should abort.
 */
export async function runMigrations(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL! });
  await client.connect();
  try {
    for (const { name, sql } of MIGRATIONS) {
      await client.query(sql);
      console.log(`[db] migration applied: ${name}`);
    }
  } finally {
    await client.end();
  }
}
