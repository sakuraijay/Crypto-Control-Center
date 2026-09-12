import { describe, expect, it } from 'vitest';
import { evaluateRegime, DEFAULT_REGIME_ENGINE_CONFIG, validateRegimeEngineConfig } from '../intel/regimeEngineV2';
import type { RegimeEngineInput, RegimeState } from '../intel/regimeEngineV2';
import type { CandleTechnicalSnapshot } from '../intel/candleTechnicalFeaturesV2';
import type { MarketStructureEvidence } from '../intel/marketStructureV2';

const technical = (kind: 'UP' | 'DOWN' | 'RANGE' | 'COMPRESSED' | 'HIGH_VOL'): CandleTechnicalSnapshot => {
  const up = kind === 'UP'; const down = kind === 'DOWN';
  return {
    configVersion: 'regime-candle-technicals/v1', quality: 'GOOD', sourceCandleOpenTime: 1, issues: [],
    ema: up ? { fast: 110, medium: 108, long: 105, macro: 100 }
      : down ? { fast: 90, medium: 92, long: 95, macro: 100 }
        : { fast: 100, medium: 100, long: 100, macro: 100 },
    emaSlopePctPerBar: up ? { fast: .1, medium: .08, long: .05 }
      : down ? { fast: -.1, medium: -.08, long: -.05 } : { fast: 0, medium: 0, long: 0 },
    atr: { absolute: kind === 'HIGH_VOL' ? 4 : 1, percent: kind === 'HIGH_VOL' ? 4 : 1 },
    directionalIndex: up ? { adx: 30, plusDi: 35, minusDi: 10 }
      : down ? { adx: 30, plusDi: 10, minusDi: 35 } : { adx: 10, plusDi: 15, minusDi: 15 },
    bollinger: { upper: 104, middle: 100, lower: 96,
      widthPct: kind === 'COMPRESSED' ? 1 : kind === 'HIGH_VOL' ? 10 : 4 },
    keltner: { upper: 103, middle: 100, lower: 97, widthPct: 6 },
    donchian: { upper: 102, middle: 100, lower: 98,
      widthPct: kind === 'COMPRESSED' ? 2 : 4, excludesLatestCandle: true },
    volatilityPercentile: kind === 'HIGH_VOL' ? 95 : kind === 'COMPRESSED' ? 20 : 50,
    zScore: kind === 'RANGE' || kind === 'COMPRESSED' ? 0.2 : up ? 1.5 : -1.5,
  };
};
const structure = (trend: 'BULLISH' | 'BEARISH' | 'MIXED', event: MarketStructureEvidence['event'] = 'NONE'): MarketStructureEvidence => ({
  configVersion: 'regime-market-structure/v1', quality: 'GOOD', sourceCandleOpenTime: 1, issues: [],
  swingHighs: [], swingLows: [], highPattern: trend === 'BULLISH' ? 'HH' : trend === 'BEARISH' ? 'LH' : 'EQUAL',
  lowPattern: trend === 'BULLISH' ? 'HL' : trend === 'BEARISH' ? 'LL' : 'EQUAL', trend,
  event, brokenLevel: null, supportZones: [], resistanceZones: [],
  range: { high: 102, low: 98, midpoint: 100 }, breakout: { state: 'NONE', level: null, bodyRatio: .5 },
});
const input = (kind: 'UP' | 'DOWN' | 'RANGE' | 'COMPRESSED' | 'HIGH_VOL', closeTime = 1): RegimeEngineInput => ({
  symbol: 'BTC', sourceCandleCloseTime: closeTime, currentClose: kind === 'UP' ? 112 : kind === 'DOWN' ? 88 : 100,
  momentumPct: kind === 'UP' ? .5 : kind === 'DOWN' ? -.5 : 0,
  technical: technical(kind), structure: structure(kind === 'UP' ? 'BULLISH' : kind === 'DOWN' ? 'BEARISH' : 'MIXED'),
});

describe('per-symbol Regime Engine v2', () => {
  it('상승 구조·EMA·ADX·momentum을 TREND_UP으로 분류한다', () => {
    const result = evaluateRegime(input('UP'), null);
    expect(result.regime).toBe('TREND_UP');
    expect(result.confidence).toBeGreaterThanOrEqual(80);
  });
  it('하락 evidence를 TREND_DOWN으로 대칭 분류한다', () => {
    expect(evaluateRegime(input('DOWN'), null).regime).toBe('TREND_DOWN');
  });
  it('낮은 ADX·평평한 slope·혼합 구조는 RANGE다', () => {
    expect(evaluateRegime(input('RANGE'), null).regime).toBe('RANGE');
  });
  it('낮은 volatility와 좁은 channel은 BREAKOUT_READY다', () => {
    expect(evaluateRegime(input('COMPRESSED'), null).regime).toBe('BREAKOUT_READY');
  });
  it('HIGH_VOLATILITY는 안전상 hysteresis 없이 즉시 전환한다', () => {
    const previous: RegimeState = { symbol: 'BTC', regime: 'TREND_UP', confidence: 90,
      sinceCandleCloseTime: 1, heldCandles: 10, pendingRegime: null, pendingCount: 0 };
    const result = evaluateRegime(input('HIGH_VOL', 2), previous);
    expect(result.regime).toBe('HIGH_VOLATILITY');
    expect(result.changed).toBe(true);
  });
  it('단일 반대 후보는 hysteresis로 기존 regime을 유지한다', () => {
    const previous: RegimeState = { symbol: 'BTC', regime: 'TREND_UP', confidence: 90,
      sinceCandleCloseTime: 1, heldCandles: 5, pendingRegime: null, pendingCount: 0 };
    const result = evaluateRegime(input('DOWN', 2), previous);
    expect(result.regime).toBe('TREND_UP');
    expect(result.pendingRegime).toBe('TREND_DOWN');
  });
  it('연속 확인봉이 충족되면 regime 전환을 확정한다', () => {
    const previous: RegimeState = { symbol: 'BTC', regime: 'TREND_UP', confidence: 90,
      sinceCandleCloseTime: 1, heldCandles: 5, pendingRegime: 'TREND_DOWN', pendingCount: 1 };
    const result = evaluateRegime(input('DOWN', 3), previous);
    expect(result.regime).toBe('TREND_DOWN');
    expect(result.changed).toBe(true);
  });
  it('다른 symbol의 이전 상태는 공유하지 않는다', () => {
    const other: RegimeState = { symbol: 'ETH', regime: 'TREND_DOWN', confidence: 90,
      sinceCandleCloseTime: 1, heldCandles: 20, pendingRegime: null, pendingCount: 0 };
    expect(evaluateRegime(input('UP'), other).previousRegime).toBe('UNKNOWN');
  });
  it('INVALID data는 UNKNOWN fail-closed다', () => {
    const invalidInput = input('UP'); invalidInput.technical = { ...invalidInput.technical, quality: 'INVALID' };
    expect(evaluateRegime(invalidInput, null).regime).toBe('UNKNOWN');
  });
  it('strict config는 unknown/version/ADX 경계 오류를 거부한다', () => {
    expect(validateRegimeEngineConfig({ ...DEFAULT_REGIME_ENGINE_CONFIG, extra: true }).join(' ')).toContain('알 수 없는');
    expect(validateRegimeEngineConfig({ ...DEFAULT_REGIME_ENGINE_CONFIG, version: 'v3' }).join(' ')).toContain('지원하지 않는');
    expect(validateRegimeEngineConfig({ ...DEFAULT_REGIME_ENGINE_CONFIG, adxRangeMax: 30 }).join(' ')).toContain('adxRangeMax');
  });
});
