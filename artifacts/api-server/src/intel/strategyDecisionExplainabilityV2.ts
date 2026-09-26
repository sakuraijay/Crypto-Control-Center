/**
 * Pure explainability envelope for the Strategy v2 advisory chain.
 *
 * This module only serializes already-computed SHADOW, Risk, Structural sizing,
 * confidence and GMX Net Edge evidence. It performs no read, persistence or
 * execution and grants no PAPER/LIVE authority.
 */
import type { StrategyConfidenceRiskReductionAdvisory } from './strategyConfidenceRiskReductionV2';
import type { StrategyGmxContextNetEdgeAdvisory } from './strategyGmxContextNetEdgeV2';
import type { StrategyAggressiveNetEdgeAdvisory } from './strategyAggressiveNetEdgeV2';
import type { StrategyRiskAdapterDecision } from './strategyRiskAdapterV2';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';
import type { StrategyStructuralSizingAdvisory } from './strategyStructuralSizingV2';

export const STRATEGY_DECISION_EXPLAINABILITY_VERSION =
  'strategy-decision-explainability/v1' as const;

export interface StrategyDecisionExplainabilityInput {
  shadowRecord: StrategyShadowRecord;
  riskDecision: StrategyRiskAdapterDecision;
  sizingAdvisory: StrategyStructuralSizingAdvisory | null;
  confidenceAdvisory: StrategyConfidenceRiskReductionAdvisory | null;
  gmxNetEdgeAdvisory: StrategyGmxContextNetEdgeAdvisory | null;
  aggressiveAdvisory?: StrategyAggressiveNetEdgeAdvisory | null;
}

export interface StrategyDecisionExplainabilityEnvelope {
  schemaVersion: typeof STRATEGY_DECISION_EXPLAINABILITY_VERSION | 'INVALID';
  envelopeId: string;
  signalId: string | null;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NONE';
  status: 'EVALUATED' | 'REJECTED' | 'NOT_EVALUATED' | 'BLOCKED';
  stages: {
    shadow: {
      action: StrategyShadowRecord['action'];
      confidence: number | null;
      expectedNetEdgeBps: number | null;
    };
    risk: {
      action: StrategyRiskAdapterDecision['action'];
      state: StrategyRiskAdapterDecision['riskState'];
      sizeFactor: number;
      maxLeverage: number;
    };
    sizing: null | {
      status: StrategyStructuralSizingAdvisory['status'];
      stopDistanceFraction: number | null;
      allowedRiskUsd: number;
      finalAdvisoryNotionalUsd: number;
    };
    confidence: null | {
      status: StrategyConfidenceRiskReductionAdvisory['status'];
      sizeFactor: number;
      finalAdvisoryNotionalUsd: number;
    };
    gmxNetEdge: null | {
      status: StrategyGmxContextNetEdgeAdvisory['status'];
      coordinatorGeneration: number | null;
      roundTripCostUsd: number | null;
      immutableCostCapUsd: number;
      costCapExcessUsd: number | null;
      costAdjustedNetEdgeBps: number | null;
      costAdjustedNetEdgeUsd: number | null;
      finalAdvisoryNotionalUsd: number;
    };
    aggressive: null | {
      status: StrategyAggressiveNetEdgeAdvisory['status'];
      applicability: StrategyAggressiveNetEdgeAdvisory['applicability'];
      notionalUsd: number;
    };
  };
  finalAdvisoryNotionalUsd: number;
  terminalReason: string;
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  externalReadStarted: false;
  persistenceAllowed: false;
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const symbol = (value: string): string => value.trim().toUpperCase();

function output(
  input: StrategyDecisionExplainabilityInput,
  status: StrategyDecisionExplainabilityEnvelope['status'],
  version: StrategyDecisionExplainabilityEnvelope['schemaVersion'],
  finalAdvisoryNotionalUsd: number,
  terminalReason: string,
  reasons: string[],
): StrategyDecisionExplainabilityEnvelope {
  const { shadowRecord: shadow, riskDecision: risk, sizingAdvisory: sizing,
    confidenceAdvisory: confidence, gmxNetEdgeAdvisory: gmx,
    aggressiveAdvisory: aggressive = null } = input;
  return {
    schemaVersion: version,
    envelopeId: `${shadow.shadowRecordId}:DECISION_EXPLAINABILITY`,
    signalId: shadow.signalId,
    symbol: symbol(shadow.symbol),
    direction: shadow.direction,
    status,
    stages: {
      shadow: {
        action: shadow.action,
        confidence: finite(shadow.confidence) ? shadow.confidence : null,
        expectedNetEdgeBps: finite(shadow.expectedNetEdgeBps) ? shadow.expectedNetEdgeBps : null,
      },
      risk: {
        action: risk.action,
        state: risk.riskState,
        sizeFactor: finite(risk.sizeFactor) ? risk.sizeFactor : 0,
        maxLeverage: finite(risk.maxLeverage) ? risk.maxLeverage : 0,
      },
      sizing: sizing === null ? null : {
        status: sizing.status,
        stopDistanceFraction: finite(sizing.stopDistanceFraction) ? sizing.stopDistanceFraction : null,
        allowedRiskUsd: finite(sizing.allowedRiskUsd) ? sizing.allowedRiskUsd : 0,
        finalAdvisoryNotionalUsd: finite(sizing.finalAdvisoryNotionalUsd)
          ? sizing.finalAdvisoryNotionalUsd : 0,
      },
      confidence: confidence === null ? null : {
        status: confidence.status,
        sizeFactor: finite(confidence.confidenceSizeFactor) ? confidence.confidenceSizeFactor : 0,
        finalAdvisoryNotionalUsd: finite(confidence.finalAdvisoryNotionalUsd)
          ? confidence.finalAdvisoryNotionalUsd : 0,
      },
      gmxNetEdge: gmx === null ? null : {
        status: gmx.status,
        coordinatorGeneration: gmx.coordinatorGeneration,
        roundTripCostUsd: gmx.roundTripCostUsd,
        immutableCostCapUsd: gmx.immutableCostCapUsd,
        costCapExcessUsd: gmx.costCapExcessUsd,
        costAdjustedNetEdgeBps: gmx.costAdjustedNetEdgeBps,
        costAdjustedNetEdgeUsd: gmx.costAdjustedNetEdgeUsd,
        finalAdvisoryNotionalUsd: finite(gmx.finalAdvisoryNotionalUsd)
          ? gmx.finalAdvisoryNotionalUsd : 0,
      },
      aggressive: aggressive === null ? null : {
        status: aggressive.status,
        applicability: aggressive.applicability,
        notionalUsd: finite(aggressive.notionalUsd) ? aggressive.notionalUsd : 0,
      },
    },
    finalAdvisoryNotionalUsd,
    terminalReason,
    reasons,
    authority: 'ADVISORY_ONLY',
    externalReadStarted: false,
    persistenceAllowed: false,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function riskBoundaryValid(risk: StrategyRiskAdapterDecision): boolean {
  return risk.schemaVersion === 'strategy-risk-adapter/v1'
    && risk.authority === 'ADVISORY_ONLY'
    && risk.executionAuthorized === false
    && risk.approvalCreationAllowed === false
    && risk.paperPositionMutationAllowed === false
    && risk.livePositionMutationAllowed === false;
}

function downstreamBoundariesValid(input: StrategyDecisionExplainabilityInput): boolean {
  const sizing = input.sizingAdvisory;
  const confidence = input.confidenceAdvisory;
  const gmx = input.gmxNetEdgeAdvisory;
  const aggressive = input.aggressiveAdvisory ?? null;
  return (sizing === null || (sizing.schemaVersion === 'strategy-structural-sizing/v1'
      && sizing.authority === 'ADVISORY_ONLY' && sizing.executionAuthorized === false
      && sizing.approvalCreationAllowed === false && sizing.paperPositionMutationAllowed === false
      && sizing.livePositionMutationAllowed === false))
    && (confidence === null || (confidence.schemaVersion === 'strategy-confidence-risk-reduction/v1'
      && confidence.authority === 'ADVISORY_ONLY' && confidence.executionAuthorized === false
      && confidence.approvalCreationAllowed === false && confidence.paperPositionMutationAllowed === false
      && confidence.livePositionMutationAllowed === false))
    && (gmx === null || (gmx.schemaVersion === 'strategy-gmx-context-net-edge/v1'
      && gmx.authority === 'ADVISORY_ONLY' && gmx.externalReadStarted === false
      && gmx.executionAuthorized === false && gmx.approvalCreationAllowed === false
       && gmx.paperPositionMutationAllowed === false && gmx.livePositionMutationAllowed === false))
    && (aggressive === null || (aggressive.schemaVersion === 'strategy-aggressive-net-edge/v1'
      && aggressive.authority === 'ADVISORY_ONLY' && aggressive.executionAuthorized === false
      && aggressive.approvalCreationAllowed === false && aggressive.paperPositionMutationAllowed === false
      && aggressive.livePositionMutationAllowed === false));
}

function identityValid(input: StrategyDecisionExplainabilityInput): boolean {
  const { shadowRecord: shadow, riskDecision: risk, sizingAdvisory: sizing,
    confidenceAdvisory: confidence, gmxNetEdgeAdvisory: gmx,
    aggressiveAdvisory: aggressive = null } = input;
  const expectedSymbol = symbol(shadow.symbol);
  const expectedSignal = shadow.signalId;
  return shadow.schemaVersion === 'strategy-shadow-adapter/v1'
    && shadow.mode === 'SHADOW_ONLY' && shadow.executionAuthorized === false
    && shadow.paperPositionMutationAllowed === false && shadow.riskAuthority === 'NOT_EVALUATED'
    && shadow.shadowRecordId.trim().length > 0 && expectedSignal !== null && expectedSignal.trim().length > 0
    && risk.decisionId === `${shadow.shadowRecordId}:RISK_ADAPTER`
    && risk.signalId === expectedSignal && symbol(risk.symbol) === expectedSymbol
    && (risk.action === 'REJECT' ? risk.direction === 'NONE' : risk.direction === shadow.direction)
    && (sizing === null || (sizing.advisoryId === `${shadow.shadowRecordId}:STRUCTURAL_SIZING`
      && sizing.signalId === expectedSignal && symbol(sizing.symbol) === expectedSymbol))
    && (confidence === null || (confidence.advisoryId === `${shadow.shadowRecordId}:CONFIDENCE_RISK_REDUCTION`
      && confidence.signalId === expectedSignal && symbol(confidence.symbol) === expectedSymbol))
    && (gmx === null || (gmx.advisoryId === `${shadow.shadowRecordId}:GMX_CONTEXT_NET_EDGE`
       && gmx.signalId === expectedSignal && symbol(gmx.symbol) === expectedSymbol))
    && (aggressive === null || (aggressive.signalId === expectedSignal
      && aggressive.advisoryId === `${expectedSignal}:AGGRESSIVE_NET_EDGE`
      && symbol(aggressive.symbol) === expectedSymbol && aggressive.direction === shadow.direction));
}

/** Build one immutable, serialization-safe explanation of the terminal advisory. */
export function buildStrategyDecisionExplainabilityEnvelope(
  input: StrategyDecisionExplainabilityInput,
): StrategyDecisionExplainabilityEnvelope {
  const { riskDecision: risk, sizingAdvisory: sizing,
    confidenceAdvisory: confidence, gmxNetEdgeAdvisory: gmx,
    aggressiveAdvisory: aggressive = null } = input;
  if (!riskBoundaryValid(risk) || !downstreamBoundariesValid(input) || !identityValid(input)) {
    return output(input, 'BLOCKED', 'INVALID', 0,
      '권한 또는 identity 결속 INVALID', ['부분 설명 저장 금지 — fail-closed']);
  }
  if ((risk.riskState === 'HARD_STOPPED' || risk.riskState === 'UNRESOLVED')
    && risk.action !== 'REJECT') {
    return output(input, 'BLOCKED', 'INVALID', 0,
      'HARD_STOPPED/UNRESOLVED Risk action consistency INVALID', ['Risk final veto 위조 차단']);
  }

  if (risk.action === 'REJECT') {
    if (sizing !== null || confidence !== null || gmx !== null || aggressive !== null) {
      return output(input, 'BLOCKED', 'INVALID', 0,
        'Risk REJECT 이후 downstream stage 존재', ['단계 순서 위반 — fail-closed']);
    }
    return output(input, 'REJECTED', STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
      'Risk Engine advisory REJECT', [...risk.reasons]);
  }
  if (sizing === null) {
    if (confidence !== null || gmx !== null || aggressive !== null) return output(input, 'BLOCKED', 'INVALID', 0,
      'Structural sizing 이전 downstream stage 존재', ['단계 순서 위반 — fail-closed']);
    return output(input, 'NOT_EVALUATED', STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
      'Structural sizing evidence 없음', ['후속 confidence·GMX 평가 미수행']);
  }
  if (sizing.status === 'REJECTED') {
    if (confidence !== null || gmx !== null || aggressive !== null) return output(input, 'BLOCKED', 'INVALID', 0,
      'Sizing REJECT 이후 downstream stage 존재', ['단계 순서 위반 — fail-closed']);
    return output(input, 'REJECTED', STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
      'Structural sizing advisory REJECTED', [...sizing.reasons]);
  }
  if (confidence === null) {
    if (gmx !== null || aggressive !== null) return output(input, 'BLOCKED', 'INVALID', 0,
      'Confidence 이전 GMX stage 존재', ['단계 순서 위반 — fail-closed']);
    return output(input, 'NOT_EVALUATED', STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
      'Confidence reduction evidence 없음', ['후속 GMX 경제성 평가 미수행']);
  }
  if (confidence.status === 'REJECTED') {
    if (gmx !== null || aggressive !== null) return output(input, 'BLOCKED', 'INVALID', 0,
      'Confidence REJECT 이후 GMX stage 존재', ['단계 순서 위반 — fail-closed']);
    return output(input, 'REJECTED', STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
      'Confidence minimum 미달 또는 축소 결과 거부', [...confidence.reasons]);
  }
  if (!finite(sizing.finalAdvisoryNotionalUsd) || sizing.finalAdvisoryNotionalUsd <= 0
    || !finite(confidence.finalAdvisoryNotionalUsd) || confidence.finalAdvisoryNotionalUsd <= 0
    || confidence.finalAdvisoryNotionalUsd > sizing.finalAdvisoryNotionalUsd) {
    return output(input, 'BLOCKED', 'INVALID', 0,
      'Sizing→Confidence 명목가치 단조 축소 위반', ['위험 확대 차단']);
  }
  if (gmx === null) {
    if (aggressive !== null) return output(input, 'BLOCKED', 'INVALID', 0,
      'GMX 이전 aggressive stage 존재', ['단계 순서 위반 — fail-closed']);
    return output(input, 'NOT_EVALUATED', STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
    'GMX Net Edge evidence 없음', ['비용을 0으로 위장하지 않음']);
  }
  if (gmx.status === 'NOT_EVALUATED') {
    if (aggressive !== null) return output(input, 'BLOCKED', 'INVALID', 0,
      'GMX NOT_EVALUATED 이후 aggressive stage 존재', ['단계 순서 위반 — fail-closed']);
    return output(input, 'NOT_EVALUATED',
    STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
    'GMX Context 또는 gross edge 미평가', [...gmx.reasons]);
  }
  if (gmx.status === 'REJECTED') {
    if (aggressive !== null) return output(input, 'BLOCKED', 'INVALID', 0,
      'GMX REJECT 이후 aggressive stage 존재', ['단계 순서 위반 — fail-closed']);
    return output(input, 'REJECTED',
    STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
    'GMX 비용·유동성·Net Edge gate REJECTED', [...gmx.reasons]);
  }
  if (!finite(gmx.finalAdvisoryNotionalUsd) || gmx.finalAdvisoryNotionalUsd <= 0
    || gmx.finalAdvisoryNotionalUsd > confidence.finalAdvisoryNotionalUsd
    || !finite(gmx.costAdjustedNetEdgeUsd) || gmx.costAdjustedNetEdgeUsd <= 0
    || !finite(gmx.roundTripCostUsd) || gmx.roundTripCostUsd > gmx.immutableCostCapUsd) {
    return output(input, 'BLOCKED', 'INVALID', 0,
      'GMX PASSED 결과의 경제성 또는 단조 축소 INVALID', ['위험 확대·비용 상한 우회 차단']);
  }
  if (aggressive === null) return output(input, 'NOT_EVALUATED',
    STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
    'GMX 이후 aggressive advisory 없음', ['aggressive prerequisite를 추정하지 않음']);
  if (aggressive.status === 'REJECTED') return output(input, 'REJECTED',
    STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0, 'Aggressive advisory REJECTED', [...aggressive.reasons]);
  if (aggressive.status === 'NOT_EVALUATED') {
    if (aggressive.applicability === 'NOT_APPLICABLE') {
      return output(input, 'EVALUATED', STRATEGY_DECISION_EXPLAINABILITY_VERSION,
        gmx.finalAdvisoryNotionalUsd, 'Base chain complete; aggressive NOT_APPLICABLE', [...aggressive.reasons]);
    }
    return output(input, 'NOT_EVALUATED', STRATEGY_DECISION_EXPLAINABILITY_VERSION, 0,
      'Aggressive prerequisite NOT_EVALUATED', [...aggressive.reasons]);
  }
  if (aggressive.status !== 'ELIGIBLE' || aggressive.applicability !== 'APPLICABLE'
    || aggressive.notionalUsd !== gmx.finalAdvisoryNotionalUsd
    || aggressive.roundTripCostUsd !== gmx.roundTripCostUsd
    || aggressive.costAdjustedNetEdgeUsd !== gmx.costAdjustedNetEdgeUsd
    || aggressive.immutableCostCapUsd !== gmx.immutableCostCapUsd) {
    return output(input, 'BLOCKED', 'INVALID', 0,
      'Aggressive economics/notional/status INVALID', ['post-GMX advisory binding fail-closed']);
  }
  return output(input, 'EVALUATED', STRATEGY_DECISION_EXPLAINABILITY_VERSION,
    gmx.finalAdvisoryNotionalUsd, '모든 read-only advisory stage 평가 완료', [
      'SHADOW→Risk→Structural sizing→Confidence→GMX Net Edge 순서 결속',
      '직렬화·표시 전용이며 실행·승인·PAPER/LIVE 권한 없음',
    ]);
}
