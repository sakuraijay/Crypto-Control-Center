/**
 * Pure advisory bridge from Strategy Ensemble SHADOW evidence to the existing
 * authoritative Risk Engine result.
 *
 * This module cannot read DB/RPC state, size or persist a position, create an
 * approval, or mutate PAPER/LIVE execution.  It only makes the existing Risk
 * Engine veto/reduction explicit for future integration work.
 */
import { RISK_POLICY } from '../lib/riskPolicy';
import type {
  RiskAction,
  RiskEvaluationResult,
  RiskOperatingState,
} from '../lib/riskStateMachine';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';

export const STRATEGY_RISK_ADAPTER_VERSION = 'strategy-risk-adapter/v1' as const;

export type StrategyRiskAdapterAction = 'ALLOW' | 'REDUCE' | 'REJECT';

export interface StrategyRiskAdapterInput {
  shadowRecord: StrategyShadowRecord;
  riskEvaluation: RiskEvaluationResult | null;
}

export interface StrategyRiskAdapterDecision {
  schemaVersion: typeof STRATEGY_RISK_ADAPTER_VERSION | 'INVALID';
  decisionId: string;
  signalId: string | null;
  symbol: string;
  action: StrategyRiskAdapterAction;
  direction: 'LONG' | 'SHORT' | 'NONE';
  sizeFactor: number;
  maxLeverage: number;
  riskState: RiskEvaluationResult['state'] | null;
  reasons: string[];
  warnings: string[];
  authority: 'ADVISORY_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();
const RISK_STATES: ReadonlySet<RiskOperatingState> = new Set([
  'NORMAL', 'DEFENSIVE', 'PROFIT_PROTECTED', 'PROFIT_TARGET_LOCKED',
  'PROFIT_CAP_LOCKED', 'DAILY_LOSS_LOCKED', 'WEEKLY_LOSS_LOCKED',
  'CONSECUTIVE_LOSS_LOCKED', 'HARD_STOPPED', 'UNRESOLVED',
]);
const RISK_ACTIONS: ReadonlySet<RiskAction> = new Set([
  'CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS', 'REDUCE_POSITION_70PCT',
]);

function decision(
  input: StrategyRiskAdapterInput,
  action: StrategyRiskAdapterAction,
  version: StrategyRiskAdapterDecision['schemaVersion'],
  reasons: string[],
  options: {
    sizeFactor?: number;
    maxLeverage?: number;
    riskState?: RiskEvaluationResult['state'] | null;
    warnings?: string[];
  } = {},
): StrategyRiskAdapterDecision {
  const record = input.shadowRecord;
  return {
    schemaVersion: version,
    decisionId: `${record.shadowRecordId}:RISK_ADAPTER`,
    signalId: record.signalId,
    symbol: normalizeSymbol(record.symbol),
    action,
    direction: action === 'ALLOW' || action === 'REDUCE'
      ? (record.action === 'LONG' || record.action === 'SHORT' ? record.action : 'NONE')
      : 'NONE',
    sizeFactor: options.sizeFactor ?? 0,
    maxLeverage: options.maxLeverage ?? 0,
    riskState: options.riskState ?? null,
    reasons,
    warnings: options.warnings ?? [],
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function shadowIssues(record: StrategyShadowRecord): string[] {
  const issues: string[] = [];
  if (record.schemaVersion !== 'strategy-shadow-adapter/v1'
    || record.mode !== 'SHADOW_ONLY'
    || record.executionAuthorized !== false
    || record.paperPositionMutationAllowed !== false
    || record.riskAuthority !== 'NOT_EVALUATED') {
    issues.push('SHADOW 권한 경계 INVALID');
  }
  if (!record.shadowRecordId.trim() || !record.symbol.trim()
    || !finite(record.evaluatedAt) || record.evaluatedAt <= 0
    || !finite(record.sourceCandleCloseTime) || record.sourceCandleCloseTime <= 0
    || record.evaluatedAt < record.sourceCandleCloseTime) {
    issues.push('SHADOW identity 또는 시각 INVALID');
  }
  if ((record.action !== 'LONG' && record.action !== 'SHORT')
    || record.direction !== record.action
    || record.lifecycleEligible !== true
    || record.signalId === null || !record.signalId.trim()) {
    issues.push('실행 후보가 아닌 SHADOW record');
  }
  if (!finite(record.entryPrice) || record.entryPrice <= 0
    || !finite(record.structuralStop) || record.structuralStop <= 0
    || !finite(record.expectedNetEdgeBps) || record.expectedNetEdgeBps <= 0
    || !finite(record.expectedNetRR) || record.expectedNetRR <= 0) {
    issues.push('가격·Structural Stop·Net Edge·R:R 근거 INVALID');
  }
  return issues;
}

/**
 * Maps already-computed Risk Engine authority into an advisory action.
 * Risk may only keep or reduce exposure; a factor above 1 is rejected.
 */
export function adaptStrategySignalToRisk(
  input: StrategyRiskAdapterInput,
): StrategyRiskAdapterDecision {
  const issues = shadowIssues(input.shadowRecord);
  if (issues.length > 0) {
    return decision(input, 'REJECT', 'INVALID', ['Strategy SHADOW evidence 거부 — fail-closed'], {
      warnings: issues,
    });
  }

  const risk = input.riskEvaluation;
  if (risk === null) {
    return decision(input, 'REJECT', STRATEGY_RISK_ADAPTER_VERSION,
      ['Risk Engine 평가 없음 — fail-closed']);
  }
  if (!Array.isArray(risk.blockReasons) || !Array.isArray(risk.actions)
    || !RISK_STATES.has(risk.state)
    || risk.blockReasons.some(reason => typeof reason !== 'string' || !reason.trim())
    || risk.actions.some(action => !RISK_ACTIONS.has(action))
    || !finite(risk.sizeFactor) || !finite(risk.maxLeverage)
    || risk.sizeFactor < 0 || risk.sizeFactor > 1 || risk.maxLeverage < 0
    || risk.maxLeverage > RISK_POLICY.baseMaxLeverage) {
    return decision(input, 'REJECT', 'INVALID', ['Risk Engine 결과 INVALID — fail-closed']);
  }
  if (!risk.entryAllowed || risk.blockReasons.length > 0) {
    return decision(input, 'REJECT', STRATEGY_RISK_ADAPTER_VERSION,
      ['기존 Risk Engine veto가 최종 권한', ...risk.blockReasons], { riskState: risk.state });
  }
  if (risk.actions.length > 0) {
    return decision(input, 'REJECT', STRATEGY_RISK_ADAPTER_VERSION,
      ['기존 포지션 강제 조치가 신규 진입보다 우선 — fail-closed', ...risk.actions], {
        riskState: risk.state,
      });
  }
  if (risk.sizeFactor <= 0 || risk.maxLeverage <= 0) {
    return decision(input, 'REJECT', STRATEGY_RISK_ADAPTER_VERSION,
      ['Risk Engine 허용 수량 또는 레버리지 0 — fail-closed'], { riskState: risk.state });
  }
  if (risk.sizeFactor < 1) {
    return decision(input, 'REDUCE', STRATEGY_RISK_ADAPTER_VERSION,
      ['기존 Risk Engine sizeFactor만큼 위험 축소', '위험 확대·주문 권한 없음'], {
        sizeFactor: risk.sizeFactor,
        maxLeverage: risk.maxLeverage,
        riskState: risk.state,
      });
  }
  return decision(input, 'ALLOW', STRATEGY_RISK_ADAPTER_VERSION,
    ['기존 Risk Engine이 후보를 허용', '실행·승인·PAPER/LIVE mutation 권한은 별도'], {
      sizeFactor: 1,
      maxLeverage: risk.maxLeverage,
      riskState: risk.state,
    });
}
