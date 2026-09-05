import { describe, expect, it } from 'vitest';
import type { StrategyConfidenceRiskReductionAdvisory } from '../intel/strategyConfidenceRiskReductionV2';
import {
  buildStrategyDecisionExplainabilityEnvelope,
  STRATEGY_DECISION_EXPLAINABILITY_VERSION,
  type StrategyDecisionExplainabilityInput,
} from '../intel/strategyDecisionExplainabilityV2';
import type { StrategyGmxContextNetEdgeAdvisory } from '../intel/strategyGmxContextNetEdgeV2';
import type { StrategyAggressiveNetEdgeAdvisory } from '../intel/strategyAggressiveNetEdgeV2';
import type { StrategyRiskAdapterDecision } from '../intel/strategyRiskAdapterV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import type { StrategyStructuralSizingAdvisory } from '../intel/strategyStructuralSizingV2';

const shadow = (): StrategyShadowRecord => ({
  schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: 'BTC:SHADOW:1', mode: 'SHADOW_ONLY',
  symbol: 'BTC', evaluatedAt: 2, sourceCandleCloseTime: 1, regime: 'TREND_UP', action: 'LONG',
  comparison: 'ENSEMBLE_ONLY', strategyId: 'TREND_PULLBACK', signalId: 'signal-1', direction: 'LONG',
  confidence: 75, selectedScore: 80, entryPrice: 100, structuralStop: 98,
  expectedNetEdgeBps: 200, expectedNetRR: 2, lifecycleEligible: true, existingAi: null,
  reasons: [], warnings: [], executionAuthorized: false, paperPositionMutationAllowed: false,
  riskAuthority: 'NOT_EVALUATED',
});
const risk = (action: 'ALLOW' | 'REDUCE' | 'REJECT' = 'ALLOW'): StrategyRiskAdapterDecision => ({
  schemaVersion: 'strategy-risk-adapter/v1', decisionId: 'BTC:SHADOW:1:RISK_ADAPTER',
  signalId: 'signal-1', symbol: 'BTC', action, direction: action === 'REJECT' ? 'NONE' : 'LONG',
  sizeFactor: action === 'REDUCE' ? 0.8 : action === 'ALLOW' ? 1 : 0,
  maxLeverage: action === 'REJECT' ? 0 : 2, riskState: 'NORMAL', reasons: [], warnings: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const sizing = (status: 'SIZED' | 'REJECTED' = 'SIZED'): StrategyStructuralSizingAdvisory => ({
  schemaVersion: 'strategy-structural-sizing/v1', advisoryId: 'BTC:SHADOW:1:STRUCTURAL_SIZING',
  signalId: 'signal-1', symbol: 'BTC', status, direction: status === 'SIZED' ? 'LONG' : 'NONE',
  entryPrice: 100, structuralStop: 98, stopDistanceFraction: status === 'SIZED' ? 0.02 : null,
  riskSizeFactor: status === 'SIZED' ? 1 : 0, allowedLeverage: status === 'SIZED' ? 2 : 0,
  allowedRiskUsd: status === 'SIZED' ? 1 : 0, effectiveStopLossFraction: status === 'SIZED' ? 0.025 : 0,
  maxNotionalBeforeRiskReductionUsd: status === 'SIZED' ? 20 : 0,
  finalAdvisoryNotionalUsd: status === 'SIZED' ? 20 : 0, reasons: [], authority: 'ADVISORY_ONLY',
  executionAuthorized: false, approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false,
});
const confidence = (status: 'UNCHANGED' | 'REDUCED' | 'REJECTED' = 'REDUCED'):
StrategyConfidenceRiskReductionAdvisory => ({
  schemaVersion: 'strategy-confidence-risk-reduction/v1',
  advisoryId: 'BTC:SHADOW:1:CONFIDENCE_RISK_REDUCTION', signalId: 'signal-1', symbol: 'BTC',
  status, confidence: 75, confidenceSizeFactor: status === 'REDUCED' ? 0.875 : status === 'UNCHANGED' ? 1 : 0,
  inputNotionalUsd: status === 'REJECTED' ? 0 : 20,
  finalAdvisoryNotionalUsd: status === 'REDUCED' ? 17.5 : status === 'UNCHANGED' ? 20 : 0,
  allowedLeverage: status === 'REJECTED' ? 0 : 2, reasons: [], authority: 'ADVISORY_ONLY',
  executionAuthorized: false, approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false,
});
const gmx = (status: 'PASSED' | 'REJECTED' | 'NOT_EVALUATED' = 'PASSED'):
StrategyGmxContextNetEdgeAdvisory => ({
  schemaVersion: 'strategy-gmx-context-net-edge/v1', advisoryId: 'BTC:SHADOW:1:GMX_CONTEXT_NET_EDGE',
  signalId: 'signal-1', symbol: 'BTC', status, coordinatorGeneration: 7,
  inputNotionalUsd: 17.5, finalAdvisoryNotionalUsd: status === 'PASSED' ? 17.5 : 0,
  grossExpectedEdgeBps: 300, grossExpectedEdgeUsd: 0.525, roundTripCostBps: 80,
  roundTripCostUsd: 0.14, immutableCostCapUsd: 0.4, costCapExcessUsd: 0,
  costAdjustedNetEdgeBps: 220, costAdjustedNetEdgeUsd: 0.385, reasons: [],
  authority: 'ADVISORY_ONLY', externalReadStarted: false, executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const aggressive = (): StrategyAggressiveNetEdgeAdvisory => ({
  schemaVersion: 'strategy-aggressive-net-edge/v1', advisoryId: 'signal-1:AGGRESSIVE_NET_EDGE',
  signalId: 'signal-1', symbol: 'BTC', status: 'ELIGIBLE', applicability: 'APPLICABLE',
  direction: 'LONG', confidence: 75, expectedNetRR: 2, notionalUsd: 17.5,
  structuralStopRiskUsd: 0.35, maxProfileRiskUsd: 1, structuralStopRiskPctOfCapital: 0.035,
  grossEdgeToCostRatio: 3.75, costAdjustedNetEdgeUsd: 0.385, roundTripCostUsd: 0.14,
  immutableCostCapUsd: 0.4, reasons: [], authority: 'ADVISORY_ONLY', executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const input = (): StrategyDecisionExplainabilityInput => ({
  shadowRecord: shadow(), riskDecision: risk(), sizingAdvisory: sizing(),
  confidenceAdvisory: confidence(), gmxNetEdgeAdvisory: gmx(), aggressiveAdvisory: aggressive(),
});

describe('Strategy decision read-only explainability envelope', () => {
  it('전체 advisory chain을 단일 직렬화 레코드로 결속한다', () => {
    expect(buildStrategyDecisionExplainabilityEnvelope(input())).toMatchObject({
      schemaVersion: STRATEGY_DECISION_EXPLAINABILITY_VERSION, status: 'EVALUATED',
      signalId: 'signal-1', symbol: 'BTC', direction: 'LONG', finalAdvisoryNotionalUsd: 17.5,
      stages: {
        risk: { action: 'ALLOW', sizeFactor: 1 },
        sizing: { status: 'SIZED', finalAdvisoryNotionalUsd: 20 },
        confidence: { status: 'REDUCED', finalAdvisoryNotionalUsd: 17.5 },
        gmxNetEdge: { status: 'PASSED', roundTripCostUsd: 0.14 },
      },
      authority: 'ADVISORY_ONLY', externalReadStarted: false, persistenceAllowed: false,
      executionAuthorized: false, approvalCreationAllowed: false,
      paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
    });
  });

  it('Risk REJECT는 downstream 없이 정상 terminal REJECTED다', () => {
    const value = input(); value.riskDecision = risk('REJECT');
    value.sizingAdvisory = null; value.confidenceAdvisory = null; value.gmxNetEdgeAdvisory = null; value.aggressiveAdvisory = null;
    expect(buildStrategyDecisionExplainabilityEnvelope(value)).toMatchObject({
      status: 'REJECTED', finalAdvisoryNotionalUsd: 0,
    });
  });

  it('중간 stage 결측은 NOT_EVALUATED이며 비용·명목을 추정하지 않는다', () => {
    const value = input(); value.confidenceAdvisory = null; value.gmxNetEdgeAdvisory = null; value.aggressiveAdvisory = null;
    expect(buildStrategyDecisionExplainabilityEnvelope(value)).toMatchObject({
      status: 'NOT_EVALUATED', finalAdvisoryNotionalUsd: 0, stages: { confidence: null, gmxNetEdge: null },
    });
  });

  it('Sizing·Confidence·GMX 거부를 terminal REJECTED로 보존한다', () => {
    const sizeRejected = input(); sizeRejected.sizingAdvisory = sizing('REJECTED'); sizeRejected.aggressiveAdvisory = null;
    sizeRejected.confidenceAdvisory = null; sizeRejected.gmxNetEdgeAdvisory = null;
    expect(buildStrategyDecisionExplainabilityEnvelope(sizeRejected).status).toBe('REJECTED');
    const confidenceRejected = input(); confidenceRejected.confidenceAdvisory = confidence('REJECTED'); confidenceRejected.aggressiveAdvisory = null;
    confidenceRejected.gmxNetEdgeAdvisory = null;
    expect(buildStrategyDecisionExplainabilityEnvelope(confidenceRejected).status).toBe('REJECTED');
    const gmxRejected = input(); gmxRejected.gmxNetEdgeAdvisory = gmx('REJECTED'); gmxRejected.aggressiveAdvisory = null;
    expect(buildStrategyDecisionExplainabilityEnvelope(gmxRejected).status).toBe('REJECTED');
  });

  it('upstream REJECT 이후 downstream이 존재하면 INVALID로 차단한다', () => {
    const value = input(); value.riskDecision = risk('REJECT');
    expect(buildStrategyDecisionExplainabilityEnvelope(value)).toMatchObject({
      schemaVersion: 'INVALID', status: 'BLOCKED',
    });
  });

  it('identity·권한 변조와 단계별 위험 확대를 INVALID로 차단한다', () => {
    const identity = input(); identity.gmxNetEdgeAdvisory = { ...gmx(), signalId: 'other' };
    expect(buildStrategyDecisionExplainabilityEnvelope(identity).schemaVersion).toBe('INVALID');
    const unsafe = input(); unsafe.sizingAdvisory = { ...sizing(), executionAuthorized: true as never };
    expect(buildStrategyDecisionExplainabilityEnvelope(unsafe).schemaVersion).toBe('INVALID');
    const enlarged = input(); enlarged.confidenceAdvisory = {
      ...confidence('UNCHANGED'), finalAdvisoryNotionalUsd: 21,
    };
    enlarged.gmxNetEdgeAdvisory = null;
    expect(buildStrategyDecisionExplainabilityEnvelope(enlarged).schemaVersion).toBe('INVALID');
  });

  it('입력을 변경하지 않고 동일 결과를 생성한다', () => {
    const value = input(); const before = JSON.stringify(value);
    expect(buildStrategyDecisionExplainabilityEnvelope(value))
      .toEqual(buildStrategyDecisionExplainabilityEnvelope(value));
    expect(JSON.stringify(value)).toBe(before);
  });

  it('forged aggressive identity/economics/authority를 모두 INVALID/BLOCKED 처리한다', () => {
    for (const forged of [
      { advisoryId: 'forged' },
      { costAdjustedNetEdgeUsd: 0.384 },
      { roundTripCostUsd: 0.13 },
      { immutableCostCapUsd: 0.5 },
      { notionalUsd: 17.4 },
      { executionAuthorized: true as never },
    ]) {
      const value = input();
      value.aggressiveAdvisory = { ...aggressive(), ...forged };
      expect(buildStrategyDecisionExplainabilityEnvelope(value)).toMatchObject({
        schemaVersion: 'INVALID', status: 'BLOCKED',
      });
    }
  });

  it('production Worker 외 직접 입력도 upstream terminal 뒤 aggressive 배치를 차단한다', () => {
    const value = input();
    value.riskDecision = risk('REJECT');
    expect(buildStrategyDecisionExplainabilityEnvelope(value)).toMatchObject({
      schemaVersion: 'INVALID', status: 'BLOCKED',
    });
  });
});
