import { describe, expect, it } from 'vitest';
import type { PaperRuntimeReadinessView } from '../lib/paperRuntimeReadiness';
import {
  buildPublicReadinessAttestation,
} from '../lib/publicReadinessAttestation';

function paperSnapshot(): PaperRuntimeReadinessView {
  const cost = (symbol: 'BTC' | 'ETH') => ({
    state: 'verified' as const,
    attemptedAtMs: 1_788_000_000_000,
    observedAtMs: 1_788_000_000_000,
    ageMs: 1_000,
    fresh: true,
    failureId: null,
    detail: null,
    evidenceRole: 'OBSERVATIONAL_READ_ONLY' as const,
    observationalFresh: true,
    symbol,
    direction: 'LONG' as const,
    notionalUsd: 20,
    holdingHours: 1,
    capUsd: 0.4,
    positionFeeUsd: 0.1,
    executionFeeUsd: 0.1,
    estimatedPriceImpactUsd: 0.05,
    fundingFeeUsd: 0.01,
    borrowingFeeUsd: 0.01,
    fundingRatePerHourFraction: 0.0001,
    borrowingRatePerHourFraction: 0.0001,
    estimatedExitFeeUsd: 0.05,
    estimatedExitPriceImpactUsd: 0.02,
    tradingFeesUsd: 0.25,
    priceImpactTotalUsd: 0.07,
    carryCostUsd: 0.02,
    otherCostUsd: 0,
    effectiveRoundTripCostUsd: 0.34,
    totalCostRatePct: 1.7,
    capDeltaUsd: 0.06,
    capExcessUsd: 0,
    capExcessRatePct: 0,
    requiredCostReductionUsd: 0,
    requiredCostReductionPct: 0,
    breakEvenGrossMoveUsd: 0.34,
    breakEvenGrossMovePct: 1.7,
    withinCap: true,
    blockReason: null,
    executionSnapshot: {
      fresh: true,
      eligible: false,
      authorized: false as const,
      maxAgeMs: 60_000,
      failureId: null,
      blockReason: null,
    },
    source: 'test',
    apiTimestamp: '2026-08-28T10:01:29.000Z',
    fetchedAt: '2026-08-28T10:01:29.000Z',
    diagnostics: {
      firstFailure: null,
      failures: [],
      sourceTraces: [],
      attemptCount: 1,
      retryCount: 0,
      failoverCount: 0,
      lastAttemptAtMs: 1_788_000_000_000,
      lastSuccessAtMs: 1_788_000_000_000,
      lastFailureAtMs: null,
      components: [],
    },
  });
  return {
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    paperMode: false,
    readonlyEnabled: true,
    costs: { BTC: cost('BTC'), ETH: cost('ETH') },
  } as unknown as PaperRuntimeReadinessView;
}

describe('public readiness observational parity', () => {
  it.each([
    ['eligible', true],
    ['blocked', false],
  ] as const)('preserves the existing %s Canary readiness result', (_case, ready) => {
    const attestation = buildPublicReadinessAttestation({
      nowMs: 1_788_000_001_000,
      paper: paperSnapshot(),
      stop: {
        available: true,
        reasons: [],
        evaluatedAt: '2026-08-28T10:01:30.000Z',
      },
      canaryReady: ready,
    });

    expect(attestation.canary.ready).toBe(ready);
    expect(attestation.canary.blockerIds).toEqual(
      ready ? [] : ['PUBLIC_CANARY_DETAILED_READINESS_BLOCKED'],
    );
    expect(attestation.boundary).toBe(
      'SANITIZED_READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    );
  });
});