import { describe, expect, it } from 'vitest';
import type { CandleFeatureResult, PatternStrengths } from '../intel/candlePatternFeatures';
import type { CandleTechnicalSnapshot } from '../intel/candleTechnicalFeaturesV2';
import type { MarketStructureEvidence, BreakoutState } from '../intel/marketStructureV2';
import type { RegimeDecision } from '../intel/regimeEngineV2';
import { DEFAULT_VOLATILITY_BREAKOUT_CONFIG, evaluateVolatilityBreakout } from '../intel/volatilityBreakoutStrategyV2';
import type { VolatilityBreakoutInput } from '../intel/volatilityBreakoutStrategyV2';

const patterns = (direction: 'LONG' | 'SHORT'): PatternStrengths => ({
  bullishCandle: direction === 'LONG' ? 80 : 0, bearishCandle: direction === 'SHORT' ? 80 : 0,
  longLowerWick: 0, longUpperWick: 0, bullishEngulfing: 0, bearishEngulfing: 0,
  insideBar: 0, outsideBar: 0, strongBullishBody: direction === 'LONG' ? 80 : 0,
  strongBearishBody: direction === 'SHORT' ? 80 : 0, doji: 0, bullishRejection: 0, bearishRejection: 0,
  bullishBreakout: direction === 'LONG' ? 80 : 0, bearishBreakout: direction === 'SHORT' ? 80 : 0,
  bullishFailedBreakout: 0, bearishFailedBreakout: 0,
});
const pattern = (direction: 'LONG' | 'SHORT', volumeRatio: number | null = 1.5): CandleFeatureResult => ({
  configVersion: 'regime-candle-patterns/v1', sourceCandleOpenTime: 1, quality: 'GOOD', issues: [], geometry: null,
  volume: volumeRatio === null ? null : 100, averageVolume: volumeRatio === null ? null : 100 / volumeRatio,
  volumeRatio, volumeSpike: volumeRatio === null ? null : volumeRatio >= 1.3, patterns: patterns(direction),
});
const technical = (volatility = 45, atrPct = 1): CandleTechnicalSnapshot => ({
  configVersion: 'regime-candle-technicals/v1', quality: 'GOOD', sourceCandleOpenTime: 1, issues: [],
  ema: { fast: 100, medium: 100, long: 100, macro: 100 },
  emaSlopePctPerBar: { fast: 0, medium: 0, long: 0 }, atr: { absolute: 0.2, percent: atrPct },
  directionalIndex: { adx: 15, plusDi: 20, minusDi: 20 },
  bollinger: { upper: 101, middle: 100, lower: 99, widthPct: 2 },
  keltner: { upper: 101, middle: 100, lower: 99, widthPct: 2 },
  donchian: { upper: 100, middle: 99, lower: 98, widthPct: 2, excludesLatestCandle: true },
  volatilityPercentile: volatility, zScore: 1,
});
const structure = (state: BreakoutState, trend: MarketStructureEvidence['trend'] = 'MIXED'): MarketStructureEvidence => ({
  configVersion: 'regime-market-structure/v1', quality: 'GOOD', sourceCandleOpenTime: 1, issues: [],
  swingHighs: [], swingLows: [], highPattern: 'EQUAL', lowPattern: 'EQUAL', trend, event: 'NONE', brokenLevel: null,
  supportZones: [], resistanceZones: [], range: { high: 100, low: 99, midpoint: 99.5 },
  breakout: { state, level: 100, bodyRatio: 0.7 },
});
const regime = (value: RegimeDecision['regime'] = 'BREAKOUT_READY'): RegimeDecision => ({
  symbol: 'BTC', regime: value, confidence: 90, sinceCandleCloseTime: 1, heldCandles: 3,
  pendingRegime: null, pendingCount: 0, configVersion: 'regime-engine/v2', previousRegime: 'RANGE', changed: true,
  candidateRegime: value, candidateConfidence: 90, calculatedAt: 1, reasons: [], warnings: [],
  scores: { TREND_UP: 0, TREND_DOWN: 0, RANGE: 0, BREAKOUT_READY: 90, HIGH_VOLATILITY: 0, TRANSITION: 0 },
});
const input = (direction: 'LONG' | 'SHORT'): VolatilityBreakoutInput => ({
  symbol: 'BTC', sourceCandleCloseTime: 1, evaluatedAt: 2, entryPrice: direction === 'LONG' ? 100.5 : 99.5,
  expectedCostsBps: 10, dataQuality: 'GOOD', regime: regime(),
  structure1h: structure('NONE'),
  structure15m: structure(direction === 'LONG' ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN'),
  technical15m: technical(), pattern15m: pattern(direction),
});

describe('Volatility Breakout Strategy v2', () => {
  it('BREAKOUT_READY 종가 상향 돌파에서 LONG 후보를 만든다', () => {
    const result = evaluateVolatilityBreakout(input('LONG'));
    expect(result.direction).toBe('LONG');
    expect(result.structuralStop).toBeLessThan(100);
    expect(result.expectedNetRR).toBeGreaterThanOrEqual(1.5);
  });
  it('하향 돌파를 SHORT로 대칭 처리한다', () => {
    const result = evaluateVolatilityBreakout(input('SHORT'));
    expect(result.direction).toBe('SHORT');
    expect(result.structuralStop).toBeGreaterThan(100);
  });
  it('BREAKOUT_READY 이외 regime에서는 비활성화한다', () => {
    const value = input('LONG'); value.regime = regime('RANGE');
    expect(evaluateVolatilityBreakout(value).direction).toBe('NONE');
  });
  it('몸통 강도가 낮은 wick touch는 돌파로 인정하지 않는다', () => {
    const value = input('LONG'); value.structure15m.breakout.bodyRatio = 0.2;
    expect(evaluateVolatilityBreakout(value).reasons.join(' ')).toContain('wick touch');
  });
  it('Failed breakout은 후보를 차단하고 cooldown 사유를 남긴다', () => {
    const value = input('LONG'); value.structure15m.breakout.state = 'FAILED_UP';
    expect(evaluateVolatilityBreakout(value).reasons.join(' ')).toContain('cooldown');
  });
  it('강한 상위 하락추세에서 LONG을 거부한다', () => {
    const value = input('LONG'); value.structure1h.trend = 'BEARISH';
    expect(evaluateVolatilityBreakout(value).reasons.join(' ')).toContain('역방향');
  });
  it('이미 고변동성으로 확장된 돌파 추격을 금지한다', () => {
    const value = input('LONG'); value.technical15m = technical(95, 4);
    expect(evaluateVolatilityBreakout(value).reasons.join(' ')).toContain('추격 금지');
  });
  it('비용 evidence가 없으면 fail-closed다', () => {
    const value = input('LONG'); value.expectedCostsBps = null;
    expect(evaluateVolatilityBreakout(value).reasons.join(' ')).toContain('비용 evidence 없음');
  });
  it('거래량 unavailable을 합성하지 않고 nullable로 유지한다', () => {
    const value = input('LONG'); value.pattern15m = pattern('LONG', null);
    const result = evaluateVolatilityBreakout(value);
    expect(result.direction).toBe('LONG');
    expect(result.volumeConfirmation).toBeNull();
  });
  it('동일 완료 캔들은 같은 Signal ID이며 strict config 오류는 차단한다', () => {
    expect(evaluateVolatilityBreakout(input('LONG')).signalId).toContain('BTC:VOLATILITY_BREAKOUT:LONG:15m:1');
    expect(evaluateVolatilityBreakout(input('LONG'), { ...DEFAULT_VOLATILITY_BREAKOUT_CONFIG, extra: true }).warnings.join(' ')).toContain('알 수 없는');
    expect(evaluateVolatilityBreakout(input('LONG'), { ...DEFAULT_VOLATILITY_BREAKOUT_CONFIG, version: 'v9' }).warnings.join(' ')).toContain('지원하지 않는');
  });
});
