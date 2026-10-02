/** Regime Strategy v2 Phase 2B — pure candle geometry and pattern tests. */
import { describe, expect, it } from 'vitest';
import {
  CANDLE_PATTERN_CONFIG_VERSION,
  CandleFeatureConfig,
  DEFAULT_CANDLE_FEATURE_CONFIG,
  candleGeometry,
  extractLatestCandleFeatures,
  validateCandleFeatureConfig,
} from '../intel/candlePatternFeatures';
import { Candle } from '../intel/types';

const bar = (t: number, o: number, h: number, l: number, c: number, v: number | null = 100): Candle =>
  ({ t, o, h, l, c, v });

const config = (overrides: Partial<CandleFeatureConfig> = {}): CandleFeatureConfig => ({
  ...DEFAULT_CANDLE_FEATURE_CONFIG,
  breakoutLookback: 3,
  volumeLookback: 3,
  ...overrides,
});

describe('Regime Strategy v2 Phase 2B candle pattern features', () => {
  it('몸통·전체 범위·윗꼬리·아래꼬리와 비율을 정확히 계산한다', () => {
    const g = candleGeometry(bar(1, 100, 112, 95, 110));
    expect(g).not.toBeNull();
    expect(g?.bodySize).toBe(10);
    expect(g?.fullRange).toBe(17);
    expect(g?.upperWick).toBe(2);
    expect(g?.lowerWick).toBe(5);
    expect(g?.bodyRatio).toBeCloseTo(10 / 17);
    expect(g?.upperWickToBody).toBeCloseTo(0.2);
    expect(g?.lowerWickToBody).toBeCloseTo(0.5);
  });

  it('0 range와 0 body에서도 NaN/Infinity 없이 Doji를 판정한다', () => {
    const result = extractLatestCandleFeatures([bar(1, 100, 100, 100, 100)], config());
    expect(result.quality).toBe('DEGRADED');
    expect(result.geometry?.bodyRatio).toBe(0);
    expect(result.geometry?.upperWickToBody).toBe(0);
    expect(result.patterns?.doji).toBe(100);
  });

  it('긴 아래꼬리와 종가 위치를 결합해 bullish rejection 강도를 만든다', () => {
    const history = [
      bar(1, 100, 102, 99, 101), bar(2, 101, 103, 100, 102), bar(3, 102, 104, 101, 103),
      bar(4, 101, 104, 90, 103),
    ];
    const result = extractLatestCandleFeatures(history, config());
    expect(result.patterns?.longLowerWick).toBeGreaterThanOrEqual(50);
    expect(result.patterns?.bullishRejection).toBeGreaterThan(0);
    expect(result.patterns?.bearishRejection).toBe(0);
  });

  it('Bullish/Bearish Engulfing을 방향별로 분리한다', () => {
    const bull = extractLatestCandleFeatures([
      bar(1, 100, 101, 97, 98),
      bar(2, 97, 102, 96, 101),
    ], config({ breakoutLookback: 5, volumeLookback: 5 }));
    expect(bull.patterns?.bullishEngulfing).toBeGreaterThanOrEqual(50);
    expect(bull.patterns?.bearishEngulfing).toBe(0);

    const bear = extractLatestCandleFeatures([
      bar(1, 98, 101, 97, 100),
      bar(2, 101, 102, 96, 97),
    ], config({ breakoutLookback: 5, volumeLookback: 5 }));
    expect(bear.patterns?.bearishEngulfing).toBeGreaterThanOrEqual(50);
    expect(bear.patterns?.bullishEngulfing).toBe(0);
  });

  it('Inside Bar와 Outside Bar를 독립적으로 판정한다', () => {
    const inside = extractLatestCandleFeatures([
      bar(1, 100, 110, 90, 105), bar(2, 102, 108, 95, 106),
    ], config({ breakoutLookback: 5, volumeLookback: 5 }));
    expect(inside.patterns?.insideBar).toBe(100);
    expect(inside.patterns?.outsideBar).toBe(0);

    const outside = extractLatestCandleFeatures([
      bar(1, 100, 108, 95, 102), bar(2, 101, 110, 93, 105),
    ], config({ breakoutLookback: 5, volumeLookback: 5 }));
    expect(outside.patterns?.outsideBar).toBe(100);
    expect(outside.patterns?.insideBar).toBe(0);
  });

  it('몸통 종가 돌파와 wick-only 실패 돌파를 구분한다', () => {
    const base = [
      bar(1, 100, 102, 98, 101),
      bar(2, 101, 103, 99, 102),
      bar(3, 102, 104, 100, 103),
    ];
    const breakout = extractLatestCandleFeatures(
      [...base, bar(4, 103, 108, 102.5, 107)], config(),
    );
    expect(breakout.patterns?.bullishBreakout).toBeGreaterThanOrEqual(50);
    expect(breakout.patterns?.bullishFailedBreakout).toBe(0);

    const failed = extractLatestCandleFeatures(
      [...base, bar(4, 103, 108, 101, 103.5)], config(),
    );
    expect(failed.patterns?.bullishBreakout).toBe(0);
    expect(failed.patterns?.bullishFailedBreakout).toBeGreaterThan(0);
  });

  it('실측 volume 평균·비율을 계산하고 누락 시 null을 유지한다', () => {
    const measured = extractLatestCandleFeatures([
      bar(1, 100, 102, 99, 101, 100),
      bar(2, 101, 103, 100, 102, 100),
      bar(3, 102, 104, 101, 103, 100),
      bar(4, 103, 105, 102, 104, 150),
    ], config());
    expect(measured.averageVolume).toBe(100);
    expect(measured.volumeRatio).toBe(1.5);
    expect(measured.volumeSpike).toBe(true);

    const missing = extractLatestCandleFeatures([
      bar(1, 100, 102, 99, 101, null),
      bar(2, 101, 103, 100, 102, null),
      bar(3, 102, 104, 101, 103, null),
      bar(4, 103, 105, 102, 104, null),
    ], config());
    expect(missing.quality).toBe('DEGRADED');
    expect(missing.volume).toBeNull();
    expect(missing.averageVolume).toBeNull();
    expect(missing.volumeRatio).toBeNull();
    expect(missing.volumeSpike).toBeNull();
  });

  it('잘못된 OHLC는 INVALID이고 패턴을 생성하지 않는다', () => {
    const result = extractLatestCandleFeatures([bar(1, 100, 99, 101, 100)], config());
    expect(result.quality).toBe('INVALID');
    expect(result.geometry).toBeNull();
    expect(result.patterns).toBeNull();
  });

  it('조정 가능한 config의 위험값을 런타임에서 거부한다', () => {
    const invalid = config({ epsilon: 0, breakoutLookback: 0, strengthSaturationMultiplier: 0.5 });
    const issues = validateCandleFeatureConfig(invalid).join(' ');
    expect(issues).toContain('epsilon 범위 오류');
    expect(issues).toContain('breakoutLookback 오류');
    expect(issues).toContain('strengthSaturationMultiplier는 1 이상');
  });

  it('지원하지 않는 version과 알 수 없는 config 필드를 fail-closed로 거부한다', () => {
    const wrongVersion = {
      ...config(),
      version: 'regime-candle-patterns/v2',
    } as unknown as CandleFeatureConfig;
    expect(validateCandleFeatureConfig(wrongVersion).join(' ')).toContain('지원하지 않는 config version');

    const unknown = {
      ...config(),
      version: CANDLE_PATTERN_CONFIG_VERSION,
      synthesizeVolume: true,
    } as CandleFeatureConfig;
    expect(validateCandleFeatureConfig(unknown).join(' ')).toContain('알 수 없는 config 필드');
  });
});
