/**
 * AI Trading Engine — 5-State Model
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
  | 'spot_swap'           // GMX on-chain swap (SPOT state)
  | 'perp_long_open'      // GMX perpetual long (LONG state)
  | 'perp_short_open'     // GMX perpetual short (SHORT state)
  | 'perp_close'          // Close existing perpetual
  | 'hedge_open'          // Open hedge against existing position
  | 'scale_in'            // Add to existing position
  | 'scale_out'           // Reduce existing position
  | 'hold'                // No action — maintain current
  | 'cash_exit';          // Exit all to USDC

export type EntryStyle = 'immediate' | 'scaled' | 'wait' | 'none';

export interface IndicatorValues {
  rsi14: number;            // 0–100
  ema9: number;             // fast EMA (price)
  ema21: number;            // slow EMA (price)
  emaCross: 'bullish' | 'bearish' | 'neutral';
  atrPct: number;           // ATR as % of current price
  priceChange24h: number;   // %
  priceChange1h: number;    // % (from recent buffer)
  momentum: number;         // -100 to +100 (short-term price momentum)
  trend: 'up' | 'down' | 'sideways';
}

export interface SymbolAnalysis {
  symbol: string;
  displaySymbol: string;
  price: number;
  indicators: IndicatorValues;
  bullishScore: number;     // 0–100 composite bullish signal
  bearishScore: number;     // 0–100 composite bearish signal
  directionalBias: number;  // −100 (strong bear) → +100 (strong bull)
  opportunityScore: number; // 0–100 overall quality of the setup
}

/**
 * Per-market ranking produced each engine cycle.
 * Lets the operator and UI see exactly which GMX markets the AI is considering
 * and in what priority order.
 */
export interface MarketRanking {
  symbol: string;
  displaySymbol: string;
  rank: number;              // 1 = best opportunity
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  opportunityScore: number;  // 0–100
  bullishScore: number;
  bearishScore: number;
  confidence: number;        // max(bull, bear) rounded
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
  createdAt: string;              // ISO timestamp

  // ── State ──────────────────────────────────────────
  operatingState: AiOperatingState;
  prevState: AiOperatingState;
  stateChanged: boolean;

  // ── Target selection ───────────────────────────────
  selectedSymbols: string[];      // GMX index symbols
  primarySymbol: string | null;   // best opportunity
  confidence: number;             // 0–100

  // ── Market context ─────────────────────────────────
  marketCondition: MarketCondition;
  riskLevel: RiskLevel;
  symbolAnalyses: SymbolAnalysis[];
  /** Ranked list of all analysed markets — updated each cycle */
  marketRankings: MarketRanking[];

  // ── Action parameters ──────────────────────────────
  executionType: ExecutionType;
  sizeUsd?: number;               // total USD position size
  leverage?: number;              // for LONG / SHORT / HEDGE
  entryStyle: EntryStyle;
  limitPrice?: number;
  tpPrice?: number;               // Take Profit price
  slPrice?: number;               // Stop Loss price
  trailingStopPct?: number;       // e.g. 2 = 2% trailing

  // ── Hedge details ──────────────────────────────────
  hedgeParams?: HedgeParams;

  // ── Reasoning ──────────────────────────────────────
  stateRationale: string;         // one-sentence summary
  reasoning: string[];            // detailed bullet points

  // ── Risk gate ──────────────────────────────────────
  riskApproved: boolean;
  riskVetoReason?: string;

  // ── Execution (paper) ──────────────────────────────
  paperExecuted: boolean;
  paperOrderId?: string;

  // ── System health ──────────────────────────────────
  /** Set when the engine skipped execution due to VPS/connectivity issues */
  pausedReason?: string;
}

export interface AiEngineStats {
  totalCycles: number;
  stateDistribution: Record<AiOperatingState, number>;
  currentStreak: { state: AiOperatingState; cycles: number };
  avgConfidence: number;
  lastCycleAt: string | null;
}

/** Price history buffer per symbol — keyed by GMX index symbol */
export type PriceBuffer = Map<string, number[]>;

// ── Live operator approval gate ────────────────────────────────────────────────

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/**
 * A decision that has been queued for operator approval before live execution.
 * Only created when engineState === 'LIVE_TRADING'. Paper mode auto-executes.
 *
 * The operator must approve within APPROVAL_TIMEOUT_MS or the decision expires
 * (market conditions will have changed).
 */
export interface PendingLiveApproval {
  id: string;
  decision: AiEngineDecision;
  createdAt: string;          // ISO
  expiresAt: string;          // ISO — auto-expires after APPROVAL_TIMEOUT_MS
  status: ApprovalStatus;
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  /** Whether the order was actually forwarded to VPS after approval */
  vpsForwarded?: boolean;
  vpsError?: string;
  /**
   * VPS connection config captured at queue time.
   * Used by forwardToVps() so that if the operator changes the VPS host/port
   * while the approval is pending, the order still reaches the intended server.
   */
  vpsSnapshot?: { host: string; port: string; useSSL: boolean };
}

/** How long the operator has to approve before a queued decision expires (ms) */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
