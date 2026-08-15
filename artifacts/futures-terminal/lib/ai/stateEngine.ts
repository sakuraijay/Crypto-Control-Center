/**
 * AI State Selection Engine (mobile port)
 *
 * Pure function — takes market data + system state → returns AiEngineDecision.
 * No side effects, no API calls, no React state.
 *
 * State selection thresholds:
 *  SPOT   bullish > 60 AND atr < 1.5%
 *  LONG   bullish > 68 AND atr 1.5–5%
 *  SHORT  bearish > 68 AND atr 1.5–5%
 *  HEDGE  existing positions at risk (drawdown > 4%) AND counter-signal > 55
 *  CASH   everything else, CRITICAL risk, emergency, stale data
 */

import type {
  AiEngineDecision,
  AiOperatingState,
  ExecutionType,
  EntryStyle,
  HedgeParams,
  MarketCondition,
  MarketRanking,
  RiskLevel,
  SymbolAnalysis,
} from './types';
import type { Position } from '@/contexts/TradingContext';
import type { RiskLimits } from '@/contexts/StrategyContext';

// ── Config ────────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  SPOT_BULLISH_MIN: 60,
  LONG_BULLISH_MIN: 68,
  SHORT_BEARISH_MIN: 68,
  HEDGE_COUNTER_SIGNAL: 55,
  HEDGE_DRAWDOWN_PCT: 4,
  CASH_MAX_SIGNAL: 44,
  VOLATILE_ATR_PCT: 5,
  HIGH_VOL_ATR_PCT: 8,
  SPOT_ATR_MAX: 1.5,
} as const;

const LEVERAGE_BY_CONFIDENCE = (confidence: number, atrPct: number): number => {
  const base = confidence >= 85 ? 10 : confidence >= 75 ? 7 : confidence >= 65 ? 5 : 3;
  const volAdj = atrPct > 3 ? 0.6 : atrPct > 2 ? 0.8 : 1;
  return Math.max(2, Math.round(base * volAdj));
};

function deriveMarketCondition(analyses: SymbolAnalysis[]): MarketCondition {
  if (analyses.length === 0) return 'RANGING';
  const avgAtr = analyses.reduce((s, a) => s + a.indicators.atrPct, 0) / analyses.length;
  const avgBias = analyses.reduce((s, a) => s + a.directionalBias, 0) / analyses.length;
  if (avgAtr > THRESHOLDS.HIGH_VOL_ATR_PCT) return 'VOLATILE';
  if (avgBias > 30) return 'TRENDING_UP';
  if (avgBias < -30) return 'TRENDING_DOWN';
  return 'RANGING';
}

function deriveRiskLevel(
  analyses: SymbolAnalysis[],
  positions: Position[],
  consecutiveLosses: number,
  limits: RiskLimits,
  account: { unrealizedPnl: number; realizedPnlToday: number; balance: number },
): RiskLevel {
  const avgAtr = analyses.length > 0
    ? analyses.reduce((s, a) => s + a.indicators.atrPct, 0) / analyses.length
    : 0;
  const totalDailyLoss = account.realizedPnlToday + account.unrealizedPnl;
  const lossLimitPct = limits.dailyLossLimitUSDT > 0
    ? Math.abs(Math.min(0, totalDailyLoss)) / limits.dailyLossLimitUSDT
    : 0;
  const maxDrawdown = positions.length > 0
    ? Math.max(...positions.map(p => p.unrealizedPnl < 0 ? Math.abs(p.unrealizedPnl) / p.collateralUsd * 100 : 0))
    : 0;

  if (
    lossLimitPct > 0.9 ||
    consecutiveLosses >= limits.consecutiveLossLimit ||
    avgAtr > THRESHOLDS.HIGH_VOL_ATR_PCT ||
    maxDrawdown > limits.maxDrawdownPercent * 0.9
  ) return 'CRITICAL';

  if (
    lossLimitPct > 0.5 ||
    consecutiveLosses >= Math.floor(limits.consecutiveLossLimit * 0.7) ||
    avgAtr > THRESHOLDS.VOLATILE_ATR_PCT ||
    maxDrawdown > limits.maxDrawdownPercent * 0.5
  ) return 'HIGH';

  if (lossLimitPct > 0.25 || consecutiveLosses >= 2 || avgAtr > 2.5) return 'MEDIUM';
  return 'LOW';
}

function calcSizeUsd(
  state: AiOperatingState,
  confidence: number,
  limits: RiskLimits,
  availableBalance: number,
): number {
  const confFactor = confidence >= 85 ? 0.5 : confidence >= 75 ? 0.35 : confidence >= 65 ? 0.25 : 0.15;
  const maxByConf  = availableBalance * confFactor;
  const maxByLimits = state === 'SPOT'
    ? limits.maxMarginPerTrade * 3
    : limits.maxMarginPerTrade;
  return Math.max(50, Math.min(maxByConf, maxByLimits, limits.maxTotalExposureUSDT * 0.35));
}

function calcTpSl(
  price: number,
  isLong: boolean,
  atrPct: number,
  confidence: number,
): { tpPrice: number; slPrice: number; trailingStopPct: number } {
  const atrMult = confidence >= 80 ? 3 : confidence >= 70 ? 2.5 : 2;
  const slMult  = 1.5;
  const tpDist  = price * (atrPct / 100) * atrMult;
  const slDist  = price * (atrPct / 100) * slMult;
  const tpPrice = isLong ? price + tpDist : price - tpDist;
  const slPrice = isLong ? price - slDist : price + slDist;
  const trailingStopPct = Math.max(0.8, Math.min(2, atrPct * 0.8));
  return { tpPrice, slPrice, trailingStopPct };
}

function buildHedgeParams(
  riskPositions: Position[],
  bestAnalysis: SymbolAnalysis | undefined,
  limits: RiskLimits,
): HedgeParams | undefined {
  if (riskPositions.length === 0 || !bestAnalysis) return undefined;
  const target = riskPositions.reduce((max, p) =>
    Math.abs(p.unrealizedPnl) > Math.abs(max.unrealizedPnl) ? p : max
  );
  const hedgeDir = target.side === 'LONG' ? 'SHORT' : 'LONG';
  const hedgeSizeUsd = Math.min(target.sizeInUsd * 0.5, limits.maxMarginPerTrade * 5);
  const hedgeLeverage = Math.max(2, Math.min(5, target.leverage * 0.5));
  return {
    symbol: target.symbol,
    direction: hedgeDir,
    sizeUsd: Math.round(hedgeSizeUsd),
    leverage: hedgeLeverage,
    reason: `Protecting ${target.symbol} ${target.side} @ $${target.entryPrice.toFixed(2)} — drawdown ${
      ((Math.abs(target.unrealizedPnl) / target.collateralUsd) * 100).toFixed(1)
    }%`,
  };
}

function buildReasoning(
  state: AiOperatingState,
  best: SymbolAnalysis | null,
  condition: MarketCondition,
  riskLevel: RiskLevel,
  vetoed: boolean,
  vetoReason?: string,
): { stateRationale: string; reasoning: string[] } {
  const bullets: string[] = [];
  if (best) {
    const { rsi14, atrPct, emaCross, priceChange24h } = best.indicators;
    bullets.push(`${best.displaySymbol} RSI=${rsi14.toFixed(0)} — ${rsi14 < 35 ? 'oversold' : rsi14 > 65 ? 'overbought' : 'neutral'}`);
    bullets.push(`EMA(9/21) cross: ${emaCross} | ATR ${atrPct.toFixed(2)}% | 24h ${priceChange24h >= 0 ? '+' : ''}${priceChange24h.toFixed(2)}%`);
    bullets.push(`Directional bias: ${best.directionalBias > 0 ? '▲ bullish' : '▼ bearish'} ${Math.abs(best.directionalBias).toFixed(0)}pts`);
  }
  bullets.push(`Market condition: ${condition.replace(/_/g, ' ')}`);
  bullets.push(`System risk level: ${riskLevel}`);
  if (vetoed && vetoReason) bullets.push(`⛔ Risk veto: ${vetoReason}`);

  const stateDesc: Record<AiOperatingState, string> = {
    SPOT:  `Bullish signal with low volatility — entering SPOT swap on ${best?.displaySymbol ?? '—'}`,
    LONG:  `Strong bullish signal — opening leveraged LONG on ${best?.displaySymbol ?? '—'}`,
    SHORT: `Strong bearish signal — opening leveraged SHORT on ${best?.displaySymbol ?? '—'}`,
    HEDGE: `Risk detected in existing positions — opening hedge`,
    CASH:  vetoed ? `Risk veto: ${vetoReason ?? 'safety condition'}` : `Insufficient directional edge — holding CASH`,
  };
  return { stateRationale: stateDesc[state], reasoning: bullets };
}

// ── Main engine function ──────────────────────────────────────────────────────

export interface EngineInput {
  cycleNumber: number;
  prevState: AiOperatingState;
  analyses: SymbolAnalysis[];
  positions: Position[];
  account: { balance: number; availableBalance: number; unrealizedPnl: number; realizedPnlToday: number };
  limits: RiskLimits;
  engineState: string;
  consecutiveLosses: number;
  dataFreshMs: number;
}

export function runAiEngine(
  input: EngineInput,
): Omit<AiEngineDecision, 'id' | 'createdAt' | 'paperExecuted' | 'paperOrderId'> {
  const { cycleNumber, prevState, analyses, positions, account, limits, engineState, consecutiveLosses, dataFreshMs } = input;

  const CASH_DECISION = (reason: string, riskApproved = false) => {
    const { stateRationale, reasoning } = buildReasoning('CASH', null, 'RANGING', 'CRITICAL', true, reason);
    return {
      cycleNumber, prevState, operatingState: 'CASH' as AiOperatingState,
      stateChanged: prevState !== 'CASH', selectedSymbols: [], primarySymbol: null,
      confidence: 0, marketCondition: 'RANGING' as const, riskLevel: 'CRITICAL' as const,
      symbolAnalyses: analyses, marketRankings: [] as MarketRanking[],
      executionType: 'hold' as ExecutionType, entryStyle: 'none' as EntryStyle,
      stateRationale, reasoning, riskApproved, riskVetoReason: reason,
    };
  };

  if (engineState === 'EMERGENCY_STOP') return CASH_DECISION('Emergency stop active');
  if (dataFreshMs > 60_000) return CASH_DECISION(`Price data stale (${Math.round(dataFreshMs / 1000)}s old)`);
  if (analyses.length === 0) return CASH_DECISION('No market data available');

  const condition = deriveMarketCondition(analyses);
  const riskLevel = deriveRiskLevel(analyses, positions, consecutiveLosses, limits, account);

  if (riskLevel === 'CRITICAL') return CASH_DECISION('Risk level CRITICAL — no new positions');

  const riskPositions = positions.filter(p => {
    const drawdownPct = p.collateralUsd > 0 ? (Math.abs(Math.min(0, p.unrealizedPnl)) / p.collateralUsd) * 100 : 0;
    return drawdownPct >= THRESHOLDS.HEDGE_DRAWDOWN_PCT;
  });

  const sorted = [...analyses].sort((a, b) => b.opportunityScore - a.opportunityScore);
  const best = sorted[0] ?? null;
  if (!best) return CASH_DECISION('No scoreable symbols');

  const { bullishScore, bearishScore, directionalBias } = best;
  const avgAtr = analyses.reduce((s, a) => s + a.indicators.atrPct, 0) / analyses.length;

  let state: AiOperatingState;
  let executionType: ExecutionType = 'hold';
  let confidence: number;
  let sizeUsd: number | undefined;
  let leverage: number | undefined;
  let entryStyle: EntryStyle = 'none';
  let tpPrice: number | undefined;
  let slPrice: number | undefined;
  let trailingStopPct: number | undefined;
  let hedgeParams: HedgeParams | undefined;

  const hasOpenPositions = positions.length > 0;

  if (riskPositions.length > 0 && (bearishScore >= THRESHOLDS.HEDGE_COUNTER_SIGNAL || bullishScore >= THRESHOLDS.HEDGE_COUNTER_SIGNAL)) {
    state = 'HEDGE';
    confidence = Math.min(90, Math.max(bearishScore, bullishScore));
    hedgeParams = buildHedgeParams(riskPositions, best, limits);
    sizeUsd = hedgeParams?.sizeUsd;
    leverage = hedgeParams?.leverage;
    executionType = 'hedge_open';
    entryStyle = 'immediate';
    if (hedgeParams && best.price > 0) {
      const isHedgeLong = hedgeParams.direction === 'LONG';
      const tpsl = calcTpSl(best.price, isHedgeLong, avgAtr, confidence);
      tpPrice = tpsl.tpPrice; slPrice = tpsl.slPrice;
    }
  } else if (Math.max(bullishScore, bearishScore) < THRESHOLDS.CASH_MAX_SIGNAL || avgAtr > THRESHOLDS.HIGH_VOL_ATR_PCT) {
    state = 'CASH';
    confidence = 100 - Math.max(bullishScore, bearishScore);
    executionType = 'hold'; entryStyle = 'none';
  } else if (bullishScore >= THRESHOLDS.LONG_BULLISH_MIN && avgAtr >= THRESHOLDS.SPOT_ATR_MAX) {
    state = 'LONG';
    confidence = Math.min(95, bullishScore + (directionalBias > 40 ? 10 : 0));
    leverage = LEVERAGE_BY_CONFIDENCE(confidence, avgAtr);
    sizeUsd = calcSizeUsd('LONG', confidence, limits, account.availableBalance) * leverage;
    executionType = hasOpenPositions ? 'scale_in' : 'perp_long_open';
    entryStyle = confidence >= 80 ? 'immediate' : 'scaled';
    const tpsl = calcTpSl(best.price, true, avgAtr, confidence);
    tpPrice = tpsl.tpPrice; slPrice = tpsl.slPrice; trailingStopPct = tpsl.trailingStopPct;
  } else if (bearishScore >= THRESHOLDS.SHORT_BEARISH_MIN && avgAtr >= THRESHOLDS.SPOT_ATR_MAX) {
    state = 'SHORT';
    confidence = Math.min(95, bearishScore + (directionalBias < -40 ? 10 : 0));
    leverage = LEVERAGE_BY_CONFIDENCE(confidence, avgAtr);
    sizeUsd = calcSizeUsd('SHORT', confidence, limits, account.availableBalance) * leverage;
    executionType = hasOpenPositions ? 'scale_in' : 'perp_short_open';
    entryStyle = confidence >= 80 ? 'immediate' : 'scaled';
    const tpsl = calcTpSl(best.price, false, avgAtr, confidence);
    tpPrice = tpsl.tpPrice; slPrice = tpsl.slPrice; trailingStopPct = tpsl.trailingStopPct;
  } else if (bullishScore >= THRESHOLDS.SPOT_BULLISH_MIN && avgAtr < THRESHOLDS.SPOT_ATR_MAX) {
    state = 'SPOT';
    confidence = Math.min(90, bullishScore);
    sizeUsd = calcSizeUsd('SPOT', confidence, limits, account.availableBalance) * 3;
    executionType = 'spot_swap'; entryStyle = 'immediate';
  } else {
    state = 'CASH'; confidence = 75; executionType = 'hold'; entryStyle = 'none';
  }

  let riskApproved = true;
  let riskVetoReason: string | undefined;

  if (state !== 'CASH') {
    const totalExposure = positions.reduce((s, p) => s + p.sizeInUsd, 0) + (sizeUsd ?? 0);
    if (totalExposure > limits.maxTotalExposureUSDT) {
      riskApproved = false;
      riskVetoReason = `Total exposure $${totalExposure.toFixed(0)} would exceed limit $${limits.maxTotalExposureUSDT.toLocaleString()}`;
      state = 'CASH'; executionType = 'hold';
    }
    if ((sizeUsd ?? 0) / (leverage ?? 1) > limits.maxMarginPerTrade) {
      riskApproved = false;
      riskVetoReason = `Collateral $${((sizeUsd ?? 0) / (leverage ?? 1)).toFixed(0)} exceeds per-trade limit $${limits.maxMarginPerTrade}`;
      state = 'CASH'; executionType = 'hold';
    }
    if (positions.length >= limits.maxSimultaneousPositions && state !== 'HEDGE') {
      riskApproved = false;
      riskVetoReason = `Max simultaneous positions (${limits.maxSimultaneousPositions}) reached`;
      state = 'CASH'; executionType = 'hold';
    }
  }

  const selectedSymbols = state === 'HEDGE' && hedgeParams
    ? [hedgeParams.symbol]
    : sorted.slice(0, 3).map(a => a.symbol);

  const { stateRationale, reasoning } = buildReasoning(state, best, condition, riskLevel, !riskApproved, riskVetoReason);

  const marketRankings: MarketRanking[] = sorted.map((a, i) => {
    const isBull = a.bullishScore >= THRESHOLDS.LONG_BULLISH_MIN;
    const isBear = a.bearishScore >= THRESHOLDS.SHORT_BEARISH_MIN;
    const direction: 'LONG' | 'SHORT' | 'NEUTRAL' =
      isBull && a.bullishScore > a.bearishScore ? 'LONG' :
      isBear && a.bearishScore > a.bullishScore ? 'SHORT' : 'NEUTRAL';
    return {
      symbol: a.symbol, displaySymbol: a.displaySymbol, rank: i + 1,
      direction, opportunityScore: Math.round(a.opportunityScore),
      bullishScore: Math.round(a.bullishScore), bearishScore: Math.round(a.bearishScore),
      confidence: Math.round(Math.max(a.bullishScore, a.bearishScore)),
      atrPct: a.indicators.atrPct, price: a.price,
      priceChange24h: a.indicators.priceChange24h,
    };
  });

  return {
    cycleNumber, prevState,
    operatingState: state, stateChanged: prevState !== state,
    selectedSymbols, primarySymbol: best?.symbol ?? null,
    confidence: Math.round(confidence),
    marketCondition: condition, riskLevel, symbolAnalyses: sorted,
    marketRankings,
    executionType,
    sizeUsd: sizeUsd !== undefined ? Math.round(sizeUsd) : undefined,
    leverage, entryStyle, tpPrice, slPrice, trailingStopPct, hedgeParams,
    stateRationale, reasoning, riskApproved, riskVetoReason,
  };
}
