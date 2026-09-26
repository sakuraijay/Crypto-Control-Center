import { describe, expect, it } from 'vitest';
import type { CandleFeatureResult, PatternStrengths } from '../intel/candlePatternFeatures';
import type { MarketStructureEvidence } from '../intel/marketStructureV2';
import type { RegimeDecision } from '../intel/regimeEngineV2';
import { DEFAULT_TREND_PULLBACK_CONFIG, evaluateTrendPullback } from '../intel/trendPullbackStrategyV2';
import type { TrendPullbackInput } from '../intel/trendPullbackStrategyV2';

const patterns = (direction: 'LONG' | 'SHORT'): PatternStrengths => ({
  bullishCandle: direction === 'LONG' ? 80 : 0, bearishCandle: direction === 'SHORT' ? 80 : 0,
  longLowerWick: direction === 'LONG' ? 80 : 0, longUpperWick: direction === 'SHORT' ? 80 : 0,
  bullishEngulfing: direction === 'LONG' ? 80 : 0, bearishEngulfing: direction === 'SHORT' ? 80 : 0,
  insideBar: 0, outsideBar: 0, strongBullishBody: 50, strongBearishBody: 50, doji: 0,
  bullishRejection: direction === 'LONG' ? 80 : 0, bearishRejection: direction === 'SHORT' ? 80 : 0,
  bullishBreakout: direction === 'LONG' ? 80 : 0, bearishBreakout: direction === 'SHORT' ? 80 : 0,
  bullishFailedBreakout: 0, bearishFailedBreakout: 0,
});
const pattern = (direction: 'LONG' | 'SHORT', volumeRatio: number | null = 1.5): CandleFeatureResult => ({
  configVersion: 'regime-candle-patterns/v1', sourceCandleOpenTime: 1, quality: 'GOOD', issues: [],
  geometry: null, volume: volumeRatio === null ? null : 100, averageVolume: volumeRatio === null ? null : 100 / volumeRatio,
  volumeRatio, volumeSpike: volumeRatio === null ? null : volumeRatio >= 1.3, patterns: patterns(direction),
});
const structure = (direction: 'LONG' | 'SHORT', withStop = true): MarketStructureEvidence => ({
  configVersion: 'regime-market-structure/v1', quality: 'GOOD', sourceCandleOpenTime: 1, issues: [],
  swingHighs: withStop && direction === 'SHORT' ? [{ type: 'HIGH', price: 100.5, candleOpenTime: 1, confirmedAtOpenTime: 2, sourceIndex: 1 }] : [],
  swingLows: withStop && direction === 'LONG' ? [{ type: 'LOW', price: 99.5, candleOpenTime: 1, confirmedAtOpenTime: 2, sourceIndex: 1 }] : [],
  highPattern: direction === 'LONG' ? 'HH' : 'LH', lowPattern: direction === 'LONG' ? 'HL' : 'LL',
  trend: direction === 'LONG' ? 'BULLISH' : 'BEARISH', event: 'NONE', brokenLevel: null,
  supportZones: [], resistanceZones: [], range: { high: null, low: null, midpoint: null },
  breakout: { state: 'NONE', level: null, bodyRatio: null },
});
const regime = (direction: 'LONG' | 'SHORT', value?: RegimeDecision['regime']): RegimeDecision => ({
  symbol: 'BTC', regime: value ?? (direction === 'LONG' ? 'TREND_UP' : 'TREND_DOWN'), confidence: 90,
  sinceCandleCloseTime: 1, heldCandles: 3, pendingRegime: null, pendingCount: 0,
  configVersion: 'regime-engine/v2', previousRegime: 'UNKNOWN', changed: true,
  candidateRegime: value ?? (direction === 'LONG' ? 'TREND_UP' : 'TREND_DOWN'), candidateConfidence: 90,
  calculatedAt: 1, reasons: [], warnings: [],
  scores: { TREND_UP: 0, TREND_DOWN: 0, RANGE: 0, BREAKOUT_READY: 0, HIGH_VOLATILITY: 0, TRANSITION: 0 },
});
const input = (direction: 'LONG' | 'SHORT'): TrendPullbackInput => ({
  symbol: 'BTC', sourceCandleCloseTime: 1, evaluatedAt: 2, entryPrice: 100, atr15m: 0.2,
  expectedCostsBps: 10, dataQuality: 'GOOD', regime: regime(direction),
  structure1h: structure(direction), structure15m: structure(direction), pattern15m: pattern(direction),
});

describe('Trend Pullback Strategy v2', () => {
  it('TREND_UP+1H HH/HL+15m confirmation에서 LONG 후보를 만든다', () => {
    const result = evaluateTrendPullback(input('LONG'));
    expect(result.direction).toBe('LONG');
    expect(result.confidence).toBeGreaterThanOrEqual(70);
    expect(result.structuralStop).toBeLessThan(100);
    expect(result.expectedNetRR).toBeGreaterThanOrEqual(1.5);
  });
  it('TREND_DOWN 대칭 구조에서 SHORT 후보를 만든다', () => {
    const result = evaluateTrendPullback(input('SHORT'));
    expect(result.direction).toBe('SHORT');
    expect(result.structuralStop).toBeGreaterThan(100);
  });
  it('Regime이 RANGE면 전략을 비활성화한다', () => {
    const value = input('LONG'); value.regime = regime('LONG', 'RANGE');
    expect(evaluateTrendPullback(value).direction).toBe('NONE');
  });
  it('1H 구조가 상위 추세와 반대면 NO TRADE다', () => {
    const value = input('LONG'); value.structure1h = structure('SHORT');
    expect(evaluateTrendPullback(value).reasons.join(' ')).toContain('불일치');
  });
  it('구조적 Stop 기준이 없으면 fail-closed다', () => {
    const value = input('LONG'); value.structure1h = structure('LONG', false); value.structure15m = structure('LONG', false);
    expect(evaluateTrendPullback(value).reasons.join(' ')).toContain('Stop 기준 없음');
  });
  it('실행비용 evidence가 없으면 후보를 생성하지 않는다', () => {
    const value = input('LONG'); value.expectedCostsBps = null;
    expect(evaluateTrendPullback(value).reasons.join(' ')).toContain('실행비용 evidence 없음');
  });
  it('거래량 unavailable은 합성하지 않고 경고로 남긴다', () => {
    const value = input('LONG'); value.pattern15m = pattern('LONG', null);
    const result = evaluateTrendPullback(value);
    expect(result.direction).toBe('LONG');
    expect(result.volumeConfirmation).toBeNull();
    expect(result.warnings.join(' ')).toContain('unavailable');
  });
  it('동일 완료 캔들은 항상 같은 Signal ID를 생성한다', () => {
    expect(evaluateTrendPullback(input('LONG')).signalId).toBe(evaluateTrendPullback(input('LONG')).signalId);
    expect(evaluateTrendPullback(input('LONG')).signalId).toContain('BTC:TREND_PULLBACK:LONG:15m:1');
  });
  it('INVALID data는 NONE으로 차단한다', () => {
    const value = input('LONG'); value.dataQuality = 'INVALID';
    expect(evaluateTrendPullback(value).direction).toBe('NONE');
  });
  it('strict config는 unknown/version/stop 경계 오류를 거부한다', () => {
    const value = input('LONG');
    expect(evaluateTrendPullback(value, { ...DEFAULT_TREND_PULLBACK_CONFIG, extra: true }).warnings.join(' ')).toContain('알 수 없는');
    expect(evaluateTrendPullback(value, { ...DEFAULT_TREND_PULLBACK_CONFIG, version: 'v9' }).warnings.join(' ')).toContain('지원하지 않는');
    expect(evaluateTrendPullback(value, { ...DEFAULT_TREND_PULLBACK_CONFIG, maxStopDistancePct: 0.05 }).warnings.join(' ')).toContain('경계');
  });
});
