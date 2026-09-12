import { beforeEach, describe, expect, it } from 'vitest';

import { CANONICAL_AUTHORIZATION_FRESHNESS_MS } from '../lib/canonicalAuthorizationFreshness';
import { evaluateActivationGate, type ActivationGateInput } from '../lib/relayActivationGate';
import { __resetReadinessRefreshForTests, recordCanonicalSnapshot } from '../lib/relayActivationStatus';

const NOW_MS = Date.parse('2026-08-29T18:00:00.000Z');

function allowManualCanaryOpen(): ActivationGateInput {
  return {
    env: {
      WORKER_ENGINE_MODE: 'PAPER',
      AUTO_WORKER_LIVE_ENABLED: 'false',
      LIVE_TEST_EXECUTION_LOCKED: 'false',
      DELEGATED_SIGNER_ENABLED: 'true',
      GMX_API_READONLY_ENABLED: 'true',
      GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
    },
    liveTestMode: true,
    manualCanary: true,
    signerInitialized: true,
    canonicalAuthorized: true,
    canonicalInFlightReservedActions: 0,
    emergencyStopActive: false,
    dbOk: true,
    rpcOk: true,
    reconciliationComplete: true,
    blockingIntentCount: 0,
    activeRevokeInProgress: false,
    freshLiveFeeQuote: true,
    currentChainId: 42161,
    gmxConfigOk: true,
    deploymentVerified: true,
    kind: 'OPEN',
    nowMs: NOW_MS,
  };
}

function record(
  atMs: number,
  overrides: Partial<Parameters<typeof recordCanonicalSnapshot>[0]> = {},
): void {
  recordCanonicalSnapshot({
    atMs,
    confirmed: true,
    reason: null,
    approvalNonce: '7',
    isSubaccountListed: true,
    featureDisabled: false,
    integrationDisabled: false,
    expiresAt: String(Math.floor(NOW_MS / 1000) + 3600),
    remaining: '8',
    ...overrides,
  });
}

beforeEach(() => {
  __resetReadinessRefreshForTests();
});

describe('Controlled Canary OPEN activation canonical freshness gate', () => {
  it('allows the existing activation path when canonical readback is fresh', () => {
    record(NOW_MS - CANONICAL_AUTHORIZATION_FRESHNESS_MS);
    const result = evaluateActivationGate(allowManualCanaryOpen());
    expect(result.networkEligible).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('fails closed before any OPEN transport when canonical readback is stale', () => {
    record(NOW_MS - CANONICAL_AUTHORIZATION_FRESHNESS_MS - 1);
    const result = evaluateActivationGate(allowManualCanaryOpen());
    expect(result.networkEligible).toBe(false);
    expect(result.missing.some((x) => x.includes('canonical authorization evidence') && x.includes('stale'))).toBe(true);
  });

  it('fails closed when canonical readback is absent or from the future', () => {
    const absent = evaluateActivationGate(allowManualCanaryOpen());
    expect(absent.networkEligible).toBe(false);

    record(NOW_MS + 1);
    const future = evaluateActivationGate(allowManualCanaryOpen());
    expect(future.networkEligible).toBe(false);
  });

  it.each([
    ['confirmed=false', { confirmed: false, reason: 'readback unconfirmed' }],
    ['subaccount listed=false', { isSubaccountListed: false }],
    ['expiry missing', { expiresAt: null }],
    ['approval expired', { expiresAt: String(Math.floor(NOW_MS / 1000)) }],
    ['remaining action budget=0', { remaining: '0' }],
    ['feature disabled', { featureDisabled: true }],
    ['integration disabled', { integrationDisabled: true }],
  ] as const)('fails closed on fresh but invalid canonical evidence: %s', (_label, overrides) => {
    record(NOW_MS, overrides);
    const result = evaluateActivationGate(allowManualCanaryOpen());
    expect(result.networkEligible).toBe(false);
    expect(result.missing.some((x) => x.includes('canonical authorization evidence 미충족'))).toBe(true);
  });

  it('fails closed when the in-flight action reservation cannot be read', () => {
    record(NOW_MS);
    const result = evaluateActivationGate({
      ...allowManualCanaryOpen(),
      canonicalInFlightReservedActions: null,
    });
    expect(result.networkEligible).toBe(false);
    expect(result.missing.some((x) => x.includes('진행 중 예약분 조회 불가'))).toBe(true);
  });

  it('does not add the Manual Canary freshness requirement to CLOSE safety actions', () => {
    const input = { ...allowManualCanaryOpen(), kind: 'CLOSE' as const };
    const result = evaluateActivationGate(input);
    expect(result.networkEligible).toBe(true);
  });
});
