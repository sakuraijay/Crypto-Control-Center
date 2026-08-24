/**
 * Regime-Aware Strategy Ensemble v2 — confirmed closed-candle market structure.
 * Pure evidence only: no persistence, network, risk, signer, or execution imports.
 */
import type { Candle } from './types';

export const MARKET_STRUCTURE_CONFIG_VERSION = 'regime-market-structure/v1' as const;

export interface MarketStructureConfig {
  version: typeof MARKET_STRUCTURE_CONFIG_VERSION;
  lookback: number;
  swingLeftBars: number;
  swingRightBars: number;
  structureTolerancePct: number;
  zoneTolerancePct: number;
  rangeLookback: number;
  breakoutBodyRatioMin: number;
  retestTolerancePct: number;
}

export const DEFAULT_MARKET_STRUCTURE_CONFIG: MarketStructureConfig = Object.freeze({
  version: MARKET_STRUCTURE_CONFIG_VERSION,
  lookback: 120,
  swingLeftBars: 2,
  swingRightBars: 2,
  structureTolerancePct: 0.1,
  zoneTolerancePct: 0.35,
  rangeLookback: 20,
  breakoutBodyRatioMin: 0.55,
  retestTolerancePct: 0.25,
});

export type SwingPointType = 'HIGH' | 'LOW';
export interface ConfirmedSwingPoint {
  type: SwingPointType;
  price: number;
  candleOpenTime: number;
  confirmedAtOpenTime: number;
  sourceIndex: number;
}

export interface StructureZone {
  low: number;
  high: number;
  midpoint: number;
  touches: number;
}

export type StructureTrend = 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN';
export type StructureEvent = 'BOS_UP' | 'BOS_DOWN' | 'CHOCH_UP' | 'CHOCH_DOWN' | 'NONE';
export type BreakoutState = 'BREAKOUT_UP' | 'BREAKOUT_DOWN' | 'FAILED_UP' | 'FAILED_DOWN' | 'RETEST_UP' | 'RETEST_DOWN' | 'NONE';

export interface MarketStructureEvidence {
  configVersion: typeof MARKET_STRUCTURE_CONFIG_VERSION | 'INVALID';
  quality: 'GOOD' | 'DEGRADED' | 'INVALID';
  sourceCandleOpenTime: number | null;
  issues: string[];
  swingHighs: ConfirmedSwingPoint[];
  swingLows: ConfirmedSwingPoint[];
  highPattern: 'HH' | 'LH' | 'EQUAL' | 'UNAVAILABLE';
  lowPattern: 'HL' | 'LL' | 'EQUAL' | 'UNAVAILABLE';
  trend: StructureTrend;
  event: StructureEvent;
  brokenLevel: number | null;
  supportZones: StructureZone[];
  resistanceZones: StructureZone[];
  range: { high: number | null; low: number | null; midpoint: number | null };
  breakout: { state: BreakoutState; level: number | null; bodyRatio: number | null };
}

const CONFIG_KEYS = [
  'version', 'lookback', 'swingLeftBars', 'swingRightBars', 'structureTolerancePct',
  'zoneTolerancePct', 'rangeLookback', 'breakoutBodyRatioMin', 'retestTolerancePct',
] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const round = (value: number, digits = 12): number => Number(value.toPrecision(digits));

export function validateMarketStructureConfig(value: unknown): string[] {
  if (!record(value)) return ['market structure config 객체 필요'];
  const issues: string[] = [];
  const allowed = new Set<string>(CONFIG_KEYS);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`알 수 없는 config 필드: ${key}`);
  for (const key of CONFIG_KEYS) if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push(`config 필드 누락: ${key}`);
  if (value.version !== MARKET_STRUCTURE_CONFIG_VERSION) issues.push(`지원하지 않는 config version: ${String(value.version)}`);
  for (const key of ['lookback', 'swingLeftBars', 'swingRightBars', 'rangeLookback'] as const) {
    const number = value[key];
    if (!finite(number) || !Number.isInteger(number) || number < 1 || number > 1_000) issues.push(`${key} 정수 범위 오류`);
  }
  for (const key of ['structureTolerancePct', 'zoneTolerancePct', 'retestTolerancePct'] as const) {
    const number = value[key];
    if (!finite(number) || number < 0 || number > 10) issues.push(`${key} 범위 오류`);
  }
  if (!finite(value.breakoutBodyRatioMin) || value.breakoutBodyRatioMin < 0
    || value.breakoutBodyRatioMin > 1) issues.push('breakoutBodyRatioMin 범위 오류');
  if (finite(value.lookback) && finite(value.swingLeftBars) && finite(value.swingRightBars)
    && value.lookback < value.swingLeftBars + value.swingRightBars + 3) issues.push('lookback이 swing 확인 표본보다 작음');
  return issues;
}

function invalid(issues: string[]): MarketStructureEvidence {
  return {
    configVersion: 'INVALID', quality: 'INVALID', sourceCandleOpenTime: null, issues,
    swingHighs: [], swingLows: [], highPattern: 'UNAVAILABLE', lowPattern: 'UNAVAILABLE',
    trend: 'UNKNOWN', event: 'NONE', brokenLevel: null, supportZones: [], resistanceZones: [],
    range: { high: null, low: null, midpoint: null },
    breakout: { state: 'NONE', level: null, bodyRatio: null },
  };
}

function validateCandles(candles: Candle[]): string[] {
  const issues: string[] = [];
  candles.forEach((candle, index) => {
    if (![candle.t, candle.o, candle.h, candle.l, candle.c].every(finite)
      || candle.o <= 0 || candle.h <= 0 || candle.l <= 0 || candle.c <= 0
      || candle.h < Math.max(candle.o, candle.c) || candle.l > Math.min(candle.o, candle.c)) {
      issues.push(`candle[${index}] OHLC 오류`);
    }
    if (index > 0 && candle.t <= candles[index - 1].t) issues.push(`candle[${index}] timestamp 비증가`);
  });
  return issues;
}

export function findConfirmedSwingPoints(
  candles: Candle[], leftBars: number, rightBars: number,
): { highs: ConfirmedSwingPoint[]; lows: ConfirmedSwingPoint[] } {
  const highs: ConfirmedSwingPoint[] = [];
  const lows: ConfirmedSwingPoint[] = [];
  for (let index = leftBars; index < candles.length - rightBars; index += 1) {
    const candle = candles[index];
    const left = candles.slice(index - leftBars, index);
    const right = candles.slice(index + 1, index + rightBars + 1);
    const neighbors = [...left, ...right];
    if (neighbors.every(item => candle.h > item.h)) highs.push({
      type: 'HIGH', price: round(candle.h), candleOpenTime: candle.t,
      confirmedAtOpenTime: candles[index + rightBars].t, sourceIndex: index,
    });
    if (neighbors.every(item => candle.l < item.l)) lows.push({
      type: 'LOW', price: round(candle.l), candleOpenTime: candle.t,
      confirmedAtOpenTime: candles[index + rightBars].t, sourceIndex: index,
    });
  }
  return { highs, lows };
}

function pattern(
  points: ConfirmedSwingPoint[], tolerancePct: number, higher: 'HH' | 'HL', lower: 'LH' | 'LL',
): 'HH' | 'HL' | 'LH' | 'LL' | 'EQUAL' | 'UNAVAILABLE' {
  if (points.length < 2) return 'UNAVAILABLE';
  const previous = points.at(-2)!.price;
  const recent = points.at(-1)!.price;
  const changePct = ((recent - previous) / previous) * 100;
  if (changePct > tolerancePct) return higher;
  if (changePct < -tolerancePct) return lower;
  return 'EQUAL';
}

function clusterZones(points: ConfirmedSwingPoint[], tolerancePct: number): StructureZone[] {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters: number[][] = [];
  for (const point of sorted) {
    const cluster = clusters.at(-1);
    const midpoint = cluster ? (Math.min(...cluster) + Math.max(...cluster)) / 2 : null;
    if (cluster && midpoint! > 0 && Math.abs(point.price - midpoint!) / midpoint! * 100 <= tolerancePct) {
      cluster.push(point.price);
    } else clusters.push([point.price]);
  }
  return clusters.map(cluster => {
    const low = Math.min(...cluster);
    const high = Math.max(...cluster);
    return { low: round(low), high: round(high), midpoint: round((low + high) / 2), touches: cluster.length };
  });
}

function priorRange(candles: Candle[], lookback: number, offset = 1): { high: number; low: number } | null {
  const end = candles.length - offset;
  const start = Math.max(0, end - lookback);
  const sample = candles.slice(start, end);
  if (sample.length < lookback) return null;
  return { high: Math.max(...sample.map(candle => candle.h)), low: Math.min(...sample.map(candle => candle.l)) };
}

export function computeMarketStructure(
  candlesInput: Candle[] | null | undefined,
  configInput: unknown = DEFAULT_MARKET_STRUCTURE_CONFIG,
): MarketStructureEvidence {
  const configIssues = validateMarketStructureConfig(configInput);
  if (configIssues.length > 0 || !record(configInput)) return invalid(configIssues);
  if (!Array.isArray(candlesInput) || candlesInput.length === 0) return invalid(['캔들 없음']);
  const candleIssues = validateCandles(candlesInput);
  if (candleIssues.length > 0) return invalid(candleIssues);
  const config = configInput as unknown as MarketStructureConfig;
  const candles = candlesInput.slice(-config.lookback);
  const swings = findConfirmedSwingPoints(candles, config.swingLeftBars, config.swingRightBars);
  const highPattern = pattern(swings.highs, config.structureTolerancePct, 'HH', 'LH') as MarketStructureEvidence['highPattern'];
  const lowPattern = pattern(swings.lows, config.structureTolerancePct, 'HL', 'LL') as MarketStructureEvidence['lowPattern'];
  const trend: StructureTrend = highPattern === 'HH' && lowPattern === 'HL' ? 'BULLISH'
    : highPattern === 'LH' && lowPattern === 'LL' ? 'BEARISH'
      : highPattern === 'UNAVAILABLE' || lowPattern === 'UNAVAILABLE' ? 'UNKNOWN' : 'MIXED';
  const latest = candles.at(-1)!;
  const previous = candles.at(-2);
  const latestHigh = swings.highs.at(-1)?.price ?? null;
  const latestLow = swings.lows.at(-1)?.price ?? null;
  const brokeUp = previous !== undefined && latestHigh !== null && previous.c <= latestHigh && latest.c > latestHigh;
  const brokeDown = previous !== undefined && latestLow !== null && previous.c >= latestLow && latest.c < latestLow;
  let event: StructureEvent = 'NONE';
  let brokenLevel: number | null = null;
  if (brokeUp) {
    event = trend === 'BEARISH' ? 'CHOCH_UP' : 'BOS_UP';
    brokenLevel = latestHigh;
  } else if (brokeDown) {
    event = trend === 'BULLISH' ? 'CHOCH_DOWN' : 'BOS_DOWN';
    brokenLevel = latestLow;
  }
  const range = priorRange(candles, config.rangeLookback);
  const bodyRatio = latest.h > latest.l ? Math.abs(latest.c - latest.o) / (latest.h - latest.l) : 0;
  let breakout: MarketStructureEvidence['breakout'] = { state: 'NONE', level: null, bodyRatio: round(bodyRatio, 8) };
  if (range) {
    if (latest.c > range.high && bodyRatio >= config.breakoutBodyRatioMin) breakout = { state: 'BREAKOUT_UP', level: round(range.high), bodyRatio: round(bodyRatio, 8) };
    else if (latest.c < range.low && bodyRatio >= config.breakoutBodyRatioMin) breakout = { state: 'BREAKOUT_DOWN', level: round(range.low), bodyRatio: round(bodyRatio, 8) };
    else if (latest.h > range.high && latest.c <= range.high) breakout = { state: 'FAILED_UP', level: round(range.high), bodyRatio: round(bodyRatio, 8) };
    else if (latest.l < range.low && latest.c >= range.low) breakout = { state: 'FAILED_DOWN', level: round(range.low), bodyRatio: round(bodyRatio, 8) };
  }
  const retestBase = priorRange(candles, config.rangeLookback, 2);
  if (previous && retestBase) {
    const upperTolerance = retestBase.high * (1 + config.retestTolerancePct / 100);
    const lowerTolerance = retestBase.low * (1 - config.retestTolerancePct / 100);
    if (previous.c > retestBase.high && latest.l <= upperTolerance && latest.c > retestBase.high) {
      breakout = { state: 'RETEST_UP', level: round(retestBase.high), bodyRatio: round(bodyRatio, 8) };
    } else if (previous.c < retestBase.low && latest.h >= lowerTolerance && latest.c < retestBase.low) {
      breakout = { state: 'RETEST_DOWN', level: round(retestBase.low), bodyRatio: round(bodyRatio, 8) };
    }
  }
  const issues: string[] = [];
  if (swings.highs.length < 2) issues.push('confirmed swing high 표본 부족');
  if (swings.lows.length < 2) issues.push('confirmed swing low 표본 부족');
  if (!range) issues.push('range 표본 부족');
  return {
    configVersion: MARKET_STRUCTURE_CONFIG_VERSION,
    quality: issues.length > 0 ? 'DEGRADED' : 'GOOD',
    sourceCandleOpenTime: latest.t,
    issues,
    swingHighs: swings.highs,
    swingLows: swings.lows,
    highPattern,
    lowPattern,
    trend,
    event,
    brokenLevel,
    supportZones: clusterZones(swings.lows, config.zoneTolerancePct),
    resistanceZones: clusterZones(swings.highs, config.zoneTolerancePct),
    range: range ? { high: round(range.high), low: round(range.low), midpoint: round((range.high + range.low) / 2) }
      : { high: null, low: null, midpoint: null },
    breakout,
  };
}
