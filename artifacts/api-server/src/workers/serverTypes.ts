/**
 * Server-side type definitions for the AI engine.
 * Mirrors the frontend AI types without React/browser dependencies.
 */

export type AiOperatingState = 'SPOT' | 'LONG' | 'SHORT' | 'HEDGE' | 'CASH';

export type MarketCondition =
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'RANGING'
  | 'VOLATILE'
  | 'LOW_LIQUIDITY';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ExecutionType =
  | 'spot_swap'
  | 'perp_long_open'
  | 'perp_short_open'
  | 'perp_close'
  | 'hedge_open'
  | 'scale_in'
  | 'scale_out'
  | 'hold'
  | 'cash_exit';

export type EntryStyle = 'immediate' | 'scaled' | 'wait' | 'none';

export interface IndicatorValues {
  rsi14: number;
  ema9: number;
  ema21: number;
  emaCross: 'bullish' | 'bearish' | 'neutral';
  atrPct: number;
  priceChange24h: number;
  priceChange1h: number;
  momentum: number;
  trend: 'up' | 'down' | 'sideways';
}

export interface SymbolAnalysis {
  symbol: string;
  displaySymbol: string;
  price: number;
  indicators: IndicatorValues;
  bullishScore: number;
  bearishScore: number;
  directionalBias: number;
  opportunityScore: number;
}

export interface MarketRanking {
  symbol: string;
  displaySymbol: string;
  rank: number;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  opportunityScore: number;
  bullishScore: number;
  bearishScore: number;
  confidence: number;
  atrPct: number;
  price: number;
  priceChange24h: number;
}

export interface HedgeParams {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  sizeUsd: number;
  leverage: number;
  reason: string;
}

/** Minimal Position shape used by the AI risk engine (no wallet fields). */
export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  sizeInUsd: number;
  collateralUsd: number;
  unrealizedPnl: number;
  entryPrice: number;
  leverage: number;
}

/** Strategy risk limits — mirrors StrategyContext.RiskLimits. */
export interface RiskLimits {
  dailyLossLimitUSDT: number;
  maxDrawdownPercent: number;
  consecutiveLossLimit: number;
  maxLeverage: number;
  maxMarginPerTrade: number;
  maxTotalExposureUSDT: number;
  tradingCapital: number;
  reserveCashPct: number;
  profitLockThresholdPct?: number;
  maxSimultaneousPositions?: number;
  maxRiskPerSymbolPct?: number;
  /** Weekly loss limit since Monday 00:00 UTC. Mirrors StrategyContext.weeklyLossLimitUSDT. */
  weeklyLossLimitUSDT?: number;
  /** Rolling 24-hour loss limit (USDT). When exceeded the engine immediately returns CASH. 0 = disabled. */
  rolling24hLossLimitUSDT?: number;
  cooldownMinutes?: number;
  maxTradesPerHour?: number;
  // ── LIVE TEST MODE ────────────────────────────────────────────────────────
  /** Activate LIVE TEST MODE safety layer. false = off (default). */
  liveTestMode?: boolean;
  /** Test budget in USD. LIVE TEST mode will block new entries if accumulated losses reach testMaxLossUsd. Default $100. */
  testBudgetUsd?: number;
  /** Maximum accumulated test loss (USD) before emergency stop. Default $50. */
  testMaxLossUsd?: number;
  /** Maximum leverage in LIVE TEST mode (hard cap, default 2×). */
  testMaxLeverage?: number;
  /** Max simultaneous positions in LIVE TEST mode. Always 1 — not configurable. */
  readonly testMaxPositions?: 1;
}

/** Full AI decision record produced by one engine cycle. */
export interface ServerAiDecision {
  id: string;
  cycleNumber: number;
  createdAt: string;
  operatingState: AiOperatingState;
  prevState: AiOperatingState;
  stateChanged: boolean;
  selectedSymbols: string[];
  primarySymbol: string | null;
  confidence: number;
  marketCondition: MarketCondition;
  riskLevel: RiskLevel;
  symbolAnalyses: SymbolAnalysis[];
  marketRankings: MarketRanking[];
  executionType: ExecutionType;
  sizeUsd?: number;
  leverage?: number;
  entryStyle: EntryStyle;
  tpPrice?: number;
  slPrice?: number;
  trailingStopPct?: number;
  hedgeParams?: HedgeParams;
  stateRationale: string;
  reasoning: string[];
  riskApproved: boolean;
  riskVetoReason?: string;
  profitLockStage: 0 | 1 | 2 | 3;
  /** true = 서버 권위 PAPER 실행기가 이 결정으로 실제 OPEN을 기록함 */
  paperExecuted: boolean;
  /** paperExecuted=true일 때 OPEN trade 행 id */
  paperOrderId: string | null;
  /** Source tag to distinguish worker decisions from browser decisions in UI */
  source: 'server_worker';
  /** True when this decision was produced while LIVE TEST MODE was active */
  testMode?: boolean;
}
