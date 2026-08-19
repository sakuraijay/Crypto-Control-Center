import { getAddress } from 'viem';
import type { CheckOutcome } from './manualCanary';
import { EXPECTED_CANARY_SIGNER } from './canaryAllowanceInfo';
import { getStoredPublicSignerAddress } from './delegatedSigner';
import { getActiveReadySession } from './ownerApprovalSession';

type StoredSignerResult =
  | { ok: true; address: string }
  | { ok: false; reason: string };

interface OwnerApprovalSession {
  maxAllowedCount: string;
  deadline: string;
  expiresAt: string;
  approvalNonce: string;
}

export interface ManualCanaryOwnerApprovalDeps {
  getStoredSigner(expectedAddress: string): Promise<StoredSignerResult>;
  getReadySession(args: {
    expectedOwner: `0x${string}` | null;
    expectedSubaccount: `0x${string}`;
    canonicalNonce: bigint | null;
  }): Promise<OwnerApprovalSession | null>;
}

const outcome = (ok: boolean, detail: string): CheckOutcome => ({ ok, detail });

/**
 * Owner Approval readback is bound directly to the stored public signer.
 * It never decrypts or initializes signer key material.
 */
export async function checkManualCanaryOwnerApproval(
  nowMs: number,
  ownerAddress: string | null,
  injectedDeps?: ManualCanaryOwnerApprovalDeps,
): Promise<CheckOutcome> {
  try {
    // Lazy binding keeps unrelated route tests with narrow delegatedSigner mocks
    // isolated until this check is actually invoked.
    const deps = injectedDeps ?? {
      getStoredSigner: getStoredPublicSignerAddress,
      getReadySession: getActiveReadySession,
    };
    const stored = await deps.getStoredSigner(EXPECTED_CANARY_SIGNER);
    if (!stored.ok) return outcome(false, `저장된 signer 공개주소 조회 실패 — ${stored.reason}`);

    const storedAddress = getAddress(stored.address);
    if (storedAddress !== getAddress(EXPECTED_CANARY_SIGNER)) {
      return outcome(false, '저장된 signer 공개주소가 기대 canary signer와 불일치');
    }

    const session = await deps.getReadySession({
      expectedOwner: ownerAddress ? getAddress(ownerAddress) : null,
      expectedSubaccount: storedAddress,
      canonicalNonce: null,
    });
    if (!session) return outcome(false, 'READY Owner Approval 없음 — 새 Prepare+MetaMask 서명 필요');
    if (session.maxAllowedCount !== '8') return outcome(false, `maxAllowedCount ${session.maxAllowedCount} ≠ 8`);
    const deadlineMs = Number(session.deadline) * 1000;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
      return outcome(false, 'Owner Approval deadline 만료 — 자동 사용 금지, 새 Prepare+서명 필요');
    }
    const expiresMs = Number(session.expiresAt) * 1000;
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      return outcome(false, 'Owner Approval expiresAt 경과 — 새 Prepare+서명 필요');
    }
    return outcome(true, `READY 세션 유효 (nonce ${session.approvalNonce}, deadline까지 ${Math.floor((deadlineMs - nowMs) / 1000)}s)`);
  } catch {
    return outcome(false, 'Owner Approval 조회 실패 (fail-closed)');
  }
}