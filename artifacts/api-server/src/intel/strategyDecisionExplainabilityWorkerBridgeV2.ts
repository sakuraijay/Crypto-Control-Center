/**
 * Read-only aiWorker bridge for Strategy decision explainability.
 *
 * The bridge only joins the already-computed SHADOW and Risk projections.
 * Downstream sizing, confidence and GMX evidence deliberately remain null
 * until a separately verified same-generation context is wired. It starts no
 * external read and cannot authorize persistence or execution on its own.
 */
import {
  buildStrategyDecisionExplainabilityEnvelope,
  type StrategyDecisionExplainabilityEnvelope,
} from './strategyDecisionExplainabilityV2';
import type { StrategyConfidenceRiskReductionAdvisory } from './strategyConfidenceRiskReductionV2';
import type { StrategyGmxContextNetEdgeAdvisory } from './strategyGmxContextNetEdgeV2';
import {
  evaluateAggressiveNetEdge,
  type StrategyAggressiveNetEdgeInput,
} from './strategyAggressiveNetEdgeV2';
import type { StrategyRiskWorkerAdvisory } from './strategyRiskWorkerBridgeV2';
import type { StrategyShadowWorkerEnvelope } from './strategyShadowWorkerEnvelopeV2';
import type { StrategyStructuralSizingReadinessBinding } from './strategyStructuralSizingReadinessBindingV2';
import type { StrategyStructuralSizingWorkerAdvisory } from './strategyStructuralSizingWorkerBridgeV2';

export const STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION =
  'strategy-decision-explainability-worker/v1' as const;

export interface StrategyDecisionExplainabilityWorkerInput {
  shadowEnvelope: StrategyShadowWorkerEnvelope;
  riskAdvisory: StrategyRiskWorkerAdvisory;
}

/**
 * Already-computed downstream evidence supplied by a caller that owns the
 * shared readiness generation. This bridge never obtains the evidence itself.
 * Null array entries are explicit NOT_EVALUATED markers, not zero values.
 */
export interface StrategyDecisionExplainabilityWorkerDownstreamInput
  extends StrategyDecisionExplainabilityWorkerInput {
  sizingAdvisory: StrategyStructuralSizingWorkerAdvisory;
  readinessBinding: StrategyStructuralSizingReadinessBinding;
  confidenceAdvisories: readonly (StrategyConfidenceRiskReductionAdvisory | null)[];
  gmxNetEdgeAdvisories: readonly (StrategyGmxContextNetEdgeAdvisory | null)[];
  /** Per-record evaluator inputs; null is the explicit NOT_EVALUATED marker. */
  aggressiveInputs: readonly (StrategyAggressiveNetEdgeInput | null)[];
}

export interface StrategyDecisionExplainabilityWorkerAdvisory {
  schemaVersion: typeof STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION | 'INVALID';
  advisoryId: string;
  cycleNumber: number;
  status: 'NOT_EVALUATED' | 'PARTIAL' | 'EVALUATED' | 'BLOCKED';
  envelopes: StrategyDecisionExplainabilityEnvelope[];
  summary: { evaluated: number; rejected: number; notEvaluated: number; blocked: number };
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  externalReadStarted: false;
  independentPersistenceAllowed: false;
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

function output(
  input: StrategyDecisionExplainabilityWorkerInput,
  status: StrategyDecisionExplainabilityWorkerAdvisory['status'],
  version: StrategyDecisionExplainabilityWorkerAdvisory['schemaVersion'],
  envelopes: StrategyDecisionExplainabilityEnvelope[],
  reasons: string[],
): StrategyDecisionExplainabilityWorkerAdvisory {
  return {
    schemaVersion: version,
    advisoryId: `${input.shadowEnvelope.envelopeId}:DECISION_EXPLAINABILITY_ADVISORY`,
    cycleNumber: input.shadowEnvelope.cycleNumber,
    status,
    envelopes,
    summary: {
      evaluated: envelopes.filter(value => value.status === 'EVALUATED').length,
      rejected: envelopes.filter(value => value.status === 'REJECTED').length,
      notEvaluated: envelopes.filter(value => value.status === 'NOT_EVALUATED').length,
      blocked: envelopes.filter(value => value.status === 'BLOCKED').length,
    },
    reasons,
    authority: 'ADVISORY_ONLY',
    externalReadStarted: false,
    independentPersistenceAllowed: false,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function boundariesValid(input: StrategyDecisionExplainabilityWorkerInput): boolean {
  const shadow = input.shadowEnvelope;
  const risk = input.riskAdvisory;
  return shadow.schemaVersion === 'strategy-shadow-worker-envelope/v1'
    && shadow.mode === 'SHADOW_ONLY'
    && shadow.executionAuthorized === false
    && shadow.approvalCreationAllowed === false
    && shadow.paperPositionMutationAllowed === false
    && shadow.livePositionMutationAllowed === false
    && shadow.riskAuthority === 'NOT_EVALUATED'
    && risk.schemaVersion === 'strategy-risk-worker-bridge/v1'
    && risk.authority === 'ADVISORY_ONLY'
    && risk.executionAuthorized === false
    && risk.approvalCreationAllowed === false
    && risk.paperPositionMutationAllowed === false
    && risk.livePositionMutationAllowed === false
    && risk.cycleNumber === shadow.cycleNumber
    && risk.advisoryId === `${shadow.envelopeId}:RISK_ADVISORY`;
}

/** Build per-record terminal Risk explanations without starting downstream work. */
export function buildStrategyDecisionExplainabilityWorkerAdvisory(
  input: StrategyDecisionExplainabilityWorkerInput,
): StrategyDecisionExplainabilityWorkerAdvisory {
  const shadow = input.shadowEnvelope;
  const risk = input.riskAdvisory;
  if (!boundariesValid(input) || shadow.status === 'BLOCKED' || risk.status === 'BLOCKED') {
    return output(input, 'BLOCKED', 'INVALID', [],
      ['SHADOW/Risk Worker 권한 또는 cycle 결속 INVALID — explainability 전체 차단']);
  }
  if (shadow.records.length === 0 || shadow.status === 'NOT_EVALUATED'
    || risk.status === 'NOT_EVALUATED') {
    return output(input, 'NOT_EVALUATED', STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION, [], [
      'SHADOW 또는 Risk 근거 미평가 — terminal explanation 생성 금지',
      '외부 read·sizing·confidence·GMX 평가를 새로 시작하지 않음',
    ]);
  }
  if (shadow.records.length !== risk.decisions.length
    || shadow.records.some((record, index) => {
      const decision = risk.decisions[index];
      return decision?.decisionId !== `${record.shadowRecordId}:RISK_ADAPTER`
        || decision.signalId !== record.signalId
        || decision.symbol.trim().toUpperCase() !== record.symbol.trim().toUpperCase();
    })) {
    return output(input, 'BLOCKED', 'INVALID', [],
      ['SHADOW record와 Risk decision 일대일 결속 실패 — 부분 설명 저장 금지']);
  }

  const envelopes = shadow.records.map((shadowRecord, index) =>
    buildStrategyDecisionExplainabilityEnvelope({
      shadowRecord,
      riskDecision: risk.decisions[index],
      sizingAdvisory: null,
      confidenceAdvisory: null,
      gmxNetEdgeAdvisory: null,
    }));
  if (envelopes.some(value => value.schemaVersion === 'INVALID' || value.status === 'BLOCKED')) {
    return output(input, 'BLOCKED', 'INVALID', [],
      ['개별 explainability identity 또는 단계 경계 INVALID — 전체 결과 폐기']);
  }

  const terminal = envelopes.filter(value => value.status === 'REJECTED'
    || value.status === 'EVALUATED').length;
  const status = shadow.status === 'PARTIAL' || risk.status === 'PARTIAL'
    ? 'PARTIAL'
    : terminal === envelopes.length ? 'EVALUATED'
      : terminal > 0 ? 'PARTIAL' : 'NOT_EVALUATED';
  return output(input, status, STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION, envelopes, [
    '기존 SHADOW·Risk 결과만 parent AI decision explainability에 직렬화',
    'Sizing·Confidence·GMX 근거는 미연결 상태를 null·NOT_EVALUATED로 보존',
    '독립 저장·외부 read·실행·승인·PAPER/LIVE 권한 없음',
  ]);
}

function downstreamAggregateBoundariesValid(
  input: StrategyDecisionExplainabilityWorkerDownstreamInput,
): boolean {
  const sizing = input.sizingAdvisory;
  const binding = input.readinessBinding;
  const expectedSymbols = input.shadowEnvelope.expectedSymbols.map(value => value.trim().toUpperCase());
  const bindingSymbols = Object.keys(binding.marketContextBySymbol).map(value => value.trim().toUpperCase());
  const bound = Object.values(binding.marketContextBySymbol).filter(value => value !== null).length;
  return boundariesValid(input)
    && sizing.schemaVersion === 'strategy-structural-sizing-worker/v1'
    && sizing.status !== 'BLOCKED'
    && sizing.advisoryId === `${input.shadowEnvelope.envelopeId}:STRUCTURAL_SIZING_ADVISORY`
    && sizing.cycleNumber === input.shadowEnvelope.cycleNumber
    && sizing.authority === 'ADVISORY_ONLY'
    && sizing.externalReadStarted === false
    && sizing.executionAuthorized === false
    && sizing.approvalCreationAllowed === false
    && sizing.paperPositionMutationAllowed === false
    && sizing.livePositionMutationAllowed === false
    && binding.schemaVersion === 'strategy-structural-sizing-readiness-binding/v1'
    && binding.status !== 'BLOCKED'
    && Number.isInteger(binding.coordinatorGeneration)
    && (binding.coordinatorGeneration ?? 0) > 0
    && binding.authority === 'ADVISORY_ONLY'
    && binding.externalReadStarted === false
    && binding.executionAuthorized === false
    && binding.approvalCreationAllowed === false
    && binding.paperPositionMutationAllowed === false
    && binding.livePositionMutationAllowed === false
    && binding.summary.expected === expectedSymbols.length
    && binding.summary.bound === bound
    && binding.summary.missingOrStale === bindingSymbols.length - bound
    && bindingSymbols.length === expectedSymbols.length
    && bindingSymbols.every(value => expectedSymbols.includes(value));
}

/**
 * Attach downstream advisories only when they belong to one completed
 * readiness generation. Missing stages stay null; upstream terminal rejects
 * forbid all later stages. The function starts no read and performs no write.
 */
export function buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream(
  input: StrategyDecisionExplainabilityWorkerDownstreamInput,
): StrategyDecisionExplainabilityWorkerAdvisory {
  const { shadowEnvelope: shadow, riskAdvisory: risk, sizingAdvisory: sizing,
    readinessBinding: binding, confidenceAdvisories: confidences,
    gmxNetEdgeAdvisories: gmxAdvisories,
    aggressiveInputs } = input;
  const count = shadow.records.length;
  if (!downstreamAggregateBoundariesValid(input)
    || shadow.status === 'BLOCKED' || risk.status === 'BLOCKED'
    || sizing.status === 'BLOCKED') {
    return output(input, 'BLOCKED', 'INVALID', [],
      ['SHADOW/Risk/Sizing/readiness 권한 또는 generation 결속 INVALID — 전체 설명 차단']);
  }
  if (count !== risk.decisions.length || count !== sizing.sizings.length
    || count !== confidences.length || count !== gmxAdvisories.length
    || count !== aggressiveInputs.length) {
    return output(input, 'BLOCKED', 'INVALID', [],
      ['downstream evidence 일대일 개수 결속 실패 — 부분 설명 저장 금지']);
  }

  const envelopeInputs = shadow.records.map((shadowRecord, index) => {
    const riskDecision = risk.decisions[index];
    const sizingValue = sizing.sizings[index];
    const confidence = confidences[index];
    const gmx = gmxAdvisories[index];
    const aggressiveInput = aggressiveInputs[index];
    if (riskDecision.action === 'REJECT') {
      if (sizingValue.status !== 'REJECTED' || confidence !== null || gmx !== null || aggressiveInput !== null) return null;
      return { shadowRecord, riskDecision, sizingAdvisory: null,
        confidenceAdvisory: null, gmxNetEdgeAdvisory: null, aggressiveAdvisory: null };
    }
    if (sizingValue.schemaVersion === 'INVALID') {
      if (confidence !== null || gmx !== null || aggressiveInput !== null) return null;
      return { shadowRecord, riskDecision, sizingAdvisory: null,
        confidenceAdvisory: null, gmxNetEdgeAdvisory: null, aggressiveAdvisory: null };
    }
    if (sizingValue.status === 'REJECTED' && (confidence !== null || gmx !== null || aggressiveInput !== null)) return null;
    if (confidence === null && (gmx !== null || aggressiveInput !== null)) return null;
    if (confidence?.status === 'REJECTED' && (gmx !== null || aggressiveInput !== null)) return null;
    if (gmx === null && aggressiveInput !== null) return null;
    if (gmx !== null && gmx.coordinatorGeneration !== binding.coordinatorGeneration) return null;
    if (aggressiveInput !== null && (
      aggressiveInput.riskDecision !== riskDecision
      || aggressiveInput.structuralSizing !== sizingValue
      || aggressiveInput.netEdge !== gmx
      || aggressiveInput.researchResult !== shadowRecord.netEdgeResearch
      || aggressiveInput.evaluatedAt !== shadowRecord.evaluatedAt
      || aggressiveInput.lifecycleEligible !== shadowRecord.lifecycleEligible
      || aggressiveInput.signal.signalId !== shadowRecord.signalId
      || aggressiveInput.signal.symbol.trim().toUpperCase() !== shadowRecord.symbol.trim().toUpperCase()
      || aggressiveInput.signal.direction !== shadowRecord.direction
      || aggressiveInput.signal.strategyId !== shadowRecord.netEdgeResearch?.strategyId
      || aggressiveInput.signal.confidence !== shadowRecord.netEdgeResearch?.signalConfidence
      || aggressiveInput.signal.netExpectedEdgeBps !== (
        (shadowRecord.netEdgeResearch?.expectedGrossEdge?.bps ?? Number.NaN)
        - (shadowRecord.netEdgeResearch?.expectedRoundTripCost?.bps ?? Number.NaN))
      || aggressiveInput.signal.expectedNetRR !== (
        ((shadowRecord.netEdgeResearch?.expectedGrossEdge?.bps ?? Number.NaN)
          - (shadowRecord.netEdgeResearch?.expectedRoundTripCost?.bps ?? Number.NaN))
        / (shadowRecord.netEdgeResearch?.riskBps ?? Number.NaN))
      || aggressiveInput.signal.dataQuality !== shadowRecord.netEdgeResearch?.signalDataQuality
      || aggressiveInput.signal.sourceTimeframes.length
        !== (shadowRecord.netEdgeResearch?.sourceTimeframes.length ?? -1)
      || aggressiveInput.signal.sourceTimeframes.some((timeframe, timeframeIndex) =>
        timeframe !== shadowRecord.netEdgeResearch?.sourceTimeframes[timeframeIndex])
    )) return null;
    const aggressive = aggressiveInput === null ? null : evaluateAggressiveNetEdge(aggressiveInput);
    return { shadowRecord, riskDecision, sizingAdvisory: sizingValue,
      confidenceAdvisory: confidence, gmxNetEdgeAdvisory: gmx, aggressiveAdvisory: aggressive };
  });
  if (envelopeInputs.some(value => value === null)) {
    return output(input, 'BLOCKED', 'INVALID', [], [
      'upstream terminal 이후 downstream 존재 또는 readiness generation 불일치 — 전체 폐기',
    ]);
  }

  const envelopes = envelopeInputs.map(value =>
    buildStrategyDecisionExplainabilityEnvelope(value!));
  if (envelopes.some(value => value.schemaVersion === 'INVALID' || value.status === 'BLOCKED')) {
    return output(input, 'BLOCKED', 'INVALID', [],
      ['downstream identity·권한·단계·단조 축소 검증 실패 — 전체 결과 폐기']);
  }
  const terminal = envelopes.filter(value => value.status === 'REJECTED'
    || value.status === 'EVALUATED').length;
  const status = shadow.status === 'PARTIAL' || risk.status === 'PARTIAL'
    || sizing.status === 'PARTIAL'
    ? 'PARTIAL'
    : terminal === envelopes.length ? 'EVALUATED'
      : terminal > 0 ? 'PARTIAL' : 'NOT_EVALUATED';
  return output(input, status, STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION, envelopes, [
    `readiness coordinator generation ${binding.coordinatorGeneration} 후속 근거만 결속`,
    '결측 stage는 null·NOT_EVALUATED, terminal reject 이후 stage는 금지',
    '독립 저장·외부 read·실행·승인·PAPER/LIVE 권한 없음',
  ]);
}
