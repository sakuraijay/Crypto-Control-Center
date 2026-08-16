/**
 * relaySignerBinding — delegated signer를 제출 흐름에 연결하는 DI 어댑터 (5단계 §3).
 *
 * 규칙 (지시서):
 *  - 모든 중앙 게이트·canonical 검증 통과 전에는 signer 저장소 접근 0회 —
 *    runSubmitFlow가 게이트를 먼저 평가하므로 이 callback은 게이트 통과 후에만
 *    호출된다. callback 내부에서도 enabled/initialized 플래그를 키 접근 없이
 *    먼저 확인한다.
 *  - 복호화된 키는 delegatedSigner 모듈 내부(요청 로컬 서명 함수)에만 존재 —
 *    이 모듈은 개인키를 절대 받지 않는다.
 *  - signer address 재계산 검증(verifyIntegrity), main==signer 차단,
 *    서명 후 digest 재계산·recoverAddress 재검증까지 전부 통과해야 ok.
 *  - 어떤 실패도 transport 0회 (runSubmitFlow가 보장).
 */

import { recoverAddress, type Hex } from 'viem';

export interface SignerBindingDeps {
  /** 키 접근 없는 플래그 확인 */
  isEnabled(): boolean;
  isInitialized(): boolean;
  getStoredAddress(): string | null;
  /** 키 접근 1: 개인키에서 주소 재계산 후 저장 주소와 대조 */
  verifyIntegrity(): boolean;
  /** 키 접근 2: digest 서명 (개인키는 signer 모듈 내부에만) */
  signDigest(digest: Hex): Promise<Hex>;
}

export interface SignerBindingParams {
  deps: SignerBindingDeps;
  mainAccount: string;
  /** 제출 payload에서 파생된 digest — 서명 대상 */
  expectedDigest: Hex;
  /** payload에서 digest를 다시 계산 — 결속 검증용 (변조 감지) */
  recomputeDigest: () => Hex;
}

/**
 * runSubmitFlow의 verifySignatureBinding에 주입할 검증기 생성.
 * 성공 시 서명을 sink로 전달한다 (제출 payload 조립용) — 반환값에는 미포함.
 */
export function createSignerBindingVerifier(
  params: SignerBindingParams,
  onSignature?: (signature: Hex) => void,
): () => Promise<{ ok: boolean; reason?: string }> {
  return async () => {
    const { deps, mainAccount, expectedDigest, recomputeDigest } = params;

    // 1) 키 접근 없는 사전 확인 — disabled/미초기화면 저장소·키 접근 0회
    if (!deps.isEnabled()) return { ok: false, reason: 'delegated signer 비활성 (DELEGATED_SIGNER_ENABLED 아님)' };
    if (!deps.isInitialized()) return { ok: false, reason: 'delegated signer 미초기화' };
    const stored = deps.getStoredAddress();
    if (!stored) return { ok: false, reason: 'signer 주소 없음' };

    // 2) main account == signer 차단
    if (stored.toLowerCase() === mainAccount.toLowerCase()) {
      return { ok: false, reason: 'main account와 signer가 동일 — 차단' };
    }

    // 3) payload → digest 재계산 결속 (서명 전 변조 감지)
    let recomputed: Hex;
    try { recomputed = recomputeDigest(); } catch {
      return { ok: false, reason: 'digest 재계산 실패' };
    }
    if (recomputed.toLowerCase() !== expectedDigest.toLowerCase()) {
      return { ok: false, reason: 'digest 재계산 불일치 — payload 변조 의심' };
    }

    // 4) 키 접근 1 — 주소 재계산 검증
    if (!deps.verifyIntegrity()) {
      return { ok: false, reason: 'signer 무결성 검증 실패 (주소 재계산 불일치)' };
    }

    // 5) 키 접근 2 — 서명
    let signature: Hex;
    try {
      signature = await deps.signDigest(expectedDigest);
    } catch {
      return { ok: false, reason: '서명 실패' }; // 오류 원문 미노출
    }

    // 6) 서명 → 주소 복원 재검증 (서명-payload 최종 결속)
    try {
      const recovered = await recoverAddress({ hash: expectedDigest, signature });
      if (recovered.toLowerCase() !== stored.toLowerCase()) {
        return { ok: false, reason: '서명 복원 주소 불일치' };
      }
    } catch {
      return { ok: false, reason: '서명 복원 실패' };
    }

    onSignature?.(signature);
    return { ok: true };
  };
}
