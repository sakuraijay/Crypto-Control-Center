/** Pure RANGE-only mean-reversion strategy. No persistence, sizing, authorization, or execution. */
import type { CandleFeatureResult } from './candlePatternFeatures';
import type { CandleTechnicalSnapshot } from './candleTechnicalFeaturesV2';
import type { MarketStructureEvidence } from './marketStructureV2';
import type { RegimeDecision } from './regimeEngineV2';
import {
  buildStrategySignalId,
  STRATEGY_SIGNAL_SCHEMA_VERSION,
  type StrategyDataQuality,
  type StrategyDirection,
  type StrategySignal,
} from './strategySignalV2';

export const RANGE_MEAN_REVERSION_CONFIG_VERSION = 'range-mean-reversion/v1' as const;
export interface RangeMeanReversionConfig {
  version: typeof RANGE_MEAN_REVERSION_CONFIG_VERSION;
  minConfidence: number;
  boundaryZoneFraction: number;
  minimumZScoreMagnitude: number;
  confirmationStrengthMin: number;
  volumeRatioMin: number;
  stopBufferAtrMultiplier: number;
  minStopBufferPct: number;
  maxStopDistancePct: number;
  minimumNetRR: number;
  targetMode: 'MIDPOINT' | 'OPPOSITE_BOUNDARY';
}

export const DEFAULT_RANGE_MEAN_REVERSION_CONFIG: RangeMeanReversionConfig = Object.freeze({
  version: RANGE_MEAN_REVERSION_CONFIG_VERSION,
  minConfidence: 70,
  boundaryZoneFraction: 0.2,
  minimumZScoreMagnitude: 1,
  confirmationStrengthMin: 50,
  volumeRatioMin: 1.3,
  stopBufferAtrMultiplier: 0.25,
  minStopBufferPct: 0.1,
  maxStopDistancePct: 3,
  minimumNetRR: 1.5,
  targetMode: 'MIDPOINT',
});

export interface RangeMeanReversionInput {
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

export function validateRangeMeanReversionConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['range config 객체 필요'];
  const record = value as Record<string, unknown>;
  const numeric = ['minConfidence', 'boundaryZoneFraction', 'minimumZScoreMagnitude',
    'confirmationStrengthMin', 'volumeRatioMin', 'stopBufferAtrMultiplier',
    'minStopBufferPct', 'maxStopDistancePct', 'minimumNetRR'] as const;
  const expected = ['version', ...numeric, 'targetMode'] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 config 필드: ${key}`);
  for (const key of expected) if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`config 필드 누락: ${key}`);
  if (record.version !== RANGE_MEAN_REVERSION_CONFIG_VERSION) issues.push('지원하지 않는 config version');
  for (const key of numeric) {
    const candidate = record[key];
    if (!finite(candidate) || candidate < 0) issues.push(`${key} 범위 오류`);
  }
  if (finite(record.minConfidence) && record.minConfidence > 100) issues.push('minConfidence 범위 오류');
  if (finite(record.confirmationStrengthMin) && record.confirmationStrengthMin > 100) issues.push('confirmationStrengthMin 범위 오류');
  if (finite(record.boundaryZoneFraction) && (record.boundaryZoneFraction <= 0 || record.boundaryZoneFraction >= 0.5)) issues.push('boundaryZoneFraction 범위 오류');
  if (record.targetMode !== 'MIDPOINT' && record.targetMode !== 'OPPOSITE_BOUNDARY') issues.push('targetMode 범위 오류');
  if (finite(record.minStopBufferPct) && finite(record.maxStopDistancePct)
    && record.minStopBufferPct >= record.maxStopDistancePct) issues.push('stop buffer/distance 경계 오류');
  return issues;
}

function emptySignal(
  input: RangeMeanReversionInput,
  direction: StrategyDirection,
  reasons: string[],
  warnings: string[],
): StrategySignal {
  return {
    schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
    signalId: buildStrategySignalId(input.symbol, 'RANGE_MEAN_REVERSION', direction, '15m', input.sourceCandleCloseTime),
    strategyId: 'RANGE_MEAN_REVERSION', symbol: input.symbol, regime: input.regime.regime,
    direction: 'NONE', confidence: 0, entryZoneLow: null, entryZoneHigh: null,
    proposedEntryPrice: null, structuralStop: null, stopDistancePct: null,
    invalidationPrice: null, targets: [], grossExpectedEdgeBps: null,
    expectedCostsBps: input.expectedCostsBps, netExpectedEdgeBps: null, expectedNetRR: null,
    higherTimeframeTrend: input.structure1h.trend, marketStructure: input.structure15m.trend,
    confirmationPattern: null, sourceTimeframes: ['4h', '1h', '15m'],
    sourceCandleCloseTime: input.sourceCandleCloseTime, dataQuality: input.dataQuality,
    volumeConfirmation: input.pattern15m.volumeRatio === null ? null
      : input.pattern15m.volumeRatio >= DEFAULT_RANGE_MEAN_REVERSION_CONFIG.volumeRatioMin,
    reasons, warnings,
  };
}

export function evaluateRangeMeanReversion(
  input: RangeMeanReversionInput,
  configInput: unknown = DEFAULT_RANGE_MEAN_REVERSION_CONFIG,
): StrategySignal {
  const configIssues = validateRangeMeanReversionConfig(configInput);
  if (configIssues.length > 0) return emptySignal(input, 'NONE', ['config INVALID'], configIssues);
  const config = configInput as RangeMeanReversionConfig;
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
  if (input.regime.regime !== 'RANGE') {
    return emptySignal(input, 'NONE', ['RANGE 외 Regime에서 Mean-Reversion 비활성'], warnings);
  }
  if (input.structure1h.trend === 'BULLISH' || input.structure1h.trend === 'BEARISH') {
    return emptySignal(input, 'NONE', ['1H 추세형 구조에서 Mean-Reversion 금지'], warnings);
  }
  if (input.structure15m.breakout.state === 'BREAKOUT_UP'
    || input.structure15m.breakout.state === 'BREAKOUT_DOWN'
    || input.structure15m.breakout.state === 'RETEST_UP'
    || input.structure15m.breakout.state === 'RETEST_DOWN') {
    return emptySignal(input, 'NONE', ['확정 돌파 상태에서 Mean-Reversion 금지'], warnings);
  }

  const { low, high, midpoint } = input.structure15m.range;
  if (low === null || high === null || midpoint === null || !finite(low) || !finite(high)
    || !finite(midpoint) || low <= 0 || high <= low || midpoint <= low || midpoint >= high
    || input.entryPrice < low || input.entryPrice > high) {
    return emptySignal(input, 'NONE', ['명확한 Range 경계 없음'], warnings);
  }
  const width = high - low;
  const rangePosition = (input.entryPrice - low) / width;
  const longBoundary = rangePosition <= config.boundaryZoneFraction;
  const shortBoundary = rangePosition >= 1 - config.boundaryZoneFraction;
  if (!longBoundary && !shortBoundary) return emptySignal(input, 'NONE', ['Range 중앙 진입 금지'], warnings);

  const zScore = input.technical15m.zScore;
  if (zScore === null || !finite(zScore)) return emptySignal(input, 'NONE', ['Z-score evidence 없음'], warnings);
  const patterns = input.pattern15m.patterns;
  const failedDown = input.structure15m.breakout.state === 'FAILED_DOWN';
  const failedUp = input.structure15m.breakout.state === 'FAILED_UP';
  const longConfirmations = [patterns.bullishRejection, patterns.longLowerWick, patterns.bullishEngulfing];
  const shortConfirmations = [patterns.bearishRejection, patterns.longUpperWick, patterns.bearishEngulfing];
  const longStrength = Math.max(...longConfirmations.map(value => value ?? 0));
  const shortStrength = Math.max(...shortConfirmations.map(value => value ?? 0));
  const longConfirmed = longBoundary && zScore <= -config.minimumZScoreMagnitude
    && (failedDown || longStrength >= config.confirmationStrengthMin);
  const shortConfirmed = shortBoundary && zScore >= config.minimumZScoreMagnitude
    && (failedUp || shortStrength >= config.confirmationStrengthMin);
  if (longConfirmed === shortConfirmed) {
    return emptySignal(input, 'NONE', [longConfirmed ? '반대 방향 신호 충돌 — NO TRADE' : 'Range 반전 confirmation 미달'], warnings);
  }
  const direction: Exclude<StrategyDirection, 'NONE'> = longConfirmed ? 'LONG' : 'SHORT';
  if (input.expectedCostsBps === null || !finite(input.expectedCostsBps) || input.expectedCostsBps < 0) {
    return emptySignal(input, direction, ['실행비용 evidence 없음 — fail-closed'], warnings);
  }

  const atrAbs = input.technical15m.atr.absolute;
  const minimumBuffer = input.entryPrice * config.minStopBufferPct / 100;
  const atrBuffer = atrAbs !== null && finite(atrAbs) && atrAbs > 0
    ? atrAbs * config.stopBufferAtrMultiplier : 0;
  const buffer = Math.max(minimumBuffer, atrBuffer);
  const stop = direction === 'LONG' ? low - buffer : high + buffer;
  const riskDistance = Math.abs(input.entryPrice - stop);
  const stopDistancePct = riskDistance / input.entryPrice * 100;
  if (!finite(stop) || stop <= 0 || stopDistancePct <= 0 || stopDistancePct > config.maxStopDistancePct) {
    return emptySignal(input, direction, ['구조적 Stop 거리가 허용 범위 밖'], warnings);
  }
  const target = config.targetMode === 'MIDPOINT' ? midpoint : direction === 'LONG' ? high : low;
  if ((direction === 'LONG' && target <= input.entryPrice) || (direction === 'SHORT' && target >= input.entryPrice)) {
    return emptySignal(input, direction, ['Range target/entry 관계 INVALID'], warnings);
  }
  const grossExpectedEdgeBps = Math.abs(target - input.entryPrice) / input.entryPrice * 10_000;
  const netExpectedEdgeBps = grossExpectedEdgeBps - input.expectedCostsBps;
  const expectedNetRR = netExpectedEdgeBps / (stopDistancePct * 100);
  const grossExpectedR = Math.abs(target - input.entryPrice) / riskDistance;
  if (netExpectedEdgeBps <= 0 || expectedNetRR < config.minimumNetRR) {
    return emptySignal(input, direction, ['비용 차감 후 최소 Net R:R 미달'], warnings);
  }

  const confirmationStrength = direction === 'LONG' ? longStrength : shortStrength;
  const failedBreakout = direction === 'LONG' ? failedDown : failedUp;
  let confidence = 30 + 20 + Math.min(20, Math.abs(zScore) * 10);
  if (confirmationStrength >= config.confirmationStrengthMin) confidence += 10;
  if (failedBreakout) confidence += 10;
  const volumeConfirmation = input.pattern15m.volumeRatio === null ? null
    : input.pattern15m.volumeRatio >= config.volumeRatioMin;
  if (volumeConfirmation === true) confidence += 5;
  else if (volumeConfirmation === null) warnings.push('거래량 unavailable — confidence 가산 없음');
  else warnings.push('거래량 confirmation 미달');
  if (expectedNetRR >= 2) confidence += 5;
  confidence = clamp(confidence);
  if (confidence < config.minConfidence) return emptySignal(input, direction, ['최소 confidence 미달'], warnings);

  const zoneWidth = width * config.boundaryZoneFraction;
  return {
    schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
    signalId: buildStrategySignalId(input.symbol, 'RANGE_MEAN_REVERSION', direction, '15m', input.sourceCandleCloseTime),
    strategyId: 'RANGE_MEAN_REVERSION', symbol: input.symbol, regime: input.regime.regime,
    direction, confidence,
    entryZoneLow: round(direction === 'LONG' ? low : high - zoneWidth),
    entryZoneHigh: round(direction === 'LONG' ? low + zoneWidth : high),
    proposedEntryPrice: round(input.entryPrice), structuralStop: round(stop),
    stopDistancePct: round(stopDistancePct), invalidationPrice: round(stop),
    targets: [{ price: round(target), expectedR: round(grossExpectedR), allocationPct: 100 }],
    grossExpectedEdgeBps: round(grossExpectedEdgeBps), expectedCostsBps: round(input.expectedCostsBps),
    netExpectedEdgeBps: round(netExpectedEdgeBps), expectedNetRR: round(expectedNetRR),
    higherTimeframeTrend: input.structure1h.trend,
    marketStructure: direction === 'LONG' ? 'RANGE_LOW_RECLAIM' : 'RANGE_HIGH_REJECTION',
    confirmationPattern: failedBreakout ? 'FAILED_BREAKOUT_REENTRY'
      : direction === 'LONG' ? 'BULLISH_RANGE_REJECTION' : 'BEARISH_RANGE_REJECTION',
    sourceTimeframes: ['4h', '1h', '15m'], sourceCandleCloseTime: input.sourceCandleCloseTime,
    dataQuality: input.dataQuality, volumeConfirmation,
    reasons: ['RANGE regime과 명확한 경계 확인', '15m 반전 confirmation 확인', '구조적 Stop 및 Net R:R 충족'],
    warnings,
  };
}
