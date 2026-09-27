import { describe, expect, it } from 'vitest';
import type { CandleFeatureResult, PatternStrengths } from '../intel/candlePatternFeatures';
import type { CandleTechnicalSnapshot } from '../intel/candleTechnicalFeaturesV2';
import type { BreakoutState, MarketStructureEvidence } from '../intel/marketStructureV2';
import type { RegimeDecision } from '../intel/regimeEngineV2';
import {
  DEFAULT_RANGE_MEAN_REVERSION_CONFIG,
  evaluateRangeMeanReversion,
  type RangeMeanReversionInput,
} from '../intel/rangeMeanReversionStrategyV2';

const patterns = (direction: 'LONG' | 'SHORT'): PatternStrengths => ({
  bullishCandle: direction === 'LONG' ? 70 : 0, bearishCandle: direction === 'SHORT' ? 70 : 0,
  longLowerWick: direction === 'LONG' ? 80 : 0, longUpperWick: direction === 'SHORT' ? 80 : 0,
  bullishEngulfing: direction === 'LONG' ? 70 : 0, bearishEngulfing: direction === 'SHORT' ? 70 : 0,
  insideBar: 0, outsideBar: 0, strongBullishBody: 0, strongBearishBody: 0, doji: 0,
  bullishRejection: direction === 'LONG' ? 85 : 0, bearishRejection: direction === 'SHORT' ? 85 : 0,
  bullishBreakout: 0, bearishBreakout: 0, bullishFailedBreakout: 0, bearishFailedBreakout: 0,
});
const pattern = (direction: 'LONG' | 'SHORT', volumeRatio: number | null = 1.5): CandleFeatureResult => ({
  configVersion: 'regime-candle-patterns/v1', sourceCandleOpenTime: 1, quality: 'GOOD', issues: [], geometry: null,
  volume: volumeRatio === null ? null : 100, averageVolume: volumeRatio === null ? null : 100 / volumeRatio,
  volumeRatio, volumeSpike: volumeRatio === null ? null : volumeRatio >= 1.3, patterns: patterns(direction),
});
const technical = (zScore: number): CandleTechnicalSnapshot => ({
  configVersion: 'regime-candle-technicals/v1', quality: 'GOOD', sourceCandleOpenTime: 1, issues: [],
  ema: { fast: 100, medium: 100, long: 100, macro: 100 },
  emaSlopePctPerBar: { fast: 0, medium: 0, long: 0 }, atr: { absolute: 0.2, percent: 0.2 },
  directionalIndex: { adx: 12, plusDi: 18, minusDi: 18 },
  bollinger: { upper: 102, middle: 100, lower: 98, widthPct: 4 },
  keltner: { upper: 102, middle: 100, lower: 98, widthPct: 4 },
  donchian: { upper: 102, middle: 100, lower: 98, widthPct: 4, excludesLatestCandle: true },
  volatilityPercentile: 40, zScore,
});
const structure = (state: BreakoutState = 'NONE', trend: MarketStructureEvidence['trend'] = 'MIXED'): MarketStructureEvidence => ({
  configVersion: 'regime-market-structure/v1', quality: 'GOOD', sourceCandleOpenTime: 1, issues: [],
  swingHighs: [], swingLows: [], highPattern: 'EQUAL', lowPattern: 'EQUAL', trend, event: 'NONE', brokenLevel: null,
  supportZones: [], resistanceZones: [], range: { high: 102, low: 98, midpoint: 100 },
  breakout: { state, level: state.includes('UP') ? 102 : state.includes('DOWN') ? 98 : null, bodyRatio: 0.4 },
});
const regime = (value: RegimeDecision['regime'] = 'RANGE'): RegimeDecision => ({
  symbol: 'BTC', regime: value, confidence: 90, sinceCandleCloseTime: 1, heldCandles: 3,
  pendingRegime: null, pendingCount: 0, configVersion: 'regime-engine/v2', previousRegime: 'TRANSITION', changed: true,
  candidateRegime: value, candidateConfidence: 90, calculatedAt: 1, reasons: [], warnings: [],
  scores: { TREND_UP: 0, TREND_DOWN: 0, RANGE: 90, BREAKOUT_READY: 0, HIGH_VOLATILITY: 0, TRANSITION: 0 },
});
const input = (direction: 'LONG' | 'SHORT'): RangeMeanReversionInput => ({
  symbol: 'BTC', sourceCandleCloseTime: 1, evaluatedAt: 2,
  entryPrice: direction === 'LONG' ? 98.5 : 101.5, expectedCostsBps: 10,
  dataQuality: 'GOOD', regime: regime(), structure1h: structure(), structure15m: structure(),
  technical15m: technical(direction === 'LONG' ? -1.5 : 1.5), pattern15m: pattern(direction),
});

describe('Range Mean-Reversion Strategy v2', () => {
  it('Range Low 반전 confirmation에서 LONG 후보를 만든다', () => {
    const result = evaluateRangeMeanReversion(input('LONG'));
    expect(result.direction).toBe('LONG');
    expect(result.structuralStop).toBeLessThan(98);
    expect(result.targets[0].price).toBe(100);
  });
  it('Range High 거부를 SHORT로 대칭 처리한다', () => {
    const result = evaluateRangeMeanReversion(input('SHORT'));
    expect(result.direction).toBe('SHORT');
    expect(result.structuralStop).toBeGreaterThan(102);
  });
  it('RANGE 외 Regime에서는 비활성화한다', () => {
    const value = input('LONG'); value.regime = regime('TREND_UP');
    expect(evaluateRangeMeanReversion(value).reasons.join(' ')).toContain('RANGE 외');
  });
  it('1H 추세형 구조에서는 RSI/Z-score만으로 역추세 진입하지 않는다', () => {
    const value = input('LONG'); value.structure1h.trend = 'BEARISH';
    expect(evaluateRangeMeanReversion(value).reasons.join(' ')).toContain('추세형 구조');
  });
  it('Range 중앙에서는 진입하지 않는다', () => {
    const value = input('LONG'); value.entryPrice = 100;
    expect(evaluateRangeMeanReversion(value).reasons.join(' ')).toContain('중앙');
  });
  it('확정 돌파 중에는 Breakout 전략과 동시에 활성화하지 않는다', () => {
    const value = input('LONG'); value.structure15m.breakout.state = 'BREAKOUT_UP';
    expect(evaluateRangeMeanReversion(value).reasons.join(' ')).toContain('돌파 상태');
  });
  it('Z-score 또는 반전 confirmation이 부족하면 NO TRADE다', () => {
    const value = input('LONG'); value.technical15m = technical(-0.2);
    expect(evaluateRangeMeanReversion(value).direction).toBe('NONE');
  });
  it('비용 차감 Net R:R이 부족하면 거부한다', () => {
    const value = input('LONG'); value.expectedCostsBps = 400;
    expect(evaluateRangeMeanReversion(value).reasons.join(' ')).toContain('Net R:R');
  });
  it('거래량 unavailable을 합성하지 않고 nullable로 유지한다', () => {
    const value = input('LONG'); value.pattern15m = pattern('LONG', null);
    expect(evaluateRangeMeanReversion(value).volumeConfirmation).toBeNull();
  });
  it('동일 완료 캔들은 동일 Signal ID이며 strict config 오류는 차단한다', () => {
    expect(evaluateRangeMeanReversion(input('LONG')).signalId).toContain('BTC:RANGE_MEAN_REVERSION:LONG:15m:1');
    expect(evaluateRangeMeanReversion(input('LONG'), { ...DEFAULT_RANGE_MEAN_REVERSION_CONFIG, extra: true }).warnings.join(' ')).toContain('알 수 없는');
    expect(evaluateRangeMeanReversion(input('LONG'), { ...DEFAULT_RANGE_MEAN_REVERSION_CONFIG, version: 'v9' }).warnings.join(' ')).toContain('지원하지 않는');
  });
});
