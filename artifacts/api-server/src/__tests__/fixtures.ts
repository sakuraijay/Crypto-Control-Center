/**
 * Shared test fixtures for AI engine tests.
 *
 * All values are chosen to be safe "neutral" inputs that avoid triggering
 * safety gates unless a specific test overrides them.
 */
import type { SymbolAnalysis, Position, RiskLimits } from '../workers/serverTypes';
import type { EngineInput } from '../workers/stateEngine';

// ── Thresholds (mirrors stateEngine.ts THRESHOLDS) ───────────────────────────
export const T = {
  SPOT_BULLISH_MIN:     60,
  LONG_BULLISH_MIN:     68,
  SHORT_BEARISH_MIN:    68,
  HEDGE_COUNTER_SIGNAL: 55,
  HEDGE_DRAWDOWN_PCT:   4,
  CASH_MAX_SIGNAL:      44,
  HIGH_VOL_ATR_PCT:     8,
  SPOT_ATR_MAX:         1.5,
} as const;

// ── Default limits (safe defaults that do NOT trigger secondary risk gates) ───
//
// maxMarginPerTrade = 2000: 충분히 커서 SPOT(sizeUsd≤1500) / HEDGE(collateral≤1000) 통과
// maxTotalExposureUSDT = 50000: 포지션+신규 합산이 초과되지 않도록
// maxRiskPerSymbolPct = 0: disabled — 심볼별 한도 체크 비활성화
export const BASE_LIMITS: RiskLimits = {
  dailyLossLimitUSDT:      500,
  maxDrawdownPercent:       20,
  consecutiveLossLimit:      5,
  maxLeverage:              10,
  maxMarginPerTrade:      2_000,   // ↑ was 200 — secondary gate: collateral ≤ maxMarginPerTrade
  maxTotalExposureUSDT:  50_000,   // ↑ was 5000  — exposure gate: position+new ≤ limit
  tradingCapital:        10_000,
  reserveCashPct:            20,
  profitLockThresholdPct:     1,
  maxSimultaneousPositions:   5,
  maxRiskPerSymbolPct:        0,   // ↓ was 2 — 0 = disabled (skip symbol margin cap)
  weeklyLossLimitUSDT:    1_500,
  rolling24hLossLimitUSDT:    0,
  cooldownMinutes:           30,
  maxTradesPerHour:           6,
};

// ── Default account (no losses, sufficient balance) ───────────────────────────
export const BASE_ACCOUNT = {
  balance:          10_000,
  availableBalance:  8_000,
  unrealizedPnl:         0,
  realizedPnlToday:      0,
};

// ── Indicator factory ─────────────────────────────────────────────────────────
export function makeIndicators(
  atrPct = 2.0,
  emaCross: 'bullish' | 'bearish' | 'neutral' = 'neutral',
) {
  return {
    rsi14:          50,
    ema9:        50_000,
    ema21:       50_000,
    emaCross,
    atrPct,
    priceChange24h: 0,
    priceChange1h:  0,
    momentum:       0,
    trend:         'sideways' as const,
  };
}

// ── SymbolAnalysis factory ────────────────────────────────────────────────────
export function makeAnalysis(overrides: Partial<SymbolAnalysis> = {}): SymbolAnalysis {
  return {
    symbol:           'BTC',
    displaySymbol:    'BTC/USD',
    price:            50_000,
    indicators:       makeIndicators(),
    bullishScore:     50,
    bearishScore:     50,
    directionalBias:   0,
    opportunityScore: 50,
    ...overrides,
  };
}

// ── Position factory ──────────────────────────────────────────────────────────
export function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    symbol:       'BTC',
    side:         'LONG',
    sizeInUsd:    5_000,
    collateralUsd: 1_000,
    unrealizedPnl:     0,
    entryPrice:   50_000,
    leverage:          5,
    ...overrides,
  };
}

// ── EngineInput factory ───────────────────────────────────────────────────────
export function makeInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    cycleNumber:              1,
    prevState:             'CASH',
    analyses:                 [],
    positions:                [],
    account:          BASE_ACCOUNT,
    limits:           BASE_LIMITS,
    engineState:  'PAPER_TRADING',
    consecutiveLosses:         0,
    dataFreshMs:           1_000,   // fresh data
    dailyRealizedPnlUsd:       0,
    tradingCapital:       10_000,
    weeklyRealizedPnlUsd:      0,
    rolling24hRealizedPnlUsd:  0,
    accountDrawdownPct:        0,
    ...overrides,
  };
}

// ── State-specific analysis presets ──────────────────────────────────────────

/** Inputs that produce CASH: signal well below CASH_MAX_SIGNAL */
export const CASH_ANALYSIS = makeAnalysis({
  bullishScore:     30,
  bearishScore:     30,
  opportunityScore: 30,
  indicators:       makeIndicators(2.0),
});

/** Inputs that produce LONG: bullish ≥ 68, ATR ≥ 1.5% */
export const LONG_ANALYSIS = makeAnalysis({
  bullishScore:     70,
  bearishScore:     20,
  directionalBias:  50,
  opportunityScore: 80,
  indicators:       makeIndicators(2.0, 'bullish'),
});

/** Inputs that produce SHORT: bearish ≥ 68, ATR ≥ 1.5% */
export const SHORT_ANALYSIS = makeAnalysis({
  bearishScore:     70,
  bullishScore:     20,
  directionalBias: -50,
  opportunityScore: 80,
  indicators:       makeIndicators(2.0, 'bearish'),
});

/** Inputs that produce SPOT: bullish ≥ 60, ATR < 1.5% */
export const SPOT_ANALYSIS = makeAnalysis({
  bullishScore:     65,
  bearishScore:     20,
  directionalBias:  30,
  opportunityScore: 70,
  indicators:       makeIndicators(0.8, 'bullish'),
});

/** Inputs that produce HEDGE: counter-signal ≥ 55, ATR = 1.0% (well below HIGH_VOL) */
export const HEDGE_ANALYSIS = makeAnalysis({
  bullishScore:     55,  // ≥ HEDGE_COUNTER_SIGNAL
  bearishScore:     30,
  opportunityScore: 60,
  indicators:       makeIndicators(1.0),
});

/**
 * Position whose unrealized loss drawdown = 4% of collateral.
 * Triggers HEDGE evaluation (HEDGE_DRAWDOWN_PCT = 4).
 * max drawdown = 4% < maxDrawdownPercent * 0.9 = 18% → NOT CRITICAL risk level.
 */
export const HEDGE_POSITION = makePosition({
  unrealizedPnl: -40,   // 40/1000 * 100 = 4% drawdown
  collateralUsd: 1_000,
});
