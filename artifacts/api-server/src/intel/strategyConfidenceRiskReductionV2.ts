/**
 * Pure confidence-based downside-only risk modifier.
 *
 * Confidence may reject or reduce an existing read-only sizing advisory. It
 * can never increase notional, leverage, or any execution authority.
 */
import { RISK_POLICY } from '../lib/riskPolicy';
import type { StrategyRiskAdapterDecision } from './strategyRiskAdapterV2';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';
import type { StrategyStructuralSizingAdvisory } from './strategyStructuralSizingV2';

export const STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION =
  'strategy-confidence-risk-reduction/v1' as const;

export interface StrategyConfidenceRiskReductionPolicy {
  version: typeof STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION;
  minimumConfidence: number;
  fullSizeConfidence: number;
  minimumSizeFactor: number;
}

export const DEFAULT_STRATEGY_CONFIDENCE_RISK_REDUCTION_POLICY:
Readonly<StrategyConfidenceRiskReductionPolicy> = Object.freeze({
  version: STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION,
  minimumConfidence: 60,
  fullSizeConfidence: 80,
  minimumSizeFactor: 0.5,
});

export interface StrategyConfidenceRiskReductionInput {
  shadowRecord: StrategyShadowRecord;
  riskDecision: StrategyRiskAdapterDecision;
  sizingAdvisory: StrategyStructuralSizingAdvisory;
}

export interface StrategyConfidenceRiskReductionAdvisory {
  schemaVersion: typeof STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION | 'INVALID';
  advisoryId: string;
  signalId: string | null;
  symbol: string;
  status: 'UNCHANGED' | 'REDUCED' | 'REJECTED';
  confidence: number | null;
  confidenceSizeFactor: number;
  inputNotionalUsd: number;
  finalAdvisoryNotionalUsd: number;
  allowedLeverage: number;
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const symbol = (value: string): string => value.trim().toUpperCase();

export function validateStrategyConfidenceRiskReductionPolicy(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['policy 객체 필요'];
  const record = value as Record<string, unknown>;
  const keys = ['version', 'minimumConfidence', 'fullSizeConfidence', 'minimumSizeFactor'] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!keys.includes(key as typeof keys[number])) issues.push(`알 수 없는 policy 필드: ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`policy 필드 누락: ${key}`);
  }
  if (record.version !== STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION) issues.push('지원하지 않는 policy version');
  if (!finite(record.minimumConfidence) || record.minimumConfidence < 0 || record.minimumConfidence >= 100) {
    issues.push('minimumConfidence INVALID');
  }
  if (!finite(record.fullSizeConfidence) || record.fullSizeConfidence <= 0 || record.fullSizeConfidence > 100) {
    issues.push('fullSizeConfidence INVALID');
  }
  if (finite(record.minimumConfidence) && finite(record.fullSizeConfidence)
    && record.minimumConfidence >= record.fullSizeConfidence) {
    issues.push('confidence 구간 INVALID');
  }
  if (!finite(record.minimumSizeFactor)
    || record.minimumSizeFactor <= 0 || record.minimumSizeFactor > 1) {
    issues.push('minimumSizeFactor INVALID');
  }
  return issues;
}

function rejected(
  input: StrategyConfidenceRiskReductionInput,
  reason: string,
  invalid = false,
): StrategyConfidenceRiskReductionAdvisory {
  return {
    schemaVersion: invalid ? 'INVALID' : STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION,
    advisoryId: `${input.shadowRecord.shadowRecordId}:CONFIDENCE_RISK_REDUCTION`,
    signalId: input.shadowRecord.signalId,
    symbol: symbol(input.shadowRecord.symbol),
    status: 'REJECTED',
    confidence: finite(input.shadowRecord.confidence) ? input.shadowRecord.confidence : null,
    confidenceSizeFactor: 0,
    inputNotionalUsd: 0,
    finalAdvisoryNotionalUsd: 0,
    allowedLeverage: 0,
    reasons: [reason],
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function boundariesValid(input: StrategyConfidenceRiskReductionInput): boolean {
  const shadow = input.shadowRecord;
  const risk = input.riskDecision;
  const sizing = input.sizingAdvisory;
  return shadow.schemaVersion === 'strategy-shadow-adapter/v1'
    && shadow.mode === 'SHADOW_ONLY'
    && shadow.executionAuthorized === false
    && shadow.paperPositionMutationAllowed === false
    && shadow.riskAuthority === 'NOT_EVALUATED'
    && risk.schemaVersion === 'strategy-risk-adapter/v1'
    && risk.authority === 'ADVISORY_ONLY'
    && risk.executionAuthorized === false
    && risk.approvalCreationAllowed === false
    && risk.paperPositionMutationAllowed === false
    && risk.livePositionMutationAllowed === false
    && sizing.schemaVersion === 'strategy-structural-sizing/v1'
    && sizing.authority === 'ADVISORY_ONLY'
    && sizing.executionAuthorized === false
    && sizing.approvalCreationAllowed === false
    && sizing.paperPositionMutationAllowed === false
    && sizing.livePositionMutationAllowed === false;
}

/** Apply confidence after authoritative Risk and Structural sizing. */
export function reduceStrategyRiskByConfidence(
  input: StrategyConfidenceRiskReductionInput,
  policyInput: unknown = DEFAULT_STRATEGY_CONFIDENCE_RISK_REDUCTION_POLICY,
): StrategyConfidenceRiskReductionAdvisory {
  const policyIssues = validateStrategyConfidenceRiskReductionPolicy(policyInput);
  if (policyIssues.length > 0) return rejected(input, `Confidence policy INVALID: ${policyIssues.join('; ')}`, true);
  const policy = policyInput as StrategyConfidenceRiskReductionPolicy;
  const { shadowRecord: shadow, riskDecision: risk, sizingAdvisory: sizing } = input;
  if (!boundariesValid(input)) return rejected(input, 'SHADOW/Risk/sizing 권한 경계 INVALID', true);
  if (!shadow.shadowRecordId.trim() || shadow.signalId === null || !shadow.signalId.trim()
    || !shadow.symbol.trim() || (shadow.direction !== 'LONG' && shadow.direction !== 'SHORT')
    || risk.decisionId !== `${shadow.shadowRecordId}:RISK_ADAPTER`
    || sizing.advisoryId !== `${shadow.shadowRecordId}:STRUCTURAL_SIZING`
    || risk.signalId !== shadow.signalId || sizing.signalId !== shadow.signalId
    || symbol(risk.symbol) !== symbol(shadow.symbol) || symbol(sizing.symbol) !== symbol(shadow.symbol)
    || risk.direction !== shadow.direction || sizing.direction !== shadow.direction) {
    return rejected(input, 'Signal identity 또는 direction 결속 INVALID', true);
  }
  if ((risk.action !== 'ALLOW' && risk.action !== 'REDUCE') || sizing.status !== 'SIZED') {
    return rejected(input, 'Risk 또는 Structural sizing 승인 없음 — fail-closed');
  }
  if (!finite(shadow.confidence) || shadow.confidence < 0 || shadow.confidence > 100
    || !finite(risk.sizeFactor) || risk.sizeFactor <= 0 || risk.sizeFactor > 1
    || !finite(sizing.riskSizeFactor) || sizing.riskSizeFactor !== risk.sizeFactor
    || !finite(sizing.finalAdvisoryNotionalUsd) || sizing.finalAdvisoryNotionalUsd <= 0
    || !finite(sizing.maxNotionalBeforeRiskReductionUsd)
    || sizing.finalAdvisoryNotionalUsd > sizing.maxNotionalBeforeRiskReductionUsd
    || !finite(sizing.allowedLeverage) || sizing.allowedLeverage <= 0
    || sizing.allowedLeverage > risk.maxLeverage
    || sizing.allowedLeverage > RISK_POLICY.baseMaxLeverage) {
    return rejected(input, 'Confidence 입력 또는 기존 risk/sizing 결과 INVALID', true);
  }
  if (shadow.confidence < policy.minimumConfidence) {
    return rejected(input, '최소 confidence 미달 — 신규 위험 0');
  }

  const confidenceSizeFactor = shadow.confidence >= policy.fullSizeConfidence
    ? 1
    : policy.minimumSizeFactor
      + ((shadow.confidence - policy.minimumConfidence)
        / (policy.fullSizeConfidence - policy.minimumConfidence))
        * (1 - policy.minimumSizeFactor);
  const finalAdvisoryNotionalUsd = sizing.finalAdvisoryNotionalUsd * confidenceSizeFactor;
  if (!finite(confidenceSizeFactor) || confidenceSizeFactor <= 0 || confidenceSizeFactor > 1
    || !finite(finalAdvisoryNotionalUsd) || finalAdvisoryNotionalUsd <= 0
    || finalAdvisoryNotionalUsd > sizing.finalAdvisoryNotionalUsd) {
    return rejected(input, 'Confidence 축소 결과 INVALID — 위험 확대 차단', true);
  }

  return {
    schemaVersion: STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION,
    advisoryId: `${shadow.shadowRecordId}:CONFIDENCE_RISK_REDUCTION`,
    signalId: shadow.signalId,
    symbol: symbol(shadow.symbol),
    status: confidenceSizeFactor === 1 ? 'UNCHANGED' : 'REDUCED',
    confidence: shadow.confidence,
    confidenceSizeFactor,
    inputNotionalUsd: sizing.finalAdvisoryNotionalUsd,
    finalAdvisoryNotionalUsd,
    allowedLeverage: sizing.allowedLeverage,
    reasons: [
      confidenceSizeFactor === 1 ? 'full-size confidence 충족 — 기존 sizing 유지' : 'confidence 기반 위험 축소',
      '기존 Risk·Structural sizing보다 notional/leverage 확대 불가',
      '실행·승인·PAPER/LIVE mutation 권한 없음',
    ],
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}
