/** Regime-Aware Strategy Ensemble v2 Phase 1 — pure, read-only candle boundary tests. */
import { describe, expect, it } from 'vitest';
import {
  buildMultiTimeframeCandleSet,
  CandleFoundationConfig,
  CandleFrameInput,
  STRATEGY_TIMEFRAMES,
  StrategyTimeframe,
  validateCandleFoundationConfig,
  validateClosedCandleFrame,
} from '../intel/candleFoundationV2';
import { Candle, TIMEFRAME_MS } from '../intel/types';

const NOW = 1_800_000_000_000; // exact 4h boundary

const TEST_CONFIG: CandleFoundationConfig = {
  version: 'test/v1',
  closeGraceMs: 0,
  trustedSources: ['gmx-official-api'],
  frames: {
    '15m': { expectedCount: 4, minCount: 4, maxStaleIntervals: 2 },
    '1h': { expectedCount: 4, minCount: 4, maxStaleIntervals: 2 },
    '4h': { expectedCount: 4, minCount: 4, maxStaleIntervals: 2 },
  },
};

function candles(timeframe: StrategyTimeframe, count = 4, opts?: {
  latestCloseMs?: number;
  volume?: number | null;
}): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const latestCloseMs = opts?.latestCloseMs ?? NOW;
  const start = latestCloseMs - count * step;
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index;
    const close = open + 0.5;
    return {
      t: start + index * step,
      o: open,
      h: close + 0.25,
      l: open - 0.25,
      c: close,
      v: opts?.volume === undefined ? 1_000 : opts.volume,
    };
  });
}

function frame(timeframe: StrategyTimeframe, series = candles(timeframe)): CandleFrameInput {
  return {
    symbol: 'BTC',
    timeframe,
    source: 'gmx-official-api',
    fetchedAtMs: NOW,
    candles: series,
  };
}

function allFrames(): Record<StrategyTimeframe, CandleFrameInput> {
  return Object.fromEntries(
    STRATEGY_TIMEFRAMES.map(timeframe => [timeframe, frame(timeframe)]),
  ) as Record<StrategyTimeframe, CandleFrameInput>;
}

describe('Regime Strategy v2 Phase 1 candle foundation', () => {
  it('15m/1h/4h 완료 캔들만 결합하고 진행 중 캔들을 제외한다', () => {
    const inputs = allFrames();
    for (const timeframe of STRATEGY_TIMEFRAMES) {
      const step = TIMEFRAME_MS[timeframe];
      inputs[timeframe].candles!.push({ t: NOW, o: 105, h: 106, l: 104, c: 105.5, v: 1_000 });
      expect(inputs[timeframe].candles!.at(-1)!.t + step).toBeGreaterThan(NOW);
    }

    const result = buildMultiTimeframeCandleSet('BTC', inputs, NOW, TEST_CONFIG);
    expect(result.quality).toBe('GOOD');
    expect(result.tradeAllowed).toBe(true);
    for (const timeframe of STRATEGY_TIMEFRAMES) {
      expect(result.frames[timeframe]?.candles).toHaveLength(4);
      expect(result.frames[timeframe]?.excludedOpenCandles).toBe(1);
      expect(result.frames[timeframe]?.latestCloseTimeMs).toBe(NOW);
    }
  });

  it('거래량 누락을 0으로 합성하지 않고 DEGRADED로 명시한다', () => {
    const inputs = allFrames();
    inputs['15m'] = frame('15m', candles('15m', 4, { volume: null }));
    const result = buildMultiTimeframeCandleSet('BTC', inputs, NOW, TEST_CONFIG);
    expect(result.quality).toBe('DEGRADED');
    expect(result.tradeAllowed).toBe(true);
    expect(result.frames['15m']?.volumeAvailable).toBe(false);
    expect(result.frames['15m']?.candles.every(candle => candle.v === null)).toBe(true);
    expect(result.issues.join(' ')).toContain('volume 필수 전략은 차단');
  });

  it('필수 timeframe 누락은 INVALID 및 fail-closed다', () => {
    const inputs = allFrames();
    delete (inputs as Partial<Record<StrategyTimeframe, CandleFrameInput>>)['1h'];
    const result = buildMultiTimeframeCandleSet('BTC', inputs, NOW, TEST_CONFIG);
    expect(result.quality).toBe('INVALID');
    expect(result.tradeAllowed).toBe(false);
    expect(result.issues).toContain('1h timeframe 누락');
  });

  it('stale 완료 캔들은 거래 입력을 차단한다', () => {
    const stale = candles('15m', 4, { latestCloseMs: NOW - 3 * TIMEFRAME_MS['15m'] });
    const result = validateClosedCandleFrame(frame('15m', stale), NOW, TEST_CONFIG);
    expect(result.quality).toBe('INVALID');
    expect(result.issues.join(' ')).toContain('stale candle');
  });

  it('중복·역순·잘못된 OHLC를 각각 거부한다', () => {
    const duplicate = candles('15m');
    duplicate[2] = { ...duplicate[1] };
    expect(validateClosedCandleFrame(frame('15m', duplicate), NOW, TEST_CONFIG).quality).toBe('INVALID');

    const reversed = candles('15m').reverse();
    expect(validateClosedCandleFrame(frame('15m', reversed), NOW, TEST_CONFIG).quality).toBe('INVALID');

    const badOhlc = candles('15m');
    badOhlc[2] = { ...badOhlc[2], h: badOhlc[2].l - 1 };
    expect(validateClosedCandleFrame(frame('15m', badOhlc), NOW, TEST_CONFIG).quality).toBe('INVALID');
  });

  it('timeframe 격자에 맞지 않는 timestamp를 거부한다', () => {
    const unaligned = candles('1h').map(candle => ({ ...candle, t: candle.t + 1 }));
    const result = validateClosedCandleFrame(frame('1h', unaligned), NOW, TEST_CONFIG);
    expect(result.quality).toBe('INVALID');
    expect(result.issues).toContain('timeframe timestamp 정렬 오류');
  });

  it('NaN 및 미래 timestamp가 미완료 캔들처럼 조용히 제거되지 않는다', () => {
    const nanTimestamp = candles('15m');
    nanTimestamp.push({ t: Number.NaN, o: 105, h: 106, l: 104, c: 105.5, v: 1_000 });
    expect(validateClosedCandleFrame(frame('15m', nanTimestamp), NOW, TEST_CONFIG).issues)
      .toContain('비정상 candle timestamp');

    const futureTimestamp = candles('15m');
    futureTimestamp.push({ t: NOW + 60_000, o: 105, h: 106, l: 104, c: 105.5, v: 1_000 });
    expect(validateClosedCandleFrame(frame('15m', futureTimestamp), NOW, TEST_CONFIG).issues)
      .toContain('미래 시각 캔들');
  });

  it('검증되지 않은 출처와 symbol 혼합을 거부한다', () => {
    const untrusted = { ...frame('15m'), source: 'unknown' };
    expect(validateClosedCandleFrame(untrusted, NOW, TEST_CONFIG).quality).toBe('INVALID');

    const inputs = allFrames();
    inputs['4h'] = { ...inputs['4h'], symbol: 'ETH' };
    const result = buildMultiTimeframeCandleSet('BTC', inputs, NOW, TEST_CONFIG);
    expect(result.quality).toBe('INVALID');
    expect(result.tradeAllowed).toBe(false);
    expect(result.issues.join(' ')).toContain('symbol 불일치');
  });

  it('위험한 설정값은 런타임 검증에서 거부한다', () => {
    const invalid: CandleFoundationConfig = {
      ...TEST_CONFIG,
      trustedSources: [],
      frames: {
        ...TEST_CONFIG.frames,
        '15m': { expectedCount: 3, minCount: 4, maxStaleIntervals: 0 },
      },
    };
    const issues = validateCandleFoundationConfig(invalid);
    expect(issues.join(' ')).toContain('trustedSources');
    expect(issues.join(' ')).toContain('minCount가 expectedCount 초과');
    expect(issues.join(' ')).toContain('maxStaleIntervals 오류');
  });
});
