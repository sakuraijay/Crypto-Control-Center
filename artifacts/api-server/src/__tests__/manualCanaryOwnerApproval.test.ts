import { describe, expect, it, vi } from 'vitest';
import { EXPECTED_CANARY_SIGNER } from '../lib/canaryAllowanceInfo';
import { checkManualCanaryOwnerApproval } from '../lib/manualCanaryOwnerApproval';

const NOW = Date.parse('2026-08-19T16:00:00.000Z');
const OWNER = `0x${'aa'.repeat(20)}`;
const READY = {
  maxAllowedCount: '8',
  deadline: String(Math.floor(NOW / 1000) + 600),
  expiresAt: String(Math.floor(NOW / 1000) + 3_600),
  approvalNonce: '7',
};

describe('Manual Canary Owner Approval stored-signer binding', () => {
  it('fails before READY-session lookup when stored public signer is absent', async () => {
    const getReadySession = vi.fn(async () => READY);
    const result = await checkManualCanaryOwnerApproval(NOW, OWNER, {
      getStoredSigner: async () => ({ ok: false, reason: '부재' }),
      getReadySession,
    });
    expect(result.ok).toBe(false);
    expect(getReadySession).not.toHaveBeenCalled();
  });

  it('rejects a mismatched stored public signer before READY-session lookup', async () => {
    const getReadySession = vi.fn(async () => READY);
    const result = await checkManualCanaryOwnerApproval(NOW, OWNER, {
      getStoredSigner: async () => ({ ok: true, address: `0x${'bb'.repeat(20)}` }),
      getReadySession,
    });
    expect(result.ok).toBe(false);
    expect(getReadySession).not.toHaveBeenCalled();
  });

  it('uses the stored public signer as expectedSubaccount for the READY lookup', async () => {
    const getReadySession = vi.fn(async () => READY);
    const result = await checkManualCanaryOwnerApproval(NOW, OWNER, {
      getStoredSigner: async () => ({ ok: true, address: EXPECTED_CANARY_SIGNER }),
      getReadySession,
    });
    expect(result.ok).toBe(true);
    expect(getReadySession).toHaveBeenCalledWith(expect.objectContaining({
      expectedSubaccount: EXPECTED_CANARY_SIGNER,
    }));
  });
});