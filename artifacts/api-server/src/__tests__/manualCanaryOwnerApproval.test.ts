import { describe, expect, it, vi } from 'vitest';
import { EXPECTED_CANARY_SIGNER } from '../lib/canaryAllowanceInfo';
import { CANONICAL_AUTHORIZATION_FRESHNESS_MS } from '../lib/canonicalAuthorizationFreshness';
import { checkManualCanaryOwnerApproval } from '../lib/manualCanaryOwnerApproval';
import type { CanonicalSnapshot } from '../lib/relayActivationStatus';

const NOW = Date.parse('2026-08-19T16:00:00.000Z');
const OWNER = `0x${'aa'.repeat(20)}`;
const READY = {
  maxAllowedCount: '8',
  deadline: String(Math.floor(NOW / 1000) + 600),
  expiresAt: String(Math.floor(NOW / 1000) + 3_600),
  approvalNonce: '7',
};
const CANONICAL: CanonicalSnapshot = {
  atMs: NOW,
  confirmed: true,
  reason: null,
  approvalNonce: READY.approvalNonce,
  isSubaccountListed: true,
  featureDisabled: false,
  integrationDisabled: false,
  expiresAt: READY.expiresAt,
  remaining: '8',
};

describe('Manual Canary Owner Approval stored-signer binding', () => {
  it('fails before READY-session lookup when stored public signer is absent', async () => {
    const getReadySession = vi.fn(async () => READY);
    const result = await checkManualCanaryOwnerApproval(NOW, OWNER, CANONICAL, {
      getStoredSigner: async () => ({ ok: false, reason: '부재' }),
      getReadySession,
    });
    expect(result.ok).toBe(false);
    expect(getReadySession).not.toHaveBeenCalled();
  });

  it('rejects a mismatched stored public signer before READY-session lookup', async () => {
    const getReadySession = vi.fn(async () => READY);
    const result = await checkManualCanaryOwnerApproval(NOW, OWNER, CANONICAL, {
      getStoredSigner: async () => ({ ok: true, address: `0x${'bb'.repeat(20)}` }),
      getReadySession,
    });
    expect(result.ok).toBe(false);
    expect(getReadySession).not.toHaveBeenCalled();
  });

  it('uses the stored public signer as expectedSubaccount for the READY lookup', async () => {
    const getReadySession = vi.fn(async () => READY);
    const result = await checkManualCanaryOwnerApproval(NOW, OWNER, CANONICAL, {
      getStoredSigner: async () => ({ ok: true, address: EXPECTED_CANARY_SIGNER }),
      getReadySession,
    });
    expect(result.ok).toBe(true);
    expect(getReadySession).toHaveBeenCalledWith(expect.objectContaining({
      expectedSubaccount: EXPECTED_CANARY_SIGNER,
      canonicalNonce: 7n,
      persistInvalidation: false,
    }));
  });

  it.each([
    ['missing snapshot', null],
    ['stale snapshot', { ...CANONICAL, atMs: NOW - CANONICAL_AUTHORIZATION_FRESHNESS_MS - 1 }],
    ['future snapshot', { ...CANONICAL, atMs: NOW + 1 }],
    ['unconfirmed snapshot', { ...CANONICAL, confirmed: false }],
    ['missing nonce', { ...CANONICAL, approvalNonce: null }],
  ])('fails closed before READY lookup for %s', async (_name, snapshot) => {
    const getReadySession = vi.fn(async () => READY);
    const result = await checkManualCanaryOwnerApproval(
      NOW,
      OWNER,
      snapshot as CanonicalSnapshot | null,
      {
        getStoredSigner: async () => ({ ok: true, address: EXPECTED_CANARY_SIGNER }),
        getReadySession,
      },
    );
    expect(result.ok).toBe(false);
    expect(getReadySession).not.toHaveBeenCalled();
  });

  it('rejects the old signed session after the canonical nonce changes', async () => {
    const getReadySession = vi.fn(async ({ canonicalNonce }: { canonicalNonce: bigint | null }) =>
      canonicalNonce === BigInt(READY.approvalNonce) ? READY : null);
    const changedCanonical = { ...CANONICAL, approvalNonce: '8' };

    const result = await checkManualCanaryOwnerApproval(
      NOW,
      OWNER,
      changedCanonical,
      {
        getStoredSigner: async () => ({ ok: true, address: EXPECTED_CANARY_SIGNER }),
        getReadySession,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('canonical nonce 8');
    expect(result.detail).toContain('과거 서명 재사용 금지');
    expect(getReadySession).toHaveBeenCalledWith(expect.objectContaining({
      canonicalNonce: 8n,
      persistInvalidation: false,
    }));
  });

  it('keeps mismatch diagnostics read-only and never permits persistent invalidation', async () => {
    const getReadySession = vi.fn(async () => null);
    const result = await checkManualCanaryOwnerApproval(
      NOW,
      OWNER,
      { ...CANONICAL, approvalNonce: '9' },
      {
        getStoredSigner: async () => ({ ok: true, address: EXPECTED_CANARY_SIGNER }),
        getReadySession,
      },
    );

    expect(result.ok).toBe(false);
    expect(getReadySession).toHaveBeenCalledWith(expect.objectContaining({
      canonicalNonce: 9n,
      persistInvalidation: false,
    }));
    expect(getReadySession).not.toHaveBeenCalledWith(expect.objectContaining({
      persistInvalidation: true,
    }));
  });

  it('defensively rejects a session whose returned nonce is not canonical', async () => {
    const result = await checkManualCanaryOwnerApproval(NOW, OWNER, CANONICAL, {
      getStoredSigner: async () => ({ ok: true, address: EXPECTED_CANARY_SIGNER }),
      getReadySession: async () => ({ ...READY, approvalNonce: '6' }),
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('nonce 6 ≠ canonical 7');
  });
});