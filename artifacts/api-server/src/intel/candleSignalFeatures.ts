/** Pure feature extraction for validated, closed candle frames. */
import { computeAtrPct } from './candles';
import {
  CandleAnatomy,
  CandleFrameFeatures,
  CandleSignalConfig,
  SupportResistanceEvidence,
  SwingHighPattern,
  SwingLowPattern,
  SwingStructure,
  VolumeConfirmation,
} from './candleSignalContract';
import { ValidatedCandleFrame } from './candleFoundationV2';
import { Candle } from './types';

/** Significant-digit serialization preserves geometry for sub-micro priced assets. */
const round = (value: number, significantDigits = 12): number =>
  Number(value.toPrecision(significantDigits));

export function computeCandleAnatomy(candle: Candle): CandleAnatomy {
  const bodyAbs = Math.abs(candle.c - candle.o);
  const rangeAbs = candle.h - candle.l;
  const upperWickAbs = Math.max(0, candle.h - Math.max(candle.o, candle.c));
  const lowerWickAbs = Math.max(0, Math.min(candle.o, candle.c) - candle.l);
  return {
    bodyAbs: round(bodyAbs),
    rangeAbs: round(rangeAbs),
    upperWickAbs: round(upperWickAbs),
    lowerWickAbs: round(lowerWickAbs),
    bodyToRangeRatio: rangeAbs > 0 ? round(bodyAbs / rangeAbs) : 0,
    upperWickToRangeRatio: rangeAbs > 0 ? round(upperWickAbs / rangeAbs) : 0,
    lowerWickToRangeRatio: rangeAbs > 0 ? round(lowerWickAbs / rangeAbs) : 0,
    upperWickToBodyRatio: bodyAbs > 0 ? round(upperWickAbs / bodyAbs) : null,
    lowerWickToBodyRatio: bodyAbs > 0 ? round(lowerWickAbs / bodyAbs) : null,
    bullish: candle.c > candle.o,
    bearish: candle.c < candle.o,
  };
}

export function computeSimpleMovingAverage(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const values = candles.slice(-period);
  return round(values.reduce((sum, candle) => sum + candle.c, 0) / period);
}

/** Simple close-to-close candle RSI. Insufficient data remains null. */
export function computeCandleRsi(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const delta = slice[index].c - slice[index - 1].c;
    if (delta > 0) gains += delta;
    else if (delta < 0) losses += Math.abs(delta);
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  const rs = (gains / period) / (losses / period);
  return round(100 - 100 / (1 + rs), 6);
}

function comparePattern(
  recent: number | null,
  previous: number | null,
  tolerancePct: number,
  higher: 'HH' | 'HL',
  lower: 'LH' | 'LL',
): SwingHighPattern | SwingLowPattern {
  if (recent === null || previous === null || previous <= 0) return 'UNAVAILABLE';
  const changePct = ((recent - previous) / previous) * 100;
  if (changePct > tolerancePct) return higher;
  if (changePct < -tolerancePct) return lower;
  return 'EQUAL';
}

export function computeSwingStructure(
  candles: Candle[],
  lookback: number,
  window: number,
  tolerancePct: number,
): SwingStructure {
  const slice = candles.slice(-lookback);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = window; index < slice.length - window; index += 1) {
    const current = slice[index];
    const neighbors = [
      ...slice.slice(index - window, index),
      ...slice.slice(index + 1, index + window + 1),
    ];
    if (neighbors.every(candle => current.h > candle.h)) highs.push(current.h);
    if (neighbors.every(candle => current.l < candle.l)) lows.push(current.l);
  }
  const recentSwingHigh = highs.at(-1) ?? null;
  const previousSwingHigh = highs.at(-2) ?? null;
  const recentSwingLow = lows.at(-1) ?? null;
  const previousSwingLow = lows.at(-2) ?? null;
  return {
    recentSwingHigh,
    previousSwingHigh,
    recentSwingLow,
    previousSwingLow,
    highPattern: comparePattern(
      recentSwingHigh,
      previousSwingHigh,
      tolerancePct,
      'HH',
      'LH',
    ) as SwingHighPattern,
    lowPattern: comparePattern(
      recentSwingLow,
      previousSwingLow,
      tolerancePct,
      'HL',
      'LL',
    ) as SwingLowPattern,
  };
}

export function computeVolumeConfirmation(
  candles: Candle[],
  averagePeriod: number,
  ratioThreshold: number,
): VolumeConfirmation {
  if (candles.length < averagePeriod + 1) {
    return {
      quality: 'UNAVAILABLE',
      current: null,
      recentAverage: null,
      ratio: null,
      confirmed: null,
      reason: '거래량 평균 계산에 필요한 캔들 부족',
    };
  }
  const current = candles.at(-1)!.v;
  const history = candles.slice(-(averagePeriod + 1), -1).map(candle => candle.v);
  if (current === null || history.some(value => value === null)) {
    return {
      quality: 'UNAVAILABLE',
      current,
      recentAverage: null,
      ratio: null,
      confirmed: null,
      reason: '거래량 source unavailable',
    };
  }
  const numericHistory = history as number[];
  const recentAverage = numericHistory.reduce((sum, value) => sum + value, 0) / numericHistory.length;
  if (!Number.isFinite(recentAverage) || recentAverage <= 0) {
    return {
      quality: 'UNRELIABLE',
      current,
      recentAverage: Number.isFinite(recentAverage) ? recentAverage : null,
      ratio: null,
      confirmed: null,
      reason: '거래량 평균이 0 이하이거나 비정상',
    };
  }
  const ratio = current / recentAverage;
  return {
    quality: 'AVAILABLE',
    current,
    recentAverage: round(recentAverage),
    ratio: round(ratio, 6),
    confirmed: ratio >= ratioThreshold,
    reason: null,
  };
}

export function computeSupportResistance(
  candles: Candle[],
  entry: number,
  swings: SwingStructure,
  lookback: number,
  tolerancePct: number,
): SupportResistanceEvidence {
  const slice = candles.slice(-lookback);
  const lowCandidates = [
    swings.recentSwingLow,
    swings.previousSwingLow,
    ...slice.map(candle => candle.l),
  ].filter((value): value is number => value !== null && value < entry);
  const highCandidates = [
    swings.recentSwingHigh,
    swings.previousSwingHigh,
    ...slice.map(candle => candle.h),
  ].filter((value): value is number => value !== null && value > entry);
  const support = lowCandidates.length > 0 ? Math.max(...lowCandidates) : null;
  const resistance = highCandidates.length > 0 ? Math.min(...highCandidates) : null;
  const supportDistancePct = support !== null ? ((entry - support) / entry) * 100 : null;
  const resistanceDistancePct = resistance !== null ? ((resistance - entry) / entry) * 100 : null;
  return {
    support: support === null ? null : round(support),
    resistance: resistance === null ? null : round(resistance),
    supportDistancePct: supportDistancePct === null ? null : round(supportDistancePct, 6),
    resistanceDistancePct: resistanceDistancePct === null ? null : round(resistanceDistancePct, 6),
    nearSupport: supportDistancePct === null ? null : supportDistancePct <= tolerancePct,
    nearResistance: resistanceDistancePct === null ? null : resistanceDistancePct <= tolerancePct,
  };
}

export function extractCandleFrameFeatures(
  frame: ValidatedCandleFrame,
  config: CandleSignalConfig,
): CandleFrameFeatures {
  const issues: string[] = [];
  const candles = frame.candles;
  const last = candles.at(-1);
  if (!last || frame.latestCloseTimeMs === null) {
    throw new Error('validated frame에 완료 캔들이 없음');
  }
  const maFast = computeSimpleMovingAverage(candles, config.periods.maFast);
  const maMedium = computeSimpleMovingAverage(candles, config.periods.maMedium);
  const maLong = computeSimpleMovingAverage(candles, config.periods.maLong);
  const rsi = computeCandleRsi(candles, config.periods.rsi);
  const atrPct = computeAtrPct(candles, config.periods.atr);
  const atrAbs = atrPct === null ? null : round(last.c * atrPct / 100);
  const volume = computeVolumeConfirmation(
    candles,
    config.periods.volumeAverage,
    config.thresholds.volumeRatioMin,
  );
  const swings = computeSwingStructure(
    candles,
    config.periods.swingLookback,
    config.periods.swingWindow,
    config.thresholds.structureBreakTolerancePct,
  );
  const supportResistance = computeSupportResistance(
    candles,
    last.c,
    swings,
    config.periods.swingLookback,
    config.thresholds.supportResistanceTolerancePct,
  );
  if (maFast === null || maMedium === null || maLong === null) issues.push('MA 계산 데이터 부족');
  if (rsi === null) issues.push('RSI 계산 데이터 부족');
  if (atrPct === null) issues.push('ATR 계산 데이터 부족');
  if (swings.highPattern === 'UNAVAILABLE' || swings.lowPattern === 'UNAVAILABLE') {
    issues.push('swing 구조 표본 부족');
  }
  if (volume.quality !== 'AVAILABLE') issues.push(volume.reason ?? '거래량 unavailable');
  return {
    timeframe: frame.timeframe,
    closeTimeMs: frame.latestCloseTimeMs,
    open: last.o,
    high: last.h,
    low: last.l,
    close: last.c,
    anatomy: computeCandleAnatomy(last),
    maFast,
    maMedium,
    maLong,
    rsi,
    atrPct,
    atrAbs,
    volume,
    swings,
    supportResistance,
    issues,
  };
}