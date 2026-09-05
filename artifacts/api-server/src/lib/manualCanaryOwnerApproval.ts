import { getAddress } from 'viem';
import type { CheckOutcome } from './manualCanary';
import { EXPECTED_CANARY_SIGNER } from './canaryAllowanceInfo';
import { evaluateCanonicalAuthorizationFreshness } from './canonicalAuthorizationFreshness';
import type { CanonicalSnapshot } from './relayActivationStatus';

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
    persistInvalidation?: boolean;
  }): Promise<OwnerApprovalSession | null>;
}

const outcome = (ok: boolean, detail: string): CheckOutcome => ({ ok, detail });

async function loadDefaultDeps(): Promise<ManualCanaryOwnerApprovalDeps> {
  const [{ getStoredPublicSignerAddress }, { getActiveReadySession }] = await Promise.all([
    import('./delegatedSigner'),
    import('./ownerApprovalSession'),
  ]);
  return {
    getStoredSigner: getStoredPublicSignerAddress,
    getReadySession: getActiveReadySession,
  };
}

/**
 * Owner Approval readback is bound directly to the stored public signer.
 * It never decrypts or initializes signer key material.
 */
export async function checkManualCanaryOwnerApproval(
  nowMs: number,
  ownerAddress: string | null,
  canonicalSnapshot: CanonicalSnapshot | null,
  injectedDeps?: ManualCanaryOwnerApprovalDeps,
): Promise<CheckOutcome> {
  try {
    if (!ownerAddress) {
      return outcome(false, 'GMX_WALLET_ADDRESS 미설정 — Owner Approval owner 결속 불가');
    }
    const canonicalFreshness = evaluateCanonicalAuthorizationFreshness(
      canonicalSnapshot,
      nowMs,
    );
    if (!canonicalFreshness.ok) {
      return outcome(false, `Owner Approval canonical binding 불가 — ${canonicalFreshness.detail}`);
    }
    if (!canonicalSnapshot?.confirmed) {
      return outcome(false, 'canonical readback 미확인 — Owner Approval 재사용 금지');
    }
    const nonceText = canonicalSnapshot.approvalNonce;
    if (typeof nonceText !== 'string' || !/^(0|[1-9]\d*)$/.test(nonceText)) {
      return outcome(false, 'canonical approval nonce 누락/비정상 — Owner Approval 재사용 금지');
    }
    const canonicalNonce = BigInt(nonceText);

    // Keep DB-backed signer/session modules out of import-only and injected-deps
    // paths so isolated CI tests do not require DATABASE_URL.
    const deps = injectedDeps ?? await loadDefaultDeps();
    const stored = await deps.getStoredSigner(EXPECTED_CANARY_SIGNER);
    if (!stored.ok) return outcome(false, `저장된 signer 공개주소 조회 실패 — ${stored.reason}`);

    const storedAddress = getAddress(stored.address);
    if (storedAddress !== getAddress(EXPECTED_CANARY_SIGNER)) {
      return outcome(false, '저장된 signer 공개주소가 기대 canary signer와 불일치');
    }

    const session = await deps.getReadySession({
      expectedOwner: getAddress(ownerAddress),
      expectedSubaccount: storedAddress,
      canonicalNonce,
      persistInvalidation: false,
    });
    if (!session) {
      return outcome(
        false,
        `현재 canonical nonce ${nonceText}에 결속된 fresh READY Owner Approval 없음 — restart/session/nonce 변화 후 과거 서명 재사용 금지`,
      );
    }
    if (session.approvalNonce !== nonceText) {
      return outcome(false, `READY session nonce ${session.approvalNonce} ≠ canonical ${nonceText} — 과거 서명 재사용 금지`);
    }
    if (session.maxAllowedCount !== '8') return outcome(false, `maxAllowedCount ${session.maxAllowedCount} ≠ 8`);
    const deadlineMs = Number(session.deadline) * 1000;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
      return outcome(false, 'Owner Approval deadline 만료 — 자동 사용 금지, 새 Prepare+서명 필요');
    }
    const expiresMs = Number(session.expiresAt) * 1000;
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      return outcome(false, 'Owner Approval expiresAt 경과 — 새 Prepare+서명 필요');
    }
    return outcome(
      true,
      `fresh canonical-bound READY 세션 유효 (nonce ${session.approvalNonce}, readback age ${canonicalFreshness.ageMs}ms, deadline까지 ${Math.floor((deadlineMs - nowMs) / 1000)}s)`,
    );
  } catch {
    return outcome(false, 'Owner Approval 조회 실패 (fail-closed)');
  }
}
