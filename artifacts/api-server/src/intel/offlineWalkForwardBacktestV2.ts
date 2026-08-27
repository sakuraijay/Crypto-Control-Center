/**
 * Pure, offline-only BTC walk-forward/OOS simulator.
 *
 * Boundary: immutable historical inputs in, serializable research report out.
 * This module has no DB, network, worker, signer, relay, execution, or order imports.
 */
import type { MarketRegime } from './regimeEngineV2';
import type { StrategyDirection, StrategyId } from './strategySignalV2';
import type { Candle } from './types';

export const OFFLINE_WALK_FORWARD_SCHEMA_VERSION = 'offline-walk-forward/v1' as const;
export const OFFLINE_CONFIDENCE_THRESHOLDS = [60, 65, 70, 75, 80] as const;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

export type OfflineRiskProfile = 'conservative' | 'aggressive';
export type OfflineRiskDecision = 'ALLOW' | 'REDUCE' | 'REJECT';
export type OfflineReportStatus = 'OK' | 'UNAVAILABLE';
export type OfflineExitReason = 'TARGET' | 'STOP' | 'TIME' | 'AMBIGUOUS_STOP_FIRST';
export type OfflineBlockedReason =
  | 'NO_TRADE'
  | 'RISK_BLOCKED'
  | 'INSUFFICIENT_CONFIDENCE'
  | 'NEXT_BAR_UNAVAILABLE'
  | 'COST_UNAVAILABLE'
  | 'INVALID_SIGNAL';

export interface OfflineHistoricalCostEvidence {
  observedAtMs: number;
  feeBpsPerSide: number;
  entrySlippageBps: number;
  exitSlippageBps: number;
  fundingBpsPerHour: number;
  borrowingBpsPerHour: number;
  impactBps: number;
}

/** A read-only projection of the existing strategy/arbiter/risk result at a closed candle. */
export interface OfflineDecision {
  decisionId: string;
  symbol: 'BTC';
  sourceCandleCloseTime: number;
  strategyId: StrategyId | null;
  regime: MarketRegime;
  profile: OfflineRiskProfile;
  direction: StrategyDirection;
  confidence: number;
  structuralStop: number | null;
  targetPrice: number | null;
  riskDecision: OfflineRiskDecision;
  costEvidence: OfflineHistoricalCostEvidence | null;
}

export interface OfflineWalkForwardConfig {
  initialCapitalUsd: number;
  positionSizePct: number;
  trainBars: number;
  oosBars: number;
  stepBars: number;
  purgeBars: number;
  minimumFolds: number;
  maximumHoldingBars: number;
  thresholds: readonly number[];
}

export const DEFAULT_OFFLINE_WALK_FORWARD_CONFIG: OfflineWalkForwardConfig = Object.freeze({
  initialCapitalUsd: 1_000,
  positionSizePct: 0.1,
  trainBars: 96 * 30,
  oosBars: 96 * 7,
  stepBars: 96 * 7,
  purgeBars: 1,
  minimumFolds: 3,
  maximumHoldingBars: 16,
  thresholds: OFFLINE_CONFIDENCE_THRESHOLDS,
});

export interface OfflineCostTotals {
  feesUsd: number;
  slippageUsd: number;
  fundingUsd: number;
  borrowingUsd: number;
  impactUsd: number;
  totalUsd: number;
}

export interface OfflineTrade {
  decisionId: string;
  fold: number;
  sample: 'IS' | 'OOS';
  threshold: number;
  side: Exclude<StrategyDirection, 'NONE'>;
  strategyId: StrategyId;
  regime: MarketRegime;
  profile: OfflineRiskProfile;
  signalCloseTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  riskUsd: number;
  rMultiple: number;
  costs: OfflineCostTotals;
  exitReason: OfflineExitReason;
}

export interface OfflineMetrics {
  tradeCount: number;
  grossReturnPct: number | null;
  netReturnPct: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
  profitFactor: number | null;
  expectancyUsd: number | null;
  averageR: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  costs: OfflineCostTotals;
  equityCurve: Array<{ time: number; equityUsd: number }>;
}

export interface OfflineBreakdownRow {
  trades: number;
  netPnlUsd: number;
}

export interface OfflineSampleResult {
  metrics: OfflineMetrics;
  trades: OfflineTrade[];
  blocked: Record<OfflineBlockedReason, number>;
  breakdown: {
    month: Record<string, OfflineBreakdownRow>;
    direction: Record<string, OfflineBreakdownRow>;
    strategy: Record<string, OfflineBreakdownRow>;
    regime: Record<string, OfflineBreakdownRow>;
    profile: Record<string, OfflineBreakdownRow>;
  };
}

export interface OfflineFoldResult {
  fold: number;
  trainStartTime: number;
  trainEndTime: number;
  oosStartTime: number;
  oosEndTime: number;
  is: OfflineSampleResult;
  oos: OfflineSampleResult;
}

export interface OfflineThresholdResult {
  threshold: number;
  folds: OfflineFoldResult[];
  aggregateOos: OfflineSampleResult;
}

export interface OfflineWalkForwardReport {
  schemaVersion: typeof OFFLINE_WALK_FORWARD_SCHEMA_VERSION;
  status: OfflineReportStatus;
  symbol: 'BTC';
  source: string;
  generatedAtMs: number;
  config: OfflineWalkForwardConfig;
  input: {
    candleCount: number;
    decisionCount: number;
    firstCandleTime: number | null;
    lastCandleTime: number | null;
  };
  issues: string[];
  thresholds: OfflineThresholdResult[];
  autoPromotionAllowed: false;
  liveExecutionAuthorized: false;
}

export interface OfflineWalkForwardInput {
  symbol: 'BTC';
  source: string;
  generatedAtMs: number;
  candles15m: readonly Candle[];
  decisions: readonly OfflineDecision[];
  config?: OfflineWalkForwardConfig;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number): number => Number(value.toPrecision(12));
const zeroCosts = (): OfflineCostTotals => ({
  feesUsd: 0, slippageUsd: 0, fundingUsd: 0, borrowingUsd: 0, impactUsd: 0, totalUsd: 0,
});
const emptyBlocked = (): Record<OfflineBlockedReason, number> => ({
  NO_TRADE: 0,
  RISK_BLOCKED: 0,
  INSUFFICIENT_CONFIDENCE: 0,
  NEXT_BAR_UNAVAILABLE: 0,
  COST_UNAVAILABLE: 0,
  INVALID_SIGNAL: 0,
});

function validateConfig(config: OfflineWalkForwardConfig): string[] {
  const issues: string[] = [];
  if (!finite(config.initialCapitalUsd) || config.initialCapitalUsd <= 0) issues.push('initialCapitalUsd 오류');
  if (!finite(config.positionSizePct) || config.positionSizePct <= 0 || config.positionSizePct > 1) issues.push('positionSizePct 오류');
  for (const key of ['trainBars', 'oosBars', 'stepBars', 'purgeBars', 'minimumFolds', 'maximumHoldingBars'] as const) {
    if (!Number.isInteger(config[key]) || config[key] < (key === 'purgeBars' ? 0 : 1)) issues.push(`${key} 오류`);
  }
  if (config.stepBars < config.oosBars) issues.push('OOS 중복 방지를 위해 stepBars는 oosBars 이상이어야 함');
  if (!Array.isArray(config.thresholds)
    || config.thresholds.length !== OFFLINE_CONFIDENCE_THRESHOLDS.length
    || OFFLINE_CONFIDENCE_THRESHOLDS.some(value => !config.thresholds.includes(value))) {
    issues.push('thresholds는 60/65/70/75/80 동일 조건이어야 함');
  }
  return issues;
}

function validateInputs(input: OfflineWalkForwardInput, config: OfflineWalkForwardConfig): string[] {
  const issues = validateConfig(config);
  if (input.symbol !== 'BTC') issues.push('BTC 전용 연구 입력 필요');
  if (!input.source.trim()) issues.push('데이터 provenance 누락');
  if (!finite(input.generatedAtMs) || input.generatedAtMs <= 0) issues.push('generatedAtMs 오류');
  if (!Array.isArray(input.candles15m) || input.candles15m.length === 0) issues.push('15m candle 없음');

  let previous = -Infinity;
  for (const candle of input.candles15m) {
    if (![candle.t, candle.o, candle.h, candle.l, candle.c].every(finite)
      || candle.v === null || !finite(candle.v) || candle.v < 0
      || candle.o <= 0 || candle.h <= 0 || candle.l <= 0 || candle.c <= 0
      || candle.h < Math.max(candle.o, candle.c) || candle.l > Math.min(candle.o, candle.c)) {
      issues.push(`candle INVALID: ${String(candle.t)}`);
      break;
    }
    if (candle.t % FIFTEEN_MINUTES_MS !== 0) issues.push(`15m 정렬 오류: ${candle.t}`);
    if (previous !== -Infinity && candle.t !== previous + FIFTEEN_MINUTES_MS) {
      issues.push(`중복/역순/gap candle: ${previous} -> ${candle.t}`);
    }
    if (candle.t + FIFTEEN_MINUTES_MS > input.generatedAtMs) issues.push(`미마감/미래 candle: ${candle.t}`);
    previous = candle.t;
  }

  const closeTimes = new Set(input.candles15m.map(candle => candle.t + FIFTEEN_MINUTES_MS));
  const ids = new Set<string>();
  let previousDecisionTime = -Infinity;
  for (const decision of input.decisions) {
    if (!decision.decisionId || ids.has(decision.decisionId)) issues.push(`중복 decisionId: ${decision.decisionId}`);
    ids.add(decision.decisionId);
    if (decision.symbol !== 'BTC' || !closeTimes.has(decision.sourceCandleCloseTime)
      || decision.sourceCandleCloseTime < previousDecisionTime) issues.push(`decision 시각/종목 오류: ${decision.decisionId}`);
    previousDecisionTime = decision.sourceCandleCloseTime;
    if (!finite(decision.confidence) || decision.confidence < 0 || decision.confidence > 100) {
      issues.push(`confidence 오류: ${decision.decisionId}`);
    }
  }
  const minimumBars = config.trainBars + config.purgeBars + config.oosBars
    + (config.minimumFolds - 1) * config.stepBars;
  if (input.candles15m.length < minimumBars) issues.push(`fold 표본 부족: ${input.candles15m.length} < ${minimumBars}`);
  return [...new Set(issues)];
}

function validateCost(cost: OfflineHistoricalCostEvidence | null, decisionTime: number): boolean {
  if (!cost || !finite(cost.observedAtMs) || cost.observedAtMs > decisionTime) return false;
  return finite(cost.feeBpsPerSide) && cost.feeBpsPerSide >= 0
    && finite(cost.entrySlippageBps) && cost.entrySlippageBps >= 0
    && finite(cost.exitSlippageBps) && cost.exitSlippageBps >= 0
    && finite(cost.fundingBpsPerHour)
    && finite(cost.borrowingBpsPerHour) && cost.borrowingBpsPerHour >= 0
    && finite(cost.impactBps) && cost.impactBps >= 0;
}

function addBreakdown(target: Record<string, OfflineBreakdownRow>, key: string, pnl: number): void {
  target[key] ??= { trades: 0, netPnlUsd: 0 };
  target[key].trades += 1;
  target[key].netPnlUsd = round(target[key].netPnlUsd + pnl);
}

function calculateMetrics(trades: OfflineTrade[], initialCapital: number): OfflineMetrics {
  const costs = trades.reduce<OfflineCostTotals>((sum, trade) => ({
    feesUsd: sum.feesUsd + trade.costs.feesUsd,
    slippageUsd: sum.slippageUsd + trade.costs.slippageUsd,
    fundingUsd: sum.fundingUsd + trade.costs.fundingUsd,
    borrowingUsd: sum.borrowingUsd + trade.costs.borrowingUsd,
    impactUsd: sum.impactUsd + trade.costs.impactUsd,
    totalUsd: sum.totalUsd + trade.costs.totalUsd,
  }), zeroCosts());
  for (const key of Object.keys(costs) as Array<keyof OfflineCostTotals>) costs[key] = round(costs[key]);
  if (trades.length === 0) {
    return {
      tradeCount: 0, grossReturnPct: null, netReturnPct: null, winRatePct: null,
      maxDrawdownPct: null, profitFactor: null, expectancyUsd: null, averageR: null,
      sharpe: null, sortino: null, maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
      costs, equityCurve: [],
    };
  }
  const gross = trades.reduce((sum, trade) => sum + trade.grossPnlUsd, 0);
  const net = trades.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  const wins = trades.filter(trade => trade.netPnlUsd > 0);
  const losses = trades.filter(trade => trade.netPnlUsd < 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnlUsd, 0));
  const returns = trades.map(trade => trade.netPnlUsd / initialCapital);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const downside = returns.filter(value => value < 0);
  const downsideDeviation = downside.length === 0 ? null
    : Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length);
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let maxWins = 0;
  let maxLosses = 0;
  const equityCurve = trades.map(trade => {
    equity += trade.netPnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 100);
    if (trade.netPnlUsd > 0) { winStreak += 1; lossStreak = 0; } else { lossStreak += 1; winStreak = 0; }
    maxWins = Math.max(maxWins, winStreak);
    maxLosses = Math.max(maxLosses, lossStreak);
    return { time: trade.exitTime, equityUsd: round(equity) };
  });
  return {
    tradeCount: trades.length,
    grossReturnPct: round(gross / initialCapital * 100),
    netReturnPct: round(net / initialCapital * 100),
    winRatePct: round(wins.length / trades.length * 100),
    maxDrawdownPct: round(maxDrawdownPct),
    profitFactor: grossLosses > 0 ? round(grossWins / grossLosses) : null,
    expectancyUsd: round(net / trades.length),
    averageR: round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length),
    sharpe: variance > 0 ? round(mean / Math.sqrt(variance) * Math.sqrt(trades.length)) : null,
    sortino: downsideDeviation && downsideDeviation > 0 ? round(mean / downsideDeviation * Math.sqrt(trades.length)) : null,
    maxConsecutiveWins: maxWins,
    maxConsecutiveLosses: maxLosses,
    costs,
    equityCurve,
  };
}

function sampleResult(trades: OfflineTrade[], blocked: Record<OfflineBlockedReason, number>, initialCapital: number): OfflineSampleResult {
  const breakdown: OfflineSampleResult['breakdown'] = {
    month: {}, direction: {}, strategy: {}, regime: {}, profile: {},
  };
  for (const trade of trades) {
    addBreakdown(breakdown.month, new Date(trade.exitTime).toISOString().slice(0, 7), trade.netPnlUsd);
    addBreakdown(breakdown.direction, trade.side, trade.netPnlUsd);
    addBreakdown(breakdown.strategy, trade.strategyId, trade.netPnlUsd);
    addBreakdown(breakdown.regime, trade.regime, trade.netPnlUsd);
    addBreakdown(breakdown.profile, trade.profile, trade.netPnlUsd);
  }
  return { metrics: calculateMetrics(trades, initialCapital), trades, blocked, breakdown };
}

function simulateWindow(args: {
  candles: readonly Candle[];
  decisions: readonly OfflineDecision[];
  startIndex: number;
  endIndex: number;
  threshold: number;
  fold: number;
  sample: 'IS' | 'OOS';
  config: OfflineWalkForwardConfig;
}): OfflineSampleResult {
  const { candles, decisions, startIndex, endIndex, threshold, fold, sample, config } = args;
  const blocked = emptyBlocked();
  const trades: OfflineTrade[] = [];
  let equity = config.initialCapitalUsd;
  let nextAvailableEntryIndex = startIndex;
  const byClose = new Map(candles.map((candle, index) => [candle.t + FIFTEEN_MINUTES_MS, index]));
  for (const decision of decisions) {
    const signalIndex = byClose.get(decision.sourceCandleCloseTime);
    if (signalIndex === undefined || signalIndex < startIndex || signalIndex >= endIndex) continue;
    if (decision.direction === 'NONE' || decision.strategyId === null) { blocked.NO_TRADE += 1; continue; }
    if (decision.riskDecision === 'REJECT') { blocked.RISK_BLOCKED += 1; continue; }
    if (decision.confidence < threshold) { blocked.INSUFFICIENT_CONFIDENCE += 1; continue; }
    if (!validateCost(decision.costEvidence, decision.sourceCandleCloseTime)) { blocked.COST_UNAVAILABLE += 1; continue; }
    const entryIndex = signalIndex + 1;
    if (entryIndex >= endIndex || entryIndex >= candles.length) { blocked.NEXT_BAR_UNAVAILABLE += 1; continue; }
    if (entryIndex < nextAvailableEntryIndex) { blocked.NO_TRADE += 1; continue; }
    const entry = candles[entryIndex];
    const side = decision.direction;
    const stop = decision.structuralStop;
    const target = decision.targetPrice;
    if (!finite(stop) || !finite(target)
      || (side === 'LONG' && !(stop < entry.o && target > entry.o))
      || (side === 'SHORT' && !(stop > entry.o && target < entry.o))) {
      blocked.INVALID_SIGNAL += 1;
      continue;
    }
    const maximumExitIndex = Math.min(endIndex - 1, entryIndex + config.maximumHoldingBars);
    let exitIndex = maximumExitIndex;
    let exitPrice = candles[maximumExitIndex].c;
    let exitReason: OfflineExitReason = 'TIME';
    for (let index = entryIndex; index <= maximumExitIndex; index += 1) {
      const candle = candles[index];
      const stopHit = side === 'LONG' ? candle.l <= stop : candle.h >= stop;
      const targetHit = side === 'LONG' ? candle.h >= target : candle.l <= target;
      if (stopHit && targetHit) {
        exitIndex = index; exitPrice = stop; exitReason = 'AMBIGUOUS_STOP_FIRST'; break;
      }
      if (stopHit) { exitIndex = index; exitPrice = stop; exitReason = 'STOP'; break; }
      if (targetHit) { exitIndex = index; exitPrice = target; exitReason = 'TARGET'; break; }
    }
    const sizeUsd = equity * config.positionSizePct * (decision.riskDecision === 'REDUCE' ? 0.5 : 1);
    const direction = side === 'LONG' ? 1 : -1;
    const grossPnlUsd = sizeUsd * direction * ((exitPrice - entry.o) / entry.o);
    const cost = decision.costEvidence as OfflineHistoricalCostEvidence;
    const heldHours = Math.max(FIFTEEN_MINUTES_MS, candles[exitIndex].t - entry.t + FIFTEEN_MINUTES_MS) / ONE_HOUR_MS;
    const feesUsd = sizeUsd * (cost.feeBpsPerSide * 2) / 10_000;
    const slippageUsd = sizeUsd * (cost.entrySlippageBps + cost.exitSlippageBps) / 10_000;
    const fundingUsd = sizeUsd * cost.fundingBpsPerHour * heldHours / 10_000;
    const borrowingUsd = sizeUsd * cost.borrowingBpsPerHour * heldHours / 10_000;
    const impactUsd = sizeUsd * cost.impactBps / 10_000;
    const totalUsd = feesUsd + slippageUsd + fundingUsd + borrowingUsd + impactUsd;
    const netPnlUsd = grossPnlUsd - totalUsd;
    const riskUsd = sizeUsd * Math.abs(entry.o - stop) / entry.o;
    const trade: OfflineTrade = {
      decisionId: decision.decisionId, fold, sample, threshold, side,
      strategyId: decision.strategyId, regime: decision.regime, profile: decision.profile,
      signalCloseTime: decision.sourceCandleCloseTime,
      entryTime: entry.t, exitTime: candles[exitIndex].t + FIFTEEN_MINUTES_MS,
      entryPrice: entry.o, exitPrice,
      grossPnlUsd: round(grossPnlUsd), netPnlUsd: round(netPnlUsd), riskUsd: round(riskUsd),
      rMultiple: round(riskUsd > 0 ? netPnlUsd / riskUsd : 0),
      costs: {
        feesUsd: round(feesUsd), slippageUsd: round(slippageUsd), fundingUsd: round(fundingUsd),
        borrowingUsd: round(borrowingUsd), impactUsd: round(impactUsd), totalUsd: round(totalUsd),
      },
      exitReason,
    };
    trades.push(trade);
    equity += netPnlUsd;
    nextAvailableEntryIndex = exitIndex + 1;
  }
  return sampleResult(trades, blocked, config.initialCapitalUsd);
}

function aggregateOos(folds: OfflineFoldResult[], initialCapital: number): OfflineSampleResult {
  const trades = folds.flatMap(fold => fold.oos.trades);
  const blocked = emptyBlocked();
  for (const fold of folds) {
    for (const key of Object.keys(blocked) as OfflineBlockedReason[]) blocked[key] += fold.oos.blocked[key];
  }
  return sampleResult(trades, blocked, initialCapital);
}

export function runOfflineWalkForwardBacktest(input: OfflineWalkForwardInput): OfflineWalkForwardReport {
  const config = input.config ?? DEFAULT_OFFLINE_WALK_FORWARD_CONFIG;
  const issues = validateInputs(input, config);
  const base: Omit<OfflineWalkForwardReport, 'status' | 'issues' | 'thresholds'> = {
    schemaVersion: OFFLINE_WALK_FORWARD_SCHEMA_VERSION,
    symbol: 'BTC', source: input.source, generatedAtMs: input.generatedAtMs, config,
    input: {
      candleCount: input.candles15m.length,
      decisionCount: input.decisions.length,
      firstCandleTime: input.candles15m[0]?.t ?? null,
      lastCandleTime: input.candles15m[input.candles15m.length - 1]?.t ?? null,
    },
    autoPromotionAllowed: false,
    liveExecutionAuthorized: false,
  };
  if (issues.length > 0) return { ...base, status: 'UNAVAILABLE', issues, thresholds: [] };

  const foldStarts: number[] = [];
  for (let start = 0;
    start + config.trainBars + config.purgeBars + config.oosBars <= input.candles15m.length;
    start += config.stepBars) foldStarts.push(start);
  if (foldStarts.length < config.minimumFolds) {
    return { ...base, status: 'UNAVAILABLE', issues: ['유효 Walk-Forward fold 부족'], thresholds: [] };
  }

  const thresholds = config.thresholds.map(threshold => {
    const folds = foldStarts.map((trainStart, offset): OfflineFoldResult => {
      const trainEnd = trainStart + config.trainBars;
      const oosStart = trainEnd + config.purgeBars;
      const oosEnd = oosStart + config.oosBars;
      return {
        fold: offset + 1,
        trainStartTime: input.candles15m[trainStart].t,
        trainEndTime: input.candles15m[trainEnd - 1].t + FIFTEEN_MINUTES_MS,
        oosStartTime: input.candles15m[oosStart].t,
        oosEndTime: input.candles15m[oosEnd - 1].t + FIFTEEN_MINUTES_MS,
        is: simulateWindow({ candles: input.candles15m, decisions: input.decisions, startIndex: trainStart,
          endIndex: trainEnd, threshold, fold: offset + 1, sample: 'IS', config }),
        oos: simulateWindow({ candles: input.candles15m, decisions: input.decisions, startIndex: oosStart,
          endIndex: oosEnd, threshold, fold: offset + 1, sample: 'OOS', config }),
      };
    });
    return { threshold, folds, aggregateOos: aggregateOos(folds, config.initialCapitalUsd) };
  });
  return { ...base, status: 'OK', issues: [], thresholds };
}
