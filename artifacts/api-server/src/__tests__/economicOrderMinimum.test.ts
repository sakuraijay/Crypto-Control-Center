import { describe, expect, it } from 'vitest';
import { calculateEconomicOrderMinimum, type EconomicCostEvidence } from '../lib/economicOrderMinimum';
import { MIN_ORDER_NOTIONAL_USD } from '../lib/orderSizingEnforcement';

const completeCost = (override: Partial<EconomicCostEvidence> = {}): EconomicCostEvidence => ({
  complete: true,
  evidenceNotionalUsd: 20,
  positionFeeUsd: 0.02,
  executionFeeUsd: 0.1,
  estimatedPriceImpactUsd: 0.01,
  estimatedExitFeeUsd: 0.02,
  estimatedExitPriceImpactUsd: 0.01,
  fundingFeeUsd: 0.002,
  borrowingFeeUsd: 0.002,
  fundingRatePerHourFraction: 0.0001,
  borrowingRatePerHourFraction: 0.0001,
  otherCostUsd: 0,
  effectiveRoundTripCostUsd: 0.164,
  ...override,
});

const calculate = (override: Partial<Parameters<typeof calculateEconomicOrderMinimum>[0]> = {}) =>
  calculateEconomicOrderMinimum({
    candidateNotionalUsd: 20,
    holdingHours: 1,
    expectedGrossEdge: { kind: 'fraction', fraction: 0.05, source: 'test-explicit-edge' },
    cost: completeCost(),
    immutableCostCapUsd: 0.4,
    ...override,
  });

describe('calculateEconomicOrderMinimum', () => {
  it('fails closed on missing cost data and zero/negative edge', () => {
    expect(calculate({ cost: completeCost({ executionFeeUsd: null }) })).toMatchObject({
      state: 'UNAVAILABLE', reason: 'COST_EVIDENCE_INCOMPLETE',
    });
    expect(calculate({
      expectedGrossEdge: { kind: 'fraction', fraction: 0, source: 'explicit' },
    })).toMatchObject({ state: 'UNAVAILABLE', reason: 'EXPECTED_GROSS_EDGE_NOT_STRICTLY_POSITIVE' });
    expect(calculate({
      expectedGrossEdge: { kind: 'fraction', fraction: -0.01, source: 'explicit' },
    })).toMatchObject({ state: 'UNAVAILABLE', reason: 'EXPECTED_GROSS_EDGE_NOT_STRICTLY_POSITIVE' });
  });

  it('uses the existing OPEN technical minimum when it dominates', () => {
    const result = calculate({ cost: completeCost({ executionFeeUsd: 0.001 }) });
    expect(result.state).toBe('AVAILABLE');
    expect(result.technicalMinimumNotionalUsd).toBe(MIN_ORDER_NOTIONAL_USD);
    expect(result.requiredMinimumNotionalUsd).toBe(MIN_ORDER_NOTIONAL_USD);
  });

  it('reports immutable cap relationship without replacing economic arithmetic', () => {
    const under = calculate();
    const over = calculate({
      cost: completeCost({ effectiveRoundTripCostUsd: 0.41 }),
    });
    expect(under.capRelationship).toBe('WITHIN_CAP');
    expect(over.capRelationship).toBe('EXCEEDS_CAP');
    expect(over.economicMinimumNotionalUsd).toBe(under.economicMinimumNotionalUsd);
  });

  it('is monotonic: higher complete fixed or variable costs cannot lower the minimum', () => {
    const base = calculate();
    const higherFixed = calculate({ cost: completeCost({ executionFeeUsd: 0.2 }) });
    const higherVariable = calculate({ cost: completeCost({ positionFeeUsd: 0.04 }) });
    expect(higherFixed.economicMinimumNotionalUsd!).toBeGreaterThanOrEqual(base.economicMinimumNotionalUsd!);
    expect(higherVariable.economicMinimumNotionalUsd!).toBeGreaterThanOrEqual(base.economicMinimumNotionalUsd!);
  });

  it('uses rate×hours carry once and never lets signed impact rebates lower the minimum', () => {
    const base = calculate();
    const differentQuotedCarry = calculate({
      cost: completeCost({ fundingFeeUsd: 0.02, borrowingFeeUsd: 0.02 }),
    });
    const rebate = calculate({
      cost: completeCost({
        estimatedPriceImpactUsd: -10,
        estimatedExitPriceImpactUsd: -10,
      }),
    });
    const zeroImpact = calculate({
      cost: completeCost({
        estimatedPriceImpactUsd: 0,
        estimatedExitPriceImpactUsd: 0,
      }),
    });
    expect(differentQuotedCarry.economicMinimumNotionalUsd).toBe(base.economicMinimumNotionalUsd);
    expect(rebate.economicMinimumNotionalUsd).toBe(zeroImpact.economicMinimumNotionalUsd);
  });

  it('treats adverse quoted impact as fixed and refuses extrapolation beyond evidence notional', () => {
    const base = calculate();
    const impacted = calculate({
      cost: completeCost({ estimatedPriceImpactUsd: 0.1 }),
    });
    expect(impacted.economicMinimumNotionalUsd!).toBeGreaterThan(base.economicMinimumNotionalUsd!);
    expect(calculate({
      candidateNotionalUsd: 20.01,
    })).toMatchObject({ state: 'UNAVAILABLE', reason: 'CANDIDATE_OUTSIDE_EVIDENCE_DOMAIN' });
    expect(calculate({
      cost: completeCost({ executionFeeUsd: 1 }),
    })).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'ECONOMIC_MINIMUM_OUTSIDE_EVIDENCE_DOMAIN',
    });
  });

  it('fails closed when edge does not exceed complete variable cost rate', () => {
    expect(calculate({
      expectedGrossEdge: { kind: 'fraction', fraction: 0.001, source: 'explicit' },
    })).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'ECONOMIC_DENOMINATOR_NON_POSITIVE',
    });
  });

  it('rounds infinitesimally above a cent strictly upward and rejects overflow', () => {
    const rounded = calculate({
      // variable rate is .0022 and fixed cost is .12; this produces
      // $2.2000000001 before cent rounding.
      expectedGrossEdge: { kind: 'fraction', fraction: 0.05674545454338843, source: 'explicit' },
    });
    expect(rounded.economicMinimumNotionalUsd).toBe(2.21);
    expect(calculate({
      expectedGrossEdge: { kind: 'fraction', fraction: 1e-320, source: 'explicit' },
      cost: completeCost({ positionFeeUsd: 0, estimatedExitFeeUsd: 0, estimatedPriceImpactUsd: 0, estimatedExitPriceImpactUsd: 0, fundingRatePerHourFraction: 0, borrowingRatePerHourFraction: 0 }),
    })).toMatchObject({ state: 'UNAVAILABLE' });
  });

  it('normalizes an explicit absolute edge only against its explicit matching candidate notional', () => {
    const result = calculate({
      expectedGrossEdge: {
        kind: 'absolute_usd', amountUsd: 1, candidateNotionalUsd: 20, source: 'paper-candidate',
      },
    });
    expect(result.expectedGrossEdgeFraction).toBe(0.05);
    expect(calculate({
      expectedGrossEdge: {
        kind: 'absolute_usd', amountUsd: 1, candidateNotionalUsd: 10, source: 'paper-candidate',
      },
    }).state).toBe('UNAVAILABLE');
  });
});