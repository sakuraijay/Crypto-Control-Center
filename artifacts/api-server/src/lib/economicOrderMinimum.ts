/**
 * DB-free PAPER/read-only economic order minimum.
 *
 * This is diagnostic arithmetic only. It neither replaces cost freshness/cap
 * gates nor authorizes an OPEN.
 */
import { MIN_ORDER_NOTIONAL_USD } from './orderSizingEnforcement';

export type ExpectedGrossEdge =
  | { kind: 'fraction'; fraction: number; source: string }
  | { kind: 'absolute_usd'; amountUsd: number; candidateNotionalUsd: number; source: string };

export interface EconomicCostEvidence {
  complete: boolean;
  evidenceNotionalUsd: number | null;
  positionFeeUsd: number | null;
  executionFeeUsd: number | null;
  estimatedPriceImpactUsd: number | null;
  estimatedExitFeeUsd: number | null;
  estimatedExitPriceImpactUsd: number | null;
  fundingFeeUsd: number | null;
  borrowingFeeUsd: number | null;
  fundingRatePerHourFraction: number | null;
  borrowingRatePerHourFraction: number | null;
  otherCostUsd: number | null;
  effectiveRoundTripCostUsd: number | null;
}

export type EconomicOrderMinimumResult = {
  state: 'AVAILABLE' | 'UNAVAILABLE';
  reason: string | null;
  candidateNotionalUsd: number | null;
  holdingHours: number | null;
  expectedGrossEdgeFraction: number | null;
  expectedGrossEdgeUsd: number | null;
  expectedGrossEdgeSource: string | null;
  fixedExecutionCostUsd: number | null;
  variableCostRateFraction: number | null;
  denominatorFraction: number | null;
  economicMinimumNotionalUsd: number | null;
  technicalMinimumNotionalUsd: number;
  requiredMinimumNotionalUsd: number | null;
  candidateSufficient: boolean | null;
  capUsd: number | null;
  capRelationship: 'WITHIN_CAP' | 'EXCEEDS_CAP' | 'UNAVAILABLE';
};

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const centsUp = (value: number): number => Math.ceil(value * 100) / 100;

function unavailable(
  reason: string,
  candidateNotionalUsd: number | null,
  holdingHours: number | null,
  capUsd: number | null,
): EconomicOrderMinimumResult {
  return {
    state: 'UNAVAILABLE',
    reason,
    candidateNotionalUsd,
    holdingHours,
    expectedGrossEdgeFraction: null,
    expectedGrossEdgeUsd: null,
    expectedGrossEdgeSource: null,
    fixedExecutionCostUsd: null,
    variableCostRateFraction: null,
    denominatorFraction: null,
    economicMinimumNotionalUsd: null,
    technicalMinimumNotionalUsd: MIN_ORDER_NOTIONAL_USD,
    requiredMinimumNotionalUsd: null,
    candidateSufficient: null,
    capUsd: finite(capUsd) ? capUsd : null,
    capRelationship: 'UNAVAILABLE',
  };
}

export function calculateEconomicOrderMinimum(input: {
  candidateNotionalUsd: number;
  holdingHours: number;
  expectedGrossEdge: ExpectedGrossEdge | null;
  cost: EconomicCostEvidence;
  immutableCostCapUsd: number;
}): EconomicOrderMinimumResult {
  const candidate = input.candidateNotionalUsd;
  if (!finite(candidate) || candidate <= 0) {
    return unavailable('CANDIDATE_NOTIONAL_UNAVAILABLE', null, input.holdingHours, input.immutableCostCapUsd);
  }
  if (!finite(input.holdingHours) || input.holdingHours < 0) {
    return unavailable('HOLDING_HOURS_UNAVAILABLE', candidate, null, input.immutableCostCapUsd);
  }
  if (!input.expectedGrossEdge) {
    return unavailable('EXPECTED_GROSS_EDGE_UNAVAILABLE', candidate, input.holdingHours, input.immutableCostCapUsd);
  }

  const edgeFraction = input.expectedGrossEdge.kind === 'fraction'
    ? input.expectedGrossEdge.fraction
    : input.expectedGrossEdge.amountUsd / input.expectedGrossEdge.candidateNotionalUsd;
  const absoluteBasisValid = input.expectedGrossEdge.kind === 'fraction'
    || (finite(input.expectedGrossEdge.amountUsd)
      && finite(input.expectedGrossEdge.candidateNotionalUsd)
      && input.expectedGrossEdge.candidateNotionalUsd > 0
      && Math.abs(input.expectedGrossEdge.candidateNotionalUsd - candidate) < 0.000001);
  if (!absoluteBasisValid || !finite(edgeFraction) || edgeFraction <= 0) {
    return unavailable('EXPECTED_GROSS_EDGE_NOT_STRICTLY_POSITIVE', candidate, input.holdingHours, input.immutableCostCapUsd);
  }

  const costValues = [
    input.cost.evidenceNotionalUsd,
    input.cost.positionFeeUsd,
    input.cost.executionFeeUsd,
    input.cost.estimatedPriceImpactUsd,
    input.cost.estimatedExitFeeUsd,
    input.cost.estimatedExitPriceImpactUsd,
    input.cost.fundingFeeUsd,
    input.cost.borrowingFeeUsd,
    input.cost.fundingRatePerHourFraction,
    input.cost.borrowingRatePerHourFraction,
    input.cost.otherCostUsd,
    input.cost.effectiveRoundTripCostUsd,
  ];
  if (!input.cost.complete || costValues.some((value) => value === null || !finite(value))) {
    return unavailable('COST_EVIDENCE_INCOMPLETE', candidate, input.holdingHours, input.immutableCostCapUsd);
  }
  const evidenceNotional = input.cost.evidenceNotionalUsd as number;
  const execution = input.cost.executionFeeUsd as number;
  const cap = input.immutableCostCapUsd;
  if (evidenceNotional <= 0 || execution < 0 || !finite(cap) || cap <= 0) {
    return unavailable('COST_DATA_UNAVAILABLE', candidate, input.holdingHours, cap);
  }
  const nonNegativeCosts = [
    input.cost.positionFeeUsd,
    input.cost.executionFeeUsd,
    input.cost.estimatedExitFeeUsd,
    input.cost.fundingFeeUsd,
    input.cost.borrowingFeeUsd,
    input.cost.fundingRatePerHourFraction,
    input.cost.borrowingRatePerHourFraction,
    input.cost.otherCostUsd,
    input.cost.effectiveRoundTripCostUsd,
  ] as number[];
  if (nonNegativeCosts.some((value) => value < 0)) {
    return unavailable('COST_DATA_UNAVAILABLE', candidate, input.holdingHours, cap);
  }
  if (candidate > evidenceNotional) {
    return unavailable('CANDIDATE_OUTSIDE_EVIDENCE_DOMAIN', candidate, input.holdingHours, cap);
  }

  const feeUsd = (input.cost.positionFeeUsd as number)
    + (input.cost.estimatedExitFeeUsd as number);
  // Quote impact is non-linear. It is a fixed conservative quote-domain cost,
  // never a rate and never a rebate credit. The snapshot's bounded-impact
  // validation remains upstream; economics additionally floors rebates at zero.
  const fixedCost = execution
    + Math.max(input.cost.estimatedPriceImpactUsd as number, 0)
    + Math.max(input.cost.estimatedExitPriceImpactUsd as number, 0)
    + Math.max(input.cost.otherCostUsd as number, 0);
  const variableQuoteUsd = feeUsd;
  const carryRate = (input.cost.fundingRatePerHourFraction as number)
    + (input.cost.borrowingRatePerHourFraction as number);
  const variableRate = variableQuoteUsd / evidenceNotional + carryRate * input.holdingHours;
  const denominator = edgeFraction - variableRate;
  if (!finite(variableRate) || variableRate < 0 || !finite(denominator) || denominator <= 0) {
    return unavailable('ECONOMIC_DENOMINATOR_NON_POSITIVE', candidate, input.holdingHours, cap);
  }

  const economicMinimum = centsUp(fixedCost / denominator);
  // Both operands are already cent-rounded (the exported technical minimum is
  // a fixed cent value), so applying ceil again could falsely add a cent from
  // binary representation. Do not subtract an epsilon from economic math.
  const requiredMinimum = Math.max(economicMinimum, MIN_ORDER_NOTIONAL_USD);
  if (!finite(economicMinimum) || !finite(requiredMinimum) || economicMinimum <= 0
    || requiredMinimum <= 0 || !Number.isSafeInteger(Math.ceil(economicMinimum * 100))
    || !Number.isSafeInteger(Math.ceil(requiredMinimum * 100))) {
    return unavailable('ECONOMIC_MINIMUM_OVERFLOW', candidate, input.holdingHours, cap);
  }
  if (economicMinimum > evidenceNotional) {
    return unavailable('ECONOMIC_MINIMUM_OUTSIDE_EVIDENCE_DOMAIN', candidate, input.holdingHours, cap);
  }
  const quoteCost = input.cost.effectiveRoundTripCostUsd as number;
  return {
    state: 'AVAILABLE',
    reason: null,
    candidateNotionalUsd: candidate,
    holdingHours: input.holdingHours,
    expectedGrossEdgeFraction: edgeFraction,
    expectedGrossEdgeUsd: edgeFraction * candidate,
    expectedGrossEdgeSource: input.expectedGrossEdge.source,
    fixedExecutionCostUsd: fixedCost,
    variableCostRateFraction: variableRate,
    denominatorFraction: denominator,
    economicMinimumNotionalUsd: economicMinimum,
    technicalMinimumNotionalUsd: MIN_ORDER_NOTIONAL_USD,
    requiredMinimumNotionalUsd: requiredMinimum,
    candidateSufficient: candidate >= requiredMinimum,
    capUsd: cap,
    capRelationship: quoteCost <= cap ? 'WITHIN_CAP' : 'EXCEEDS_CAP',
  };
}