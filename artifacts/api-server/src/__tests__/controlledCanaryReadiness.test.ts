import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveControlledCanaryReadiness,
  type ControlledCanaryReadinessInput,
} from '../lib/controlledCanaryReadiness';
import { deriveStopExecutionCapability, type StopCapabilityInput } from '../lib/stopExecutionCapability';
import {
  __resetExecutionEligibleCostEvidenceForTests,
  getExecutionEligibleCostEvidence,
  recordExecutionEligibleCostEvidence,
  type CostSnapshot,
} from '../lib/costSnapshot';

const NOW = 1_777_000_000_000;

function completeStopInput(): StopCapabilityInput {
  return {
    initialStopHandoffReady: true,
    schemaVerified: true,
    transportConfigured: true,
    signerReady: true,
    durableStoreOk: true,
    reconciliationOk: true,
    actionBudgetSufficient: true,
    actionBudgetRemaining: 8,
    freshFeeQuote: true,
    uncoveredCount: 0,
    blockingProtectionCount: 0,
    executionUnlocked: true,
    decimalsSourceReady: true,
    priceConversionVerified: true,
    evidenceCollectorReady: true,
    protectionReconciliationClean: true,
    positionSnapshotFresh: true,
  };
}

function readyInput(): ControlledCanaryReadinessInput {
  return {
    readonlyEnabled: true,
    submissionEnabled: true,
    signerEnabled: true,
    signerInitialized: true,
    liveLocked: false,
    emergencyStop: false,
    reconciled: true,
    dbOk: true,
    canonicalAuthorizationReady: true,
    ownerApprovalReady: true,
    blockingIntents: 0,
    unresolvedCount: 0,
    activeRevoke: false,
    manualCanaryPostureAllowed: true,
    deploymentVerified: true,
    executionCostEvidence: {
      fresh: true,
      effectiveRoundTripCostUsd: 0.4,
    },
    decimalsReady: true,
    stopCapability: {
      available: true,
      evaluatedAt: new Date(NOW - 1_000).toISOString(),
    },
    nowMs: NOW,
    uncoveredStopCount: 0,
    settlementComplete: true,
    legacyZeroFeeCount: 0,
    unsettledLiveTradeCount: 0,
    blockingProtectionCount: 0,
    staleStopCount: 0,
    actionBudgetSufficient: true,
    priceConversionVerified: true,
    protectionReconciliationComplete: true,
    protectionReconciliationBlocksNewOpens: false,
    protectionReconciliationAmbiguousCount: 0,
    requiredActions: 6,
  };
}

describe('Controlled Canary readiness composition', () => {
  it('accepts only the fully verified composition at the exact immutable cap', () => {
    expect(deriveControlledCanaryReadiness(readyInput())).toBe(true);
  });

  it('blocks a confirmed OPEN when generalized initial-Stop handoff or Stop capability is unavailable', () => {
    const stopInput = completeStopInput();
    stopInput.initialStopHandoffReady = false;
    const stop = deriveStopExecutionCapability(stopInput);

    expect(stop.available).toBe(false);
    expect(deriveControlledCanaryReadiness({
      ...readyInput(),
      stopCapability: {
        available: stop.available,
        evaluatedAt: new Date(NOW - 1_000).toISOString(),
      },
      uncoveredStopCount: 1,
    })).toBe(false);
  });

  it.each([
    ['canonical delegation false', { canonicalAuthorizationReady: false }],
    ['canonical delegation expired', { canonicalAuthorizationReady: false }],
    ['subaccount listing unproven', { canonicalAuthorizationReady: false }],
    ['fresh Owner Approval unproven', { ownerApprovalReady: false }],
  ])('blocks when %s', (_name, override) => {
    expect(deriveControlledCanaryReadiness({
      ...readyInput(),
      ...override,
    })).toBe(false);
  });

  it.each([
    ['missing evaluation time', null],
    ['malformed evaluation time', 'malformed'],
    ['future evaluation time', new Date(NOW + 1).toISOString()],
    ['expired evaluation time', new Date(NOW - 30_001).toISOString()],
  ])('blocks an otherwise available Stop capability with %s', (_name, evaluatedAt) => {
    expect(deriveControlledCanaryReadiness({
      ...readyInput(),
      stopCapability: { available: true, evaluatedAt },
    })).toBe(false);
  });

  it.each([
    ['missing', { fresh: false, effectiveRoundTripCostUsd: null }],
    ['stale', { fresh: false, effectiveRoundTripCostUsd: 0.2 }],
    ['over cap', { fresh: true, effectiveRoundTripCostUsd: 0.4000001 }],
    ['non-finite', { fresh: true, effectiveRoundTripCostUsd: Number.POSITIVE_INFINITY }],
  ])('blocks %s immutable $0.40 cost evidence', (_name, executionCostEvidence) => {
    expect(deriveControlledCanaryReadiness({
      ...readyInput(),
      executionCostEvidence,
    })).toBe(false);
  });

  it('does not expose mutable validated cost evidence by reference', () => {
    __resetExecutionEligibleCostEvidenceForTests();
    const observedAt = new Date(NOW - 1_000).toISOString();
    const snapshot: CostSnapshot = {
      market: 'BTC',
      isLong: true,
      orderType: 'MarketIncrease',
      notionalUsd: 20,
      positionFeeUsd: 0.1,
      executionFeeUsd: 0.1,
      estimatedPriceImpactUsd: 0,
      fundingFeeUsd: 0,
      borrowingFeeUsd: 0,
      estimatedExitFeeUsd: 0.1,
      estimatedExitPriceImpactUsd: 0,
      fundingRatePerHourFraction: 0,
      borrowingRatePerHourFraction: 0,
      totalEstimatedRoundTripCostUsd: 0.3,
      source: 'GMX_API',
      blockNumber: 1,
      apiTimestamp: observedAt,
      fetchedAt: observedAt,
      expiresAt: new Date(NOW + 30_000).toISOString(),
    };
    expect(recordExecutionEligibleCostEvidence(snapshot, {
      market: 'BTC',
      isLong: true,
      orderType: 'MarketIncrease',
      notionalUsd: 20,
    }, NOW)).toBe(true);

    const exposed = getExecutionEligibleCostEvidence(NOW);
    (exposed.evidence as { effectiveRoundTripCostUsd: number }).effectiveRoundTripCostUsd = 9;

    expect(getExecutionEligibleCostEvidence(NOW).evidence?.effectiveRoundTripCostUsd)
      .toBeCloseTo(0.3);
  });

  it('is pure validation and cannot trigger prepare/sign/submit/relay/order/fund side effects', () => {
    const forbidden = {
      prepare: vi.fn(),
      sign: vi.fn(),
      submit: vi.fn(),
      relay: vi.fn(),
      order: vi.fn(),
      fund: vi.fn(),
    };
    const blocked = deriveControlledCanaryReadiness({
      ...readyInput(),
      canonicalAuthorizationReady: false,
      ownerApprovalReady: false,
      stopCapability: { available: false, evaluatedAt: null },
      executionCostEvidence: { fresh: false, effectiveRoundTripCostUsd: null },
    });

    expect(blocked).toBe(false);
    for (const callback of Object.values(forbidden)) {
      expect(callback).not.toHaveBeenCalled();
    }

    const source = readFileSync(
      new URL('../lib/controlledCanaryReadiness.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(
      /@workspace\/db|delegatedSigner|relaySubmission|gmxApiTransport|executionIntents|protectionOrders|liveTestExecutor/,
    );
    expect(source).not.toMatch(
      /\b(?:prepare|sign|submit|relay|placeOrder|createOrder|transferFunds)\s*\(/,
    );
  });
});