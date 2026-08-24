import { describe, expect, it } from 'vitest';
import type { StrategyConfidenceRiskReductionAdvisory } from '../intel/strategyConfidenceRiskReductionV2';
import {
  evaluateStrategyGmxContextNetEdge,
  STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION,
  type StrategyGmxContextNetEdgeInput,
} from '../intel/strategyGmxContextNetEdgeV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import type { StrategySignal } from '../intel/strategySignalV2';
import type { StrategyStructuralSizingReadinessBinding } from '../intel/strategyStructuralSizingReadinessBindingV2';

const signal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  schemaVersion: 'strategy-signal/v2', signalId: 'signal-1', strategyId: 'TREND_PULLBACK',
  symbol: 'BTC', regime: 'TREND_UP', direction: 'LONG', confidence: 80,
  entryZoneLow: 99, entryZoneHigh: 101, proposedEntryPrice: 100, structuralStop: 98,
  stopDistancePct: 2, invalidationPrice: 98, targets: [{ price: 104, expectedR: 2, allocationPct: 100 }],
  grossExpectedEdgeBps: 300, expectedCostsBps: 100, netExpectedEdgeBps: 200,
  expectedNetRR: 2, higherTimeframeTrend: 'UP', marketStructure: 'HH_HL',
  confirmationPattern: 'BULLISH_REJECTION', sourceTimeframes: ['15m', '1h', '4h'],
  sourceCandleCloseTime: 1, dataQuality: 'GOOD', volumeConfirmation: true,
  reasons: [], warnings: [], ...overrides,
});
const shadow = (): StrategyShadowRecord => ({
  schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: 'BTC:SHADOW:1',
  mode: 'SHADOW_ONLY', symbol: 'BTC', evaluatedAt: 2, sourceCandleCloseTime: 1,
  regime: 'TREND_UP', action: 'LONG', comparison: 'ENSEMBLE_ONLY',
  strategyId: 'TREND_PULLBACK', signalId: 'signal-1', direction: 'LONG', confidence: 80,
  selectedScore: 80, entryPrice: 100, structuralStop: 98, expectedNetEdgeBps: 200,
  expectedNetRR: 2, lifecycleEligible: true, existingAi: null, reasons: [], warnings: [],
  executionAuthorized: false, paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED',
});
const confidence = (notional = 20): StrategyConfidenceRiskReductionAdvisory => ({
  schemaVersion: 'strategy-confidence-risk-reduction/v1',
  advisoryId: 'BTC:SHADOW:1:CONFIDENCE_RISK_REDUCTION', signalId: 'signal-1', symbol: 'BTC',
  status: 'UNCHANGED', confidence: 80, confidenceSizeFactor: 1,
  inputNotionalUsd: notional, finalAdvisoryNotionalUsd: notional, allowedLeverage: 2,
  reasons: [], authority: 'ADVISORY_ONLY', executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false,
});
const binding = (overrides: Partial<StrategyStructuralSizingReadinessBinding> = {}):
StrategyStructuralSizingReadinessBinding => ({
  schemaVersion: 'strategy-structural-sizing-readiness-binding/v1', status: 'BOUND',
  coordinatorGeneration: 7,
  marketContextBySymbol: { BTC: {
    source: 'VERIFIED_READ_ONLY', evidenceId: 'g7-btc', symbol: 'BTC', observedAt: 100,
    fresh: true, roundTripFeesFraction: 0.005, adverseImpactBufferFraction: 0.002,
    fundingBorrowingBufferFraction: 0.001, liquidityCapUsd: 1_000, tierNotionalCapUsd: 500,
  } },
  summary: { expected: 1, bound: 1, missingOrStale: 0 }, reasons: [],
  authority: 'ADVISORY_ONLY', externalReadStarted: false, executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false, ...overrides,
});
const input = (): StrategyGmxContextNetEdgeInput => ({
  signal: signal(), shadowRecord: shadow(), confidenceAdvisory: confidence(),
  readinessBinding: binding(),
});

describe('Strategy GMX Context cost-adjusted Net Edge', () => {
  it('fresh same-generation context로 비용을 재계산하고 양수 Net Edge만 통과시킨다', () => {
    const result = evaluateStrategyGmxContextNetEdge(input());
    expect(result).toMatchObject({
      schemaVersion: STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION, status: 'PASSED',
      coordinatorGeneration: 7, inputNotionalUsd: 20, finalAdvisoryNotionalUsd: 20,
      grossExpectedEdgeBps: 300, grossExpectedEdgeUsd: 0.6, roundTripCostBps: 80,
      costCapExcessUsd: 0, costAdjustedNetEdgeBps: 220,
      authority: 'ADVISORY_ONLY', externalReadStarted: false, executionAuthorized: false,
      approvalCreationAllowed: false, paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
    });
    expect(result.roundTripCostUsd).toBeCloseTo(0.16, 12);
    expect(result.costAdjustedNetEdgeUsd).toBeCloseTo(0.44, 12);
  });

  it('예상 수익이 있어도 고정 $0.40 왕복비용 상한을 초과하면 차단한다', () => {
    const value = input();
    value.readinessBinding = binding({ marketContextBySymbol: { BTC: {
      ...binding().marketContextBySymbol.BTC!, roundTripFeesFraction: 0.025,
    } } });
    const result = evaluateStrategyGmxContextNetEdge(value);
    expect(result).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
    expect(result.roundTripCostUsd).toBeCloseTo(0.56, 12);
    expect(result.costCapExcessUsd).toBeCloseTo(0.16, 12);
  });

  it('비용 차감 Net Edge가 0 이하이면 경제성 부적격으로 차단한다', () => {
    const value = input();
    value.signal = signal({ grossExpectedEdgeBps: 50 });
    expect(evaluateStrategyGmxContextNetEdge(value)).toMatchObject({
      status: 'REJECTED', costAdjustedNetEdgeBps: -30, finalAdvisoryNotionalUsd: 0,
    });
  });

  it('context가 missing이면 비용을 0으로 위장하지 않고 NOT_EVALUATED다', () => {
    const value = input();
    value.readinessBinding = binding({
      status: 'NOT_EVALUATED', coordinatorGeneration: 7,
      marketContextBySymbol: { BTC: null }, summary: { expected: 1, bound: 0, missingOrStale: 1 },
    });
    expect(evaluateStrategyGmxContextNetEdge(value)).toMatchObject({
      status: 'NOT_EVALUATED', roundTripCostUsd: null, costAdjustedNetEdgeUsd: null,
      finalAdvisoryNotionalUsd: 0,
    });
  });

  it('Signal identity·direction 또는 권한 변조는 INVALID다', () => {
    const mismatch = input(); mismatch.signal = signal({ signalId: 'other' });
    expect(evaluateStrategyGmxContextNetEdge(mismatch)).toMatchObject({
      schemaVersion: 'INVALID', status: 'REJECTED',
    });
    const unsafe = input(); unsafe.confidenceAdvisory = {
      ...unsafe.confidenceAdvisory, executionAuthorized: true as never,
    };
    expect(evaluateStrategyGmxContextNetEdge(unsafe)).toMatchObject({
      schemaVersion: 'INVALID', status: 'REJECTED',
    });
  });

  it('liquidity·tier cap 초과 또는 gross edge 결측을 fail-closed 처리한다', () => {
    const capped = input(); capped.confidenceAdvisory = confidence(600);
    expect(evaluateStrategyGmxContextNetEdge(capped).status).toBe('REJECTED');
    const missing = input(); missing.signal = signal({ grossExpectedEdgeBps: null });
    expect(evaluateStrategyGmxContextNetEdge(missing).status).toBe('NOT_EVALUATED');
  });

  it('기존 추정 net edge를 신뢰하지 않고 gross edge와 GMX 비용으로 재계산하며 입력은 불변이다', () => {
    const value = input(); value.signal = signal({ netExpectedEdgeBps: 9_999, expectedCostsBps: 0 });
    const before = JSON.stringify(value);
    expect(evaluateStrategyGmxContextNetEdge(value)).toMatchObject({ costAdjustedNetEdgeBps: 220 });
    expect(JSON.stringify(value)).toBe(before);
  });
});
