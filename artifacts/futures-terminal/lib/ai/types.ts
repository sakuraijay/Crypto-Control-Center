/**
 * AI Trading Engine — 5-State Model  (mobile mirror)
 *
 * SPOT   — bullish signal but leverage risk not justified; use GMX on-chain swap
 * LONG   — strong bullish signal with leverage (GMX Perpetual MarketIncrease)
 * SHORT  — strong bearish signal with leverage (GMX Perpetual MarketIncrease short)
 * HEDGE  — protect existing position when directional risk grows
 * CASH   — no clear edge, high volatility, or safety condition — hold USDC
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

/**
 * Per-market ranking produced each engine cycle.
 */
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

export interface AiEngineDecision {
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
  limitPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  trailingStopPct?: number;

  hedgeParams?: HedgeParams;

  stateRationale: string;
  reasoning: string[];

  riskApproved: boolean;
  riskVetoReason?: string;

  paperExecuted: boolean;
  paperOrderId?: string;

  pausedReason?: string;
}

export interface AiEngineStats {
  totalCycles: number;
  stateDistribution: Record<AiOperatingState, number>;
  currentStreak: { state: AiOperatingState; cycles: number };
  avgConfidence: number;
  lastCycleAt: string | null;
}

export type PriceBuffer = Map<string, number[]>;

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface PendingLiveApproval {
  id: string;
  decision: AiEngineDecision;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  vpsForwarded?: boolean;
  vpsError?: string;
}

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
