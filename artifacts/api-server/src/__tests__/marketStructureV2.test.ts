import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKET_STRUCTURE_CONFIG,
  MARKET_STRUCTURE_CONFIG_VERSION,
  computeMarketStructure,
  findConfirmedSwingPoints,
  validateMarketStructureConfig,
} from '../intel/marketStructureV2';
import type { MarketStructureConfig } from '../intel/marketStructureV2';
import type { Candle } from '../intel/types';

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: null });
const wave = (count = 80, drift = 0.08): Candle[] => Array.from({ length: count }, (_, index) => {
  const center = 100 + index * drift + Math.sin(index * Math.PI / 3) * 2;
  return bar(index * 900_000, center - 0.2, center + 0.6, center - 0.6, center + 0.2);
});
const config = (overrides: Partial<MarketStructureConfig> = {}): MarketStructureConfig => ({
  ...DEFAULT_MARKET_STRUCTURE_CONFIG, ...overrides,
});

describe('Regime Strategy v2 confirmed market structure', () => {
  it('right-side 완료봉이 생긴 뒤에만 swing을 확정한다', () => {
    const candles = [
      bar(0, 9, 10, 8, 9), bar(1, 10, 12, 9, 11), bar(2, 9, 10, 7, 8),
      bar(3, 8, 9, 6, 7), bar(4, 9, 11, 8, 10),
    ];
    const before = findConfirmedSwingPoints(candles.slice(0, 3), 1, 2);
    const after = findConfirmedSwingPoints(candles, 1, 2);
    expect(before.highs).toHaveLength(0);
    expect(after.highs[0]).toMatchObject({ price: 12, candleOpenTime: 1, confirmedAtOpenTime: 3 });
  });

  it('상승 파동을 HH/HL과 BULLISH로 분류한다', () => {
    const result = computeMarketStructure(wave());
    expect(result.quality).toBe('GOOD');
    expect(result.highPattern).toBe('HH');
    expect(result.lowPattern).toBe('HL');
    expect(result.trend).toBe('BULLISH');
  });

  it('하락 파동을 LH/LL과 BEARISH로 분류한다', () => {
    const result = computeMarketStructure(wave(80, -0.08));
    expect(result.highPattern).toBe('LH');
    expect(result.lowPattern).toBe('LL');
    expect(result.trend).toBe('BEARISH');
  });

  it('종가가 prior range를 강한 몸통으로 넘으면 breakout을 확정한다', () => {
    const candles = wave();
    const priorHigh = Math.max(...candles.slice(-20).map(item => item.h));
    candles.push(bar(candles.at(-1)!.t + 900_000, priorHigh - 0.2, priorHigh + 2, priorHigh - 0.4, priorHigh + 1.7));
    const result = computeMarketStructure(candles);
    expect(result.breakout.state).toBe('BREAKOUT_UP');
    expect(result.breakout.level).toBeCloseTo(priorHigh);
  });

  it('wick만 range를 넘고 종가 복귀하면 failed breakout이다', () => {
    const candles = wave();
    const priorHigh = Math.max(...candles.slice(-20).map(item => item.h));
    candles.push(bar(candles.at(-1)!.t + 900_000, priorHigh - 0.4, priorHigh + 1, priorHigh - 0.8, priorHigh - 0.1));
    expect(computeMarketStructure(candles).breakout.state).toBe('FAILED_UP');
  });

  it('돌파 다음 완료봉의 level 방어를 retest로 분류한다', () => {
    const candles = wave();
    const baseHigh = Math.max(...candles.slice(-20).map(item => item.h));
    candles.push(bar(candles.at(-1)!.t + 900_000, baseHigh - 0.1, baseHigh + 2, baseHigh - 0.2, baseHigh + 1.5));
    candles.push(bar(candles.at(-1)!.t + 900_000, baseHigh + 1.2, baseHigh + 1.6, baseHigh + 0.05, baseHigh + 0.8));
    expect(computeMarketStructure(candles).breakout.state).toBe('RETEST_UP');
  });

  it('swing 가격을 조절 가능한 zone으로 군집화한다', () => {
    const result = computeMarketStructure(wave(), config({ zoneTolerancePct: 1 }));
    expect(result.supportZones.length).toBeGreaterThan(0);
    expect(result.resistanceZones.length).toBeGreaterThan(0);
    expect(result.supportZones.some(zone => zone.touches > 1)).toBe(true);
  });

  it('표본 부족은 구조를 합성하지 않고 DEGRADED로 남긴다', () => {
    const result = computeMarketStructure(wave(10));
    expect(result.quality).toBe('DEGRADED');
    expect(result.highPattern).toBe('UNAVAILABLE');
    expect(result.range.high).toBeNull();
  });

  it('잘못된 OHLC·역순 timestamp는 INVALID로 거부한다', () => {
    expect(computeMarketStructure([bar(0, 10, 9, 11, 10)]).quality).toBe('INVALID');
    const reversed = [bar(2, 10, 11, 9, 10), bar(1, 10, 11, 9, 10)];
    expect(computeMarketStructure(reversed).issues.join(' ')).toContain('timestamp 비증가');
  });

  it('strict versioned config가 unknown field와 unsafe threshold를 거부한다', () => {
    expect(validateMarketStructureConfig({ ...config(), version: 'future/v2' }).join(' ')).toContain('지원하지 않는');
    expect(validateMarketStructureConfig({ ...config(), synthesize: true }).join(' ')).toContain('알 수 없는');
    expect(validateMarketStructureConfig(config({ breakoutBodyRatioMin: 2 })).join(' ')).toContain('breakoutBodyRatioMin');
    expect(computeMarketStructure(wave()).configVersion).toBe(MARKET_STRUCTURE_CONFIG_VERSION);
  });
});
