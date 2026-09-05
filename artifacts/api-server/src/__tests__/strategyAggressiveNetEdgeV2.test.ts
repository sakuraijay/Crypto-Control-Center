import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGGRESSIVE_NET_EDGE_CONFIG,
  evaluateAggressiveNetEdge,
  STRATEGY_AGGRESSIVE_NET_EDGE_VERSION,
  type StrategyAggressiveNetEdgeInput,
} from '../intel/strategyAggressiveNetEdgeV2';
import type { StrategyGmxContextNetEdgeAdvisory } from '../intel/strategyGmxContextNetEdgeV2';
import type { StrategySignal } from '../intel/strategySignalV2';
import type { StrategyStructuralSizingAdvisory } from '../intel/strategyStructuralSizingV2';
import type { AppliedRiskProfileSnapshot } from '../lib/riskProfiles';

const signal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  schemaVersion: 'strategy-signal/v2', signalId: 'signal-aggressive-1', strategyId: 'TREND_PULLBACK',
  symbol: 'BTC', regime: 'TREND_UP', direction: 'LONG', confidence: 85,
  entryZoneLow: 99, entryZoneHigh: 101, proposedEntryPrice: 100, structuralStop: 98,
  stopDistancePct: 2, invalidationPrice: 98, targets: [{ price: 105, expectedR: 2.5, allocationPct: 100 }],
  grossExpectedEdgeBps: 300, expectedCostsBps: 80, netExpectedEdgeBps: 220,
  expectedNetRR: 2.5, higherTimeframeTrend: 'UP', marketStructure: 'HH_HL',
  confirmationPattern: 'BULLISH_REJECTION', sourceTimeframes: ['15m', '1h', '4h'],
  sourceCandleCloseTime: 1, dataQuality: 'GOOD', volumeConfirmation: true,
  reasons: [], warnings: [], ...overrides,
});

const netEdge = (overrides: Partial<StrategyGmxContextNetEdgeAdvisory> = {}): StrategyGmxContextNetEdgeAdvisory => ({
  schemaVersion: 'strategy-gmx-context-net-edge/v1', advisoryId: 'shadow-1:GMX_CONTEXT_NET_EDGE',
  signalId: 'signal-aggressive-1', symbol: 'BTC', status: 'PASSED', coordinatorGeneration: 7,
  inputNotionalUsd: 20, finalAdvisoryNotionalUsd: 20,
  grossExpectedEdgeBps: 300, grossExpectedEdgeUsd: 0.60,
  roundTripCostBps: 80, roundTripCostUsd: 0.16, immutableCostCapUsd: 0.40,
  costCapExcessUsd: 0, costAdjustedNetEdgeBps: 220, costAdjustedNetEdgeUsd: 0.44,
  reasons: [], authority: 'ADVISORY_ONLY', externalReadStarted: false,
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
  ...overrides,
});

const sizing = (overrides: Partial<StrategyStructuralSizingAdvisory> = {}): StrategyStructuralSizingAdvisory => ({
  schemaVersion: 'strategy-structural-sizing/v1', advisoryId: 'shadow-1:STRUCTURAL_SIZING',
  signalId: 'signal-aggressive-1', symbol: 'BTC', status: 'SIZED', direction: 'LONG',
  entryPrice: 100, structuralStop: 98, stopDistanceFraction: 0.02,
  riskSizeFactor: 1, allowedLeverage: 2, allowedRiskUsd: 5,
  effectiveStopLossFraction: 0.02, maxNotionalBeforeRiskReductionUsd: 20,
  finalAdvisoryNotionalUsd: 20, reasons: [], authority: 'ADVISORY_ONLY',
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
  ...overrides,
});

const aggressiveProfile = (overrides: Partial<AppliedRiskProfileSnapshot> = {}): AppliedRiskProfileSnapshot => ({
  name: 'aggressive', version: 'risk-profile/v1', appliedAt: '2026-09-05T00:00:00.000Z',
  derivedLimits: {
    immediateEntryThreshold: 80, maxRiskPerTradePct: 0.5, reserveCashPct: 20,
    maxMarginPerTradeUsd: 334, maxConcurrentPositions: 1, cooldownMinutes: 30,
    maxLeverage: 3, maxTotalExposureUsd: 3000, allocatedTradingCapitalUsd: 1000,
    maxRiskPerTradeUsd: 5,
  },
  ...overrides,
});

const input = (): StrategyAggressiveNetEdgeInput => ({
  signal: signal(), netEdge: netEdge(), structuralSizing: sizing(), riskProfile: aggressiveProfile(),
});

describe('Aggressive Net-Edge advisory policy', () => {
  it('비용 3배 이상 gross edge와 bounded structural-stop risk를 모두 만족할 때만 후보가 된다', () => {
    const result = evaluateAggressiveNetEdge(input());
    expect(result).toMatchObject({
      schemaVersion: STRATEGY_AGGRESSIVE_NET_EDGE_VERSION,
      status: 'ELIGIBLE', direction: 'LONG', confidence: 85, expectedNetRR: 2.5,
      notionalUsd: 20, structuralStopRiskUsd: 0.4, maxProfileRiskUsd: 5,
      structuralStopRiskPctOfCapital: 0.04, grossEdgeToCostRatio: 3.75,
      costAdjustedNetEdgeUsd: 0.44, roundTripCostUsd: 0.16, immutableCostCapUsd: 0.4,
      authority: 'ADVISORY_ONLY', executionAuthorized: false,
      approvalCreationAllowed: false, paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
    });
    expect(result.reasons.join(' ')).toContain('Risk Engine');
  });

  it('gross edge가 비용 3배를 압도하지 못하면 양의 Net Edge여도 거부한다', () => {
    const value = input();
    value.netEdge = netEdge({ grossExpectedEdgeUsd: 0.40, costAdjustedNetEdgeUsd: 0.24 });
    const result = evaluateAggressiveNetEdge(value);
    expect(result.status).toBe('REJECTED');
    expect(result.grossEdgeToCostRatio).toBe(2.5);
    expect(result.reasons.join(' ')).toContain('3배 미만');
  });

  it('일정 손실 허용은 applied aggressive profile의 거래당 0.5% 위험예산을 넘지 못한다', () => {
    const value = input();
    value.netEdge = netEdge({
      inputNotionalUsd: 300, finalAdvisoryNotionalUsd: 300,
      grossExpectedEdgeUsd: 0.90, roundTripCostUsd: 0.30, costAdjustedNetEdgeUsd: 0.60,
    });
    value.structuralSizing = sizing({
      maxNotionalBeforeRiskReductionUsd: 300, finalAdvisoryNotionalUsd: 300,
      stopDistanceFraction: 0.02, allowedRiskUsd: 5,
    });
    const result = evaluateAggressiveNetEdge(value);
    expect(result).toMatchObject({ status: 'REJECTED', structuralStopRiskUsd: 6 });
    expect(result.reasons.join(' ')).toContain('원금 위험');
  });

  it('immutable $0.40 비용 상한은 공격형 전략도 우회할 수 없다', () => {
    const value = input();
    value.netEdge = netEdge({ roundTripCostUsd: 0.41, grossExpectedEdgeUsd: 1.64, costAdjustedNetEdgeUsd: 1.23 });
    const result = evaluateAggressiveNetEdge(value);
    expect(result.status).toBe('REJECTED');
    expect(result.reasons.join(' ')).toContain('immutable');
  });

  it('conservative profile에서는 공격형 후보를 생성하지 않는다', () => {
    const value = input();
    value.riskProfile = {
      ...aggressiveProfile(), name: 'conservative',
      derivedLimits: {
        ...aggressiveProfile().derivedLimits,
        maxRiskPerTradePct: 0.25, maxRiskPerTradeUsd: 2.5,
      },
    };
    expect(evaluateAggressiveNetEdge(value)).toMatchObject({ status: 'NOT_EVALUATED' });
  });

  it('Net Edge와 Structural Sizing의 notional이 다르면 재산출하지 않고 NOT_EVALUATED다', () => {
    const value = input();
    value.structuralSizing = sizing({ finalAdvisoryNotionalUsd: 19 });
    expect(evaluateAggressiveNetEdge(value)).toMatchObject({ status: 'NOT_EVALUATED', notionalUsd: 0 });
  });

  it('confidence 또는 Net R:R 기준을 낮게 주면 거부한다', () => {
    const lowConfidence = input(); lowConfidence.signal = signal({ confidence: 79 });
    expect(evaluateAggressiveNetEdge(lowConfidence).status).toBe('REJECTED');
    const lowRr = input(); lowRr.signal = signal({ expectedNetRR: 1.99 });
    expect(evaluateAggressiveNetEdge(lowRr).status).toBe('REJECTED');
  });

  it('권한 변조와 잘못된 config는 INVALID fail-closed다', () => {
    const unsafe = input();
    unsafe.netEdge = { ...unsafe.netEdge, executionAuthorized: true as never };
    expect(evaluateAggressiveNetEdge(unsafe)).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
    expect(evaluateAggressiveNetEdge(input(), {
      ...DEFAULT_AGGRESSIVE_NET_EDGE_CONFIG, minimumGrossEdgeToCostRatio: 1,
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
  });
});
