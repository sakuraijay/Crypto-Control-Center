/** Pure Trend Pullback strategy. It cannot size, authorize, persist, or execute. */
import type { CandleFeatureResult } from './candlePatternFeatures';
import type { MarketStructureEvidence } from './marketStructureV2';
import type { RegimeDecision } from './regimeEngineV2';
import {
  buildStrategySignalId,
  STRATEGY_SIGNAL_SCHEMA_VERSION,
  type StrategyDataQuality,
  type StrategyDirection,
  type StrategySignal,
} from './strategySignalV2';

export const TREND_PULLBACK_CONFIG_VERSION = 'trend-pullback/v1' as const;
export interface TrendPullbackConfig {
  version: typeof TREND_PULLBACK_CONFIG_VERSION;
  minConfidence: number;
  confirmationStrengthMin: number;
  volumeRatioMin: number;
  supportProximityPct: number;
  stopBufferAtrMultiplier: number;
  minStopBufferPct: number;
  maxStopDistancePct: number;
  targetRiskMultiple: number;
  minimumNetRR: number;
  chaseBodyStrengthMax: number;
}

export const DEFAULT_TREND_PULLBACK_CONFIG: TrendPullbackConfig = Object.freeze({
  version: TREND_PULLBACK_CONFIG_VERSION,
  minConfidence: 70,
  confirmationStrengthMin: 50,
  volumeRatioMin: 1.3,
  supportProximityPct: 0.75,
  stopBufferAtrMultiplier: 0.25,
  minStopBufferPct: 0.1,
  maxStopDistancePct: 3,
  targetRiskMultiple: 2,
  minimumNetRR: 1.5,
  chaseBodyStrengthMax: 85,
});

export interface TrendPullbackInput {
  symbol: string;
  sourceCandleCloseTime: number;
  evaluatedAt: number;
  entryPrice: number;
  atr15m: number | null;
  expectedCostsBps: number | null;
  dataQuality: StrategyDataQuality;
  regime: RegimeDecision;
  structure1h: MarketStructureEvidence;
  structure15m: MarketStructureEvidence;
  pattern15m: CandleFeatureResult;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number): number => Number(value.toPrecision(12));
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

export function validateTrendPullbackConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['trend config 객체 필요'];
  const record = value as Record<string, unknown>;
  const expected = ['version', 'minConfidence', 'confirmationStrengthMin', 'volumeRatioMin',
    'supportProximityPct', 'stopBufferAtrMultiplier', 'minStopBufferPct', 'maxStopDistancePct',
    'targetRiskMultiple', 'minimumNetRR', 'chaseBodyStrengthMax'] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 config 필드: ${key}`);
  for (const key of expected) if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`config 필드 누락: ${key}`);
  if (record.version !== TREND_PULLBACK_CONFIG_VERSION) issues.push('지원하지 않는 config version');
  for (const key of expected.filter(key => key !== 'version')) {
    const candidate = record[key];
    if (!finite(candidate) || candidate < 0) issues.push(`${key} 범위 오류`);
  }
  if (finite(record.minConfidence) && record.minConfidence > 100) issues.push('minConfidence 범위 오류');
  if (finite(record.confirmationStrengthMin) && record.confirmationStrengthMin > 100) issues.push('confirmationStrengthMin 범위 오류');
  if (finite(record.chaseBodyStrengthMax) && record.chaseBodyStrengthMax > 100) issues.push('chaseBodyStrengthMax 범위 오류');
  if (finite(record.minStopBufferPct) && finite(record.maxStopDistancePct)
    && record.minStopBufferPct >= record.maxStopDistancePct) issues.push('stop buffer/distance 경계 오류');
  return issues;
}

function structuralReference(
  direction: Exclude<StrategyDirection, 'NONE'>,
  entry: number,
  frames: MarketStructureEvidence[],
): number | null {
  const candidates: number[] = [];
  for (const frame of frames) {
    if (direction === 'LONG') {
      candidates.push(...frame.swingLows.map(point => point.price));
      candidates.push(...frame.supportZones.flatMap(zone => [zone.low, zone.midpoint]));
      if (frame.range.low !== null) candidates.push(frame.range.low);
    } else {
      candidates.push(...frame.swingHighs.map(point => point.price));
      candidates.push(...frame.resistanceZones.flatMap(zone => [zone.high, zone.midpoint]));
      if (frame.range.high !== null) candidates.push(frame.range.high);
    }
  }
  const valid = candidates.filter(value => finite(value) && value > 0
    && (direction === 'LONG' ? value < entry : value > entry));
  if (valid.length === 0) return null;
  return direction === 'LONG' ? Math.max(...valid) : Math.min(...valid);
}

function emptySignal(input: TrendPullbackInput, direction: StrategyDirection, reasons: string[], warnings: string[]): StrategySignal {
  return {
    schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
    signalId: buildStrategySignalId(input.symbol, 'TREND_PULLBACK', direction, '15m', input.sourceCandleCloseTime),
    strategyId: 'TREND_PULLBACK', symbol: input.symbol, regime: input.regime.regime,
    direction: 'NONE', confidence: 0, entryZoneLow: null, entryZoneHigh: null,
    proposedEntryPrice: null, structuralStop: null, stopDistancePct: null,
    invalidationPrice: null, targets: [], grossExpectedEdgeBps: null,
    expectedCostsBps: input.expectedCostsBps, netExpectedEdgeBps: null, expectedNetRR: null,
    higherTimeframeTrend: input.regime.regime, marketStructure: input.structure1h.trend,
    confirmationPattern: null, sourceTimeframes: ['4h', '1h', '15m'],
    sourceCandleCloseTime: input.sourceCandleCloseTime, dataQuality: input.dataQuality,
    volumeConfirmation: input.pattern15m.volumeRatio === null ? null : input.pattern15m.volumeRatio >= DEFAULT_TREND_PULLBACK_CONFIG.volumeRatioMin,
    reasons, warnings,
  };
}

export function evaluateTrendPullback(
  input: TrendPullbackInput,
  configInput: unknown = DEFAULT_TREND_PULLBACK_CONFIG,
): StrategySignal {
  const configIssues = validateTrendPullbackConfig(configInput);
  if (configIssues.length > 0) return emptySignal(input, 'NONE', ['config INVALID'], configIssues);
  const config = configInput as TrendPullbackConfig;
  const warnings: string[] = [];
  if (!input.symbol.trim() || !finite(input.sourceCandleCloseTime) || !finite(input.evaluatedAt)
    || !finite(input.entryPrice) || input.entryPrice <= 0 || input.sourceCandleCloseTime > input.evaluatedAt) {
    return emptySignal(input, 'NONE', ['입력값 INVALID'], warnings);
  }
  if (input.dataQuality === 'INVALID' || input.regime.regime === 'UNKNOWN'
    || input.structure1h.quality === 'INVALID' || input.structure15m.quality === 'INVALID'
    || input.pattern15m.quality === 'INVALID' || input.pattern15m.patterns === null) {
    return emptySignal(input, 'NONE', ['데이터 품질 INVALID — fail-closed'], warnings);
  }
  const direction: StrategyDirection = input.regime.regime === 'TREND_UP' ? 'LONG'
    : input.regime.regime === 'TREND_DOWN' ? 'SHORT' : 'NONE';
  if (direction === 'NONE') return emptySignal(input, direction, ['현재 regime에서 Trend Pullback 비활성'], warnings);
  const structureAligned = direction === 'LONG' ? input.structure1h.trend === 'BULLISH'
    : input.structure1h.trend === 'BEARISH';
  if (!structureAligned) return emptySignal(input, direction, ['1H 시장구조가 상위 추세와 불일치'], warnings);

  const reference = structuralReference(direction, input.entryPrice, [input.structure15m, input.structure1h]);
  if (reference === null) return emptySignal(input, direction, ['구조적 Stop 기준 없음'], warnings);
  const proximityPct = Math.abs(input.entryPrice - reference) / input.entryPrice * 100;
  if (proximityPct > config.supportProximityPct) {
    return emptySignal(input, direction, ['지지·저항 구간에서 너무 멂 — 중간 진입 금지'], warnings);
  }
  const patterns = input.pattern15m.patterns;
  const rejection = direction === 'LONG' ? patterns.bullishRejection : patterns.bearishRejection;
  const engulfing = direction === 'LONG' ? patterns.bullishEngulfing : patterns.bearishEngulfing;
  const breakout = direction === 'LONG' ? patterns.bullishBreakout : patterns.bearishBreakout;
  const confirmations = [
    { name: direction === 'LONG' ? 'BULLISH_REJECTION' : 'BEARISH_REJECTION', strength: rejection },
    { name: direction === 'LONG' ? 'BULLISH_ENGULFING' : 'BEARISH_ENGULFING', strength: engulfing },
    { name: direction === 'LONG' ? 'BULLISH_BREAKOUT' : 'BEARISH_BREAKOUT', strength: breakout },
  ].filter(item => item.strength !== null && item.strength >= config.confirmationStrengthMin);
  if (confirmations.length === 0) return emptySignal(input, direction, ['15m confirmation 없음'], warnings);
  const bodyStrength = direction === 'LONG' ? patterns.strongBullishBody : patterns.strongBearishBody;
  if (bodyStrength > config.chaseBodyStrengthMax && proximityPct > config.supportProximityPct / 2) {
    return emptySignal(input, direction, ['강한 장대봉 추격 진입 금지'], warnings);
  }

  const minimumBuffer = input.entryPrice * config.minStopBufferPct / 100;
  const atrBuffer = input.atr15m !== null && finite(input.atr15m) && input.atr15m > 0
    ? input.atr15m * config.stopBufferAtrMultiplier : 0;
  const buffer = Math.max(minimumBuffer, atrBuffer);
  const stop = direction === 'LONG' ? reference - buffer : reference + buffer;
  const riskDistance = Math.abs(input.entryPrice - stop);
  const stopDistancePct = riskDistance / input.entryPrice * 100;
  if (!finite(stop) || stop <= 0 || stopDistancePct <= 0 || stopDistancePct > config.maxStopDistancePct) {
    return emptySignal(input, direction, ['구조적 Stop 거리가 허용 범위 밖'], warnings);
  }
  if (input.expectedCostsBps === null || !finite(input.expectedCostsBps) || input.expectedCostsBps < 0) {
    return emptySignal(input, direction, ['실행비용 evidence 없음 — fail-closed'], warnings);
  }

  const target = direction === 'LONG'
    ? input.entryPrice + riskDistance * config.targetRiskMultiple
    : input.entryPrice - riskDistance * config.targetRiskMultiple;
  const grossExpectedEdgeBps = Math.abs(target - input.entryPrice) / input.entryPrice * 10_000;
  const netExpectedEdgeBps = grossExpectedEdgeBps - input.expectedCostsBps;
  const riskBps = stopDistancePct * 100;
  const expectedNetRR = netExpectedEdgeBps / riskBps;
  if (netExpectedEdgeBps <= 0 || expectedNetRR < config.minimumNetRR) {
    return emptySignal(input, direction, ['비용 차감 후 최소 Net R:R 미달'], warnings);
  }

  let confidence = 25 + 20 + 15;
  confidence += Math.min(15, Math.max(...confirmations.map(item => item.strength ?? 0)) * 0.15);
  if ((engulfing ?? 0) >= config.confirmationStrengthMin) confidence += 10;
  if ((breakout ?? 0) >= config.confirmationStrengthMin) confidence += 10;
  const volumeConfirmation = input.pattern15m.volumeRatio === null ? null
    : input.pattern15m.volumeRatio >= config.volumeRatioMin;
  if (volumeConfirmation === true) confidence += 5;
  else if (volumeConfirmation === null) warnings.push('거래량 unavailable — confidence 가산 없음');
  else warnings.push('거래량 confirmation 미달');
  confidence = clamp(confidence);
  if (confidence < config.minConfidence) return emptySignal(input, direction, ['최소 confidence 미달'], warnings);

  const zoneHalfWidth = input.entryPrice * config.supportProximityPct / 200;
  return {
    schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
    signalId: buildStrategySignalId(input.symbol, 'TREND_PULLBACK', direction, '15m', input.sourceCandleCloseTime),
    strategyId: 'TREND_PULLBACK', symbol: input.symbol, regime: input.regime.regime,
    direction, confidence, entryZoneLow: round(input.entryPrice - zoneHalfWidth),
    entryZoneHigh: round(input.entryPrice + zoneHalfWidth), proposedEntryPrice: round(input.entryPrice),
    structuralStop: round(stop), stopDistancePct: round(stopDistancePct), invalidationPrice: round(stop),
    targets: [{ price: round(target), expectedR: config.targetRiskMultiple, allocationPct: 100 }],
    grossExpectedEdgeBps: round(grossExpectedEdgeBps), expectedCostsBps: round(input.expectedCostsBps),
    netExpectedEdgeBps: round(netExpectedEdgeBps), expectedNetRR: round(expectedNetRR),
    higherTimeframeTrend: input.regime.regime, marketStructure: input.structure1h.trend,
    confirmationPattern: confirmations.sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))[0].name,
    sourceTimeframes: ['4h', '1h', '15m'], sourceCandleCloseTime: input.sourceCandleCloseTime,
    dataQuality: input.dataQuality, volumeConfirmation,
    reasons: [`${input.regime.regime}와 1H 구조 일치`, '15m confirmation 확인', '구조적 Stop 및 Net R:R 충족'],
    warnings,
  };
}
