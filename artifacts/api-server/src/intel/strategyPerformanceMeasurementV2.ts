import {
  STRATEGY_AGGRESSIVE_NET_EDGE_VERSION,
  type StrategyAggressiveNetEdgeAdvisory,
} from './strategyAggressiveNetEdgeV2';
import type { StrategyDecisionExplainabilityEnvelope } from './strategyDecisionExplainabilityV2';
import type { StrategyRiskAdapterDecision } from './strategyRiskAdapterV2';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';
import { validateStrategyNetEdgeResearchResult } from './strategyNetEdgeResearchGateV1';
import { MANUAL_CANARY_CAPS } from '../lib/manualCanaryCaps';

export const STRATEGY_PERFORMANCE_MEASUREMENT_VERSION =
  'strategy-performance-measurement/v1' as const;
export const IMMUTABLE_PERFORMANCE_COST_CAP_USD = MANUAL_CANARY_CAPS.maxRoundTripCostUsd;
const PERFORMANCE_HORIZON_MS = 4 * 60 * 60 * 1_000;
const COST_EVIDENCE_MAX_TTL_MS = 60_000;

export type StrategyPerformanceVariant = 'STANDARD_EXISTING' | 'AGGRESSIVE_CANDIDATE';

export interface StrategyPerformanceCandidate {
  candidateId: string;
  variant: StrategyPerformanceVariant;
  strategyId: string;
  regime: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  evaluatedAt: number;
  notionalUsd: number | null;
  expectedTotalCostUsd: number | null;
  costEvidenceId: string | null;
  costEvidenceObservedAtMs: number | null;
  costEvidenceExpiresAtMs: number | null;
  riskUsd: number | null;
  status: 'ELIGIBLE' | 'REJECTED' | 'NOT_EVALUATED';
  reasons: string[];
  authority: 'MEASUREMENT_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

export interface StrategyPerformanceMeasurementPlan {
  schemaVersion: typeof STRATEGY_PERFORMANCE_MEASUREMENT_VERSION;
  mode: 'SHADOW_PAPER_ONLY';
  candidates: StrategyPerformanceCandidate[];
  immutableCostCapUsd: typeof IMMUTABLE_PERFORMANCE_COST_CAP_USD;
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function candidate(
  shadow: StrategyShadowRecord,
  variant: StrategyPerformanceVariant,
  notionalUsd: number | null,
  totalCostUsd: number | null,
  costEvidence: {
    id: string;
    observedAtMs: number;
    expiresAtMs: number;
  } | null,
  riskUsd: number | null,
  status: StrategyPerformanceCandidate['status'],
  reasons: string[],
): StrategyPerformanceCandidate | null {
  if (shadow.strategyId === null || shadow.signalId === null
    || (shadow.direction !== 'LONG' && shadow.direction !== 'SHORT')) return null;
  return {
    candidateId: `${shadow.shadowRecordId}:PERFORMANCE:${variant}`,
    variant,
    strategyId: shadow.strategyId,
    regime: shadow.regime,
    symbol: shadow.symbol.trim().toUpperCase(),
    direction: shadow.direction,
    evaluatedAt: shadow.evaluatedAt,
    notionalUsd,
    expectedTotalCostUsd: totalCostUsd,
    costEvidenceId: costEvidence?.id ?? null,
    costEvidenceObservedAtMs: costEvidence?.observedAtMs ?? null,
    costEvidenceExpiresAtMs: costEvidence?.expiresAtMs ?? null,
    riskUsd,
    status,
    reasons,
    authority: 'MEASUREMENT_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

export function buildStrategyPerformanceMeasurementPlan(input: {
  shadowRecords: readonly StrategyShadowRecord[];
  riskDecisions: readonly StrategyRiskAdapterDecision[];
  envelopes: readonly StrategyDecisionExplainabilityEnvelope[];
  aggressiveAdvisories: readonly (StrategyAggressiveNetEdgeAdvisory | null)[];
}): StrategyPerformanceMeasurementPlan {
  const candidates: StrategyPerformanceCandidate[] = [];
  if (input.shadowRecords.length !== input.riskDecisions.length
    || input.shadowRecords.length !== input.envelopes.length
    || input.shadowRecords.length !== input.aggressiveAdvisories.length) {
    return emptyStrategyPerformanceMeasurementPlan();
  }
  input.shadowRecords.forEach((shadow, index) => {
    const risk = input.riskDecisions[index];
    const envelope = input.envelopes[index];
    const aggressive = input.aggressiveAdvisories[index];
    const research = shadow.netEdgeResearch ?? null;
    const researchIssues = validateStrategyNetEdgeResearchResult(research, {
      signalId: shadow.signalId,
      symbol: shadow.symbol,
      strategyId: shadow.strategyId,
      confidence: shadow.confidence,
      expectedNetEdgeBps: shadow.expectedNetEdgeBps,
      expectedNetRR: shadow.expectedNetRR,
      lifecycleEligible: shadow.lifecycleEligible,
      action: shadow.action,
      evaluatedAt: shadow.evaluatedAt,
    });
    const cost = research?.expectedRoundTripCost?.usd ?? null;
    const costOk = researchIssues.length === 0 && research?.eligible === true
      && finite(cost) && cost > 0 && cost <= IMMUTABLE_PERFORMANCE_COST_CAP_USD;
    const riskOk = risk.action === 'ALLOW' || risk.action === 'REDUCE';
    const gmx = envelope.stages.gmxNetEdge;
    const researchNotional = research?.costEvidence?.notionalUsd ?? null;
    const costQuote = research?.costEvidence && research.expectedRoundTripCost
      ? research.costEvidence.directionalQuotes[research.costEvidence.conservativeBasisDirection]
      : null;
    const gmxBindingOk = gmx === null || (gmx.status === 'PASSED'
      && gmx.finalAdvisoryNotionalUsd === researchNotional
      && gmx.roundTripCostUsd === cost
      && gmx.immutableCostCapUsd === IMMUTABLE_PERFORMANCE_COST_CAP_USD);
    const standardNotional = gmx === null ? researchNotional : gmx.finalAdvisoryNotionalUsd;
    const costEvidence = costOk && gmxBindingOk && costQuote
      ? {
          id: `${shadow.shadowRecordId}:RESEARCH_COST:${costQuote.observedAtMs}`,
          observedAtMs: costQuote.observedAtMs,
          expiresAtMs: costQuote.expiresAtMs,
        } : null;
    const standardRiskUsd = research?.riskBps !== null && research?.riskBps !== undefined
      && finite(standardNotional) && standardNotional > 0
      ? standardNotional * research.riskBps / 10_000 : null;
    const standardEligible = costOk && gmxBindingOk && riskOk && shadow.lifecycleEligible === true
      && finite(standardNotional) && standardNotional > 0;
    const standard = candidate(
      shadow, 'STANDARD_EXISTING',
      standardEligible ? standardNotional : null,
      standardEligible ? cost : null,
      standardEligible ? costEvidence : null,
      standardEligible
        ? (envelope.stages.sizing?.allowedRiskUsd ?? standardRiskUsd) : null,
      standardEligible ? 'ELIGIBLE'
        : risk.action === 'REJECT' || gmx?.status === 'REJECTED' ? 'REJECTED' : 'NOT_EVALUATED',
      standardEligible ? ['fresh Research/Risk/GMX evidence bound for measurement only']
        : [...researchIssues, ...(!costOk ? ['fresh cost evidence 또는 $0.40 cap 미충족'] : []),
          ...(!gmxBindingOk ? ['GMX/Research exact-notional 비용 결속 실패'] : []),
          ...(!riskOk ? ['Risk Engine veto'] : [])],
    );
    if (standard) candidates.push(standard);

    if (aggressive !== null) {
      const sizing = envelope.stages.sizing;
      const aggressiveBoundaryOk = aggressive.schemaVersion === STRATEGY_AGGRESSIVE_NET_EDGE_VERSION
        && aggressive.advisoryId === `${shadow.signalId}:AGGRESSIVE_NET_EDGE`
        && aggressive.signalId === shadow.signalId
        && aggressive.symbol === shadow.symbol.trim().toUpperCase()
        && aggressive.direction === shadow.direction
        && aggressive.confidence === shadow.confidence
        && aggressive.expectedNetRR === research?.expectedNetRR
        && aggressive.authority === 'ADVISORY_ONLY'
        && aggressive.executionAuthorized === false && aggressive.approvalCreationAllowed === false
        && aggressive.paperPositionMutationAllowed === false
        && aggressive.livePositionMutationAllowed === false
        && aggressive.notionalUsd === standardNotional
        && aggressive.roundTripCostUsd === cost
        && aggressive.costAdjustedNetEdgeUsd === gmx?.costAdjustedNetEdgeUsd
        && aggressive.immutableCostCapUsd === IMMUTABLE_PERFORMANCE_COST_CAP_USD
        && finite(aggressive.structuralStopRiskUsd) && aggressive.structuralStopRiskUsd > 0
        && finite(aggressive.maxProfileRiskUsd)
        && aggressive.maxProfileRiskUsd >= aggressive.structuralStopRiskUsd
        && sizing !== null && finite(sizing.allowedRiskUsd)
        && sizing.allowedRiskUsd >= aggressive.structuralStopRiskUsd
        && finite(aggressive.grossEdgeToCostRatio)
        && aggressive.grossEdgeToCostRatio ===
          (research?.expectedGrossEdge?.usd ?? Number.NaN) / (cost ?? Number.NaN);
      const aggressiveEligible = standardEligible && aggressiveBoundaryOk
        && aggressive.status === 'ELIGIBLE'
        && aggressive.applicability === 'APPLICABLE'
        && finite(aggressive.notionalUsd) && aggressive.notionalUsd > 0;
      const aggressiveCandidate = candidate(
        shadow, 'AGGRESSIVE_CANDIDATE',
        aggressiveEligible ? aggressive.notionalUsd : null,
        aggressiveEligible ? cost : null,
        aggressiveEligible ? costEvidence : null,
        aggressiveEligible ? aggressive.structuralStopRiskUsd : null,
        aggressiveEligible ? 'ELIGIBLE'
          : aggressive.status === 'REJECTED' || risk.action === 'REJECT' ? 'REJECTED' : 'NOT_EVALUATED',
        aggressiveEligible ? ['Aggressive advisory passed Research Gate and Risk Engine for measurement only']
          : ['Aggressive requires eligible Standard evidence, Research Gate, Risk Engine and immutable cost cap'],
      );
      if (aggressiveCandidate) candidates.push(aggressiveCandidate);
    }
  });
  return {
    ...emptyStrategyPerformanceMeasurementPlan(),
    candidates,
  };
}

export function emptyStrategyPerformanceMeasurementPlan(): StrategyPerformanceMeasurementPlan {
  return {
    schemaVersion: STRATEGY_PERFORMANCE_MEASUREMENT_VERSION,
    mode: 'SHADOW_PAPER_ONLY',
    candidates: [],
    immutableCostCapUsd: IMMUTABLE_PERFORMANCE_COST_CAP_USD,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

export interface StrategyPerformanceObservation {
  candidateId: string;
  variant: StrategyPerformanceVariant;
  strategyId: string;
  regime: string;
  direction: 'LONG' | 'SHORT';
  measuredAtMs: number;
  horizonHours: 4;
  outcomeWindowStartedAtMs: number;
  outcomeWindowEndedAtMs: number;
  completionEvidenceId: string | null;
  outcomeStatus: 'COMPLETE' | 'INCOMPLETE' | 'AMBIGUOUS_INTRABAR' | 'DATA_UNAVAILABLE';
  costEvidenceId: string | null;
  grossPnlUsd: number | null;
  totalCostUsd: number | null;
  netPnlUsd: number | null;
  riskUsd: number | null;
}

export interface StrategyPerformanceMetrics {
  tradeCount: number;
  grossPnlUsd: number;
  totalCostUsd: number;
  netPnlUsd: number;
  feeToGrossRatio: number | null;
  expectancyUsd: number;
  profitFactor: number | null;
  winRate: number;
  maxDrawdownUsd: number;
  averageR: number | null;
}

export interface StrategyPerformanceAggregate {
  schemaVersion: typeof STRATEGY_PERFORMANCE_MEASUREMENT_VERSION;
  status: 'OK' | 'NOT_EVALUATED';
  excludedCount: number;
  overall: StrategyPerformanceMetrics | null;
  byStrategy: Record<string, StrategyPerformanceMetrics>;
  byRegime: Record<string, StrategyPerformanceMetrics>;
  byVariant: Record<StrategyPerformanceVariant, StrategyPerformanceMetrics | null>;
  byStrategyRegimeVariant: Record<string, StrategyPerformanceMetrics>;
  authority: 'MEASUREMENT_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

function aggregate(rows: StrategyPerformanceObservation[]): StrategyPerformanceMetrics {
  const ordered = [...rows].sort((a, b) => a.measuredAtMs - b.measuredAtMs
    || a.candidateId.localeCompare(b.candidateId));
  const grossPnlUsd = ordered.reduce((sum, row) => sum + (row.grossPnlUsd as number), 0);
  const totalCostUsd = ordered.reduce((sum, row) => sum + (row.totalCostUsd as number), 0);
  const netPnlUsd = ordered.reduce((sum, row) => sum + (row.netPnlUsd as number), 0);
  const grossProfit = ordered.filter(row => (row.grossPnlUsd as number) > 0)
    .reduce((sum, row) => sum + (row.grossPnlUsd as number), 0);
  const wins = ordered.filter(row => (row.netPnlUsd as number) > 0);
  const netWins = wins.reduce((sum, row) => sum + (row.netPnlUsd as number), 0);
  const netLosses = Math.abs(ordered.filter(row => (row.netPnlUsd as number) < 0)
    .reduce((sum, row) => sum + (row.netPnlUsd as number), 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const row of ordered) {
    equity += row.netPnlUsd as number;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  const rRows = ordered.filter(row => finite(row.riskUsd) && (row.riskUsd as number) > 0);
  return {
    tradeCount: ordered.length,
    grossPnlUsd,
    totalCostUsd,
    netPnlUsd,
    feeToGrossRatio: grossProfit > 0 ? totalCostUsd / grossProfit : null,
    expectancyUsd: netPnlUsd / ordered.length,
    profitFactor: netLosses > 0 ? netWins / netLosses : null,
    winRate: wins.length / ordered.length,
    maxDrawdownUsd,
    averageR: rRows.length > 0
      ? rRows.reduce((sum, row) => sum + (row.netPnlUsd as number) / (row.riskUsd as number), 0)
        / rRows.length : null,
  };
}

function eligibleCandidateIsValid(candidate: StrategyPerformanceCandidate): boolean {
  return candidate.status === 'ELIGIBLE'
    && candidate.candidateId.length > 0 && candidate.strategyId.length > 0
    && candidate.regime.length > 0 && candidate.symbol.length > 0
    && (candidate.variant === 'STANDARD_EXISTING' || candidate.variant === 'AGGRESSIVE_CANDIDATE')
    && (candidate.direction === 'LONG' || candidate.direction === 'SHORT')
    && finite(candidate.evaluatedAt) && candidate.evaluatedAt > 0
    && finite(candidate.notionalUsd) && candidate.notionalUsd > 0
    && finite(candidate.expectedTotalCostUsd) && candidate.expectedTotalCostUsd > 0
    && candidate.expectedTotalCostUsd <= IMMUTABLE_PERFORMANCE_COST_CAP_USD
    && typeof candidate.costEvidenceId === 'string' && candidate.costEvidenceId.length > 0
    && finite(candidate.costEvidenceObservedAtMs) && candidate.costEvidenceObservedAtMs > 0
    && finite(candidate.costEvidenceExpiresAtMs)
    && candidate.costEvidenceExpiresAtMs >= candidate.evaluatedAt
    && candidate.costEvidenceObservedAtMs <= candidate.evaluatedAt
    && candidate.costEvidenceExpiresAtMs > candidate.costEvidenceObservedAtMs
    && candidate.costEvidenceExpiresAtMs - candidate.costEvidenceObservedAtMs <= COST_EVIDENCE_MAX_TTL_MS
    && (candidate.riskUsd === null || (finite(candidate.riskUsd) && candidate.riskUsd > 0))
    && candidate.authority === 'MEASUREMENT_ONLY'
    && candidate.executionAuthorized === false && candidate.approvalCreationAllowed === false
    && candidate.paperPositionMutationAllowed === false
    && candidate.livePositionMutationAllowed === false;
}

export function computeStrategyPerformanceAggregate(
  input: {
    plan: StrategyPerformanceMeasurementPlan;
    observations: readonly StrategyPerformanceObservation[];
  },
): StrategyPerformanceAggregate {
  const duplicatePlanIds = new Set<string>();
  const candidateById = new Map<string, StrategyPerformanceCandidate>();
  for (const candidateValue of input.plan.candidates) {
    if (candidateById.has(candidateValue.candidateId)) duplicatePlanIds.add(candidateValue.candidateId);
    candidateById.set(candidateValue.candidateId, candidateValue);
  }
  const observationCounts = new Map<string, number>();
  for (const row of input.observations) {
    observationCounts.set(row.candidateId, (observationCounts.get(row.candidateId) ?? 0) + 1);
  }
  const planSafe = input.plan.schemaVersion === STRATEGY_PERFORMANCE_MEASUREMENT_VERSION
    && input.plan.mode === 'SHADOW_PAPER_ONLY'
    && input.plan.immutableCostCapUsd === IMMUTABLE_PERFORMANCE_COST_CAP_USD
    && input.plan.executionAuthorized === false && input.plan.approvalCreationAllowed === false
    && input.plan.paperPositionMutationAllowed === false
    && input.plan.livePositionMutationAllowed === false;
  const valid = input.observations.filter(row => {
    const issued = candidateById.get(row.candidateId);
    return planSafe && issued !== undefined && eligibleCandidateIsValid(issued)
    && !duplicatePlanIds.has(row.candidateId) && observationCounts.get(row.candidateId) === 1
    && issued.variant === row.variant && issued.strategyId === row.strategyId
    && issued.regime === row.regime && issued.direction === row.direction
    && issued.costEvidenceId !== null && row.costEvidenceId === issued.costEvidenceId
    && finite(issued.expectedTotalCostUsd) && issued.expectedTotalCostUsd >= 0
    && row.totalCostUsd === issued.expectedTotalCostUsd
    && row.riskUsd === issued.riskUsd
    && row.horizonHours === 4
    && typeof row.completionEvidenceId === 'string' && row.completionEvidenceId.length > 0
    && finite(row.outcomeWindowStartedAtMs) && finite(row.outcomeWindowEndedAtMs)
    && row.outcomeWindowStartedAtMs >= issued.evaluatedAt
    && row.outcomeWindowEndedAtMs - row.outcomeWindowStartedAtMs >= PERFORMANCE_HORIZON_MS
    && row.measuredAtMs >= row.outcomeWindowEndedAtMs
    && row.outcomeStatus === 'COMPLETE'
    && finite(row.measuredAtMs) && row.measuredAtMs > 0
    && row.measuredAtMs >= issued.evaluatedAt
    && finite(row.grossPnlUsd) && finite(row.totalCostUsd) && row.totalCostUsd >= 0
    && finite(row.netPnlUsd)
    && Math.abs((row.grossPnlUsd - row.totalCostUsd) - row.netPnlUsd) <= 1e-6;
  });
  const grouped = (key: (row: StrategyPerformanceObservation) => string) => {
    const map = new Map<string, StrategyPerformanceObservation[]>();
    for (const row of valid) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
    return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => [name, aggregate(rows)]));
  };
  return {
    schemaVersion: STRATEGY_PERFORMANCE_MEASUREMENT_VERSION,
    status: valid.length > 0 ? 'OK' : 'NOT_EVALUATED',
    excludedCount: input.observations.length - valid.length,
    overall: valid.length > 0 ? aggregate(valid) : null,
    byStrategy: grouped(row => row.strategyId),
    byRegime: grouped(row => row.regime),
    byVariant: {
      STANDARD_EXISTING: valid.some(row => row.variant === 'STANDARD_EXISTING')
        ? aggregate(valid.filter(row => row.variant === 'STANDARD_EXISTING')) : null,
      AGGRESSIVE_CANDIDATE: valid.some(row => row.variant === 'AGGRESSIVE_CANDIDATE')
        ? aggregate(valid.filter(row => row.variant === 'AGGRESSIVE_CANDIDATE')) : null,
    },
    byStrategyRegimeVariant: grouped(row =>
      `${row.strategyId}|${row.regime}|${row.variant}|${row.direction}`),
    authority: 'MEASUREMENT_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}