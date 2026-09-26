/** Pure deterministic Candle Signal → Risk contract tests. DB/RPC/runtime calls: zero. */
import { describe, expect, it } from 'vitest';
import {
  CandleSignalConfig,
  CANDLE_SIGNAL_SCHEMA_VERSION,
  DEFAULT_CANDLE_SIGNAL_CONFIG,
  parseCandleSignalConfig,
} from '../intel/candleSignalContract';
import { CandleSignalInput, evaluateCandleSignal } from '../intel/candleSignalCore';
import {
  CandleFrameInput,
  DEFAULT_CANDLE_FOUNDATION_CONFIG,
  StrategyTimeframe,
  STRATEGY_TIMEFRAMES,
} from '../intel/candleFoundationV2';
import { Candle, TIMEFRAME_MS } from '../intel/types';

const LATEST_CLOSE = 1_800_000_000_000; // exact 4H boundary
const NOW = LATEST_CLOSE + DEFAULT_CANDLE_FOUNDATION_CONFIG.closeGraceMs;
const COUNT = 80;

function trendCandles(
  timeframe: StrategyTimeframe,
  direction: 'LONG' | 'SHORT',
  volume: 'AVAILABLE' | 'MISSING' = 'AVAILABLE',
  latestCloseMs = LATEST_CLOSE,
): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const sign = direction === 'LONG' ? 1 : -1;
  const start = latestCloseMs - COUNT * step;
  const result: Candle[] = [];
  for (let index = 0; index < COUNT; index += 1) {
    const center = 100 + sign * index * 0.18 + Math.sin(index * 0.72) * 0.9;
    const open = center - sign * 0.12;
    const close = center + sign * 0.12;
    result.push({
      t: start + index * step,
      o: open,
      h: Math.max(open, close) + 0.24,
      l: Math.min(open, close) - 0.24,
      c: close,
      v: volume === 'MISSING' ? null : 1_000,
    });
  }
  const last = result.at(-1)!;
  if (direction === 'LONG') {
    last.o = last.c - 0.2;
    last.h = last.c + 0.1;
    last.l = last.o - 0.5;
  } else {
    last.o = last.c + 0.2;
    last.h = last.o + 0.5;
    last.l = last.c - 0.1;
  }
  last.v = volume === 'MISSING' ? null : 1_500;
  return result;
}

function flatCandles(timeframe: StrategyTimeframe): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  return Array.from({ length: COUNT }, (_, index) => ({
    t: LATEST_CLOSE - (COUNT - index) * step,
    o: 100,
    h: 100.2,
    l: 99.8,
    c: 100,
    v: 1_000,
  }));
}

function input(
  direction: 'LONG' | 'SHORT',
  options?: { volume?: 'AVAILABLE' | 'MISSING'; symbol?: string; latestCloseMs?: number },
): CandleSignalInput {
  const symbol = options?.symbol ?? 'BTC';
  const frames = Object.fromEntries(STRATEGY_TIMEFRAMES.map(timeframe => [
    timeframe,
    {
      symbol,
      timeframe,
      source: 'gmx-official-api',
      fetchedAtMs: NOW,
      candles: trendCandles(
        timeframe,
        direction,
        options?.volume,
        options?.latestCloseMs,
      ),
    } satisfies CandleFrameInput,
  ])) as Record<StrategyTimeframe, CandleFrameInput>;
  return { symbol, evaluatedAtMs: NOW, frames };
}

function withThresholds(overrides: Partial<CandleSignalConfig['thresholds']>): CandleSignalConfig {
  return {
    ...DEFAULT_CANDLE_SIGNAL_CONFIG,
    periods: { ...DEFAULT_CANDLE_SIGNAL_CONFIG.periods },
    thresholds: { ...DEFAULT_CANDLE_SIGNAL_CONFIG.thresholds, ...overrides },
    weights: { ...DEFAULT_CANDLE_SIGNAL_CONFIG.weights },
  };
}

describe('Pure Candle Signal Core', () => {
  it('BTC 4H/1H/15m 상승 fixture를 LONG Signal→Risk evidence로 만든다', () => {
    const result = evaluateCandleSignal(input('LONG'));
    expect(result.schemaVersion).toBe(CANDLE_SIGNAL_SCHEMA_VERSION);
    expect(result.symbol).toBe('BTC');
    expect(result.direction).toBe('LONG');
    expect(result.confidence).toBeGreaterThanOrEqual(DEFAULT_CANDLE_SIGNAL_CONFIG.thresholds.minConfidence);
    expect(result.longConfidence).toBeGreaterThan(result.shortConfidence);
    expect(result.entryCandidate).toBe(result.frameFeatures?.['15m'].close);
    expect(result.higherTimeframeTrend).toBe('BULLISH');
    expect(result.dataQuality.status).toBe('GOOD');
    expect(result.dataQuality.scoreCoveragePct).toBe(100);
    expect(result.scoreComponents).toHaveLength(10);
    expect(result.reasonCodes).toContain('LONG_SIGNAL');
    expect(result.reasons.some(reason => reason.includes('4H'))).toBe(true);
  });

  it('하락 fixture는 LONG과 대칭인 SHORT evidence를 만든다', () => {
    const result = evaluateCandleSignal(input('SHORT', { symbol: 'ASSET-X' }));
    expect(result.symbol).toBe('ASSET-X');
    expect(result.direction).toBe('SHORT');
    expect(result.reasonCodes).toContain('SHORT_SIGNAL');
    expect(result.shortConfidence).toBeGreaterThan(result.longConfidence);
    expect(result.higherTimeframeTrend).toBe('BEARISH');
    expect(result.structuralStopCandidate?.direction).toBe('SHORT');
    expect(result.structuralStopCandidate!.stopPrice).toBeGreaterThan(result.entryCandidate!);
  });

  it('body/wick, MA, RSI, swing, S/R, volatility, volume feature를 모두 노출한다', () => {
    const result = evaluateCandleSignal(input('LONG'));
    const feature = result.frameFeatures?.['15m'];
    expect(feature).not.toBeNull();
    expect(feature?.anatomy.bodyAbs).toBeGreaterThan(0);
    expect(feature?.anatomy.lowerWickAbs).toBeGreaterThan(0);
    expect(feature?.anatomy.lowerWickToBodyRatio).toBeGreaterThan(1);
    expect(feature?.anatomy.bullish).toBe(true);
    expect(feature?.maFast).not.toBeNull();
    expect(feature?.maMedium).not.toBeNull();
    expect(feature?.maLong).not.toBeNull();
    expect(feature?.rsi).not.toBeNull();
    expect(feature?.swings.recentSwingHigh).not.toBeNull();
    expect(feature?.swings.recentSwingLow).not.toBeNull();
    expect(result.supportResistance?.support).not.toBeNull();
    expect(result.supportResistance?.resistance).not.toBeNull();
    expect(result.volatility.atrPct).toBeGreaterThan(0);
    expect(result.volumeConfirmation.ratio).toBeCloseTo(1.5);
  });

  it('거래량 누락은 null/unavailable로 유지하고 score component를 0으로 합성하지 않는다', () => {
    const result = evaluateCandleSignal(input('LONG', { volume: 'MISSING' }));
    expect(result.dataQuality.status).toBe('DEGRADED');
    expect(result.volumeConfirmation).toMatchObject({
      quality: 'UNAVAILABLE',
      recentAverage: null,
      ratio: null,
      confirmed: null,
    });
    const volume = result.scoreComponents.find(component => component.id === 'confirmation15mVolume');
    expect(volume).toMatchObject({
      available: false,
      rawValue: null,
      longMatch: null,
      shortMatch: null,
      longContribution: null,
      shortContribution: null,
    });
    expect(result.dataQuality.scoreCoveragePct).toBe(95);
    expect(result.reasonCodes).toContain('VOLUME_UNAVAILABLE');
  });

  it('동일 input/config는 byte-equivalent 결정 결과를 만든다', () => {
    const fixture = input('LONG');
    expect(evaluateCandleSignal(fixture)).toEqual(evaluateCandleSignal(fixture));
  });

  it('동률·낮은 score는 NO_TRADE로 fail-closed 처리한다', () => {
    const frames = Object.fromEntries(STRATEGY_TIMEFRAMES.map(timeframe => [
      timeframe,
      {
        symbol: 'FLAT',
        timeframe,
        source: 'gmx-official-api',
        fetchedAtMs: NOW,
        candles: flatCandles(timeframe),
      } satisfies CandleFrameInput,
    ])) as Record<StrategyTimeframe, CandleFrameInput>;
    const result = evaluateCandleSignal({ symbol: 'FLAT', frames, evaluatedAtMs: NOW });
    expect(result.direction).toBe('NO_TRADE');
    expect(result.entryCandidate).toBeNull();
    expect(result.structuralStopCandidate).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/동률|최고 confidence|추세|score coverage/);
    expect(result.reasonCodes.some(code => [
      'SCORE_COVERAGE_LOW',
      'SCORE_TIE',
      'CONFIDENCE_BELOW_MIN',
      'HTF_TREND_MISMATCH',
    ].includes(code))).toBe(true);
  });

  it('open candle은 명시적으로 제외하고 완전히 닫힌 candle만 feature에 사용한다', () => {
    const fixture = input('LONG');
    for (const timeframe of STRATEGY_TIMEFRAMES) {
      const step = TIMEFRAME_MS[timeframe];
      fixture.frames[timeframe]!.candles!.push({
        t: LATEST_CLOSE,
        o: 1,
        h: 1.1,
        l: 0.9,
        c: 1,
        v: null,
      });
      expect(fixture.frames[timeframe]!.candles!.at(-1)!.t + step).toBeGreaterThan(NOW);
    }
    const result = evaluateCandleSignal(fixture);
    expect(result.direction).toBe('LONG');
    expect(result.dataQuality.excludedOpenCandles).toEqual({ '15m': 1, '1h': 1, '4h': 1 });
    expect(result.reasonCodes).toContain('OPEN_CANDLE_EXCLUDED');
    expect(result.volumeConfirmation.quality).toBe('AVAILABLE');
  });

  it.each([
    ['gap', (series: Candle[]) => series.splice(10, 1)],
    ['duplicate', (series: Candle[]) => { series[10] = { ...series[9] }; }],
    ['reverse', (series: Candle[]) => series.reverse()],
    ['bad OHLC', (series: Candle[]) => { series[10] = { ...series[10], h: series[10].l - 1 }; }],
    ['NaN', (series: Candle[]) => { series[10] = { ...series[10], c: Number.NaN }; }],
    ['non-positive', (series: Candle[]) => { series[10] = { ...series[10], l: 0 }; }],
  ])('%s candle series를 INVALID/NO_TRADE로 거부한다', (_name, mutate) => {
    const fixture = input('LONG');
    mutate(fixture.frames['15m']!.candles!);
    const result = evaluateCandleSignal(fixture);
    expect(result.direction).toBe('NO_TRADE');
    expect(result.dataQuality.status).toBe('INVALID');
  });

  it('최신 봉 누락/stale 및 timeframe 누락을 fail-closed 처리한다', () => {
    const stale = input('LONG');
    stale.frames['15m'] = {
      ...stale.frames['15m']!,
      candles: trendCandles('15m', 'LONG', 'AVAILABLE', LATEST_CLOSE - TIMEFRAME_MS['15m']),
    };
    const staleResult = evaluateCandleSignal(stale);
    expect(staleResult.direction).toBe('NO_TRADE');
    expect(staleResult.dataQuality.flags.join(' ')).toContain('최신 완료봉 누락/stale');
    expect(staleResult.reasonCodes).toContain('LATEST_CANDLE_MISSING_OR_STALE');

    const missing = input('LONG');
    delete missing.frames['1h'];
    expect(evaluateCandleSignal(missing).dataQuality.status).toBe('INVALID');
  });

  it('검증되지 않은 source와 mixed symbol을 거부한다', () => {
    const untrusted = input('LONG');
    untrusted.frames['4h'] = { ...untrusted.frames['4h']!, source: 'unknown' };
    expect(evaluateCandleSignal(untrusted).direction).toBe('NO_TRADE');

    const mixed = input('LONG');
    mixed.frames['1h'] = { ...mixed.frames['1h']!, symbol: 'ETH' };
    expect(evaluateCandleSignal(mixed).direction).toBe('NO_TRADE');
  });

  it('LONG stop은 signal/structure low 아래, SHORT stop은 high 위에만 제안한다', () => {
    const long = evaluateCandleSignal(input('LONG'));
    const longStop = long.structuralStopCandidate!;
    expect(longStop.stopPrice).toBeLessThan(long.frameFeatures!['15m'].low);
    expect(longStop.stopPrice).toBeLessThan(long.entryCandidate!);
    expect(longStop.buffer).toBeGreaterThan(0);
    expect(longStop.stopDistance).toBeGreaterThan(0);

    const short = evaluateCandleSignal(input('SHORT'));
    const shortStop = short.structuralStopCandidate!;
    expect(shortStop.stopPrice).toBeGreaterThan(short.frameFeatures!['15m'].high);
    expect(shortStop.stopPrice).toBeGreaterThan(short.entryCandidate!);
  });

  it('gross R/R은 양의 구조적 risk와 target 후보를 설명하되 주문을 결정하지 않는다', () => {
    const result = evaluateCandleSignal(input('LONG'));
    expect(result.grossExpectedRiskReward?.riskDistance).toBeGreaterThan(0);
    expect(result.grossExpectedRiskReward?.rewardDistance).toBeGreaterThan(0);
    expect(result.grossExpectedRiskReward?.ratio).toBeGreaterThanOrEqual(1);
    expect(result.grossExpectedRiskReward?.targetPriceCandidate).toBeGreaterThan(result.entryCandidate!);
    expect(result).not.toHaveProperty('allowed');
    expect(result).not.toHaveProperty('sizeUsd');
    expect(result).not.toHaveProperty('leverage');
    expect(result).not.toHaveProperty('order');
  });

  it('strict version parser는 안전한 default만 허용하고 unknown/version/period/weight 오류를 거부한다', () => {
    expect(parseCandleSignalConfig(DEFAULT_CANDLE_SIGNAL_CONFIG)).toEqual({
      ok: true,
      config: DEFAULT_CANDLE_SIGNAL_CONFIG,
      issues: [],
    });
    expect(Object.isFrozen(DEFAULT_CANDLE_SIGNAL_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CANDLE_SIGNAL_CONFIG.periods)).toBe(true);

    const unknown = { ...DEFAULT_CANDLE_SIGNAL_CONFIG, surprise: true };
    expect(parseCandleSignalConfig(unknown).issues.join(' ')).toContain('알 수 없는 필드');

    const version = { ...DEFAULT_CANDLE_SIGNAL_CONFIG, version: 'future/v2' };
    expect(parseCandleSignalConfig(version).issues.join(' ')).toContain('지원하지 않는 config version');

    const periods = {
      ...DEFAULT_CANDLE_SIGNAL_CONFIG,
      periods: { ...DEFAULT_CANDLE_SIGNAL_CONFIG.periods, maFast: 30, maMedium: 20 },
    };
    expect(parseCandleSignalConfig(periods).issues.join(' ')).toContain('MA 기간');

    const weights = {
      ...DEFAULT_CANDLE_SIGNAL_CONFIG,
      weights: { ...DEFAULT_CANDLE_SIGNAL_CONFIG.weights, trend4hMa: 1 },
    };
    expect(parseCandleSignalConfig(weights).issues.join(' ')).toContain('합계는 100');
  });

  it('strict foundation config version/unknown field 오류도 core 경계에서 fail-closed다', () => {
    const wrongVersion = {
      ...DEFAULT_CANDLE_FOUNDATION_CONFIG,
      version: 'regime-candle-foundation/v2',
    };
    const result = evaluateCandleSignal(
      input('LONG'),
      DEFAULT_CANDLE_SIGNAL_CONFIG,
      wrongVersion,
    );
    expect(result.direction).toBe('NO_TRADE');
    expect(result.reasonCodes).toEqual(['FOUNDATION_CONFIG_INVALID']);

    const unknown = { ...DEFAULT_CANDLE_FOUNDATION_CONFIG, allowLegacy: true };
    expect(evaluateCandleSignal(
      input('LONG'),
      DEFAULT_CANDLE_SIGNAL_CONFIG,
      unknown,
    ).reasonCodes).toEqual(['FOUNDATION_CONFIG_INVALID']);
  });

  it('sub-micro 가격 자산에서도 stop/R/R geometry를 0으로 반올림하지 않는다', () => {
    const tiny = input('LONG', { symbol: 'TINY' });
    for (const timeframe of STRATEGY_TIMEFRAMES) {
      tiny.frames[timeframe]!.candles = tiny.frames[timeframe]!.candles!.map(candle => ({
        ...candle,
        o: candle.o * 1e-10,
        h: candle.h * 1e-10,
        l: candle.l * 1e-10,
        c: candle.c * 1e-10,
      }));
    }
    const result = evaluateCandleSignal(tiny);
    expect(result.direction).toBe('LONG');
    expect(result.entryCandidate).toBeGreaterThan(0);
    expect(result.entryCandidate).toBeLessThan(0.000001);
    expect(result.structuralStopCandidate?.stopPrice).toBeGreaterThan(0);
    expect(result.structuralStopCandidate?.stopPrice).toBeLessThan(result.entryCandidate!);
    expect(result.structuralStopCandidate?.stopDistance).toBeGreaterThan(0);
    expect(result.grossExpectedRiskReward?.targetPriceCandidate).toBeGreaterThan(result.entryCandidate!);
    expect(result.grossExpectedRiskReward?.ratio).toBeGreaterThanOrEqual(1);
  });

  it('score coverage와 confidence threshold는 strict config에서 결정된다', () => {
    const missingVolume = input('LONG', { volume: 'MISSING' });
    const rejectCoverage = evaluateCandleSignal(
      missingVolume,
      withThresholds({ minScoreCoveragePct: 100 }),
    );
    expect(rejectCoverage.direction).toBe('NO_TRADE');
    expect(rejectCoverage.reasons.join(' ')).toContain('score coverage');

    const lowerConfidence = input('LONG');
    lowerConfidence.frames['15m']!.candles!.at(-1)!.v = 1_000;
    const rejectConfidence = evaluateCandleSignal(
      lowerConfidence,
      withThresholds({ minConfidence: 100 }),
    );
    expect(rejectConfidence.direction).toBe('NO_TRADE');
  });

  it('foundation 안전 설정과 공식 timeframe 목록을 그대로 재사용한다', () => {
    expect(DEFAULT_CANDLE_FOUNDATION_CONFIG.trustedSources).toContain('gmx-official-api');
    expect(STRATEGY_TIMEFRAMES).toEqual(['15m', '1h', '4h']);
  });
});