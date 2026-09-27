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
import type { StrategyRiskAdapterDecision } from '../intel/strategyRiskAdapterV2';
import {
  evaluateStrategyNetEdgeResearch, STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
  type StrategyNetEdgeCostEvidence,
} from '../intel/strategyNetEdgeResearchGateV1';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');
const researchCost = (): StrategyNetEdgeCostEvidence => {
  const part = (bps: number) => ({ bps, usd: bps / 500 });
  const quote = (direction: 'LONG' | 'SHORT') => ({
    direction, market: '0x1111111111111111111111111111111111111111', orderType: 'MarketIncrease' as const,
    notionalUsd: 20, holdingHorizonHours: 12, source: 'PAPER_GMX_ESTIMATE' as const, blockNumber: null,
    observedAtMs: NOW - 1_000, fetchedAtMs: NOW - 1_000, expiresAtMs: NOW + 59_000,
    fundingRatePerHourFraction: part(5).usd / 20 / 12, borrowingRatePerHourFraction: part(5).usd / 20 / 12,
    positionFee: part(4), exitFee: part(4), funding: part(5), borrowing: part(5), priceImpact: part(1),
    network: part(1), totalRoundTripCost: part(20),
  });
  return { schemaVersion: STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
    market: '0x1111111111111111111111111111111111111111', notionalUsd: 20, holdingHorizonHours: 12,
    observedAtMs: NOW - 1_000, bidirectionalValidated: true, holdingCostsDerivedFromRates: true,
    holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT', conservativeBasisDirection: 'LONG',
    directionalQuotes: { LONG: quote('LONG'), SHORT: quote('SHORT') } };
};

const signal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  schemaVersion: 'strategy-signal/v2', signalId: 'signal-aggressive-1', strategyId: 'TREND_PULLBACK',
  symbol: 'BTC', regime: 'TREND_UP', direction: 'LONG', confidence: 85,
  entryZoneLow: 99, entryZoneHigh: 101, proposedEntryPrice: 100, structuralStop: 98,
  stopDistancePct: 1, invalidationPrice: 98, targets: [{ price: 105, expectedR: 2.5, allocationPct: 100 }],
  grossExpectedEdgeBps: 300, expectedCostsBps: 20, netExpectedEdgeBps: 280,
  expectedNetRR: 2.8, higherTimeframeTrend: 'UP', marketStructure: 'HH_HL',
  confirmationPattern: 'BULLISH_REJECTION', sourceTimeframes: ['15m', '1h', '4h'],
  sourceCandleCloseTime: 1, dataQuality: 'GOOD', volumeConfirmation: true,
  reasons: [], warnings: [], ...overrides,
});

const netEdge = (overrides: Partial<StrategyGmxContextNetEdgeAdvisory> = {}): StrategyGmxContextNetEdgeAdvisory => ({
  schemaVersion: 'strategy-gmx-context-net-edge/v1', advisoryId: 'shadow-1:GMX_CONTEXT_NET_EDGE',
  signalId: 'signal-aggressive-1', symbol: 'BTC', status: 'PASSED', coordinatorGeneration: 7,
  inputNotionalUsd: 20, finalAdvisoryNotionalUsd: 20,
  grossExpectedEdgeBps: 300, grossExpectedEdgeUsd: 0.60,
  roundTripCostBps: 20, roundTripCostUsd: 0.04, immutableCostCapUsd: 0.40,
  costCapExcessUsd: 0, costAdjustedNetEdgeBps: 280, costAdjustedNetEdgeUsd: 0.56,
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
  lifecycleEligible: true, evaluatedAt: NOW,
  researchResult: evaluateStrategyNetEdgeResearch({
    signal: signal(), costEvidence: researchCost(),
    eligibility: { configVersion: 'signal-lifecycle/v1', signalId: 'signal-aggressive-1', eligible: true,
      codes: [], blockedUntilCandleCloseTime: null, strategyConsecutiveLosses: 0, symbolConsecutiveLosses: 0,
      reasons: [], warnings: [] }, evaluatedAt: NOW,
  }),
  riskDecision: { schemaVersion: 'strategy-risk-adapter/v1', decisionId: 'shadow-1:RISK_ADAPTER',
    signalId: 'signal-aggressive-1', symbol: 'BTC', action: 'ALLOW', direction: 'LONG',
    sizeFactor: 1, maxLeverage: 2, riskState: 'NORMAL', reasons: [], warnings: [], authority: 'ADVISORY_ONLY',
    executionAuthorized: false, approvalCreationAllowed: false, paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false } satisfies StrategyRiskAdapterDecision,
});

describe('Aggressive Net-Edge advisory policy', () => {
  it('비용 3배 이상 gross edge와 bounded structural-stop risk를 모두 만족할 때만 후보가 된다', () => {
    const result = evaluateAggressiveNetEdge(input());
    expect(result).toMatchObject({
      schemaVersion: STRATEGY_AGGRESSIVE_NET_EDGE_VERSION,
      status: 'ELIGIBLE', direction: 'LONG', confidence: 85, expectedNetRR: 2.75,
      notionalUsd: 20, structuralStopRiskUsd: 0.4, maxProfileRiskUsd: 5,
      structuralStopRiskPctOfCapital: 0.04, grossEdgeToCostRatio: 15,
      costAdjustedNetEdgeUsd: 0.56, roundTripCostUsd: 0.04, immutableCostCapUsd: 0.4,
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
    expect(result).toMatchObject({ status: 'REJECTED', schemaVersion: 'INVALID' });
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
    expect(result).toMatchObject({ status: 'REJECTED', schemaVersion: 'INVALID' });
  });

  it('immutable $0.40 비용 상한은 공격형 전략도 우회할 수 없다', () => {
    const value = input();
    value.netEdge = netEdge({ roundTripCostUsd: 0.41, grossExpectedEdgeUsd: 1.64, costAdjustedNetEdgeUsd: 1.23 });
    const result = evaluateAggressiveNetEdge(value);
    expect(result).toMatchObject({ status: 'REJECTED', schemaVersion: 'INVALID' });
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
    expect(evaluateAggressiveNetEdge(value)).toMatchObject({
      status: 'NOT_EVALUATED', applicability: 'NOT_APPLICABLE',
    });
  });

  it('Net Edge와 Structural Sizing의 notional이 다르면 INVALID fail-closed다', () => {
    const value = input();
    value.structuralSizing = sizing({ finalAdvisoryNotionalUsd: 19 });
    expect(evaluateAggressiveNetEdge(value)).toMatchObject({ status: 'REJECTED', schemaVersion: 'INVALID', notionalUsd: 0 });
  });

  it('confidence 또는 Net R:R 기준을 낮게 주면 거부한다', () => {
    const lowConfidence = input(); lowConfidence.signal = signal({ confidence: 79 });
    lowConfidence.researchResult = evaluateStrategyNetEdgeResearch({
      signal: lowConfidence.signal, costEvidence: researchCost(),
      eligibility: { configVersion: 'signal-lifecycle/v1', signalId: lowConfidence.signal.signalId,
        eligible: true, codes: [], blockedUntilCandleCloseTime: null, strategyConsecutiveLosses: 0,
        symbolConsecutiveLosses: 0, reasons: [], warnings: [] }, evaluatedAt: NOW,
    });
    expect(evaluateAggressiveNetEdge(lowConfidence)).toMatchObject({
      status: 'REJECTED', schemaVersion: STRATEGY_AGGRESSIVE_NET_EDGE_VERSION,
    });
    const lowRr = input();
    lowRr.signal = signal({ stopDistancePct: 280 / 1.8 / 100, expectedNetRR: 1.8 });
    lowRr.researchResult = evaluateStrategyNetEdgeResearch({
      signal: lowRr.signal, costEvidence: researchCost(),
      eligibility: { configVersion: 'signal-lifecycle/v1', signalId: lowRr.signal.signalId,
        eligible: true, codes: [], blockedUntilCandleCloseTime: null, strategyConsecutiveLosses: 0,
        symbolConsecutiveLosses: 0, reasons: [], warnings: [] }, evaluatedAt: NOW,
    });
    expect(evaluateAggressiveNetEdge(lowRr)).toMatchObject({
      status: 'REJECTED', schemaVersion: STRATEGY_AGGRESSIVE_NET_EDGE_VERSION,
    });
  });

  it('권한 변조와 잘못된 config는 INVALID fail-closed다', () => {
    const unsafe = input();
    unsafe.netEdge = { ...unsafe.netEdge, executionAuthorized: true as never };
    expect(evaluateAggressiveNetEdge(unsafe)).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
    expect(evaluateAggressiveNetEdge(input(), {
      ...DEFAULT_AGGRESSIVE_NET_EDGE_CONFIG, minimumGrossEdgeToCostRatio: 1,
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
  });

  it('valid Research NO_TRADE and final Risk veto cannot be promoted', () => {
    const noTrade = input();
    noTrade.lifecycleEligible = false;
    noTrade.researchResult = evaluateStrategyNetEdgeResearch({
      signal: signal(), costEvidence: researchCost(),
      eligibility: { configVersion: 'signal-lifecycle/v1', signalId: 'signal-aggressive-1', eligible: false,
        codes: ['STOP_LOSS_COOLDOWN'], blockedUntilCandleCloseTime: null, strategyConsecutiveLosses: 0,
        symbolConsecutiveLosses: 0, reasons: [], warnings: [] }, evaluatedAt: NOW,
    });
    expect(evaluateAggressiveNetEdge(noTrade)).toMatchObject({ status: 'REJECTED',
      schemaVersion: STRATEGY_AGGRESSIVE_NET_EDGE_VERSION });
    const veto = input();
    veto.riskDecision = { ...veto.riskDecision, action: 'REJECT', direction: 'NONE', sizeFactor: 0,
      maxLeverage: 0, riskState: 'HARD_STOPPED' };
    expect(evaluateAggressiveNetEdge(veto)).toMatchObject({ status: 'REJECTED',
      schemaVersion: STRATEGY_AGGRESSIVE_NET_EDGE_VERSION });
  });

  it('stale Research and forged HARD_STOP ALLOW are INVALID fail-closed', () => {
    const stale = input();
    stale.evaluatedAt = NOW + 61_000;
    expect(evaluateAggressiveNetEdge(stale)).toMatchObject({ status: 'NOT_EVALUATED', schemaVersion: 'INVALID' });
    const forged = input();
    forged.riskDecision = { ...forged.riskDecision, riskState: 'HARD_STOPPED' };
    expect(evaluateAggressiveNetEdge(forged)).toMatchObject({ status: 'REJECTED', schemaVersion: 'INVALID' });
  });
});
