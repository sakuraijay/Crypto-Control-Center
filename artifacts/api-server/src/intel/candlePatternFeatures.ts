/**
 * Regime-Aware Strategy Ensemble v2 — Phase 2B candle-pattern extractor.
 * Pure calculations only: no DB, network, worker, risk, signer, or execution imports.
 */
import { Candle } from './types';

export type FeatureQuality = 'GOOD' | 'DEGRADED' | 'INVALID';

export const CANDLE_PATTERN_CONFIG_VERSION = 'regime-candle-patterns/v1' as const;

export interface CandleFeatureConfig {
  version: typeof CANDLE_PATTERN_CONFIG_VERSION;
  epsilon: number;
  dojiBodyRatioMax: number;
  strongBodyRatioMin: number;
  longWickToBodyMin: number;
  rejectionWickToBodyMin: number;
  rejectionCloseLocationMin: number;
  engulfingBodyFactorMin: number;
  breakoutLookback: number;
  breakoutBodyRatioMin: number;
  strengthSaturationMultiplier: number;
  volumeLookback: number;
  volumeSpikeRatio: number;
}

export const DEFAULT_CANDLE_FEATURE_CONFIG: CandleFeatureConfig = Object.freeze({
  version: CANDLE_PATTERN_CONFIG_VERSION,
  epsilon: 1e-12,
  dojiBodyRatioMax: 0.10,
  strongBodyRatioMin: 0.65,
  longWickToBodyMin: 1.5,
  rejectionWickToBodyMin: 2,
  rejectionCloseLocationMin: 0.65,
  engulfingBodyFactorMin: 1,
  breakoutLookback: 20,
  breakoutBodyRatioMin: 0.60,
  strengthSaturationMultiplier: 2,
  volumeLookback: 20,
  volumeSpikeRatio: 1.3,
});

export interface CandleGeometry {
  bullish: boolean;
  bearish: boolean;
  bodySize: number;
  fullRange: number;
  upperWick: number;
  lowerWick: number;
  bodyRatio: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  upperWickToBody: number;
  lowerWickToBody: number;
  closeLocation: number;
}

export interface PatternStrengths {
  bullishCandle: number;
  bearishCandle: number;
  longLowerWick: number;
  longUpperWick: number;
  bullishEngulfing: number | null;
  bearishEngulfing: number | null;
  insideBar: number | null;
  outsideBar: number | null;
  strongBullishBody: number;
  strongBearishBody: number;
  doji: number;
  bullishRejection: number;
  bearishRejection: number;
  bullishBreakout: number | null;
  bearishBreakout: number | null;
  bullishFailedBreakout: number | null;
  bearishFailedBreakout: number | null;
}

export interface CandleFeatureResult {
  configVersion: string;
  sourceCandleOpenTime: number | null;
  quality: FeatureQuality;
  issues: string[];
  geometry: CandleGeometry | null;
  volume: number | null;
  averageVolume: number | null;
  volumeRatio: number | null;
  volumeSpike: boolean | null;
  patterns: PatternStrengths | null;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const CONFIG_KEYS = new Set<keyof CandleFeatureConfig>([
  'version',
  'epsilon',
  'dojiBodyRatioMax',
  'strongBodyRatioMin',
  'longWickToBodyMin',
  'rejectionWickToBodyMin',
  'rejectionCloseLocationMin',
  'engulfingBodyFactorMin',
  'breakoutLookback',
  'breakoutBodyRatioMin',
  'strengthSaturationMultiplier',
  'volumeLookback',
  'volumeSpikeRatio',
]);

const clamp100 = (value: number): number => Math.max(0, Math.min(100, value));

function thresholdStrength(value: number, threshold: number, saturationMultiplier: number): number {
  if (value < threshold) return clamp100((value / threshold) * 50);
  const saturation = threshold * saturationMultiplier;
  if (saturation <= threshold) return 100;
  return clamp100(50 + ((value - threshold) / (saturation - threshold)) * 50);
}

export function validateCandleFeatureConfig(config: CandleFeatureConfig): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key as keyof CandleFeatureConfig)) issues.push(`알 수 없는 config 필드: ${key}`);
  }
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) issues.push(`config 필드 누락: ${key}`);
  }
  if (config.version !== CANDLE_PATTERN_CONFIG_VERSION) {
    issues.push(`지원하지 않는 config version: ${String(config.version)}`);
  }
  if (!finite(config.epsilon) || config.epsilon <= 0 || config.epsilon > 1e-3) issues.push('epsilon 범위 오류');
  for (const key of ['dojiBodyRatioMax', 'strongBodyRatioMin', 'rejectionCloseLocationMin', 'breakoutBodyRatioMin'] as const) {
    const value = config[key];
    if (!finite(value) || value <= 0 || value > 1) issues.push(`${key} 범위 오류`);
  }
  for (const key of ['longWickToBodyMin', 'rejectionWickToBodyMin', 'engulfingBodyFactorMin', 'strengthSaturationMultiplier', 'volumeSpikeRatio'] as const) {
    const value = config[key];
    if (!finite(value) || value <= 0) issues.push(`${key} 범위 오류`);
  }
  if (finite(config.strengthSaturationMultiplier) && config.strengthSaturationMultiplier < 1) {
    issues.push('strengthSaturationMultiplier는 1 이상');
  }
  if (!positiveInteger(config.breakoutLookback)) issues.push('breakoutLookback 오류');
  if (!positiveInteger(config.volumeLookback)) issues.push('volumeLookback 오류');
  return issues;
}

export function candleGeometry(candle: Candle, epsilon = DEFAULT_CANDLE_FEATURE_CONFIG.epsilon): CandleGeometry | null {
  if (![candle.t, candle.o, candle.h, candle.l, candle.c].every(finite)) return null;
  if (candle.o <= 0 || candle.h <= 0 || candle.l <= 0 || candle.c <= 0) return null;
  if (candle.h < candle.l || candle.h < Math.max(candle.o, candle.c) || candle.l > Math.min(candle.o, candle.c)) return null;
  if (!finite(epsilon) || epsilon <= 0) return null;

  const bodySize = Math.abs(candle.c - candle.o);
  const fullRange = candle.h - candle.l;
  const upperWick = candle.h - Math.max(candle.o, candle.c);
  const lowerWick = Math.min(candle.o, candle.c) - candle.l;
  const rangeDenominator = Math.max(fullRange, epsilon);
  const bodyDenominator = Math.max(bodySize, epsilon);
  return {
    bullish: candle.c > candle.o,
    bearish: candle.c < candle.o,
    bodySize,
    fullRange,
    upperWick,
    lowerWick,
    bodyRatio: bodySize / rangeDenominator,
    upperWickRatio: upperWick / rangeDenominator,
    lowerWickRatio: lowerWick / rangeDenominator,
    upperWickToBody: upperWick / bodyDenominator,
    lowerWickToBody: lowerWick / bodyDenominator,
    closeLocation: fullRange > epsilon ? (candle.c - candle.l) / fullRange : 0.5,
  };
}

function invalid(config: CandleFeatureConfig, issues: string[]): CandleFeatureResult {
  return {
    configVersion: config.version || 'INVALID',
    sourceCandleOpenTime: null,
    quality: 'INVALID',
    issues,
    geometry: null,
    volume: null,
    averageVolume: null,
    volumeRatio: null,
    volumeSpike: null,
    patterns: null,
  };
}

export function extractLatestCandleFeatures(
  candles: Candle[] | null | undefined,
  config: CandleFeatureConfig = DEFAULT_CANDLE_FEATURE_CONFIG,
): CandleFeatureResult {
  const configIssues = validateCandleFeatureConfig(config);
  if (configIssues.length > 0) return invalid(config, configIssues);
  if (!Array.isArray(candles) || candles.length === 0) return invalid(config, ['캔들 없음']);

  const current = candles[candles.length - 1];
  const geometry = candleGeometry(current, config.epsilon);
  if (!geometry) return invalid(config, ['현재 캔들 OHLC 오류']);
  const previous = candles.length >= 2 ? candles[candles.length - 2] : null;
  const previousGeometry = previous ? candleGeometry(previous, config.epsilon) : null;
  if (previous && !previousGeometry) return invalid(config, ['이전 캔들 OHLC 오류']);

  const historyAvailable = candles.length > config.breakoutLookback;
  const history = historyAvailable ? candles.slice(-(config.breakoutLookback + 1), -1) : [];
  if (history.some(candle => candleGeometry(candle, config.epsilon) === null)) {
    return invalid(config, ['breakout lookback OHLC 오류']);
  }
  const priorHigh = historyAvailable ? Math.max(...history.map(candle => candle.h)) : null;
  const priorLow = historyAvailable ? Math.min(...history.map(candle => candle.l)) : null;

  const wickLower = thresholdStrength(
    geometry.lowerWickToBody,
    config.longWickToBodyMin,
    config.strengthSaturationMultiplier,
  );
  const wickUpper = thresholdStrength(
    geometry.upperWickToBody,
    config.longWickToBodyMin,
    config.strengthSaturationMultiplier,
  );
  const strongBody = thresholdStrength(
    geometry.bodyRatio,
    config.strongBodyRatioMin,
    1 / config.strongBodyRatioMin,
  );
  const doji = geometry.bodyRatio >= config.dojiBodyRatioMax
    ? 0
    : clamp100((1 - geometry.bodyRatio / config.dojiBodyRatioMax) * 100);

  let bullishEngulfing: number | null = null;
  let bearishEngulfing: number | null = null;
  let insideBar: number | null = null;
  let outsideBar: number | null = null;
  if (previous && previousGeometry) {
    const bodyFactor = geometry.bodySize / Math.max(previousGeometry.bodySize, config.epsilon);
    const engulfStrength = thresholdStrength(
      bodyFactor,
      config.engulfingBodyFactorMin,
      config.strengthSaturationMultiplier,
    );
    const bullishEngulfs = previous.c < previous.o && current.c > current.o
      && current.o <= previous.c && current.c >= previous.o;
    const bearishEngulfs = previous.c > previous.o && current.c < current.o
      && current.o >= previous.c && current.c <= previous.o;
    bullishEngulfing = bullishEngulfs ? engulfStrength : 0;
    bearishEngulfing = bearishEngulfs ? engulfStrength : 0;
    insideBar = current.h <= previous.h && current.l >= previous.l ? 100 : 0;
    outsideBar = current.h >= previous.h && current.l <= previous.l ? 100 : 0;
  }

  const rejectionBull = geometry.lowerWickToBody >= config.rejectionWickToBodyMin
    && geometry.closeLocation >= config.rejectionCloseLocationMin;
  const rejectionBear = geometry.upperWickToBody >= config.rejectionWickToBodyMin
    && geometry.closeLocation <= 1 - config.rejectionCloseLocationMin;
  const bullishRejection = rejectionBull
    ? clamp100((wickLower + geometry.closeLocation * 100) / 2)
    : 0;
  const bearishRejection = rejectionBear
    ? clamp100((wickUpper + (1 - geometry.closeLocation) * 100) / 2)
    : 0;

  const breakoutBodyStrength = thresholdStrength(
    geometry.bodyRatio,
    config.breakoutBodyRatioMin,
    1 / config.breakoutBodyRatioMin,
  );
  const bullishBreakout = priorHigh === null ? null
    : current.c > priorHigh && geometry.bullish ? breakoutBodyStrength : 0;
  const bearishBreakout = priorLow === null ? null
    : current.c < priorLow && geometry.bearish ? breakoutBodyStrength : 0;
  const bullishFailedBreakout = priorHigh === null ? null
    : current.h > priorHigh && current.c <= priorHigh ? clamp100(wickUpper) : 0;
  const bearishFailedBreakout = priorLow === null ? null
    : current.l < priorLow && current.c >= priorLow ? clamp100(wickLower) : 0;

  const volumeWindowAvailable = candles.length > config.volumeLookback;
  const volumeWindow = volumeWindowAvailable ? candles.slice(-(config.volumeLookback + 1), -1) : [];
  const volumeInputsAvailable = volumeWindowAvailable && current.v !== null
    && volumeWindow.every(candle => candle.v !== null);
  const averageVolume = volumeInputsAvailable
    ? volumeWindow.reduce((sum, candle) => sum + (candle.v as number), 0) / volumeWindow.length
    : null;
  const volumeRatio = averageVolume !== null && averageVolume > config.epsilon
    ? (current.v as number) / averageVolume
    : null;

  const issues: string[] = [];
  if (!previous) issues.push('이전 캔들 부족 — 2봉 패턴 unavailable');
  if (!historyAvailable) issues.push('breakout lookback 부족');
  if (!volumeInputsAvailable) issues.push('volume unavailable/insufficient — 합성값 미사용');

  return {
    configVersion: config.version,
    sourceCandleOpenTime: current.t,
    quality: issues.length > 0 ? 'DEGRADED' : 'GOOD',
    issues,
    geometry,
    volume: current.v,
    averageVolume,
    volumeRatio,
    volumeSpike: volumeRatio === null ? null : volumeRatio >= config.volumeSpikeRatio,
    patterns: {
      bullishCandle: geometry.bullish ? clamp100(geometry.bodyRatio * 100) : 0,
      bearishCandle: geometry.bearish ? clamp100(geometry.bodyRatio * 100) : 0,
      longLowerWick: wickLower,
      longUpperWick: wickUpper,
      bullishEngulfing,
      bearishEngulfing,
      insideBar,
      outsideBar,
      strongBullishBody: geometry.bullish ? strongBody : 0,
      strongBearishBody: geometry.bearish ? strongBody : 0,
      doji,
      bullishRejection,
      bearishRejection,
      bullishBreakout,
      bearishBreakout,
      bullishFailedBreakout,
      bearishFailedBreakout,
    },
  };
}
