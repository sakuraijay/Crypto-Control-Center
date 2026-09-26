/**
 * Regime-Aware Strategy Ensemble v2 — Phase 1 candle boundary.
 *
 * This module is intentionally pure and has no DB, signer, worker, or execution
 * imports. It validates the official GMX candle-cache output before any future
 * feature, regime, strategy, or risk calculation may consume it.
 */
import { validateCandleSeries } from './candles';
import { Candle, TIMEFRAME_MS, Timeframe } from './types';

export const STRATEGY_TIMEFRAMES = ['15m', '1h', '4h'] as const;
export type StrategyTimeframe = typeof STRATEGY_TIMEFRAMES[number];
export type CandleFoundationQuality = 'GOOD' | 'DEGRADED' | 'INVALID';
export const CANDLE_FOUNDATION_CONFIG_VERSION = 'regime-candle-foundation/v1' as const;

export interface CandleFramePolicy {
  expectedCount: number;
  minCount: number;
  /** The latest completed candle may be at most this many frame lengths old. */
  maxStaleIntervals: number;
}

export interface CandleFoundationConfig {
  version: string;
  closeGraceMs: number;
  trustedSources: readonly string[];
  frames: Record<StrategyTimeframe, CandleFramePolicy>;
}

export const DEFAULT_CANDLE_FOUNDATION_CONFIG: CandleFoundationConfig = Object.freeze({
  version: CANDLE_FOUNDATION_CONFIG_VERSION,
  closeGraceMs: 2_000,
  trustedSources: Object.freeze(['gmx-official-api']),
  frames: Object.freeze({
    '15m': Object.freeze({ expectedCount: 240, minCount: 60, maxStaleIntervals: 2 }),
    '1h': Object.freeze({ expectedCount: 240, minCount: 60, maxStaleIntervals: 2 }),
    '4h': Object.freeze({ expectedCount: 240, minCount: 60, maxStaleIntervals: 2 }),
  }),
});

export interface CandleFrameInput {
  symbol: string;
  timeframe: StrategyTimeframe;
  source: string;
  fetchedAtMs: number;
  candles: Candle[] | null | undefined;
}

export interface ValidatedCandleFrame {
  symbol: string;
  timeframe: StrategyTimeframe;
  source: string;
  fetchedAtMs: number;
  candles: Candle[];
  excludedOpenCandles: number;
  latestCloseTimeMs: number | null;
  dataAgeMs: number | null;
  volumeAvailable: boolean;
  quality: CandleFoundationQuality;
  issues: string[];
}

export interface MultiTimeframeCandleSet {
  symbol: string;
  configVersion: string;
  calculatedAtMs: number;
  quality: CandleFoundationQuality;
  tradeAllowed: boolean;
  frames: Partial<Record<StrategyTimeframe, ValidatedCandleFrame>>;
  issues: string[];
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: string[],
): void => {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) issues.push(`${path}.${key} 알 수 없는 필드`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push(`${path}.${key} 누락`);
  }
};

/** Runtime validation keeps research knobs configurable without accepting unsafe values. */
export function validateCandleFoundationConfig(config: CandleFoundationConfig): string[] {
  const issues: string[] = [];
  if (!isRecord(config)) return ['foundation config 객체 필요'];
  validateExactKeys(config, ['version', 'closeGraceMs', 'trustedSources', 'frames'], 'config', issues);
  if (config.version !== CANDLE_FOUNDATION_CONFIG_VERSION) {
    issues.push(`지원하지 않는 foundation config version: ${String(config.version)}`);
  }
  if (!isFiniteNumber(config.closeGraceMs) || config.closeGraceMs < 0 || config.closeGraceMs > 60_000) {
    issues.push('closeGraceMs 범위 오류');
  }
  if (!Array.isArray(config.trustedSources) || config.trustedSources.length === 0
    || config.trustedSources.some(source => typeof source !== 'string' || source.trim().length === 0)) {
    issues.push('trustedSources 누락/오류');
  }
  if (!isRecord(config.frames)) {
    issues.push('frames 객체 필요');
    return issues;
  }
  validateExactKeys(config.frames, STRATEGY_TIMEFRAMES, 'config.frames', issues);
  for (const timeframe of STRATEGY_TIMEFRAMES) {
    const policy = config.frames[timeframe];
    if (!policy) {
      issues.push(`${timeframe} policy 누락`);
      continue;
    }
    if (!isRecord(policy)) {
      issues.push(`${timeframe} policy 객체 필요`);
      continue;
    }
    validateExactKeys(policy, ['expectedCount', 'minCount', 'maxStaleIntervals'], `config.frames.${timeframe}`, issues);
    if (!isPositiveInteger(policy.expectedCount)) issues.push(`${timeframe} expectedCount 오류`);
    if (!isPositiveInteger(policy.minCount)) issues.push(`${timeframe} minCount 오류`);
    if (isPositiveInteger(policy.expectedCount) && isPositiveInteger(policy.minCount)
      && policy.minCount > policy.expectedCount) {
      issues.push(`${timeframe} minCount가 expectedCount 초과`);
    }
    if (!isPositiveInteger(policy.maxStaleIntervals)) issues.push(`${timeframe} maxStaleIntervals 오류`);
  }
  return issues;
}

function invalidFrame(input: CandleFrameInput, issues: string[]): ValidatedCandleFrame {
  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    source: input.source,
    fetchedAtMs: input.fetchedAtMs,
    candles: [],
    excludedOpenCandles: 0,
    latestCloseTimeMs: null,
    dataAgeMs: null,
    volumeAvailable: false,
    quality: 'INVALID',
    issues,
  };
}

export function validateClosedCandleFrame(
  input: CandleFrameInput,
  nowMs: number,
  config: CandleFoundationConfig = DEFAULT_CANDLE_FOUNDATION_CONFIG,
): ValidatedCandleFrame {
  const issues: string[] = [];
  const configIssues = validateCandleFoundationConfig(config);
  if (configIssues.length > 0) return invalidFrame(input, configIssues);
  if (!isFiniteNumber(nowMs)) return invalidFrame(input, ['판정 시각 오류']);
  if (typeof input.symbol !== 'string' || input.symbol.trim().length === 0) issues.push('symbol 누락');
  if (!STRATEGY_TIMEFRAMES.includes(input.timeframe)) issues.push('지원하지 않는 timeframe');
  if (!config.trustedSources.includes(input.source)) issues.push(`검증되지 않은 source: ${input.source || '없음'}`);
  if (!isFiniteNumber(input.fetchedAtMs) || input.fetchedAtMs > nowMs + 5_000) issues.push('fetchedAt 시각 오류');
  if (!Array.isArray(input.candles) || input.candles.length === 0) issues.push('캔들 없음');
  if (issues.length > 0) return invalidFrame(input, issues);

  const step = TIMEFRAME_MS[input.timeframe];
  const closedCutoffMs = nowMs - config.closeGraceMs;
  const raw = input.candles as Candle[];
  if (raw.some(candle => !isFiniteNumber(candle.t))) {
    return invalidFrame(input, ['비정상 candle timestamp']);
  }
  if (raw.some(candle => candle.t > nowMs + 5_000)) {
    return invalidFrame(input, ['미래 시각 캔들']);
  }
  const closed = raw.filter(candle => candle.t + step <= closedCutoffMs);
  const excludedOpenCandles = raw.length - closed.length;

  if (closed.some(candle => candle.t % step !== 0)) {
    return { ...invalidFrame(input, ['timeframe timestamp 정렬 오류']), excludedOpenCandles };
  }
  const policy = config.frames[input.timeframe];
  const validation = validateCandleSeries(closed, input.timeframe as Timeframe, {
    nowMs,
    expectedCount: policy.expectedCount,
    minCount: policy.minCount,
  });
  if (!validation.ok || !validation.candles) {
    return { ...invalidFrame(input, validation.issues), excludedOpenCandles };
  }

  const latest = validation.candles[validation.candles.length - 1];
  const latestCloseTimeMs = latest.t + step;
  const dataAgeMs = nowMs - latestCloseTimeMs;
  if (dataAgeMs > step * policy.maxStaleIntervals + config.closeGraceMs) {
    return {
      ...invalidFrame(input, [`stale candle: age ${dataAgeMs}ms`]),
      excludedOpenCandles,
      latestCloseTimeMs,
      dataAgeMs,
    };
  }

  const volumeAvailable = validation.candles.every(candle => candle.v !== null);
  const quality: CandleFoundationQuality = volumeAvailable ? 'GOOD' : 'DEGRADED';
  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    source: input.source,
    fetchedAtMs: input.fetchedAtMs,
    candles: validation.candles,
    excludedOpenCandles,
    latestCloseTimeMs,
    dataAgeMs,
    volumeAvailable,
    quality,
    issues: volumeAvailable ? [] : ['거래량 unavailable — volume 필수 전략은 차단 필요'],
  };
}

export function buildMultiTimeframeCandleSet(
  symbol: string,
  inputs: Partial<Record<StrategyTimeframe, CandleFrameInput>>,
  nowMs: number,
  config: CandleFoundationConfig = DEFAULT_CANDLE_FOUNDATION_CONFIG,
): MultiTimeframeCandleSet {
  const frames: Partial<Record<StrategyTimeframe, ValidatedCandleFrame>> = {};
  const issues: string[] = [];

  const configIssues = validateCandleFoundationConfig(config);
  if (configIssues.length > 0) {
    return {
      symbol,
      configVersion: config.version || 'INVALID',
      calculatedAtMs: nowMs,
      quality: 'INVALID',
      tradeAllowed: false,
      frames,
      issues: configIssues,
    };
  }

  for (const timeframe of STRATEGY_TIMEFRAMES) {
    const input = inputs[timeframe];
    if (!input) {
      issues.push(`${timeframe} timeframe 누락`);
      continue;
    }
    if (input.symbol !== symbol) {
      issues.push(`${timeframe} symbol 불일치: ${input.symbol}`);
    }
    const frame = validateClosedCandleFrame(input, nowMs, config);
    frames[timeframe] = frame;
    issues.push(...frame.issues.map(issue => `${timeframe}: ${issue}`));
  }

  const complete = STRATEGY_TIMEFRAMES.every(timeframe => frames[timeframe] !== undefined);
  const invalid = !complete || STRATEGY_TIMEFRAMES.some(timeframe => frames[timeframe]?.quality === 'INVALID')
    || issues.some(issue => issue.includes('symbol 불일치'));
  if (invalid) {
    return {
      symbol,
      configVersion: config.version,
      calculatedAtMs: nowMs,
      quality: 'INVALID',
      tradeAllowed: false,
      frames,
      issues,
    };
  }

  const close15m = frames['15m']!.latestCloseTimeMs!;
  const close1h = frames['1h']!.latestCloseTimeMs!;
  const close4h = frames['4h']!.latestCloseTimeMs!;
  if (!(close15m >= close1h && close1h >= close4h)) {
    issues.push('타임프레임 간 마지막 완료 캔들 시각 불일치');
    return {
      symbol,
      configVersion: config.version,
      calculatedAtMs: nowMs,
      quality: 'INVALID',
      tradeAllowed: false,
      frames,
      issues,
    };
  }

  const degraded = STRATEGY_TIMEFRAMES.some(timeframe => frames[timeframe]!.quality === 'DEGRADED');
  return {
    symbol,
    configVersion: config.version,
    calculatedAtMs: nowMs,
    quality: degraded ? 'DEGRADED' : 'GOOD',
    tradeAllowed: true,
    frames,
    issues,
  };
}
