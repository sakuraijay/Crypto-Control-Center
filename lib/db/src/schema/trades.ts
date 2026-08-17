import { pgTable, text, numeric, bigint, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Persistent trade log for paper-trading sessions.
 * Both OPEN and CLOSE actions are stored so activity history survives
 * browser/app storage clears.
 *
 * GMX V2 fields (nullable — existing rows keep NULL, fully backwards-compatible):
 *   gmxMarketAddress — GMX market token address (e.g. ETH/USD market)
 *   collateralToken  — USDC | WBTC.b | ETH (GMX-native collateral)
 *   sizeInUsd        — position size in USD (GMX-native denomination)
 */
export const tradesTable = pgTable("trades", {
  id:        text("id").primaryKey(),
  symbol:    text("symbol").notNull(),
  side:      text("side").notNull(),    // 'LONG' | 'SHORT'
  action:    text("action").notNull(),  // 'OPEN' | 'CLOSE'
  size:      numeric("size",  { precision: 18, scale: 8 }).notNull(),
  price:     numeric("price", { precision: 18, scale: 8 }).notNull(),
  pnl:       numeric("pnl",   { precision: 18, scale: 8 }).notNull().default("0"),
  strategy:  text("strategy").notNull().default("Manual"),
  timestamp: timestamp("timestamp").notNull(),
  closeTime: bigint("close_time", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),

  // ── GMX V2 fields (additive, nullable) ───────────────────────────────────
  gmxMarketAddress: text("gmx_market_address"),
  collateralToken:  text("collateral_token").default("USDC"),
  sizeInUsd:        numeric("size_in_usd", { precision: 18, scale: 4 }),

  // ── Risk-engine fields (additive, nullable for backward compat) ───────────
  /** Leverage used at open. Null for legacy rows — treated conservatively as 1x. */
  leverage:         numeric("leverage", { precision: 8, scale: 2 }),
  /** Collateral (margin) in USD at open. Null for legacy rows. */
  collateralUsd:    numeric("collateral_usd", { precision: 18, scale: 4 }),
  /** True for trades recorded during LIVE TEST MODE sessions (default false). */
  testMode:         boolean("test_mode").notNull().default(false),

  // ── Settlement fields (6H-2 §5 — additive, nullable) ──────────────────────
  /** 가격 차이 기반 gross PnL (수수료 미차감) */
  grossPnlUsd:      numeric("gross_pnl_usd",     { precision: 18, scale: 8 }),
  positionFeeUsd:   numeric("position_fee_usd",  { precision: 18, scale: 8 }),
  executionFeeUsd:  numeric("execution_fee_usd", { precision: 18, scale: 8 }),
  priceImpactUsd:   numeric("price_impact_usd",  { precision: 18, scale: 8 }),
  fundingFeeUsd:    numeric("funding_fee_usd",   { precision: 18, scale: 8 }),
  borrowingFeeUsd:  numeric("borrowing_fee_usd", { precision: 18, scale: 8 }),
  /** 실제 순 PnL = gross − 모든 수수료 − impact */
  netPnlUsd:        numeric("net_pnl_usd",       { precision: 18, scale: 8 }),
  /** 'UNSETTLED' | 'SETTLED' | 'PAPER_ESTIMATED' — UNSETTLED 이익은 목표 미반영.
   *  ('PAPER_ZERO_FEE'는 6H-2A에서 폐기된 legacy 값 — 과거 행에만 잔존, 실행 경로 사용 금지) */
  settlementStatus: text("settlement_status").notNull().default("UNSETTLED"),
  settledAt:        timestamp("settled_at", { withTimezone: true }),
  /** 온체인 정산 증거 tx hash — 동일 증거 이중 정산 금지 (unique partial index) */
  evidenceTxHash:   text("evidence_tx_hash"),

  // ── PAPER 추정비용 결속 (6H-2A §3·§4 — additive, nullable) ────────────────
  /** 'PAPER_GMX_ESTIMATE' — null = 비용 불명 (이익 목표 미반영) */
  costSource:            text("cost_source"),
  estEntryCostUsd:       numeric("est_entry_cost_usd",   { precision: 18, scale: 8 }),
  estExitCostUsd:        numeric("est_exit_cost_usd",    { precision: 18, scale: 8 }),
  estHoldingCostUsd:     numeric("est_holding_cost_usd", { precision: 18, scale: 8 }),
  fundingRatePerHour:    numeric("funding_rate_per_hour",   { precision: 18, scale: 12 }),
  borrowingRatePerHour:  numeric("borrowing_rate_per_hour", { precision: 18, scale: 12 }),
  costFetchedAt:         timestamp("cost_fetched_at", { withTimezone: true }),
  /** ESTIMATED 순 PnL = gross − 추정 진입/청산/보유 비용 (SETTLED 아님) */
  netPnlEstimatedUsd:    numeric("net_pnl_estimated_usd", { precision: 18, scale: 8 }),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type DbTrade = typeof tradesTable.$inferSelect;
