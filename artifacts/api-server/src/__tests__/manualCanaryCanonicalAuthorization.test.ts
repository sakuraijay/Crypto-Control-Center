import { describe, expect, it } from 'vitest';

import { requiredActionsBeforeOpen } from '../lib/actionBudget';
import { CANONICAL_AUTHORIZATION_FRESHNESS_MS } from '../lib/canonicalAuthorizationFreshness';
import { evaluateManualCanaryCanonicalAuthorization } from '../lib/manualCanaryCanonicalAuthorization';
import type { CanonicalSnapshot } from '../lib/relayActivationStatus';

const NOW_MS = Date.parse('2026-08-29T18:00:00.000Z');

function snapshot(overrides: Partial<CanonicalSnapshot> = {}): CanonicalSnapshot {
  return {
    atMs: NOW_MS,
    confirmed: true,
    reason: null,
    approvalNonce: '7',
    isSubaccountListed: true,
    featureDisabled: false,
    integrationDisabled: false,
    expiresAt: String(Math.floor(NOW_MS / 1000) + 3600),
    remaining: String(requiredActionsBeforeOpen()),
    ...overrides,
  };
}

describe('Manual Canary canonical authorization preflight', () => {
  it('fails closed when canonical readback is missing or unconfirmed', () => {
    expect(evaluateManualCanaryCanonicalAuthorization(null, NOW_MS, 0)).toMatchObject({ ok: false });
    expect(evaluateManualCanaryCanonicalAuthorization(
      snapshot({ confirmed: false, reason: 'readback unavailable' }),
      NOW_MS,
      0,
    )).toMatchObject({ ok: false });
  });

  it('fails closed when canonical readback timestamp is stale, future, missing-like, or invalid', () => {
    const invalidTimestamps = [
      NOW_MS - CANONICAL_AUTHORIZATION_FRESHNESS_MS - 1,
      NOW_MS + 1,
      Number.NaN,
      0,
    ];
    for (const atMs of invalidTimestamps) {
      const result = evaluateManualCanaryCanonicalAuthorization(
        snapshot({ atMs }),
        NOW_MS,
        0,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('accepts canonical readback at the exact freshness boundary', () => {
    const result = evaluateManualCanaryCanonicalAuthorization(
      snapshot({ atMs: NOW_MS - CANONICAL_AUTHORIZATION_FRESHNESS_MS }),
      NOW_MS,
      0,
    );
    expect(result.ok).toBe(true);
  });

  it('fails closed when the canonical subaccount is not currently authorized', () => {
    const result = evaluateManualCanaryCanonicalAuthorization(
      snapshot({ isSubaccountListed: false }),
      NOW_MS,
      0,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('authorization 비활성');
  });

  it('fails closed unless canonical feature and integration gates are explicitly active', () => {
    for (const overrides of [
      { featureDisabled: true },
      { integrationDisabled: true },
      { featureDisabled: null },
      { integrationDisabled: null },
    ]) {
      expect(evaluateManualCanaryCanonicalAuthorization(
        snapshot(overrides),
        NOW_MS,
        0,
      ).ok).toBe(false);
    }
  });

  it('fails closed when authorization is expired or expiry is unknown', () => {
    for (const expiresAt of [String(Math.floor(NOW_MS / 1000)), null, 'invalid']) {
      const result = evaluateManualCanaryCanonicalAuthorization(
        snapshot({ expiresAt }),
        NOW_MS,
        0,
      );
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('OPEN 차단');
    }
  });

  it('uses the existing dynamic OPEN budget policy at the exact boundary', () => {
    const required = requiredActionsBeforeOpen();
    expect(evaluateManualCanaryCanonicalAuthorization(
      snapshot({ remaining: String(required) }),
      NOW_MS,
      0,
    ).ok).toBe(true);
    expect(evaluateManualCanaryCanonicalAuthorization(
      snapshot({ remaining: String(required - 1) }),
      NOW_MS,
      0,
    ).ok).toBe(false);
  });

  it('fails closed for missing budget evidence and includes in-flight reservations', () => {
    const required = requiredActionsBeforeOpen();
    expect(evaluateManualCanaryCanonicalAuthorization(
      snapshot({ remaining: null }),
      NOW_MS,
      0,
    ).ok).toBe(false);
    expect(evaluateManualCanaryCanonicalAuthorization(
      snapshot({ remaining: String(required) }),
      NOW_MS,
      null,
    ).ok).toBe(false);
    expect(evaluateManualCanaryCanonicalAuthorization(
      snapshot({ remaining: String(required) }),
      NOW_MS,
      1,
    ).ok).toBe(false);
    expect(evaluateManualCanaryCanonicalAuthorization(
      snapshot({ remaining: String(required + 1) }),
      NOW_MS,
      1,
    ).ok).toBe(true);
  });
});
