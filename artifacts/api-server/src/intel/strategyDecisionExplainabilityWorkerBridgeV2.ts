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
import type { StrategyRiskWorkerAdvisory } from './strategyRiskWorkerBridgeV2';
import type { StrategyShadowWorkerEnvelope } from './strategyShadowWorkerEnvelopeV2';

export const STRATEGY_DECISION_EXPLAINABILITY_WORKER_VERSION =
  'strategy-decision-explainability-worker/v1' as const;

export interface StrategyDecisionExplainabilityWorkerInput {
  shadowEnvelope: StrategyShadowWorkerEnvelope;
  riskAdvisory: StrategyRiskWorkerAdvisory;
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
