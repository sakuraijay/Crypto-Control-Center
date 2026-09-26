import { describe, expect, it } from 'vitest';
import {
  arbitrateStrategySignals,
  DEFAULT_STRATEGY_ARBITER_CONFIG,
  type StrategyArbiterInput,
} from '../intel/strategyArbiterV2';
import {
  buildStrategySignalId,
  STRATEGY_SIGNAL_SCHEMA_VERSION,
  type StrategyDirection,
  type StrategyId,
  type StrategySignal,
} from '../intel/strategySignalV2';
import type { MarketRegime } from '../intel/regimeEngineV2';

const signal = (
  strategyId: StrategyId,
  regime: MarketRegime,
  direction: Exclude<StrategyDirection, 'NONE'> = 'LONG',
  overrides: Partial<StrategySignal> = {},
): StrategySignal => ({
  schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
  signalId: buildStrategySignalId('BTC', strategyId, direction, '15m', 900_000),
  strategyId,
  symbol: 'BTC',
  regime,
  direction,
  confidence: 85,
  entryZoneLow: 99,
  entryZoneHigh: 101,
  proposedEntryPrice: 100,
  structuralStop: direction === 'LONG' ? 98 : 102,
  stopDistancePct: 2,
  invalidationPrice: direction === 'LONG' ? 98 : 102,
  targets: [{ price: direction === 'LONG' ? 104 : 96, expectedR: 2, allocationPct: 100 }],
  grossExpectedEdgeBps: 400,
  expectedCostsBps: 20,
  netExpectedEdgeBps: 380,
  expectedNetRR: 1.9,
  higherTimeframeTrend: regime,
  marketStructure: 'TEST',
  confirmationPattern: 'TEST_CONFIRMATION',
  sourceTimeframes: ['4h', '1h', '15m'],
  sourceCandleCloseTime: 900_000,
  dataQuality: 'GOOD',
  volumeConfirmation: null,
  reasons: [],
  warnings: [],
  ...overrides,
});

const input = (regime: MarketRegime, candidates: StrategySignal[]): StrategyArbiterInput => ({
  symbol: 'BTC',
  regime,
  sourceCandleCloseTime: 900_000,
  candidates,
});

describe('Strategy Arbiter v2', () => {
  it('TREND_UP에서 Trend Pullback 하나만 선택한다', () => {
    const result = arbitrateStrategySignals(input('TREND_UP', [
      signal('TREND_PULLBACK', 'TREND_UP'),
      signal('RANGE_MEAN_REVERSION', 'TREND_UP'),
    ]));
    expect(result.action).toBe('SELECT');
    expect(result.selectedSignal?.strategyId).toBe('TREND_PULLBACK');
    expect(result.rejectedCandidates[0].reasons.join(' ')).toContain('전략 비활성');
  });

  it('RANGE에서는 Mean-Reversion만 활성화한다', () => {
    const result = arbitrateStrategySignals(input('RANGE', [signal('RANGE_MEAN_REVERSION', 'RANGE')]));
    expect(result.action).toBe('SELECT');
    expect(result.selectedSignal?.strategyId).toBe('RANGE_MEAN_REVERSION');
  });

  it('HIGH_VOLATILITY에서는 신규 진입을 선택하지 않는다', () => {
    const result = arbitrateStrategySignals(input('HIGH_VOLATILITY', [
      signal('VOLATILITY_BREAKOUT', 'HIGH_VOLATILITY'),
    ]));
    expect(result.action).toBe('NO_TRADE');
    expect(result.selectedSignal).toBeNull();
  });

  it('반대 방향 신호가 동시에 적격이면 NO TRADE다', () => {
    const long = signal('VOLATILITY_BREAKOUT', 'BREAKOUT_READY', 'LONG');
    const short = signal('VOLATILITY_BREAKOUT', 'BREAKOUT_READY', 'SHORT');
    const result = arbitrateStrategySignals(input('BREAKOUT_READY', [long, short]));
    expect(result.action).toBe('NO_TRADE');
    expect(result.reasons.join(' ')).toContain('반대 방향');
  });

  it('Data Quality INVALID 후보가 있으면 전체 판단을 fail-closed REJECT한다', () => {
    const invalid = signal('TREND_PULLBACK', 'TREND_UP', 'LONG', { dataQuality: 'INVALID' });
    const result = arbitrateStrategySignals(input('TREND_UP', [invalid]));
    expect(result.action).toBe('REJECT');
    expect(result.reasons.join(' ')).toContain('INVALID');
  });

  it('DEGRADED 품질 또는 불명확한 Structural Stop은 선택하지 않는다', () => {
    const degraded = signal('TREND_PULLBACK', 'TREND_UP', 'LONG', {
      dataQuality: 'DEGRADED', structuralStop: null, stopDistancePct: null,
    });
    const result = arbitrateStrategySignals(input('TREND_UP', [degraded]));
    expect(result.action).toBe('NO_TRADE');
    expect(result.rejectedCandidates[0].reasons.join(' ')).toContain('Structural Stop');
  });

  it('비용 차감 Net Edge와 Net R:R 미달 후보를 제외한다', () => {
    const uneconomic = signal('TREND_PULLBACK', 'TREND_UP', 'LONG', {
      netExpectedEdgeBps: -1, expectedNetRR: 1.2,
    });
    const result = arbitrateStrategySignals(input('TREND_UP', [uneconomic]));
    expect(result.action).toBe('NO_TRADE');
    expect(result.rejectedCandidates[0].reasons.join(' ')).toContain('Net Edge');
    expect(result.rejectedCandidates[0].reasons.join(' ')).toContain('Net R:R');
  });

  it('동일 Signal ID의 완전 중복은 한 번만 고려한다', () => {
    const candidate = signal('TREND_PULLBACK', 'TREND_UP');
    const result = arbitrateStrategySignals(input('TREND_UP', [candidate, { ...candidate }]));
    expect(result.action).toBe('SELECT');
    expect(result.consideredSignalIds).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('중복 Signal ID 제거');
  });

  it('동일 Signal ID의 내용 충돌은 REJECT한다', () => {
    const candidate = signal('TREND_PULLBACK', 'TREND_UP');
    const conflicting = { ...candidate, confidence: 99 };
    const result = arbitrateStrategySignals(input('TREND_UP', [candidate, conflicting]));
    expect(result.action).toBe('REJECT');
    expect(result.reasons.join(' ')).toContain('내용 충돌');
  });

  it('종목 또는 완료 캔들 시각이 다르면 fail-closed REJECT한다', () => {
    const mismatched = signal('TREND_PULLBACK', 'TREND_UP', 'LONG', { symbol: 'ETH' });
    expect(arbitrateStrategySignals(input('TREND_UP', [mismatched])).action).toBe('REJECT');
  });

  it('상위 후보 점수 차이가 부족하면 임의 선택하지 않는다', () => {
    const first = signal('TREND_PULLBACK', 'TREND_UP', 'LONG');
    const second = signal('TREND_PULLBACK', 'TREND_UP', 'LONG', {
      signalId: 'BTC:TREND_PULLBACK:LONG:15m:900000:SECOND',
      confidence: 84,
      netExpectedEdgeBps: 375,
    });
    const result = arbitrateStrategySignals(input('TREND_UP', [first, second]));
    expect(result.action).toBe('NO_TRADE');
    expect(result.reasons.join(' ')).toContain('점수 차이 부족');
  });

  it('Net Edge·R:R·confidence를 함께 점수화하며 결정 ID가 재현 가능하다', () => {
    const first = signal('VOLATILITY_BREAKOUT', 'BREAKOUT_READY', 'LONG', {
      confidence: 72, netExpectedEdgeBps: 450, expectedNetRR: 3.5,
    });
    const second = signal('VOLATILITY_BREAKOUT', 'BREAKOUT_READY', 'LONG', {
      signalId: 'BTC:VOLATILITY_BREAKOUT:LONG:15m:900000:SECOND',
      confidence: 95, netExpectedEdgeBps: 30, expectedNetRR: 1.5,
    });
    const firstResult = arbitrateStrategySignals(input('BREAKOUT_READY', [first, second]));
    const secondResult = arbitrateStrategySignals(input('BREAKOUT_READY', [first, second]));
    expect(firstResult.action).toBe('SELECT');
    expect(firstResult.selectedSignal?.signalId).toBe(first.signalId);
    expect(firstResult.decisionId).toBe(secondResult.decisionId);
  });

  it('strict versioned config 오류는 REJECT한다', () => {
    const candidate = signal('TREND_PULLBACK', 'TREND_UP');
    const extra = arbitrateStrategySignals(input('TREND_UP', [candidate]), {
      ...DEFAULT_STRATEGY_ARBITER_CONFIG, extra: true,
    });
    const wrongWeight = arbitrateStrategySignals(input('TREND_UP', [candidate]), {
      ...DEFAULT_STRATEGY_ARBITER_CONFIG, confidenceWeight: 0.9,
    });
    expect(extra.action).toBe('REJECT');
    expect(extra.warnings.join(' ')).toContain('알 수 없는');
    expect(wrongWeight.warnings.join(' ')).toContain('합은 1');
  });
});
