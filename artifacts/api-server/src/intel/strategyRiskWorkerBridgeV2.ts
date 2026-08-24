/**
 * Read-only Worker bridge for Strategy Ensemble SHADOW → Risk explainability.
 *
 * The returned value is persisted beside the existing AI decision for audit/UI
 * only.  It is never consumed by approval, sizing, PAPER, signer or LIVE paths.
 */
import type { RiskEvaluationResult } from '../lib/riskStateMachine';
import {
  adaptStrategySignalToRisk,
  type StrategyRiskAdapterDecision,
} from './strategyRiskAdapterV2';
import type { StrategyShadowWorkerEnvelope } from './strategyShadowWorkerEnvelopeV2';

export const STRATEGY_RISK_WORKER_BRIDGE_VERSION = 'strategy-risk-worker-bridge/v1' as const;

export type StrategyRiskWorkerStatus = 'NOT_EVALUATED' | 'PARTIAL' | 'EVALUATED' | 'BLOCKED';

export interface StrategyRiskWorkerAdvisory {
  schemaVersion: typeof STRATEGY_RISK_WORKER_BRIDGE_VERSION | 'INVALID';
  advisoryId: string;
  status: StrategyRiskWorkerStatus;
  cycleNumber: number;
  riskState: RiskEvaluationResult['state'] | null;
  decisions: StrategyRiskAdapterDecision[];
  summary: { allow: number; reduce: number; reject: number };
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

export interface StrategyRiskWorkerBridgeInput {
  shadowEnvelope: StrategyShadowWorkerEnvelope;
  riskEvaluation: RiskEvaluationResult | null;
}

function result(
  input: StrategyRiskWorkerBridgeInput,
  status: StrategyRiskWorkerStatus,
  version: StrategyRiskWorkerAdvisory['schemaVersion'],
  decisions: StrategyRiskAdapterDecision[],
  reasons: string[],
): StrategyRiskWorkerAdvisory {
  return {
    schemaVersion: version,
    advisoryId: `${input.shadowEnvelope.envelopeId}:RISK_ADVISORY`,
    status,
    cycleNumber: input.shadowEnvelope.cycleNumber,
    riskState: input.riskEvaluation?.state ?? null,
    decisions,
    summary: {
      allow: decisions.filter(decision => decision.action === 'ALLOW').length,
      reduce: decisions.filter(decision => decision.action === 'REDUCE').length,
      reject: decisions.filter(decision => decision.action === 'REJECT').length,
    },
    reasons,
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

/** Maps one already-computed Risk result across the cycle's SHADOW records. */
export function buildStrategyRiskWorkerAdvisory(
  input: StrategyRiskWorkerBridgeInput,
): StrategyRiskWorkerAdvisory {
  const envelope = input.shadowEnvelope;
  if (envelope.schemaVersion !== 'strategy-shadow-worker-envelope/v1'
    || envelope.mode !== 'SHADOW_ONLY'
    || envelope.executionAuthorized !== false
    || envelope.approvalCreationAllowed !== false
    || envelope.paperPositionMutationAllowed !== false
    || envelope.livePositionMutationAllowed !== false
    || envelope.riskAuthority !== 'NOT_EVALUATED'
    || !Number.isInteger(envelope.cycleNumber) || envelope.cycleNumber <= 0
    || !envelope.envelopeId.trim() || !Array.isArray(envelope.records)) {
    return result(input, 'BLOCKED', 'INVALID', [],
      ['SHADOW envelope 권한 또는 identity INVALID — Risk advisory 차단']);
  }
  if (envelope.status === 'BLOCKED') {
    return result(input, 'BLOCKED', STRATEGY_RISK_WORKER_BRIDGE_VERSION, [],
      ['SHADOW envelope가 BLOCKED — Risk advisory 미채택']);
  }
  if (envelope.records.length === 0 || envelope.status === 'NOT_EVALUATED') {
    return result(input, 'NOT_EVALUATED', STRATEGY_RISK_WORKER_BRIDGE_VERSION, [],
      ['Strategy SHADOW record 없음 — Risk advisory 미평가']);
  }
  if (input.riskEvaluation === null) {
    const decisions = envelope.records.map(shadowRecord =>
      adaptStrategySignalToRisk({ shadowRecord, riskEvaluation: null }));
    return result(input, 'NOT_EVALUATED', STRATEGY_RISK_WORKER_BRIDGE_VERSION, decisions,
      ['Risk Engine 평가 없음 — 모든 후보 fail-closed REJECT']);
  }

  const decisions = envelope.records.map(shadowRecord =>
    adaptStrategySignalToRisk({ shadowRecord, riskEvaluation: input.riskEvaluation }));
  return result(input, envelope.status === 'PARTIAL' ? 'PARTIAL' : 'EVALUATED',
    STRATEGY_RISK_WORKER_BRIDGE_VERSION, decisions,
    ['기존 Risk Engine 결과의 read-only advisory projection', '실행·승인·PAPER/LIVE 권한 없음']);
}
