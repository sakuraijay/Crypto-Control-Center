-- Migration 0001: Add GMX V2 fields to trades table
-- Additive, idempotent (IF NOT EXISTS) — safe to run on existing databases.
-- Applied automatically by `pnpm --filter @workspace/db run migrate`.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS gmx_market_address text,
  ADD COLUMN IF NOT EXISTS collateral_token    text DEFAULT 'USDC',
  ADD COLUMN IF NOT EXISTS size_in_usd         numeric(18,4);
