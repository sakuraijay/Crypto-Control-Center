/** Pure Volatility Breakout strategy. No persistence, sizing, authorization, or execution. */
import type { CandleFeatureResult } from './candlePatternFeatures';
import type { CandleTechnicalSnapshot } from './candleTechnicalFeaturesV2';
import type { MarketStructureEvidence, BreakoutState } from './marketStructureV2';
import type { RegimeDecision } from './regimeEngineV2';
import {
  buildStrategySignalId,
  STRATEGY_SIGNAL_SCHEMA_VERSION,
  type StrategyDataQuality,
  type StrategyDirection,
  type StrategySignal,
} from './strategySignalV2';

export const VOLATILITY_BREAKOUT_CONFIG_VERSION = 'volatility-breakout/v1' as const;
export interface VolatilityBreakoutConfig {
  version: typeof VOLATILITY_BREAKOUT_CONFIG_VERSION;
  minConfidence: number;
  breakoutBodyRatioMin: number;
  volumeRatioMin: number;
  maxEntryVolatilityPercentile: number;
  maxEntryAtrPct: number;
  stopBufferAtrMultiplier: number;
  minStopBufferPct: number;
  maxStopDistancePct: number;
  targetRiskMultiple: number;
  minimumNetRR: number;
  requireRetest: boolean;
}

export const DEFAULT_VOLATILITY_BREAKOUT_CONFIG: VolatilityBreakoutConfig = Object.freeze({
  version: VOLATILITY_BREAKOUT_CONFIG_VERSION,
  minConfidence: 70,
  breakoutBodyRatioMin: 0.6,
  volumeRatioMin: 1.3,
  maxEntryVolatilityPercentile: 80,
  maxEntryAtrPct: 3,
  stopBufferAtrMultiplier: 0.25,
  minStopBufferPct: 0.1,
  maxStopDistancePct: 3,
  targetRiskMultiple: 2,
  minimumNetRR: 1.5,
  requireRetest: false,
});

export interface VolatilityBreakoutInput {
  symbol: string;
  sourceCandleCloseTime: number;
  evaluatedAt: number;
  entryPrice: number;
  expectedCostsBps: number | null;
  dataQuality: StrategyDataQuality;
  regime: RegimeDecision;
  structure1h: MarketStructureEvidence;
  structure15m: MarketStructureEvidence;
  technical15m: CandleTechnicalSnapshot;
  pattern15m: CandleFeatureResult;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number): number => Number(value.toPrecision(12));
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

export function validateVolatilityBreakoutConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['breakout config 객체 필요'];
  const record = value as Record<string, unknown>;
  const numeric = ['minConfidence', 'breakoutBodyRatioMin', 'volumeRatioMin',
    'maxEntryVolatilityPercentile', 'maxEntryAtrPct', 'stopBufferAtrMultiplier',
    'minStopBufferPct', 'maxStopDistancePct', 'targetRiskMultiple', 'minimumNetRR'] as const;
  const expected = ['version', ...numeric, 'requireRetest'] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 config 필드: ${key}`);
  for (const key of expected) if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`config 필드 누락: ${key}`);
  if (record.version !== VOLATILITY_BREAKOUT_CONFIG_VERSION) issues.push('지원하지 않는 config version');
  for (const key of numeric) {
    const candidate = record[key];
    if (!finite(candidate) || candidate < 0) issues.push(`${key} 범위 오류`);
  }
  if (typeof record.requireRetest !== 'boolean') issues.push('requireRetest boolean 필요');
  if (finite(record.breakoutBodyRatioMin) && record.breakoutBodyRatioMin > 1) issues.push('breakoutBodyRatioMin 범위 오류');
  for (const key of ['minConfidence', 'maxEntryVolatilityPercentile'] as const) {
    if (finite(record[key]) && record[key] > 100) issues.push(`${key} 범위 오류`);
  }
  if (finite(record.minStopBufferPct) && finite(record.maxStopDistancePct)
    && record.minStopBufferPct >= record.maxStopDistancePct) issues.push('stop buffer/distance 경계 오류');
  return issues;
}

function directionFromBreakout(state: BreakoutState): StrategyDirection {
  if (state === 'BREAKOUT_UP' || state === 'RETEST_UP') return 'LONG';
  if (state === 'BREAKOUT_DOWN' || state === 'RETEST_DOWN') return 'SHORT';
  return 'NONE';
}

function emptySignal(
  input: VolatilityBreakoutInput,
  direction: StrategyDirection,
  reasons: string[],
  warnings: string[],
): StrategySignal {
  return {
    schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
    signalId: buildStrategySignalId(input.symbol, 'VOLATILITY_BREAKOUT', direction, '15m', input.sourceCandleCloseTime),
    strategyId: 'VOLATILITY_BREAKOUT', symbol: input.symbol, regime: input.regime.regime,
    direction: 'NONE', confidence: 0, entryZoneLow: null, entryZoneHigh: null,
    proposedEntryPrice: null, structuralStop: null, stopDistancePct: null,
    invalidationPrice: null, targets: [], grossExpectedEdgeBps: null,
    expectedCostsBps: input.expectedCostsBps, netExpectedEdgeBps: null, expectedNetRR: null,
    higherTimeframeTrend: input.structure1h.trend, marketStructure: input.structure15m.breakout.state,
    confirmationPattern: null, sourceTimeframes: ['4h', '1h', '15m'],
    sourceCandleCloseTime: input.sourceCandleCloseTime, dataQuality: input.dataQuality,
    volumeConfirmation: input.pattern15m.volumeRatio === null ? null
      : input.pattern15m.volumeRatio >= DEFAULT_VOLATILITY_BREAKOUT_CONFIG.volumeRatioMin,
    reasons, warnings,
  };
}

export function evaluateVolatilityBreakout(
  input: VolatilityBreakoutInput,
  configInput: unknown = DEFAULT_VOLATILITY_BREAKOUT_CONFIG,
): StrategySignal {
  const configIssues = validateVolatilityBreakoutConfig(configInput);
  if (configIssues.length > 0) return emptySignal(input, 'NONE', ['config INVALID'], configIssues);
  const config = configInput as VolatilityBreakoutConfig;
  const warnings: string[] = [];
  if (!input.symbol.trim() || !finite(input.sourceCandleCloseTime) || !finite(input.evaluatedAt)
    || !finite(input.entryPrice) || input.entryPrice <= 0 || input.sourceCandleCloseTime > input.evaluatedAt) {
    return emptySignal(input, 'NONE', ['입력값 INVALID'], warnings);
  }
  if (input.dataQuality === 'INVALID' || input.regime.regime === 'UNKNOWN'
    || input.structure1h.quality === 'INVALID' || input.structure15m.quality === 'INVALID'
    || input.technical15m.quality === 'INVALID' || input.pattern15m.quality === 'INVALID'
    || input.pattern15m.patterns === null) {
    return emptySignal(input, 'NONE', ['데이터 품질 INVALID — fail-closed'], warnings);
  }
  if (input.regime.regime !== 'BREAKOUT_READY') {
    return emptySignal(input, 'NONE', ['BREAKOUT_READY 외 Regime에서 전략 비활성'], warnings);
  }
  const breakoutState = input.structure15m.breakout.state;
  if (breakoutState === 'FAILED_UP' || breakoutState === 'FAILED_DOWN') {
    return emptySignal(input, 'NONE', ['Failed breakout — 해당 방향 cooldown 필요'], warnings);
  }
  const direction = directionFromBreakout(breakoutState);
  if (direction === 'NONE') return emptySignal(input, direction, ['종가 기준 돌파 미확정'], warnings);
  const retest = breakoutState === 'RETEST_UP' || breakoutState === 'RETEST_DOWN';
  if (config.requireRetest && !retest) return emptySignal(input, direction, ['Retest confirmation 대기'], warnings);
  const bodyRatio = input.structure15m.breakout.bodyRatio;
  if (bodyRatio === null || !finite(bodyRatio) || bodyRatio < config.breakoutBodyRatioMin) {
    return emptySignal(input, direction, ['몸통 종가 돌파 강도 미달 — wick touch 불인정'], warnings);
  }
  const level = input.structure15m.breakout.level;
  if (level === null || !finite(level) || level <= 0
    || (direction === 'LONG' ? input.entryPrice <= level : input.entryPrice >= level)) {
    return emptySignal(input, direction, ['돌파 level/종가 관계 INVALID'], warnings);
  }
  if ((direction === 'LONG' && input.structure1h.trend === 'BEARISH')
    || (direction === 'SHORT' && input.structure1h.trend === 'BULLISH')) {
    return emptySignal(input, direction, ['강한 상위 타임프레임 역방향'], warnings);
  }
  const volatility = input.technical15m.volatilityPercentile;
  const atrPct = input.technical15m.atr.percent;
  if ((volatility !== null && volatility > config.maxEntryVolatilityPercentile)
    || (atrPct !== null && atrPct > config.maxEntryAtrPct)) {
    return emptySignal(input, direction, ['이미 변동성이 과도하게 확장됨 — 추격 금지'], warnings);
  }
  if (input.expectedCostsBps === null || !finite(input.expectedCostsBps) || input.expectedCostsBps < 0) {
    return emptySignal(input, direction, ['실행비용 evidence 없음 — fail-closed'], warnings);
  }

  const atrAbs = input.technical15m.atr.absolute;
  const minimumBuffer = input.entryPrice * config.minStopBufferPct / 100;
  const atrBuffer = atrAbs !== null && finite(atrAbs) && atrAbs > 0
    ? atrAbs * config.stopBufferAtrMultiplier : 0;
  const buffer = Math.max(minimumBuffer, atrBuffer);
  const stop = direction === 'LONG' ? level - buffer : level + buffer;
  const riskDistance = Math.abs(input.entryPrice - stop);
  const stopDistancePct = riskDistance / input.entryPrice * 100;
  if (!finite(stop) || stop <= 0 || stopDistancePct <= 0 || stopDistancePct > config.maxStopDistancePct) {
    return emptySignal(input, direction, ['구조적 Stop 거리가 허용 범위 밖'], warnings);
  }
  const target = direction === 'LONG'
    ? input.entryPrice + riskDistance * config.targetRiskMultiple
    : input.entryPrice - riskDistance * config.targetRiskMultiple;
  const grossExpectedEdgeBps = Math.abs(target - input.entryPrice) / input.entryPrice * 10_000;
  const netExpectedEdgeBps = grossExpectedEdgeBps - input.expectedCostsBps;
  const expectedNetRR = netExpectedEdgeBps / (stopDistancePct * 100);
  if (netExpectedEdgeBps <= 0 || expectedNetRR < config.minimumNetRR) {
    return emptySignal(input, direction, ['비용 차감 후 최소 Net R:R 미달'], warnings);
  }

  const patterns = input.pattern15m.patterns;
  const patternStrength = direction === 'LONG' ? patterns.bullishBreakout : patterns.bearishBreakout;
  let confidence = 30 + 20 + Math.min(20, bodyRatio * 25);
  if (patternStrength !== null && patternStrength >= 50) confidence += 10;
  if (retest) confidence += 10;
  const volumeConfirmation = input.pattern15m.volumeRatio === null ? null
    : input.pattern15m.volumeRatio >= config.volumeRatioMin;
  if (volumeConfirmation === true) confidence += 5;
  else if (volumeConfirmation === null) warnings.push('거래량 unavailable — confidence 가산 없음');
  else warnings.push('거래량 confirmation 미달');
  if (expectedNetRR >= config.targetRiskMultiple) confidence += 5;
  confidence = clamp(confidence);
  if (confidence < config.minConfidence) return emptySignal(input, direction, ['최소 confidence 미달'], warnings);

  const zoneHalfWidth = buffer / 2;
  return {
    schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
    signalId: buildStrategySignalId(input.symbol, 'VOLATILITY_BREAKOUT', direction, '15m', input.sourceCandleCloseTime),
    strategyId: 'VOLATILITY_BREAKOUT', symbol: input.symbol, regime: input.regime.regime,
    direction, confidence, entryZoneLow: round(input.entryPrice - zoneHalfWidth),
    entryZoneHigh: round(input.entryPrice + zoneHalfWidth), proposedEntryPrice: round(input.entryPrice),
    structuralStop: round(stop), stopDistancePct: round(stopDistancePct), invalidationPrice: round(stop),
    targets: [{ price: round(target), expectedR: config.targetRiskMultiple, allocationPct: 100 }],
    grossExpectedEdgeBps: round(grossExpectedEdgeBps), expectedCostsBps: round(input.expectedCostsBps),
    netExpectedEdgeBps: round(netExpectedEdgeBps), expectedNetRR: round(expectedNetRR),
    higherTimeframeTrend: input.structure1h.trend, marketStructure: breakoutState,
    confirmationPattern: retest ? 'BREAKOUT_RETEST' : 'CLOSE_BODY_BREAKOUT',
    sourceTimeframes: ['4h', '1h', '15m'], sourceCandleCloseTime: input.sourceCandleCloseTime,
    dataQuality: input.dataQuality, volumeConfirmation,
    reasons: ['BREAKOUT_READY regime', '몸통 종가 돌파 확인', '구조적 Stop 및 Net R:R 충족'],
    warnings,
  };
}
