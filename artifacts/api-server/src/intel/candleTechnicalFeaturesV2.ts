/**
 * Regime-Aware Strategy Ensemble v2 — advanced closed-candle indicators.
 * Pure and deterministic: no DB, RPC, worker, signer, risk, or execution imports.
 */
import type { Candle } from './types';

export const CANDLE_TECHNICAL_CONFIG_VERSION = 'regime-candle-technicals/v1' as const;

export interface CandleTechnicalConfig {
  version: typeof CANDLE_TECHNICAL_CONFIG_VERSION;
  emaFast: number;
  emaMedium: number;
  emaLong: number;
  emaMacro: number;
  atrPeriod: number;
  adxPeriod: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  keltnerEmaPeriod: number;
  keltnerAtrPeriod: number;
  keltnerAtrMultiplier: number;
  donchianPeriod: number;
  slopeLookback: number;
  volatilityLookback: number;
  zScorePeriod: number;
}

export const DEFAULT_CANDLE_TECHNICAL_CONFIG: CandleTechnicalConfig = Object.freeze({
  version: CANDLE_TECHNICAL_CONFIG_VERSION,
  emaFast: 9,
  emaMedium: 21,
  emaLong: 50,
  emaMacro: 200,
  atrPeriod: 14,
  adxPeriod: 14,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  keltnerEmaPeriod: 20,
  keltnerAtrPeriod: 10,
  keltnerAtrMultiplier: 1.5,
  donchianPeriod: 20,
  slopeLookback: 5,
  volatilityLookback: 50,
  zScorePeriod: 20,
});

export interface DirectionalIndexEvidence {
  adx: number;
  plusDi: number;
  minusDi: number;
}

export interface PriceChannelEvidence {
  upper: number;
  middle: number;
  lower: number;
  widthPct: number;
}

export interface CandleTechnicalSnapshot {
  configVersion: typeof CANDLE_TECHNICAL_CONFIG_VERSION | 'INVALID';
  quality: 'GOOD' | 'DEGRADED' | 'INVALID';
  sourceCandleOpenTime: number | null;
  issues: string[];
  ema: { fast: number | null; medium: number | null; long: number | null; macro: number | null };
  emaSlopePctPerBar: { fast: number | null; medium: number | null; long: number | null };
  atr: { absolute: number | null; percent: number | null };
  directionalIndex: DirectionalIndexEvidence | null;
  bollinger: PriceChannelEvidence | null;
  keltner: PriceChannelEvidence | null;
  donchian: (PriceChannelEvidence & { excludesLatestCandle: true }) | null;
  volatilityPercentile: number | null;
  zScore: number | null;
}

const CONFIG_KEYS = [
  'version', 'emaFast', 'emaMedium', 'emaLong', 'emaMacro', 'atrPeriod', 'adxPeriod',
  'bollingerPeriod', 'bollingerStdDev', 'keltnerEmaPeriod', 'keltnerAtrPeriod',
  'keltnerAtrMultiplier', 'donchianPeriod', 'slopeLookback', 'volatilityLookback',
  'zScorePeriod',
] as const;

const round = (value: number, digits = 12): number => Number(value.toPrecision(digits));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateCandleTechnicalConfig(value: unknown): string[] {
  const issues: string[] = [];
  if (!record(value)) return ['technical config 객체 필요'];
  const allowed = new Set<string>(CONFIG_KEYS);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`알 수 없는 config 필드: ${key}`);
  for (const key of CONFIG_KEYS) if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push(`config 필드 누락: ${key}`);
  if (value.version !== CANDLE_TECHNICAL_CONFIG_VERSION) {
    issues.push(`지원하지 않는 config version: ${String(value.version)}`);
  }
  const integerKeys: Array<Exclude<keyof CandleTechnicalConfig,
    'version' | 'bollingerStdDev' | 'keltnerAtrMultiplier'>> = [
    'emaFast',
    'emaMedium',
    'emaLong',
    'emaMacro',
    'atrPeriod',
    'adxPeriod',
    'bollingerPeriod',
    'keltnerEmaPeriod',
    'keltnerAtrPeriod',
    'donchianPeriod',
    'volatilityLookback',
    'zScorePeriod',
    'slopeLookback',
  ];
  for (const key of integerKeys) {
    const number = value[key];
    if (!finite(number) || !Number.isInteger(number) || number < 2 || number > 500) {
      issues.push(`${key} 정수 범위 오류 (2..500)`);
    }
  }
  for (const key of ['bollingerStdDev', 'keltnerAtrMultiplier'] as const) {
    const number = value[key];
    if (!finite(number) || number <= 0 || number > 10) issues.push(`${key} 범위 오류 (0..10]`);
  }
  if (finite(value.emaFast) && finite(value.emaMedium) && finite(value.emaLong)
    && finite(value.emaMacro)
    && !(value.emaFast < value.emaMedium && value.emaMedium < value.emaLong
      && value.emaLong < value.emaMacro)) {
    issues.push('EMA 기간은 fast < medium < long < macro 이어야 함');
  }
  return issues;
}

function invalid(issues: string[]): CandleTechnicalSnapshot {
  return {
    configVersion: 'INVALID', quality: 'INVALID', sourceCandleOpenTime: null, issues,
    ema: { fast: null, medium: null, long: null, macro: null },
    emaSlopePctPerBar: { fast: null, medium: null, long: null },
    atr: { absolute: null, percent: null }, directionalIndex: null,
    bollinger: null, keltner: null, donchian: null,
    volatilityPercentile: null, zScore: null,
  };
}

function validateCandles(candles: Candle[]): string[] {
  const issues: string[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (![candle.t, candle.o, candle.h, candle.l, candle.c].every(finite)
      || candle.o <= 0 || candle.h <= 0 || candle.l <= 0 || candle.c <= 0
      || candle.h < Math.max(candle.o, candle.c)
      || candle.l > Math.min(candle.o, candle.c)) {
      issues.push(`candle[${index}] OHLC 오류`);
    }
    if (index > 0 && candle.t <= candles[index - 1].t) issues.push(`candle[${index}] timestamp 비증가`);
  }
  return issues;
}

function emaSeries(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    ema = values[index] * alpha + ema * (1 - alpha);
    result[index] = ema;
  }
  return result;
}

function latestEma(values: number[], period: number): number | null {
  const value = emaSeries(values, period).at(-1);
  return value === null || value === undefined ? null : round(value);
}

function trueRanges(candles: Candle[]): number[] {
  return candles.map((candle, index) => index === 0
    ? candle.h - candle.l
    : Math.max(
      candle.h - candle.l,
      Math.abs(candle.h - candles[index - 1].c),
      Math.abs(candle.l - candles[index - 1].c),
    ));
}

function wilderLatest(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    average = (average * (period - 1) + values[index]) / period;
  }
  return average;
}

function atr(candles: Candle[], period: number): number | null {
  const value = wilderLatest(trueRanges(candles), period);
  return value === null ? null : round(value);
}

export function computeDirectionalIndex(
  candles: Candle[],
  period: number,
): DirectionalIndexEvidence | null {
  if (candles.length < period * 2 + 1) return null;
  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    tr.push(Math.max(
      current.h - current.l,
      Math.abs(current.h - previous.c),
      Math.abs(current.l - previous.c),
    ));
    const up = current.h - previous.h;
    const down = previous.l - current.l;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  let smoothTr = tr.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothPlus = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothMinus = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dxValues: number[] = [];
  let plusDi = 0;
  let minusDi = 0;
  const pushDx = (): void => {
    plusDi = smoothTr > 0 ? (smoothPlus / smoothTr) * 100 : 0;
    minusDi = smoothTr > 0 ? (smoothMinus / smoothTr) * 100 : 0;
    const sum = plusDi + minusDi;
    dxValues.push(sum > 0 ? (Math.abs(plusDi - minusDi) / sum) * 100 : 0);
  };
  pushDx();
  for (let index = period; index < tr.length; index += 1) {
    smoothTr = smoothTr - smoothTr / period + tr[index];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[index];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[index];
    pushDx();
  }
  if (dxValues.length < period) return null;
  let adx = dxValues.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < dxValues.length; index += 1) {
    adx = (adx * (period - 1) + dxValues[index]) / period;
  }
  return { adx: round(adx, 8), plusDi: round(plusDi, 8), minusDi: round(minusDi, 8) };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], average: number): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function channel(upper: number, middle: number, lower: number): PriceChannelEvidence {
  return {
    upper: round(upper), middle: round(middle), lower: round(lower),
    widthPct: middle > 0 ? round(((upper - lower) / middle) * 100, 8) : 0,
  };
}

function bollinger(values: number[], period: number, multiplier: number): PriceChannelEvidence | null {
  if (values.length < period) return null;
  const sample = values.slice(-period);
  const middle = mean(sample);
  const deviation = standardDeviation(sample, middle);
  return channel(middle + deviation * multiplier, middle, middle - deviation * multiplier);
}

function donchian(candles: Candle[], period: number): CandleTechnicalSnapshot['donchian'] {
  if (candles.length < period + 1) return null;
  const sample = candles.slice(-(period + 1), -1);
  const upper = Math.max(...sample.map(candle => candle.h));
  const lower = Math.min(...sample.map(candle => candle.l));
  return { ...channel(upper, (upper + lower) / 2, lower), excludesLatestCandle: true };
}

function slope(values: number[], period: number, lookback: number): number | null {
  const series = emaSeries(values, period);
  const latest = series.at(-1);
  const previous = series.at(-(lookback + 1));
  if (latest === null || latest === undefined || previous === null || previous === undefined || previous <= 0) return null;
  return round(((latest - previous) / previous / lookback) * 100, 8);
}

function volatilityPercentile(candles: Candle[], atrPeriod: number, lookback: number): number | null {
  const values: number[] = [];
  const firstEnd = atrPeriod - 1;
  for (let end = firstEnd; end < candles.length; end += 1) {
    const sample = candles.slice(0, end + 1);
    const value = atr(sample, atrPeriod);
    const close = candles[end].c;
    if (value !== null && close > 0) values.push((value / close) * 100);
  }
  const sample = values.slice(-lookback);
  if (sample.length < Math.min(lookback, 10)) return null;
  const latest = sample.at(-1)!;
  return round((sample.filter(value => value <= latest).length / sample.length) * 100, 8);
}

function zScore(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const sample = values.slice(-period);
  const average = mean(sample);
  const deviation = standardDeviation(sample, average);
  if (deviation === 0) return 0;
  return round((sample.at(-1)! - average) / deviation, 8);
}

export function computeCandleTechnicalSnapshot(
  candlesInput: Candle[] | null | undefined,
  configInput: unknown = DEFAULT_CANDLE_TECHNICAL_CONFIG,
): CandleTechnicalSnapshot {
  const configIssues = validateCandleTechnicalConfig(configInput);
  if (configIssues.length > 0 || !record(configInput)) return invalid(configIssues);
  const config = configInput as unknown as CandleTechnicalConfig;
  if (!Array.isArray(candlesInput) || candlesInput.length === 0) return invalid(['캔들 없음']);
  const candleIssues = validateCandles(candlesInput);
  if (candleIssues.length > 0) return invalid(candleIssues);
  const candles = candlesInput;
  const closes = candles.map(candle => candle.c);
  const ema = {
    fast: latestEma(closes, config.emaFast),
    medium: latestEma(closes, config.emaMedium),
    long: latestEma(closes, config.emaLong),
    macro: latestEma(closes, config.emaMacro),
  };
  const atrAbsolute = atr(candles, config.atrPeriod);
  const currentClose = closes.at(-1)!;
  const keltnerMiddle = latestEma(closes, config.keltnerEmaPeriod);
  const keltnerAtr = atr(candles, config.keltnerAtrPeriod);
  const keltner = keltnerMiddle === null || keltnerAtr === null ? null : channel(
    keltnerMiddle + keltnerAtr * config.keltnerAtrMultiplier,
    keltnerMiddle,
    keltnerMiddle - keltnerAtr * config.keltnerAtrMultiplier,
  );
  const result: CandleTechnicalSnapshot = {
    configVersion: CANDLE_TECHNICAL_CONFIG_VERSION,
    quality: 'GOOD',
    sourceCandleOpenTime: candles.at(-1)!.t,
    issues: [],
    ema,
    emaSlopePctPerBar: {
      fast: slope(closes, config.emaFast, config.slopeLookback),
      medium: slope(closes, config.emaMedium, config.slopeLookback),
      long: slope(closes, config.emaLong, config.slopeLookback),
    },
    atr: {
      absolute: atrAbsolute,
      percent: atrAbsolute === null ? null : round((atrAbsolute / currentClose) * 100, 8),
    },
    directionalIndex: computeDirectionalIndex(candles, config.adxPeriod),
    bollinger: bollinger(closes, config.bollingerPeriod, config.bollingerStdDev),
    keltner,
    donchian: donchian(candles, config.donchianPeriod),
    volatilityPercentile: volatilityPercentile(candles, config.atrPeriod, config.volatilityLookback),
    zScore: zScore(closes, config.zScorePeriod),
  };
  const unavailable = [
    ['EMA fast', ema.fast], ['EMA medium', ema.medium], ['EMA long', ema.long], ['EMA macro', ema.macro],
    ['EMA slope fast', result.emaSlopePctPerBar.fast],
    ['EMA slope medium', result.emaSlopePctPerBar.medium],
    ['EMA slope long', result.emaSlopePctPerBar.long],
    ['ATR', result.atr.absolute], ['ADX', result.directionalIndex], ['Bollinger', result.bollinger],
    ['Keltner', result.keltner], ['Donchian', result.donchian],
    ['volatility percentile', result.volatilityPercentile], ['Z-score', result.zScore],
  ] as const;
  result.issues = unavailable.filter(([, value]) => value === null).map(([name]) => `${name} unavailable`);
  if (result.issues.length > 0) result.quality = 'DEGRADED';
  return result;
}
