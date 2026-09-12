import { pgTable, text, numeric, bigint, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
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

  // ── 서버 권위 PAPER 실행 필드 (0029 — additive, nullable) ─────────────────
  /** 'SERVER' = 서버 Worker가 체결·관리·정산하는 행. null = 클라이언트/legacy */
  managedBy:             text("managed_by"),
  /** OPEN을 생성한 서버 AI 결정 id — UNIQUE partial index로 결정당 1회 보장 */
  openDecisionId:        text("open_decision_id"),
  /** CLOSE 행이 청산한 OPEN 행 id — FULL은 UNIQUE partial index로 중복 청산 차단 */
  closesTradeId:         text("closes_trade_id"),
  /** 'FULL' | 'REDUCE70' */
  closeKind:             text("close_kind"),
  /** 청산 사유 ('STOP_LOSS'|'TAKE_PROFIT'|'CASH_TRANSITION'|'RISK_CLOSE_ALL'|...) */
  closeReason:           text("close_reason"),
  /** 서버 관리 stop trigger (USD) — OPEN 행에만 */
  stopPriceUsd:          numeric("stop_price_usd",        { precision: 18, scale: 8 }),
  /** 서버 관리 take-profit (USD, null = TP 없음) — OPEN 행에만 */
  takeProfitPriceUsd:    numeric("take_profit_price_usd", { precision: 18, scale: 8 }),
  /** 진입/청산 당시 적용된 버전 프로필과 파생 한도 불변 스냅샷 */
  riskProfileSnapshot:   jsonb("risk_profile_snapshot"),
  /** 서버 PAPER 미청산 슬롯. 1 또는 2이며 partial unique index가 최종 강제한다. */
  paperPositionSlot:     integer("paper_position_slot"),

  // ── CLOSE 결산 결속 필드 (0030 — additive, nullable) ────────────────────────
  /**
   * CLOSE 정산 행이 결속된 계정 주소 (GMX main wallet, 소문자 정규화).
   * OPEN 행 및 non-CLOSE 행은 null.
   */
  settlementAccount:        text("settlement_account"),
  /**
   * CLOSE 정산 행이 결속된 GMX 마켓 토큰 주소 (소문자 정규화).
   * executeViaGmxApi에서 marketAddress 일치 검증의 권위 소스.
   */
  settlementMarketAddress:  text("settlement_market_address"),
  /**
   * CLOSE 정산 행이 결속된 담보 토큰 주소 (소문자 정규화).
   * 온체인 canonical 포지션 키 재구성에 필요한 exact 담보 토큰.
   */
  settlementCollateralToken: text("settlement_collateral_token"),
  /**
   * keccak256(account || market || collateralToken || isLong) — GMX V2 canonical position key.
   * 정산 행의 정확한 포지션 식별자 (PositionReader 반환값과 일치해야 한다).
   */
  settlementPositionKey:    text("settlement_position_key"),
  /**
   * CLOSE 제출 직전 온체인에서 확인된 포지션 크기 (USD, numeric string).
   * 이 값에서 requestedReductionUsd가 차감된다.
   */
  preCloseSizeUsd:           numeric("pre_close_size_usd", { precision: 18, scale: 4 }),
  /** PositionReader의 exact sizeInUsd uint256 (1e30 정수 문자열). */
  preCloseSizeUsd30:         text("pre_close_size_usd_30"),
  /**
   * 이 CLOSE 주문이 요청한 감소 크기 (USD, numeric string).
   * 전량 청산 = preCloseSizeUsd 와 동일, 부분 청산 = 부분값.
   */
  requestedReductionUsd:     numeric("requested_reduction_usd", { precision: 18, scale: 4 }),
  /** prepare 요청의 exact sizeDeltaUsd uint256 (1e30 정수 문자열). */
  requestedReductionUsd30:   text("requested_reduction_usd_30"),
  /**
   * CLOSE 행을 생성한 execution intent id (settlement:close:<intentId> 형식).
   * 이 행과 execution_intents 행을 연결하는 durable linkage.
   */
  settlementIntentId:        text("settlement_intent_id"),
  settlementRelayTaskId:     text("settlement_relay_task_id"),
  settlementOrderKey:        text("settlement_order_key"),
  settlementEmitterAddress:  text("settlement_emitter_address"),
  settlementBlockNumber:     text("settlement_block_number"),
  settlementLatestBlock:     text("settlement_latest_block"),
  settlementConfirmations:   integer("settlement_confirmations"),
  settlementEvidenceBasis:   text("settlement_evidence_basis"),
  settlementEvidenceAt:      timestamp("settlement_evidence_at", { withTimezone: true }),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type DbTrade = typeof tradesTable.$inferSelect;
