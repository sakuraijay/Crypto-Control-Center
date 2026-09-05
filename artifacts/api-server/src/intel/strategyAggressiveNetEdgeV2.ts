/**
 * Pure aggressive Net-Edge advisory policy for Strategy Ensemble v2.
 *
 * "Aggressive" means accepting a bounded structural-stop loss budget only when
 * the expected gross edge materially dominates verified round-trip costs.
 * This module never increases authoritative risk limits and cannot authorize,
 * persist, submit, or mutate PAPER/LIVE execution state.
 */
import { isAppliedRiskProfileSnapshot, type AppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import type { StrategyGmxContextNetEdgeAdvisory } from './strategyGmxContextNetEdgeV2';
import type { StrategySignal } from './strategySignalV2';
import type { StrategyStructuralSizingAdvisory } from './strategyStructuralSizingV2';

export const STRATEGY_AGGRESSIVE_NET_EDGE_VERSION = 'strategy-aggressive-net-edge/v1' as const;

export interface AggressiveNetEdgeConfig {
  version: typeof STRATEGY_AGGRESSIVE_NET_EDGE_VERSION;
  minimumConfidence: number;
  minimumExpectedNetRR: number;
  minimumGrossEdgeToCostRatio: number;
}

export const DEFAULT_AGGRESSIVE_NET_EDGE_CONFIG: AggressiveNetEdgeConfig = Object.freeze({
  version: STRATEGY_AGGRESSIVE_NET_EDGE_VERSION,
  minimumConfidence: 80,
  minimumExpectedNetRR: 2,
  minimumGrossEdgeToCostRatio: 3,
});

export interface StrategyAggressiveNetEdgeInput {
  signal: StrategySignal;
  netEdge: StrategyGmxContextNetEdgeAdvisory;
  structuralSizing: StrategyStructuralSizingAdvisory;
  riskProfile: AppliedRiskProfileSnapshot;
}

export interface StrategyAggressiveNetEdgeAdvisory {
  schemaVersion: typeof STRATEGY_AGGRESSIVE_NET_EDGE_VERSION | 'INVALID';
  advisoryId: string;
  signalId: string | null;
  symbol: string;
  status: 'ELIGIBLE' | 'REJECTED' | 'NOT_EVALUATED';
  direction: 'LONG' | 'SHORT' | 'NONE';
  confidence: number | null;
  expectedNetRR: number | null;
  notionalUsd: number;
  structuralStopRiskUsd: number | null;
  maxProfileRiskUsd: number | null;
  structuralStopRiskPctOfCapital: number | null;
  grossEdgeToCostRatio: number | null;
  costAdjustedNetEdgeUsd: number | null;
  roundTripCostUsd: number | null;
  immutableCostCapUsd: number | null;
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const canonicalSymbol = (value: string): string => value.trim().toUpperCase();
const approximatelyEqual = (left: number, right: number): boolean =>
  Math.abs(left - right) <= Math.max(1e-8, Math.max(Math.abs(left), Math.abs(right)) * 1e-9);

export function validateAggressiveNetEdgeConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['config 객체 필요'];
  const record = value as Record<string, unknown>;
  const expected = ['version', 'minimumConfidence', 'minimumExpectedNetRR', 'minimumGrossEdgeToCostRatio'] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 config 필드: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`config 필드 누락: ${key}`);
  }
  if (record.version !== STRATEGY_AGGRESSIVE_NET_EDGE_VERSION) issues.push('지원하지 않는 config version');
  if (!finite(record.minimumConfidence) || record.minimumConfidence < 0 || record.minimumConfidence > 100) {
    issues.push('minimumConfidence 범위 오류');
  }
  if (!finite(record.minimumExpectedNetRR) || record.minimumExpectedNetRR <= 0) {
    issues.push('minimumExpectedNetRR 범위 오류');
  }
  if (!finite(record.minimumGrossEdgeToCostRatio) || record.minimumGrossEdgeToCostRatio <= 1) {
    issues.push('minimumGrossEdgeToCostRatio는 1보다 커야 함');
  }
  return issues;
}

function output(
  input: StrategyAggressiveNetEdgeInput,
  status: StrategyAggressiveNetEdgeAdvisory['status'],
  schemaVersion: StrategyAggressiveNetEdgeAdvisory['schemaVersion'],
  values: Partial<Pick<StrategyAggressiveNetEdgeAdvisory,
    'direction' | 'confidence' | 'expectedNetRR' | 'notionalUsd' | 'structuralStopRiskUsd'
    | 'maxProfileRiskUsd' | 'structuralStopRiskPctOfCapital' | 'grossEdgeToCostRatio'
    | 'costAdjustedNetEdgeUsd' | 'roundTripCostUsd' | 'immutableCostCapUsd'>>,
  reasons: string[],
): StrategyAggressiveNetEdgeAdvisory {
  const signalId = input.signal?.signalId ?? null;
  const symbol = input.signal?.symbol ? canonicalSymbol(input.signal.symbol) : '';
  return {
    schemaVersion,
    advisoryId: `${signalId ?? 'NO_SIGNAL'}:AGGRESSIVE_NET_EDGE`,
    signalId,
    symbol,
    status,
    direction: values.direction ?? 'NONE',
    confidence: values.confidence ?? null,
    expectedNetRR: values.expectedNetRR ?? null,
    notionalUsd: values.notionalUsd ?? 0,
    structuralStopRiskUsd: values.structuralStopRiskUsd ?? null,
    maxProfileRiskUsd: values.maxProfileRiskUsd ?? null,
    structuralStopRiskPctOfCapital: values.structuralStopRiskPctOfCapital ?? null,
    grossEdgeToCostRatio: values.grossEdgeToCostRatio ?? null,
    costAdjustedNetEdgeUsd: values.costAdjustedNetEdgeUsd ?? null,
    roundTripCostUsd: values.roundTripCostUsd ?? null,
    immutableCostCapUsd: values.immutableCostCapUsd ?? null,
    reasons,
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function authorityBoundariesValid(input: StrategyAggressiveNetEdgeInput): boolean {
  const netEdge = input.netEdge;
  const sizing = input.structuralSizing;
  return input.signal.schemaVersion === 'strategy-signal/v2'
    && netEdge.authority === 'ADVISORY_ONLY'
    && netEdge.externalReadStarted === false
    && netEdge.executionAuthorized === false
    && netEdge.approvalCreationAllowed === false
    && netEdge.paperPositionMutationAllowed === false
    && netEdge.livePositionMutationAllowed === false
    && sizing.authority === 'ADVISORY_ONLY'
    && sizing.executionAuthorized === false
    && sizing.approvalCreationAllowed === false
    && sizing.paperPositionMutationAllowed === false
    && sizing.livePositionMutationAllowed === false;
}

/**
 * Promote an already-selected, already-sized signal into an aggressive advisory candidate.
 * Risk Engine and all execution gates retain final veto authority.
 */
export function evaluateAggressiveNetEdge(
  input: StrategyAggressiveNetEdgeInput,
  configInput: unknown = DEFAULT_AGGRESSIVE_NET_EDGE_CONFIG,
): StrategyAggressiveNetEdgeAdvisory {
  const configIssues = validateAggressiveNetEdgeConfig(configInput);
  if (configIssues.length > 0) return output(input, 'REJECTED', 'INVALID', {}, ['config INVALID', ...configIssues]);
  const config = configInput as AggressiveNetEdgeConfig;

  if (!authorityBoundariesValid(input) || !isAppliedRiskProfileSnapshot(input.riskProfile)) {
    return output(input, 'REJECTED', 'INVALID', {}, ['Signal/NetEdge/Sizing/RiskProfile 권한 경계 INVALID — fail-closed']);
  }
  const { signal, netEdge, structuralSizing: sizing, riskProfile: profile } = input;
  const symbol = canonicalSymbol(signal.symbol);
  if (!signal.signalId.trim() || !symbol || netEdge.signalId !== signal.signalId || sizing.signalId !== signal.signalId
    || canonicalSymbol(netEdge.symbol) !== symbol || canonicalSymbol(sizing.symbol) !== symbol
    || (signal.direction !== 'LONG' && signal.direction !== 'SHORT')
    || sizing.direction !== signal.direction) {
    return output(input, 'REJECTED', 'INVALID', {}, ['Signal identity·symbol·direction 결속 INVALID — fail-closed']);
  }

  const baseValues = {
    direction: signal.direction,
    confidence: finite(signal.confidence) ? signal.confidence : null,
    expectedNetRR: finite(signal.expectedNetRR) ? signal.expectedNetRR : null,
    costAdjustedNetEdgeUsd: finite(netEdge.costAdjustedNetEdgeUsd) ? netEdge.costAdjustedNetEdgeUsd : null,
    roundTripCostUsd: finite(netEdge.roundTripCostUsd) ? netEdge.roundTripCostUsd : null,
    immutableCostCapUsd: finite(netEdge.immutableCostCapUsd) ? netEdge.immutableCostCapUsd : null,
    maxProfileRiskUsd: finite(profile.derivedLimits.maxRiskPerTradeUsd) ? profile.derivedLimits.maxRiskPerTradeUsd : null,
  } as const;

  if (profile.name !== 'aggressive') {
    return output(input, 'NOT_EVALUATED', STRATEGY_AGGRESSIVE_NET_EDGE_VERSION, baseValues,
      ['applied Risk Profile이 aggressive가 아님 — 공격형 전략 비활성']);
  }
  if (netEdge.schemaVersion !== 'strategy-gmx-context-net-edge/v1' || netEdge.status !== 'PASSED'
    || sizing.schemaVersion !== 'strategy-structural-sizing/v1' || sizing.status !== 'SIZED') {
    return output(input, 'NOT_EVALUATED', STRATEGY_AGGRESSIVE_NET_EDGE_VERSION, baseValues,
      ['검증된 Net Edge 또는 Structural Sizing 근거 없음 — 공격형 전략 미평가']);
  }
  if (!finite(netEdge.finalAdvisoryNotionalUsd) || netEdge.finalAdvisoryNotionalUsd <= 0
    || !finite(sizing.finalAdvisoryNotionalUsd) || sizing.finalAdvisoryNotionalUsd <= 0
    || !approximatelyEqual(netEdge.finalAdvisoryNotionalUsd, sizing.finalAdvisoryNotionalUsd)) {
    return output(input, 'NOT_EVALUATED', STRATEGY_AGGRESSIVE_NET_EDGE_VERSION, baseValues,
      ['Net Edge와 Structural Sizing의 동일 notional 결속 없음 — 재산출 없이 fail-closed']);
  }
  const notionalUsd = sizing.finalAdvisoryNotionalUsd;
  if (!finite(sizing.stopDistanceFraction) || sizing.stopDistanceFraction <= 0
    || !finite(profile.derivedLimits.allocatedTradingCapitalUsd)
    || profile.derivedLimits.allocatedTradingCapitalUsd <= 0
    || !finite(profile.derivedLimits.maxRiskPerTradeUsd)
    || profile.derivedLimits.maxRiskPerTradeUsd <= 0) {
    return output(input, 'REJECTED', 'INVALID', { ...baseValues, notionalUsd },
      ['Structural Stop 또는 active risk capital INVALID — fail-closed']);
  }

  const structuralStopRiskUsd = notionalUsd * sizing.stopDistanceFraction;
  const structuralStopRiskPctOfCapital = structuralStopRiskUsd
    / profile.derivedLimits.allocatedTradingCapitalUsd * 100;
  const grossEdgeUsd = netEdge.grossExpectedEdgeUsd;
  const roundTripCostUsd = netEdge.roundTripCostUsd;
  if (!finite(grossEdgeUsd) || grossEdgeUsd <= 0 || !finite(roundTripCostUsd) || roundTripCostUsd <= 0
    || !finite(netEdge.costAdjustedNetEdgeUsd) || netEdge.costAdjustedNetEdgeUsd <= 0
    || !finite(netEdge.immutableCostCapUsd) || netEdge.immutableCostCapUsd <= 0) {
    return output(input, 'REJECTED', 'INVALID', {
      ...baseValues, notionalUsd, structuralStopRiskUsd, structuralStopRiskPctOfCapital,
    }, ['Gross edge·round-trip cost·Net Edge 근거 INVALID — fail-closed']);
  }
  const grossEdgeToCostRatio = grossEdgeUsd / roundTripCostUsd;
  const values = {
    ...baseValues,
    notionalUsd,
    structuralStopRiskUsd,
    structuralStopRiskPctOfCapital,
    grossEdgeToCostRatio,
  };
  if (![structuralStopRiskUsd, structuralStopRiskPctOfCapital, grossEdgeToCostRatio].every(finite)) {
    return output(input, 'REJECTED', 'INVALID', values, ['공격형 경제성 산술 INVALID — fail-closed']);
  }

  const reasons: string[] = [];
  if (!finite(signal.confidence) || signal.confidence < config.minimumConfidence) {
    reasons.push(`confidence ${config.minimumConfidence} 미달`);
  }
  if (!finite(signal.expectedNetRR) || signal.expectedNetRR < config.minimumExpectedNetRR) {
    reasons.push(`Net R:R ${config.minimumExpectedNetRR} 미달`);
  }
  if (grossEdgeToCostRatio < config.minimumGrossEdgeToCostRatio) {
    reasons.push(`예상 gross edge가 왕복비용 ${config.minimumGrossEdgeToCostRatio}배 미만`);
  }
  if (roundTripCostUsd > netEdge.immutableCostCapUsd) {
    reasons.push('immutable 왕복비용 상한 초과');
  }
  if (structuralStopRiskUsd > profile.derivedLimits.maxRiskPerTradeUsd + 1e-8) {
    reasons.push('Structural Stop 기준 원금 위험이 applied aggressive profile 한도 초과');
  }
  if (sizing.allowedRiskUsd > profile.derivedLimits.maxRiskPerTradeUsd + 1e-8) {
    reasons.push('Sizing allowedRisk가 applied aggressive profile 한도 초과');
  }
  if (reasons.length > 0) {
    return output(input, 'REJECTED', STRATEGY_AGGRESSIVE_NET_EDGE_VERSION, values, reasons);
  }

  return output(input, 'ELIGIBLE', STRATEGY_AGGRESSIVE_NET_EDGE_VERSION, values, [
    `예상 gross edge가 검증된 왕복비용의 ${grossEdgeToCostRatio.toFixed(2)}배`,
    `Structural Stop 최대 손실 ${structuralStopRiskUsd.toFixed(4)} USD가 aggressive profile 위험예산 이내`,
    '공격형 후보일 뿐 Risk Engine·HARD_STOP·비용 상한·Execution Gate 최종 veto 유지',
  ]);
}
