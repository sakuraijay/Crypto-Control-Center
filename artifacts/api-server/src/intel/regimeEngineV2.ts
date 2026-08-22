/** Regime-Aware Strategy Ensemble v2 — pure per-symbol regime classification. */
import type { CandleTechnicalSnapshot } from './candleTechnicalFeaturesV2';
import type { MarketStructureEvidence } from './marketStructureV2';

export const REGIME_ENGINE_CONFIG_VERSION = 'regime-engine/v2' as const;
export type MarketRegime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'BREAKOUT_READY'
  | 'HIGH_VOLATILITY' | 'TRANSITION' | 'UNKNOWN';

export interface RegimeEngineConfig {
  version: typeof REGIME_ENGINE_CONFIG_VERSION;
  adxTrendMin: number;
  adxRangeMax: number;
  emaSlopeTrendMinPctPerBar: number;
  emaSlopeFlatMaxPctPerBar: number;
  momentumMinPct: number;
  highVolatilityPercentileMin: number;
  highVolatilityAtrPctMin: number;
  highVolatilityBandWidthPctMin: number;
  compressionVolatilityPercentileMax: number;
  compressionBandWidthPctMax: number;
  compressionDonchianWidthPctMax: number;
  rangeZScoreAbsMax: number;
  candidateConfidenceMin: number;
  transitionConfidenceMin: number;
  hysteresisMargin: number;
  minHoldCandles: number;
  minConfirmCandles: number;
}

export const DEFAULT_REGIME_ENGINE_CONFIG: RegimeEngineConfig = Object.freeze({
  version: REGIME_ENGINE_CONFIG_VERSION,
  adxTrendMin: 20,
  adxRangeMax: 17,
  emaSlopeTrendMinPctPerBar: 0.02,
  emaSlopeFlatMaxPctPerBar: 0.015,
  momentumMinPct: 0.1,
  highVolatilityPercentileMin: 85,
  highVolatilityAtrPctMin: 2.5,
  highVolatilityBandWidthPctMin: 8,
  compressionVolatilityPercentileMax: 35,
  compressionBandWidthPctMax: 2.5,
  compressionDonchianWidthPctMax: 4,
  rangeZScoreAbsMax: 1.25,
  candidateConfidenceMin: 55,
  transitionConfidenceMin: 60,
  hysteresisMargin: 8,
  minHoldCandles: 2,
  minConfirmCandles: 2,
});

export interface RegimeEngineInput {
  symbol: string;
  sourceCandleCloseTime: number;
  currentClose: number;
  momentumPct: number | null;
  technical: CandleTechnicalSnapshot;
  structure: MarketStructureEvidence;
}

export interface RegimeState {
  symbol: string;
  regime: MarketRegime;
  confidence: number;
  sinceCandleCloseTime: number;
  heldCandles: number;
  pendingRegime: MarketRegime | null;
  pendingCount: number;
}

export interface RegimeDecision extends RegimeState {
  configVersion: typeof REGIME_ENGINE_CONFIG_VERSION | 'INVALID';
  previousRegime: MarketRegime;
  changed: boolean;
  candidateRegime: MarketRegime;
  candidateConfidence: number;
  calculatedAt: number;
  reasons: string[];
  warnings: string[];
  scores: Record<Exclude<MarketRegime, 'UNKNOWN'>, number>;
}

const CONFIG_KEYS = [
  'version', 'adxTrendMin', 'adxRangeMax', 'emaSlopeTrendMinPctPerBar',
  'emaSlopeFlatMaxPctPerBar', 'momentumMinPct', 'highVolatilityPercentileMin',
  'highVolatilityAtrPctMin', 'highVolatilityBandWidthPctMin',
  'compressionVolatilityPercentileMax', 'compressionBandWidthPctMax',
  'compressionDonchianWidthPctMax', 'rangeZScoreAbsMax', 'candidateConfidenceMin',
  'transitionConfidenceMin', 'hysteresisMargin', 'minHoldCandles', 'minConfirmCandles',
] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

export function validateRegimeEngineConfig(value: unknown): string[] {
  if (!record(value)) return ['regime config 객체 필요'];
  const issues: string[] = [];
  const allowed = new Set<string>(CONFIG_KEYS);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`알 수 없는 config 필드: ${key}`);
  for (const key of CONFIG_KEYS) if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push(`config 필드 누락: ${key}`);
  if (value.version !== REGIME_ENGINE_CONFIG_VERSION) issues.push(`지원하지 않는 config version: ${String(value.version)}`);
  for (const key of CONFIG_KEYS.filter(key => key !== 'version')) {
    if (!finite(value[key])) issues.push(`${key} 유한 숫자 필요`);
  }
  for (const key of ['minHoldCandles', 'minConfirmCandles'] as const) {
    const number = value[key];
    if (!finite(number) || !Number.isInteger(number) || number < 1 || number > 100) issues.push(`${key} 정수 범위 오류`);
  }
  for (const key of ['candidateConfidenceMin', 'transitionConfidenceMin', 'hysteresisMargin',
    'highVolatilityPercentileMin', 'compressionVolatilityPercentileMax'] as const) {
    const number = value[key];
    if (!finite(number) || number < 0 || number > 100) issues.push(`${key} 범위 오류`);
  }
  if (finite(value.adxRangeMax) && finite(value.adxTrendMin) && value.adxRangeMax >= value.adxTrendMin) {
    issues.push('adxRangeMax는 adxTrendMin보다 작아야 함');
  }
  return issues;
}

type ScoreMap = RegimeDecision['scores'];
const emptyScores = (): ScoreMap => ({
  TREND_UP: 0, TREND_DOWN: 0, RANGE: 0, BREAKOUT_READY: 0,
  HIGH_VOLATILITY: 0, TRANSITION: 0,
});

function classify(input: RegimeEngineInput, config: RegimeEngineConfig): {
  regime: MarketRegime; confidence: number; reasons: string[]; warnings: string[]; scores: ScoreMap;
} {
  const warnings: string[] = [];
  const reasons: string[] = [];
  const scores = emptyScores();
  if (!input.symbol.trim() || !finite(input.sourceCandleCloseTime) || !finite(input.currentClose)
    || input.currentClose <= 0 || (input.momentumPct !== null && !finite(input.momentumPct))) {
    return { regime: 'UNKNOWN', confidence: 0, reasons: ['입력값 오류'], warnings, scores };
  }
  if (input.technical.quality === 'INVALID' || input.structure.quality === 'INVALID') {
    return { regime: 'UNKNOWN', confidence: 0, reasons: ['기술지표 또는 구조 데이터 INVALID'], warnings, scores };
  }
  if (input.technical.quality === 'DEGRADED') warnings.push(...input.technical.issues);
  if (input.structure.quality === 'DEGRADED') warnings.push(...input.structure.issues);
  const { ema, emaSlopePctPerBar: slope, directionalIndex: di, bollinger, donchian } = input.technical;
  const volatility = input.technical.volatilityPercentile;
  const atrPct = input.technical.atr.percent;
  const zScore = input.technical.zScore;
  const momentum = input.momentumPct;

  if (input.structure.trend === 'BULLISH') scores.TREND_UP += 30;
  if (input.structure.trend === 'BEARISH') scores.TREND_DOWN += 30;
  if (ema.long !== null && input.currentClose > ema.long) scores.TREND_UP += 15;
  if (ema.long !== null && input.currentClose < ema.long) scores.TREND_DOWN += 15;
  if (ema.fast !== null && ema.medium !== null && ema.long !== null) {
    if (ema.fast > ema.medium && ema.medium > ema.long) scores.TREND_UP += 20;
    if (ema.fast < ema.medium && ema.medium < ema.long) scores.TREND_DOWN += 20;
  }
  if (slope.medium !== null && slope.medium >= config.emaSlopeTrendMinPctPerBar) scores.TREND_UP += 15;
  if (slope.medium !== null && slope.medium <= -config.emaSlopeTrendMinPctPerBar) scores.TREND_DOWN += 15;
  if (di !== null && di.adx >= config.adxTrendMin) {
    scores.TREND_UP += di.plusDi > di.minusDi ? 10 : 0;
    scores.TREND_DOWN += di.minusDi > di.plusDi ? 10 : 0;
  }
  if (momentum !== null && momentum >= config.momentumMinPct) scores.TREND_UP += 10;
  if (momentum !== null && momentum <= -config.momentumMinPct) scores.TREND_DOWN += 10;

  if (di !== null && di.adx <= config.adxRangeMax) scores.RANGE += 30;
  if (input.structure.trend === 'MIXED') scores.RANGE += 25;
  if (slope.medium !== null && Math.abs(slope.medium) <= config.emaSlopeFlatMaxPctPerBar) scores.RANGE += 20;
  if (zScore !== null && Math.abs(zScore) <= config.rangeZScoreAbsMax) scores.RANGE += 10;
  if (donchian !== null && input.currentClose >= donchian.lower && input.currentClose <= donchian.upper) scores.RANGE += 15;

  if (volatility !== null && volatility <= config.compressionVolatilityPercentileMax) scores.BREAKOUT_READY += 30;
  if (bollinger !== null && bollinger.widthPct <= config.compressionBandWidthPctMax) scores.BREAKOUT_READY += 30;
  if (donchian !== null && donchian.widthPct <= config.compressionDonchianWidthPctMax) scores.BREAKOUT_READY += 25;
  if (input.structure.breakout.state === 'NONE') scores.BREAKOUT_READY += 15;

  if (volatility !== null && volatility >= config.highVolatilityPercentileMin) scores.HIGH_VOLATILITY += 40;
  if (atrPct !== null && atrPct >= config.highVolatilityAtrPctMin) scores.HIGH_VOLATILITY += 30;
  if (bollinger !== null && bollinger.widthPct >= config.highVolatilityBandWidthPctMin) scores.HIGH_VOLATILITY += 20;
  if (input.structure.breakout.state === 'BREAKOUT_UP'
    || input.structure.breakout.state === 'BREAKOUT_DOWN') scores.HIGH_VOLATILITY += 10;

  if (input.structure.event === 'CHOCH_UP' || input.structure.event === 'CHOCH_DOWN') scores.TRANSITION += 60;
  if (input.structure.trend === 'MIXED') scores.TRANSITION += 20;
  if (input.structure.breakout.state === 'FAILED_UP'
    || input.structure.breakout.state === 'FAILED_DOWN') scores.TRANSITION += 20;

  for (const regime of Object.keys(scores) as Array<keyof ScoreMap>) scores[regime] = clamp(scores[regime]);
  const ranked = (Object.entries(scores) as Array<[keyof ScoreMap, number]>).sort((a, b) => b[1] - a[1]);
  let [regime, confidence] = ranked[0];
  const second = ranked[1][1];
  if (scores.HIGH_VOLATILITY >= config.transitionConfidenceMin) {
    regime = 'HIGH_VOLATILITY'; confidence = scores.HIGH_VOLATILITY;
    reasons.push('비정상 변동성 우선 차단 상태');
  } else if (scores.BREAKOUT_READY >= config.transitionConfidenceMin
    && volatility !== null && volatility <= config.compressionVolatilityPercentileMax
    && bollinger !== null && bollinger.widthPct <= config.compressionBandWidthPctMax
    && donchian !== null && donchian.widthPct <= config.compressionDonchianWidthPctMax) {
    regime = 'BREAKOUT_READY'; confidence = scores.BREAKOUT_READY;
    reasons.push('다중 변동성 압축 evidence 일치');
  } else if (confidence < config.candidateConfidenceMin) {
    return { regime: 'UNKNOWN', confidence, reasons: ['최소 regime confidence 미달'], warnings, scores };
  } else if (confidence - second < config.hysteresisMargin && regime !== 'TRANSITION') {
    regime = 'TRANSITION'; confidence = Math.max(scores.TRANSITION, confidence);
    reasons.push('상위 regime 점수 차이 부족');
  }
  reasons.push(`${regime} score ${confidence}`);
  return { regime, confidence, reasons, warnings, scores };
}

export function evaluateRegime(
  input: RegimeEngineInput,
  previous: RegimeState | null,
  configInput: unknown = DEFAULT_REGIME_ENGINE_CONFIG,
): RegimeDecision {
  const configIssues = validateRegimeEngineConfig(configInput);
  const config = configInput as RegimeEngineConfig;
  const scores = emptyScores();
  if (configIssues.length > 0 || !record(configInput)) return {
    symbol: input.symbol, regime: 'UNKNOWN', confidence: 0, sinceCandleCloseTime: input.sourceCandleCloseTime,
    heldCandles: 0, pendingRegime: null, pendingCount: 0, configVersion: 'INVALID',
    previousRegime: previous?.regime ?? 'UNKNOWN', changed: previous?.regime !== 'UNKNOWN',
    candidateRegime: 'UNKNOWN', candidateConfidence: 0, calculatedAt: input.sourceCandleCloseTime,
    reasons: ['config INVALID'], warnings: configIssues, scores,
  };
  if (previous && previous.symbol !== input.symbol) previous = null;
  const candidate = classify(input, config);
  const previousRegime = previous?.regime ?? 'UNKNOWN';
  if (candidate.regime === 'UNKNOWN' || candidate.regime === 'HIGH_VOLATILITY') return {
    symbol: input.symbol, regime: candidate.regime, confidence: candidate.confidence,
    sinceCandleCloseTime: input.sourceCandleCloseTime, heldCandles: 1, pendingRegime: null, pendingCount: 0,
    configVersion: REGIME_ENGINE_CONFIG_VERSION, previousRegime,
    changed: candidate.regime !== previousRegime, candidateRegime: candidate.regime,
    candidateConfidence: candidate.confidence, calculatedAt: input.sourceCandleCloseTime,
    reasons: candidate.reasons, warnings: candidate.warnings, scores: candidate.scores,
  };
  if (!previous || previous.regime === 'UNKNOWN') return {
    symbol: input.symbol, regime: candidate.regime, confidence: candidate.confidence,
    sinceCandleCloseTime: input.sourceCandleCloseTime, heldCandles: 1, pendingRegime: null, pendingCount: 0,
    configVersion: REGIME_ENGINE_CONFIG_VERSION, previousRegime, changed: candidate.regime !== previousRegime,
    candidateRegime: candidate.regime, candidateConfidence: candidate.confidence,
    calculatedAt: input.sourceCandleCloseTime, reasons: candidate.reasons,
    warnings: candidate.warnings, scores: candidate.scores,
  };
  if (candidate.regime === previous.regime) return {
    ...previous, confidence: candidate.confidence, heldCandles: previous.heldCandles + 1,
    pendingRegime: null, pendingCount: 0, configVersion: REGIME_ENGINE_CONFIG_VERSION,
    previousRegime, changed: false, candidateRegime: candidate.regime,
    candidateConfidence: candidate.confidence, calculatedAt: input.sourceCandleCloseTime,
    reasons: candidate.reasons, warnings: candidate.warnings, scores: candidate.scores,
  };
  const pendingCount = previous.pendingRegime === candidate.regime ? previous.pendingCount + 1 : 1;
  const eligible = previous.heldCandles >= config.minHoldCandles
    && pendingCount >= config.minConfirmCandles
    && candidate.confidence >= config.transitionConfidenceMin
    && candidate.confidence >= previous.confidence - config.hysteresisMargin;
  if (!eligible) return {
    ...previous, pendingRegime: candidate.regime, pendingCount,
    configVersion: REGIME_ENGINE_CONFIG_VERSION, previousRegime, changed: false,
    candidateRegime: candidate.regime, candidateConfidence: candidate.confidence,
    calculatedAt: input.sourceCandleCloseTime,
    reasons: [...candidate.reasons, 'hysteresis/최소 유지·확인 조건 대기'],
    warnings: candidate.warnings, scores: candidate.scores,
  };
  return {
    symbol: input.symbol, regime: candidate.regime, confidence: candidate.confidence,
    sinceCandleCloseTime: input.sourceCandleCloseTime, heldCandles: 1,
    pendingRegime: null, pendingCount: 0, configVersion: REGIME_ENGINE_CONFIG_VERSION,
    previousRegime, changed: true, candidateRegime: candidate.regime,
    candidateConfidence: candidate.confidence, calculatedAt: input.sourceCandleCloseTime,
    reasons: [...candidate.reasons, `${previousRegime} → ${candidate.regime} 확정`],
    warnings: candidate.warnings, scores: candidate.scores,
  };
}
