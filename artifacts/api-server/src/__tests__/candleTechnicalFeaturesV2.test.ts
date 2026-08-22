import { describe, expect, it } from 'vitest';
import {
  CANDLE_TECHNICAL_CONFIG_VERSION,
  DEFAULT_CANDLE_TECHNICAL_CONFIG,
  computeCandleTechnicalSnapshot,
  computeDirectionalIndex,
  validateCandleTechnicalConfig,
} from '../intel/candleTechnicalFeaturesV2';
import type { CandleTechnicalConfig } from '../intel/candleTechnicalFeaturesV2';
import type { Candle } from '../intel/types';

const bar = (t: number, o: number, h: number, l: number, c: number): Candle =>
  ({ t, o, h, l, c, v: null });

function trend(count = 260, direction: 1 | -1 = 1, scale = 1): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const center = (100 + direction * index * 0.2 + Math.sin(index * 0.4) * 0.25) * scale;
    const open = center - direction * 0.08 * scale;
    const close = center + direction * 0.08 * scale;
    return bar(index * 900_000, open, Math.max(open, close) + 0.2 * scale,
      Math.min(open, close) - 0.2 * scale, close);
  });
}

const config = (overrides: Partial<CandleTechnicalConfig> = {}): CandleTechnicalConfig => ({
  ...DEFAULT_CANDLE_TECHNICAL_CONFIG,
  ...overrides,
});

describe('Regime Strategy v2 advanced candle technical features', () => {
  it('상승 완료봉에서 EMA 정렬·양의 기울기·+DI 우위를 계산한다', () => {
    const result = computeCandleTechnicalSnapshot(trend());
    expect(result.quality).toBe('GOOD');
    expect(result.ema.fast).toBeGreaterThan(result.ema.medium!);
    expect(result.ema.medium).toBeGreaterThan(result.ema.long!);
    expect(result.ema.long).toBeGreaterThan(result.ema.macro!);
    expect(result.emaSlopePctPerBar.fast).toBeGreaterThan(0);
    expect(result.directionalIndex?.adx).toBeGreaterThan(0);
    expect(result.directionalIndex?.plusDi).toBeGreaterThan(result.directionalIndex!.minusDi);
  });

  it('하락 완료봉에서 EMA 하락 정렬과 -DI 우위를 계산한다', () => {
    const result = computeCandleTechnicalSnapshot(trend(260, -1));
    expect(result.ema.fast).toBeLessThan(result.ema.medium!);
    expect(result.emaSlopePctPerBar.medium).toBeLessThan(0);
    expect(result.directionalIndex?.minusDi).toBeGreaterThan(result.directionalIndex!.plusDi);
  });

  it('Bollinger·Keltner·Donchian과 Z-score를 유한값으로 제공한다', () => {
    const result = computeCandleTechnicalSnapshot(trend());
    expect(result.bollinger!.upper).toBeGreaterThan(result.bollinger!.middle);
    expect(result.bollinger!.middle).toBeGreaterThan(result.bollinger!.lower);
    expect(result.keltner!.upper).toBeGreaterThan(result.keltner!.lower);
    expect(result.donchian?.excludesLatestCandle).toBe(true);
    expect(result.donchian!.upper).toBeGreaterThan(result.donchian!.lower);
    expect(Number.isFinite(result.zScore)).toBe(true);
  });

  it('Donchian은 최신 돌파봉을 제외해 wick 터치와 종가 돌파 판정에 재사용 가능하다', () => {
    const candles = trend();
    const priorHigh = Math.max(...candles.slice(-20).map(candle => candle.h));
    const previous = candles.at(-1)!;
    candles.push(bar(previous.t + 900_000, priorHigh, priorHigh + 2, priorHigh - 0.1, priorHigh + 1));
    const result = computeCandleTechnicalSnapshot(candles);
    expect(result.donchian!.upper).toBeCloseTo(priorHigh);
    expect(candles.at(-1)!.c).toBeGreaterThan(result.donchian!.upper);
  });

  it('변동성 급등은 최근 ATR percent 분포의 높은 percentile로 나타난다', () => {
    const candles = trend();
    const last = candles.at(-1)!;
    candles.push(bar(last.t + 900_000, last.c, last.c * 1.08, last.c * 0.92, last.c * 1.02));
    const result = computeCandleTechnicalSnapshot(candles);
    expect(result.volatilityPercentile).toBeGreaterThanOrEqual(90);
    expect(result.atr.percent).toBeGreaterThan(0);
  });

  it('평평한 가격은 NaN 없이 Z-score와 ADX를 0으로 유지한다', () => {
    const candles = Array.from({ length: 260 }, (_, index) => bar(index * 900_000, 100, 100, 100, 100));
    const result = computeCandleTechnicalSnapshot(candles);
    expect(result.zScore).toBe(0);
    expect(result.directionalIndex).toEqual({ adx: 0, plusDi: 0, minusDi: 0 });
  });

  it('표본 부족은 값을 합성하지 않고 DEGRADED/null로 표시한다', () => {
    const result = computeCandleTechnicalSnapshot(trend(30));
    expect(result.quality).toBe('DEGRADED');
    expect(result.ema.macro).toBeNull();
    expect(result.directionalIndex).toBeNull();
    expect(result.volatilityPercentile).toBeNull();
    expect(result.issues).toContain('EMA macro unavailable');
  });

  it('잘못된 OHLC와 역순 timestamp를 INVALID로 거부한다', () => {
    const badOhlc = [bar(1, 100, 99, 101, 100)];
    expect(computeCandleTechnicalSnapshot(badOhlc).quality).toBe('INVALID');
    const reversed = [bar(2, 100, 101, 99, 100), bar(1, 100, 101, 99, 100)];
    expect(computeCandleTechnicalSnapshot(reversed).issues.join(' ')).toContain('timestamp 비증가');
  });

  it('strict config가 version·unknown field·EMA 순서 오류를 거부한다', () => {
    const wrong = { ...config(), version: 'future/v2' } as unknown as CandleTechnicalConfig;
    expect(validateCandleTechnicalConfig(wrong).join(' ')).toContain('지원하지 않는 config version');
    const unknown = { ...config(), synthesizeCandles: true } as CandleTechnicalConfig;
    expect(validateCandleTechnicalConfig(unknown).join(' ')).toContain('알 수 없는 config 필드');
    const order = config({ emaFast: 30, emaMedium: 20 });
    expect(validateCandleTechnicalConfig(order).join(' ')).toContain('EMA 기간');
  });

  it('sub-micro 자산에서도 indicator geometry를 0으로 반올림하지 않는다', () => {
    const result = computeCandleTechnicalSnapshot(trend(260, 1, 1e-10));
    expect(result.configVersion).toBe(CANDLE_TECHNICAL_CONFIG_VERSION);
    expect(result.ema.fast).toBeGreaterThan(0);
    expect(result.atr.absolute).toBeGreaterThan(0);
    expect(Number.isFinite(result.bollinger?.widthPct)).toBe(true);
  });

  it('Directional Index는 최소 표본 전까지 null이다', () => {
    expect(computeDirectionalIndex(trend(28), 14)).toBeNull();
    expect(computeDirectionalIndex(trend(29), 14)).not.toBeNull();
  });
});
