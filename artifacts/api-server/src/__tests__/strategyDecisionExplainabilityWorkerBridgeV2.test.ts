import { describe, expect, it } from 'vitest';
import {
  buildStrategyDecisionExplainabilityWorkerAdvisory,
  buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream,
  STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION,
} from '../intel/strategyDecisionExplainabilityWorkerBridgeV2';
import {
  buildStrategyDecisionExplainabilityRuntimeAdvisory,
  STRATEGY_DECISION_EXPLAINABILITY_RUNTIME_VERSION,
} from '../intel/strategyDecisionExplainabilityRuntimeV2';
import type { StrategyConfidenceRiskReductionAdvisory } from '../intel/strategyConfidenceRiskReductionV2';
import type { StrategyGmxContextNetEdgeAdvisory } from '../intel/strategyGmxContextNetEdgeV2';
import type { StrategyAggressiveNetEdgeAdvisory } from '../intel/strategyAggressiveNetEdgeV2';
import type { StrategyAggressiveNetEdgeInput } from '../intel/strategyAggressiveNetEdgeV2';
import type { StrategySignal } from '../intel/strategySignalV2';
import {
  evaluateStrategyNetEdgeResearch, STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
  type StrategyNetEdgeCostEvidence,
} from '../intel/strategyNetEdgeResearchGateV1';
import type { StrategyRiskWorkerAdvisory } from '../intel/strategyRiskWorkerBridgeV2';
import type { StrategyRiskAdapterDecision } from '../intel/strategyRiskAdapterV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import type { StrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import type { StrategyStructuralSizingAdvisory } from '../intel/strategyStructuralSizingV2';
import type { StrategyStructuralSizingReadinessBinding } from '../intel/strategyStructuralSizingReadinessBindingV2';
import type { StrategyStructuralSizingWorkerAdvisory } from '../intel/strategyStructuralSizingWorkerBridgeV2';

const researchSignal = (symbol = 'BTC'): StrategySignal => ({
  schemaVersion: 'strategy-signal/v2', signalId: `${symbol}-signal`, strategyId: 'TREND_PULLBACK',
  symbol, regime: 'TREND_UP', direction: 'LONG', confidence: 85, entryZoneLow: 99,
  entryZoneHigh: 101, proposedEntryPrice: 100, structuralStop: 99, stopDistancePct: 1,
  invalidationPrice: 99, targets: [{ price: 103, expectedR: 2.2, allocationPct: 100 }],
  grossExpectedEdgeBps: 300, expectedCostsBps: 80, netExpectedEdgeBps: 220, expectedNetRR: 2.2,
  higherTimeframeTrend: 'UP', marketStructure: 'HH_HL', confirmationPattern: 'BULLISH_REJECTION',
  sourceTimeframes: ['4h', '1h', '15m'], sourceCandleCloseTime: 1, dataQuality: 'GOOD',
  volumeConfirmation: true, reasons: [], warnings: [],
});
const researchCost = (): StrategyNetEdgeCostEvidence => {
  const component = (usd: number) => ({ usd, bps: usd / 17.5 * 10_000 });
  const quote = (direction: 'LONG' | 'SHORT') => ({
    direction, market: '0x1111111111111111111111111111111111111111', orderType: 'MarketIncrease' as const,
    notionalUsd: 17.5, holdingHorizonHours: 12, source: 'PAPER_GMX_ESTIMATE' as const,
    blockNumber: null, observedAtMs: 1, fetchedAtMs: 1, expiresAtMs: 60_001,
    fundingRatePerHourFraction: 0.01 / 17.5 / 12,
    borrowingRatePerHourFraction: 0.01 / 17.5 / 12,
    positionFee: component(0.04), exitFee: component(0.04), funding: component(0.01),
    borrowing: component(0.01), priceImpact: component(0.03), network: component(0.01),
    totalRoundTripCost: { usd: 0.14, bps: 80 },
  });
  return { schemaVersion: STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
    market: '0x1111111111111111111111111111111111111111', notionalUsd: 17.5,
    holdingHorizonHours: 12, observedAtMs: 1, bidirectionalValidated: true,
    holdingCostsDerivedFromRates: true, holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT',
    conservativeBasisDirection: 'LONG', directionalQuotes: { LONG: quote('LONG'), SHORT: quote('SHORT') } };
};

const record = (symbol = 'BTC'): StrategyShadowRecord => ({
  schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: `${symbol}:SHADOW:1`,
  mode: 'SHADOW_ONLY', symbol, evaluatedAt: 2, sourceCandleCloseTime: 1,
  regime: 'TREND_UP', action: 'LONG', comparison: 'ENSEMBLE_ONLY',
  strategyId: 'TREND_PULLBACK', signalId: `${symbol}-signal`, direction: 'LONG',
  confidence: 85, selectedScore: 80, entryPrice: 100, structuralStop: 99,
  expectedNetEdgeBps: 220, expectedNetRR: 2.2, lifecycleEligible: true,
  existingAi: null, reasons: [], warnings: [], executionAuthorized: false,
  netEdgeResearch: evaluateStrategyNetEdgeResearch({ signal: researchSignal(symbol),
    costEvidence: researchCost(), eligibility: { configVersion: 'signal-lifecycle/v1',
      signalId: `${symbol}-signal`, eligible: true, codes: [], blockedUntilCandleCloseTime: null,
      strategyConsecutiveLosses: 0, symbolConsecutiveLosses: 0, reasons: [], warnings: [] }, evaluatedAt: 2 }),
  paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED',
});
const decision = (value: StrategyShadowRecord, action: 'ALLOW' | 'REJECT'):
StrategyRiskAdapterDecision => ({
  schemaVersion: 'strategy-risk-adapter/v1',
  decisionId: `${value.shadowRecordId}:RISK_ADAPTER`, signalId: value.signalId,
  symbol: value.symbol, action, direction: action === 'REJECT' ? 'NONE' : value.direction,
  sizeFactor: action === 'REJECT' ? 0 : 1, maxLeverage: action === 'REJECT' ? 0 : 2,
  riskState: action === 'REJECT' ? 'HARD_STOPPED' : 'NORMAL', reasons: [], warnings: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const shadow = (records = [record()]): StrategyShadowWorkerEnvelope => ({
  schemaVersion: 'strategy-shadow-worker-envelope/v1', envelopeId: 'cycle:1:SHADOW',
  status: 'EVALUATED', mode: 'SHADOW_ONLY', cycleNumber: 1, generatedAt: 2,
  expectedSymbols: records.map(value => value.symbol),
  evaluatedSymbols: records.map(value => value.symbol), missingSymbols: [], records,
  summary: {
    long: records.length, short: 0, noTrade: 0, rejected: 0, disabled: 0,
    directionConflicts: 0,
  },
  reasons: [], warnings: [], existingAi: {
    decisionId: 'decision-1', action: 'NO_TRADE', confidence: 0,
    primarySymbol: null, createdAt: new Date(2).toISOString(),
  },
  lifecycleSnapshot: null, riskAuthority: 'NOT_EVALUATED',
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const risk = (envelope: StrategyShadowWorkerEnvelope, actions: ('ALLOW' | 'REJECT')[] = ['ALLOW']):
StrategyRiskWorkerAdvisory => ({
  schemaVersion: 'strategy-risk-worker-bridge/v1',
  advisoryId: `${envelope.envelopeId}:RISK_ADVISORY`, status: 'EVALUATED', cycleNumber: 1,
  riskState: actions.every(value => value === 'REJECT') ? 'HARD_STOPPED' : 'NORMAL',
  decisions: envelope.records.map((value, index) => decision(value, actions[index] ?? 'ALLOW')),
  summary: {
    allow: actions.filter(value => value === 'ALLOW').length, reduce: 0,
    reject: actions.filter(value => value === 'REJECT').length,
  },
  reasons: [], authority: 'ADVISORY_ONLY', executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false,
});

const sizingValue = (value: StrategyShadowRecord, action: 'ALLOW' | 'REJECT' = 'ALLOW'):
StrategyStructuralSizingAdvisory => ({
  schemaVersion: 'strategy-structural-sizing/v1',
  advisoryId: `${value.shadowRecordId}:STRUCTURAL_SIZING`, signalId: value.signalId,
  symbol: value.symbol, status: action === 'ALLOW' ? 'SIZED' : 'REJECTED',
  direction: action === 'ALLOW' ? value.direction : 'NONE', entryPrice: value.entryPrice,
  structuralStop: value.structuralStop, stopDistanceFraction: action === 'ALLOW' ? 0.02 : null,
  riskSizeFactor: action === 'ALLOW' ? 1 : 0, allowedLeverage: action === 'ALLOW' ? 2 : 0,
  allowedRiskUsd: action === 'ALLOW' ? 1 : 0,
  effectiveStopLossFraction: action === 'ALLOW' ? 0.025 : 0,
  maxNotionalBeforeRiskReductionUsd: action === 'ALLOW' ? 17.5 : 0,
  finalAdvisoryNotionalUsd: action === 'ALLOW' ? 17.5 : 0, reasons: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const workerSizing = (envelope: StrategyShadowWorkerEnvelope,
  actions: ('ALLOW' | 'REJECT')[] = ['ALLOW']): StrategyStructuralSizingWorkerAdvisory => ({
  schemaVersion: 'strategy-structural-sizing-worker/v1',
  advisoryId: `${envelope.envelopeId}:STRUCTURAL_SIZING_ADVISORY`, cycleNumber: envelope.cycleNumber,
  status: 'EVALUATED',
  sizings: envelope.records.map((value, index) => sizingValue(value, actions[index] ?? 'ALLOW')),
  summary: {
    sized: actions.filter(value => value === 'ALLOW').length,
    rejected: actions.filter(value => value === 'REJECT').length, notEvaluated: 0,
  },
  reasons: [], authority: 'ADVISORY_ONLY', externalReadStarted: false,
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const readiness = (symbols: string[], generation = 7): StrategyStructuralSizingReadinessBinding => ({
  schemaVersion: 'strategy-structural-sizing-readiness-binding/v1', status: 'BOUND',
  coordinatorGeneration: generation,
  marketContextBySymbol: Object.fromEntries(symbols.map(symbol => [symbol, {
    source: 'VERIFIED_READ_ONLY', evidenceId: `${symbol}:${generation}`, symbol,
    observedAt: 1, fresh: true, roundTripFeesFraction: 0.001,
    adverseImpactBufferFraction: 0.001, fundingBorrowingBufferFraction: 0.001,
    liquidityCapUsd: 100, tierNotionalCapUsd: 100,
  }])),
  summary: { expected: symbols.length, bound: symbols.length, missingOrStale: 0 },
  reasons: [], authority: 'ADVISORY_ONLY', externalReadStarted: false,
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const confidence = (value: StrategyShadowRecord): StrategyConfidenceRiskReductionAdvisory => ({
  schemaVersion: 'strategy-confidence-risk-reduction/v1',
  advisoryId: `${value.shadowRecordId}:CONFIDENCE_RISK_REDUCTION`, signalId: value.signalId,
  symbol: value.symbol, status: 'REDUCED', confidence: 75, confidenceSizeFactor: 0.875,
  inputNotionalUsd: 20, finalAdvisoryNotionalUsd: 17.5, allowedLeverage: 2, reasons: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const gmx = (value: StrategyShadowRecord, generation = 7,
  status: 'PASSED' | 'REJECTED' = 'PASSED'): StrategyGmxContextNetEdgeAdvisory => ({
  schemaVersion: 'strategy-gmx-context-net-edge/v1',
  advisoryId: `${value.shadowRecordId}:GMX_CONTEXT_NET_EDGE`, signalId: value.signalId,
  symbol: value.symbol, status, coordinatorGeneration: generation,
  inputNotionalUsd: 17.5, finalAdvisoryNotionalUsd: status === 'PASSED' ? 17.5 : 0,
  grossExpectedEdgeBps: 300, grossExpectedEdgeUsd: 0.525, roundTripCostBps: 80,
  roundTripCostUsd: status === 'PASSED' ? 0.14 : 0.5, immutableCostCapUsd: 0.4,
  costCapExcessUsd: status === 'PASSED' ? 0 : 0.1, costAdjustedNetEdgeBps: 220,
  costAdjustedNetEdgeUsd: 0.385, reasons: [], authority: 'ADVISORY_ONLY',
  externalReadStarted: false, executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const aggressive = (value: StrategyShadowRecord): StrategyAggressiveNetEdgeAdvisory => ({
  schemaVersion: 'strategy-aggressive-net-edge/v1', advisoryId: `${value.signalId}:AGGRESSIVE_NET_EDGE`,
  signalId: value.signalId, symbol: value.symbol, status: 'ELIGIBLE', applicability: 'APPLICABLE',
  direction: value.direction, confidence: value.confidence, expectedNetRR: value.expectedNetRR,
  notionalUsd: 17.5, structuralStopRiskUsd: 0.35, maxProfileRiskUsd: 1,
  structuralStopRiskPctOfCapital: 0.035, grossEdgeToCostRatio: 3.75,
  costAdjustedNetEdgeUsd: 0.385, roundTripCostUsd: 0.14, immutableCostCapUsd: 0.4,
  reasons: [], authority: 'ADVISORY_ONLY', executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const aggressiveInput = (
  value: StrategyShadowRecord,
  riskDecision: StrategyRiskAdapterDecision,
  sizingAdvisory: StrategyStructuralSizingAdvisory,
  gmxAdvisory: StrategyGmxContextNetEdgeAdvisory,
  profileName: 'aggressive' | 'conservative' = 'aggressive',
): StrategyAggressiveNetEdgeInput => ({
  signal: researchSignal(value.symbol), riskDecision, structuralSizing: sizingAdvisory,
  netEdge: gmxAdvisory, researchResult: value.netEdgeResearch!, evaluatedAt: value.evaluatedAt,
  lifecycleEligible: value.lifecycleEligible!,
  riskProfile: { name: profileName, version: 'risk-profile/v1', appliedAt: '2026-09-05T00:00:00.000Z',
    derivedLimits: { immediateEntryThreshold: 80,
      maxRiskPerTradePct: profileName === 'conservative' ? 0.25 : 0.5, reserveCashPct: 20,
      maxMarginPerTradeUsd: 334, maxConcurrentPositions: 1, cooldownMinutes: 30, maxLeverage: 3,
      maxTotalExposureUsd: 3000, allocatedTradingCapitalUsd: 1000,
      maxRiskPerTradeUsd: profileName === 'conservative' ? 2.5 : 5 } },
});

describe('Strategy decision explainability aiWorker bridge', () => {
  it('ALLOW는 downstream을 추정하지 않고 NOT_EVALUATED로 직렬화한다', () => {
    const s = shadow();
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: risk(s) }))
      .toMatchObject({
        schemaVersion: STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION,
        status: 'NOT_EVALUATED', summary: { notEvaluated: 1 },
        envelopes: [{ status: 'NOT_EVALUATED', stages: { sizing: null, confidence: null, gmxNetEdge: null } }],
        authority: 'ADVISORY_ONLY', externalReadStarted: false,
        independentPersistenceAllowed: false, executionAuthorized: false,
      });
  });

  it('HARD_STOP Risk REJECT를 terminal EVALUATED aggregate로 보존한다', () => {
    const s = shadow();
    const result = buildStrategyDecisionExplainabilityWorkerAdvisory({
      shadowEnvelope: s, riskAdvisory: risk(s, ['REJECT']),
    });
    expect(result).toMatchObject({ status: 'EVALUATED', summary: { rejected: 1 } });
    expect(result.envelopes[0]).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
  });

  it('terminal과 미평가가 섞이면 PARTIAL을 유지한다', () => {
    const s = shadow([record('BTC'), record('ETH')]);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({
      shadowEnvelope: s, riskAdvisory: risk(s, ['REJECT', 'ALLOW']),
    })).toMatchObject({ status: 'PARTIAL', summary: { rejected: 1, notEvaluated: 1 } });
  });

  it('SHADOW 또는 Risk 미평가는 빈 NOT_EVALUATED이며 downstream을 시작하지 않는다', () => {
    const s = shadow(); const r = risk(s); r.status = 'NOT_EVALUATED';
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: r }))
      .toMatchObject({ status: 'NOT_EVALUATED', envelopes: [], externalReadStarted: false });
  });

  it('cycle·identity·권한 불일치를 INVALID/BLOCKED로 fail-closed 처리한다', () => {
    const s = shadow(); const wrongCycle = risk(s); wrongCycle.cycleNumber = 2;
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: wrongCycle }))
      .toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
    const wrongIdentity = risk(s); wrongIdentity.decisions[0] = {
      ...wrongIdentity.decisions[0], signalId: 'other',
    };
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: wrongIdentity }))
      .toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
    const unsafe = risk(s); unsafe.executionAuthorized = true as never;
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: unsafe }))
      .toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
  });

  it('입력을 변경하지 않고 동일한 결과를 생성한다', () => {
    const s = shadow(); const r = risk(s); const before = JSON.stringify({ s, r });
    expect(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: r }))
      .toEqual(buildStrategyDecisionExplainabilityWorkerAdvisory({ shadowEnvelope: s, riskAdvisory: r }));
    expect(JSON.stringify({ s, r })).toBe(before);
  });
});

describe('Strategy decision explainability same-generation downstream bridge', () => {
  it('동일 readiness generation의 전체 downstream chain을 결속한다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s);
    const gm = gmx(s.records[0]);
    gm.grossExpectedEdgeUsd = s.records[0].netEdgeResearch!.expectedGrossEdge!.usd;
    gm.grossExpectedEdgeBps = s.records[0].netEdgeResearch!.expectedGrossEdge!.bps;
    gm.roundTripCostUsd = s.records[0].netEdgeResearch!.expectedRoundTripCost!.usd;
    gm.roundTripCostBps = s.records[0].netEdgeResearch!.expectedRoundTripCost!.bps;
    gm.costAdjustedNetEdgeUsd = s.records[0].netEdgeResearch!.expectedNetEdge!.usd
      + s.records[0].netEdgeResearch!.turnoverPenalty!.usd;
    gm.costAdjustedNetEdgeBps = s.records[0].netEdgeResearch!.expectedNetEdge!.bps
      + s.records[0].netEdgeResearch!.turnoverPenalty!.bps;
    const result = buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z,
      readinessBinding: readiness(s.expectedSymbols),
      confidenceAdvisories: [confidence(s.records[0])],
      gmxNetEdgeAdvisories: [gm],
      aggressiveInputs: [aggressiveInput(s.records[0], r.decisions[0], z.sizings[0], gm)],
    });
    expect(result).toMatchObject({
      schemaVersion: STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION,
      status: 'EVALUATED', summary: { evaluated: 1 }, externalReadStarted: false,
      independentPersistenceAllowed: false, executionAuthorized: false,
      envelopes: [{ status: 'EVALUATED', finalAdvisoryNotionalUsd: 17.5,
        stages: { gmxNetEdge: { coordinatorGeneration: 7 },
          aggressive: { status: 'ELIGIBLE', applicability: 'APPLICABLE' } } }],
    });
  });

  it('GMX 비용 상한 거부를 terminal REJECTED로 보존한다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z,
      readinessBinding: readiness(s.expectedSymbols),
      confidenceAdvisories: [confidence(s.records[0])],
      gmxNetEdgeAdvisories: [gmx(s.records[0], 7, 'REJECTED')], aggressiveInputs: [null],
    })).toMatchObject({ status: 'EVALUATED', summary: { rejected: 1 },
      envelopes: [{ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 }] });
  });

  it('결측 downstream은 null NOT_EVALUATED이며 새 read를 시작하지 않는다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z,
      readinessBinding: readiness(s.expectedSymbols), confidenceAdvisories: [null],
      gmxNetEdgeAdvisories: [null], aggressiveInputs: [null],
    })).toMatchObject({ status: 'NOT_EVALUATED', externalReadStarted: false,
      envelopes: [{ status: 'NOT_EVALUATED', stages: { confidence: null, gmxNetEdge: null } }] });
  });

  it('mixed generation과 terminal 이후 stage를 INVALID/BLOCKED 처리한다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z,
      readinessBinding: readiness(s.expectedSymbols, 7),
      confidenceAdvisories: [confidence(s.records[0])],
      gmxNetEdgeAdvisories: [gmx(s.records[0], 8)], aggressiveInputs: [null],
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });

    const rejectedRisk = risk(s, ['REJECT']); const rejectedSizing = workerSizing(s, ['REJECT']);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: rejectedRisk, sizingAdvisory: rejectedSizing,
      readinessBinding: readiness(s.expectedSymbols),
      confidenceAdvisories: [confidence(s.records[0])], gmxNetEdgeAdvisories: [null], aggressiveInputs: [null],
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
  });

  it('개수·권한 변조를 전체 차단하고 입력을 변경하지 않는다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s);
    const b = readiness(s.expectedSymbols);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z, readinessBinding: b,
      confidenceAdvisories: [], gmxNetEdgeAdvisories: [], aggressiveInputs: [],
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED' });
    const unsafe = { ...b, executionAuthorized: true as never };
    const input = { shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z,
      readinessBinding: unsafe, confidenceAdvisories: [confidence(s.records[0])],
      gmxNetEdgeAdvisories: [gmx(s.records[0])], aggressiveInputs: [null] };
    const before = JSON.stringify(input);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream(input))
      .toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED' });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('canonical input reference/economics tamper와 terminal 이후 input을 전체 차단한다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s); const gm = gmx(s.records[0]);
    const canonical = aggressiveInput(s.records[0], r.decisions[0], z.sizings[0], gm);
    for (const tampered of [
      { ...canonical, riskDecision: { ...r.decisions[0] } },
      { ...canonical, structuralSizing: { ...z.sizings[0] } },
      { ...canonical, netEdge: { ...gm } },
      { ...canonical, researchResult: { ...s.records[0].netEdgeResearch! } },
      { ...canonical, signal: { ...canonical.signal, confidence: 84 } },
    ]) {
      expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
        shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z,
        readinessBinding: readiness(s.expectedSymbols), confidenceAdvisories: [confidence(s.records[0])],
        gmxNetEdgeAdvisories: [gm], aggressiveInputs: [tampered],
      })).toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
    }
    const rejectedRisk = risk(s, ['REJECT']); const rejectedSizing = workerSizing(s, ['REJECT']);
    expect(buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: rejectedRisk, sizingAdvisory: rejectedSizing,
      readinessBinding: readiness(s.expectedSymbols), confidenceAdvisories: [null],
      gmxNetEdgeAdvisories: [null], aggressiveInputs: [canonical],
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED' });
  });

  it('internally evaluated conservative input은 NOT_APPLICABLE이며 base chain은 EVALUATED다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s); const gm = gmx(s.records[0]);
    const research = s.records[0].netEdgeResearch!;
    gm.grossExpectedEdgeUsd = research.expectedGrossEdge!.usd;
    gm.grossExpectedEdgeBps = research.expectedGrossEdge!.bps;
    gm.roundTripCostUsd = research.expectedRoundTripCost!.usd;
    gm.roundTripCostBps = research.expectedRoundTripCost!.bps;
    gm.costAdjustedNetEdgeUsd = research.expectedNetEdge!.usd + research.turnoverPenalty!.usd;
    gm.costAdjustedNetEdgeBps = research.expectedNetEdge!.bps + research.turnoverPenalty!.bps;
    const result = buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
      shadowEnvelope: s, riskAdvisory: r, sizingAdvisory: z,
      readinessBinding: readiness(s.expectedSymbols), confidenceAdvisories: [confidence(s.records[0])],
      gmxNetEdgeAdvisories: [gm],
      aggressiveInputs: [aggressiveInput(s.records[0], r.decisions[0], z.sizings[0], gm, 'conservative')],
    });
    expect(result).toMatchObject({ status: 'EVALUATED', summary: { evaluated: 1 },
      envelopes: [{ status: 'EVALUATED', stages: { aggressive: {
        status: 'NOT_EVALUATED', applicability: 'NOT_APPLICABLE',
      } } }], executionAuthorized: false, approvalCreationAllowed: false,
      paperPositionMutationAllowed: false, livePositionMutationAllowed: false });
  });
});

describe('Strategy decision explainability DB-free runtime selector', () => {
  it('runtime 계약 버전과 downstream 결측의 기존 NOT_EVALUATED 투영을 고정한다', () => {
    expect(STRATEGY_DECISION_EXPLAINABILITY_RUNTIME_VERSION)
      .toBe('strategy-decision-explainability-runtime/v1');
    const s = shadow();
    const result = buildStrategyDecisionExplainabilityRuntimeAdvisory({
      shadowEnvelope: s,
      riskAdvisory: risk(s),
      downstreamEvidence: null,
    });
    expect(result).toMatchObject({
      status: 'NOT_EVALUATED',
      externalReadStarted: false,
      independentPersistenceAllowed: false,
      executionAuthorized: false,
      envelopes: [{ stages: { sizing: null, confidence: null, gmxNetEdge: null } }],
    });
  });

  it('이미 계산된 동일-generation bundle만 downstream bridge에 전달한다', () => {
    const s = shadow(); const r = risk(s); const z = workerSizing(s); const gm = gmx(s.records[0]);
    gm.grossExpectedEdgeUsd = s.records[0].netEdgeResearch!.expectedGrossEdge!.usd;
    gm.grossExpectedEdgeBps = s.records[0].netEdgeResearch!.expectedGrossEdge!.bps;
    gm.roundTripCostUsd = s.records[0].netEdgeResearch!.expectedRoundTripCost!.usd;
    gm.roundTripCostBps = s.records[0].netEdgeResearch!.expectedRoundTripCost!.bps;
    gm.costAdjustedNetEdgeUsd = s.records[0].netEdgeResearch!.expectedNetEdge!.usd
      + s.records[0].netEdgeResearch!.turnoverPenalty!.usd;
    gm.costAdjustedNetEdgeBps = s.records[0].netEdgeResearch!.expectedNetEdge!.bps
      + s.records[0].netEdgeResearch!.turnoverPenalty!.bps;
    const result = buildStrategyDecisionExplainabilityRuntimeAdvisory({
      shadowEnvelope: s,
      riskAdvisory: r,
      downstreamEvidence: {
        sizingAdvisory: z,
        readinessBinding: readiness(s.expectedSymbols),
        confidenceAdvisories: [confidence(s.records[0])],
        gmxNetEdgeAdvisories: [gm],
        aggressiveInputs: [aggressiveInput(s.records[0], r.decisions[0], z.sizings[0], gm)],
      },
    });
    expect(result).toMatchObject({
      status: 'EVALUATED',
      summary: { evaluated: 1 },
      externalReadStarted: false,
      independentPersistenceAllowed: false,
      executionAuthorized: false,
      envelopes: [{ finalAdvisoryNotionalUsd: 17.5 }],
    });
  });

  it('runtime 경계에서도 mixed generation을 INVALID/BLOCKED로 보존한다', () => {
    const s = shadow();
    expect(buildStrategyDecisionExplainabilityRuntimeAdvisory({
      shadowEnvelope: s,
      riskAdvisory: risk(s),
      downstreamEvidence: {
        sizingAdvisory: workerSizing(s),
        readinessBinding: readiness(s.expectedSymbols, 7),
        confidenceAdvisories: [confidence(s.records[0])],
        gmxNetEdgeAdvisories: [gmx(s.records[0], 8)], aggressiveInputs: [null],
      },
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', envelopes: [] });
  });
});
