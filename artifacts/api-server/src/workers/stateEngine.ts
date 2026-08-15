/**
 * AI State Selection Engine — server-side copy.
 * Pure function: takes market data + system state → returns AI decision.
 * Mirrors artifacts/futures-web/src/lib/ai/stateEngine.ts.
 * Adapted to use local server type definitions.
 */

import type {
  AiOperatingState,
  ExecutionType,
  EntryStyle,
  HedgeParams,
  MarketCondition,
  MarketRanking,
  RiskLevel,
  SymbolAnalysis,
  Position,
  RiskLimits,
} from './serverTypes';

// ── Config constants ──────────────────────────────────────────────────────────

const THRESHOLDS = {
  SPOT_BULLISH_MIN:     60,
  LONG_BULLISH_MIN:     68,
  SHORT_BEARISH_MIN:    68,
  HEDGE_COUNTER_SIGNAL: 55,
  HEDGE_DRAWDOWN_PCT:   4,
  CASH_MAX_SIGNAL:      44,
  VOLATILE_ATR_PCT:     5,
  HIGH_VOL_ATR_PCT:     8,
  SPOT_ATR_MAX:         1.5,
} as const;

const LEVERAGE_BY_CONFIDENCE = (confidence: number, atrPct: number): number => {
  const base = confidence >= 85 ? 10 : confidence >= 75 ? 7 : confidence >= 65 ? 5 : 3;
  const volAdj = atrPct > 3 ? 0.6 : atrPct > 2 ? 0.8 : 1;
  return Math.max(2, Math.round(base * volAdj));
};

// ── Market condition ──────────────────────────────────────────────────────────

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

  if (
    lossLimitPct > 0.25 ||
    consecutiveLosses >= 2 ||
    avgAtr > 2.5
  ) return 'MEDIUM';

  return 'LOW';
}

// ── Position size calculation ─────────────────────────────────────────────────

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

  if (availableBalance <= 0) return 0;
  return Math.max(Math.min(50, availableBalance), Math.min(maxByConf, maxByLimits, limits.maxTotalExposureUSDT * 0.35));
}

// ── TP / SL generation ───────────────────────────────────────────────────────

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

// ── Hedge params ──────────────────────────────────────────────────────────────

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
  const hedgeSizeUsd = Math.min(
    target.sizeInUsd * 0.5,
    limits.maxMarginPerTrade * 5,
  );
  const maxLev = limits.maxLeverage ?? 5;
  const hedgeLeverage = Math.min(Math.max(2, Math.min(5, target.leverage * 0.5)), maxLev);
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

// ── Reasoning builder ─────────────────────────────────────────────────────────

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

// ── Profit-lock stage ─────────────────────────────────────────────────────────

function computeProfitLockStage(
  dailyRealizedPnlUsd: number,
  tradingCapital: number,
  thresholdPct: number,
): 0 | 1 | 2 | 3 {
  if (tradingCapital <= 0 || thresholdPct <= 0 || dailyRealizedPnlUsd <= 0) return 0;
  const thresholdUsd = tradingCapital * (thresholdPct / 100);
  if (dailyRealizedPnlUsd >= thresholdUsd * 3) return 3;
  if (dailyRealizedPnlUsd >= thresholdUsd * 2) return 2;
  if (dailyRealizedPnlUsd >= thresholdUsd)     return 1;
  return 0;
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
  dailyRealizedPnlUsd: number;
  tradingCapital: number;
}

export function runAiEngine(
  input: EngineInput,
): Omit<import('./serverTypes').ServerAiDecision, 'id' | 'createdAt' | 'paperExecuted' | 'paperOrderId' | 'source'> {
  const {
    cycleNumber, prevState, analyses, positions, account,
    limits, engineState, consecutiveLosses, dataFreshMs,
    dailyRealizedPnlUsd, tradingCapital,
  } = input;

  const profitLockStage = computeProfitLockStage(
    dailyRealizedPnlUsd,
    tradingCapital > 0 ? tradingCapital : (limits.tradingCapital ?? 10_000),
    limits.profitLockThresholdPct ?? 1,
  );

  const CASH_DECISION = (reason: string, riskApproved = false) => {
    const { stateRationale, reasoning } = buildReasoning('CASH', null, 'RANGING', 'CRITICAL', true, reason);
    return {
      cycleNumber, prevState, operatingState: 'CASH' as AiOperatingState,
      stateChanged: prevState !== 'CASH', selectedSymbols: [], primarySymbol: null,
      confidence: 0, marketCondition: 'RANGING' as const, riskLevel: 'CRITICAL' as const,
      symbolAnalyses: analyses, marketRankings: [] as MarketRanking[],
      executionType: 'hold' as ExecutionType, entryStyle: 'none' as EntryStyle,
      stateRationale, reasoning, riskApproved, riskVetoReason: reason,
      profitLockStage,
    };
  };

  if (engineState === 'EMERGENCY_STOP') return CASH_DECISION('Emergency stop active');
  if (dataFreshMs > 60_000) return CASH_DECISION(`Price data stale (${Math.round(dataFreshMs / 1000)}s old)`);
  if (analyses.length === 0) return CASH_DECISION('No market data available');

  const condition = deriveMarketCondition(analyses);
  const riskLevel = deriveRiskLevel(analyses, positions, consecutiveLosses, limits, account);

  if (riskLevel === 'CRITICAL') return CASH_DECISION('Risk level CRITICAL — no new positions');

  const riskPositions = positions.filter(p => {
    const drawdownPct = p.collateralUsd > 0
      ? (Math.abs(Math.min(0, p.unrealizedPnl)) / p.collateralUsd) * 100
      : 0;
    return drawdownPct >= THRESHOLDS.HEDGE_DRAWDOWN_PCT;
  });

  const sorted = [...analyses].sort((a, b) => b.opportunityScore - a.opportunityScore);
  const best = sorted[0] ?? null;

  if (!best) return CASH_DECISION('No scoreable symbols');

  const { bullishScore, bearishScore, directionalBias } = best;
  const avgAtr = analyses.reduce((s, a) => s + a.indicators.atrPct, 0) / analyses.length;

  const longBullishMin  = profitLockStage >= 2 ? THRESHOLDS.LONG_BULLISH_MIN  + 10 : THRESHOLDS.LONG_BULLISH_MIN;
  const shortBearishMin = profitLockStage >= 2 ? THRESHOLDS.SHORT_BEARISH_MIN + 10 : THRESHOLDS.SHORT_BEARISH_MIN;
  const spotBullishMin  = profitLockStage >= 2 ? THRESHOLDS.SPOT_BULLISH_MIN  + 10 : THRESHOLDS.SPOT_BULLISH_MIN;

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

  const reservedCash = (limits.tradingCapital ?? 10_000) * ((limits.reserveCashPct ?? 0) / 100);
  const deployableBalance = Math.max(0, account.availableBalance - reservedCash);

  // Priority 1: HEDGE
  if (
    riskPositions.length > 0 &&
    (bearishScore >= THRESHOLDS.HEDGE_COUNTER_SIGNAL || bullishScore >= THRESHOLDS.HEDGE_COUNTER_SIGNAL)
  ) {
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
      tpPrice = tpsl.tpPrice;
      slPrice = tpsl.slPrice;
    }
  }
  // Priority 2: CASH — insufficient edge or too volatile
  else if (
    Math.max(bullishScore, bearishScore) < THRESHOLDS.CASH_MAX_SIGNAL ||
    avgAtr > THRESHOLDS.HIGH_VOL_ATR_PCT
  ) {
    state = 'CASH';
    confidence = 100 - Math.max(bullishScore, bearishScore);
    executionType = 'hold';
    entryStyle = 'none';
  }
  // Priority 3: LONG
  else if (bullishScore >= longBullishMin && avgAtr >= THRESHOLDS.SPOT_ATR_MAX) {
    state = 'LONG';
    confidence = Math.min(95, bullishScore + (directionalBias > 40 ? 10 : 0));
    leverage = Math.min(LEVERAGE_BY_CONFIDENCE(confidence, avgAtr), limits.maxLeverage ?? 10);
    sizeUsd = calcSizeUsd('LONG', confidence, limits, deployableBalance) * leverage;
    executionType = hasOpenPositions ? 'scale_in' : 'perp_long_open';
    entryStyle = confidence >= 80 ? 'immediate' : 'scaled';
    const tpsl = calcTpSl(best.price, true, avgAtr, confidence);
    tpPrice = tpsl.tpPrice; slPrice = tpsl.slPrice; trailingStopPct = tpsl.trailingStopPct;
  }
  // Priority 4: SHORT
  else if (bearishScore >= shortBearishMin && avgAtr >= THRESHOLDS.SPOT_ATR_MAX) {
    state = 'SHORT';
    confidence = Math.min(95, bearishScore + (directionalBias < -40 ? 10 : 0));
    leverage = Math.min(LEVERAGE_BY_CONFIDENCE(confidence, avgAtr), limits.maxLeverage ?? 10);
    sizeUsd = calcSizeUsd('SHORT', confidence, limits, deployableBalance) * leverage;
    executionType = hasOpenPositions ? 'scale_in' : 'perp_short_open';
    entryStyle = confidence >= 80 ? 'immediate' : 'scaled';
    const tpsl = calcTpSl(best.price, false, avgAtr, confidence);
    tpPrice = tpsl.tpPrice; slPrice = tpsl.slPrice; trailingStopPct = tpsl.trailingStopPct;
  }
  // Priority 5: SPOT
  else if (bullishScore >= spotBullishMin && avgAtr < THRESHOLDS.SPOT_ATR_MAX) {
    state = 'SPOT';
    confidence = Math.min(90, bullishScore);
    sizeUsd = calcSizeUsd('SPOT', confidence, limits, deployableBalance);
    executionType = 'spot_swap';
    entryStyle = 'immediate';
  }
  // Fallback: CASH
  else {
    state = 'CASH';
    confidence = 75;
    executionType = 'hold';
    entryStyle = 'none';
  }

  // ── Profit-lock application ───────────────────────────────────────────────
  if (profitLockStage > 0 && state !== 'CASH') {
    const exposureMultiplier =
      profitLockStage === 1 ? 0.75 :
      profitLockStage === 2 ? 0.50 : 0.25;
    const trailingTightenFactor =
      profitLockStage === 1 ? 0.80 :
      profitLockStage === 2 ? 0.65 : 0.50;
    if (sizeUsd !== undefined) sizeUsd = Math.round(sizeUsd * exposureMultiplier);
    if (trailingStopPct !== undefined)
      trailingStopPct = Math.max(0.3, trailingStopPct * trailingTightenFactor);
    if (profitLockStage >= 3 && executionType === 'scale_in') executionType = 'hold';
  }

  // ── Final reserve guard ───────────────────────────────────────────────────
  if (sizeUsd != null && sizeUsd > 0 && state !== 'CASH') {
    const cashNeeded = (leverage ?? 0) > 0 ? sizeUsd / (leverage as number) : sizeUsd;
    if (cashNeeded > deployableBalance) {
      if (deployableBalance <= 0) {
        sizeUsd = 0; state = 'CASH'; executionType = 'hold';
      } else {
        const scaleFactor = deployableBalance / cashNeeded;
        sizeUsd = Math.floor(sizeUsd * scaleFactor);
      }
    }
  }

  // ── Risk gate (secondary) ─────────────────────────────────────────────────
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
    const maxSim = limits.maxSimultaneousPositions ?? 5;
    if (positions.length >= maxSim && state !== 'HEDGE') {
      riskApproved = false;
      riskVetoReason = `Max simultaneous positions (${maxSim}) reached`;
      state = 'CASH'; executionType = 'hold';
    }
    if (riskApproved && state !== 'CASH' && state !== 'HEDGE' && (limits.maxRiskPerSymbolPct ?? 0) > 0) {
      const primarySym = best?.symbol ?? null;
      if (primarySym) {
        const existingSymbolMargin = positions
          .filter(p => p.symbol === primarySym)
          .reduce((s, p) => s + (p.collateralUsd ?? 0), 0);
        const newMargin = (sizeUsd ?? 0) / Math.max(1, leverage ?? 1);
        const symbolMarginLimit = (limits.tradingCapital ?? 10_000) * ((limits.maxRiskPerSymbolPct ?? 10) / 100);
        if (existingSymbolMargin + newMargin > symbolMarginLimit) {
          riskApproved = false;
          riskVetoReason = `${best?.displaySymbol ?? primarySym} margin $${(existingSymbolMargin + newMargin).toFixed(0)} would exceed cap`;
          state = 'CASH'; executionType = 'hold';
        }
      }
    }
  }

  // ── Build output ──────────────────────────────────────────────────────────
  const selectedSymbols = state === 'HEDGE' && hedgeParams
    ? [hedgeParams.symbol]
    : sorted.slice(0, 3).map(a => a.symbol);

  const { stateRationale, reasoning } = buildReasoning(
    state, best, condition, riskLevel, !riskApproved, riskVetoReason,
  );

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
    cycleNumber, prevState, operatingState: state,
    stateChanged: prevState !== state, selectedSymbols,
    primarySymbol: best?.symbol ?? null,
    confidence: Math.round(confidence),
    marketCondition: condition, riskLevel, symbolAnalyses: sorted,
    marketRankings, executionType,
    sizeUsd: sizeUsd !== undefined ? Math.round(sizeUsd) : undefined,
    leverage, entryStyle, tpPrice, slPrice, trailingStopPct, hedgeParams,
    stateRationale, reasoning, riskApproved, riskVetoReason,
    profitLockStage,
  };
}
