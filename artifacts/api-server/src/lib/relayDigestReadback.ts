/**
 * relayDigestReadback — 제출 직전 canonical used-digest readback (5단계 §2).
 *
 * 공식 근거 (gmx-synthetics @ a85ea3491c19c93bb4b5a002d9b358fb769b7849,
 * contracts/router/relay/BaseGelatoRelayRouter.sol):
 *  - replay 방지는 nonce 카운터가 아니라 **digest 맵**이다:
 *    `mapping(bytes32 => bool) public digests;` + `_validateDigest()`가
 *    이미 사용된 digest면 `InvalidUserDigest`로 revert 후 `digests[digest]=true`.
 *  - `userNonce`는 RelayParams 해시의 입력일 뿐이며 (RelayUtils.sol
 *    `_getRelayParamsHash`), 온체인에 단조증가 제약이 없다. gmx-interface
 *    (@ c233f85007c59c52ec70c29ee1345908d3a97d8f,
 *    sdk/src/utils/express/utils/relayParamsUtils.ts)도
 *    `userNonce: BigInt(nowInSeconds())` — 고유성 salt로만 쓴다.
 *
 * 따라서 DB 단조증가 allocation은 "정상 경로의 고유성"만 보장한다. DB 복원·
 * rollback·재배포로 nonce가 되감기면 동일 payload가 동일 digest를 만들 수
 * 있으므로, 제출 직전 반드시 온체인 `digests(digest)`를 readback 해서:
 *  - 조회 실패 → 제출 0회 (fail-closed)
 *  - 이미 사용됨 → 새 nonce로 자동 재제출 금지, 차단·조사 상태로 전환
 *
 * 이번 단계에서는 실제 RPC 호출 경로를 연결하지 않는다 — 테스트는 mock
 * client만 주입하고, 프로덕션은 활성화 게이트가 먼저 차단한다.
 */

import { toFunctionSelector } from 'viem';
import { sanitizeRpcError } from './rpcErrorSanitize';

/** `digests(bytes32)` public getter selector — ABI에서 계산 (하드코딩 금지) */
export const DIGESTS_GETTER_SELECTOR = toFunctionSelector('function digests(bytes32) view returns (bool)');

/** eth_call 1회만 수행하는 최소 클라이언트 — DI 전용 */
export interface DigestReadClient {
  /** eth_call { to, data } → 반환 데이터 hex. 실패는 throw. */
  call(params: { to: string; data: string }): Promise<string>;
}

export type DigestReadbackResult =
  | { ok: true; used: boolean }
  | { ok: false; reason: string };

/**
 * router.digests(digest) readback.
 * - 반환 32바이트 bool 해석 (0x...0 = false / 0x...1 = true)
 * - 해석 불가·호출 실패 → ok:false (fail-closed, 제출 차단)
 */
export async function checkDigestUnused(params: {
  client: DigestReadClient;
  relayRouter: string;
  digest: string; // 0x + 64 hex
}): Promise<DigestReadbackResult> {
  const { client, relayRouter, digest } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) {
    return { ok: false, reason: 'digest 형식 오류 — readback 불가' };
  }
  try {
    const data = DIGESTS_GETTER_SELECTOR + digest.slice(2);
    const raw = await client.call({ to: relayRouter, data });
    const hex = (raw ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hex)) {
      return { ok: false, reason: 'readback 응답 형식 오류 — fail-closed' };
    }
    const val = BigInt(hex);
    if (val === 0n) return { ok: true, used: false };
    if (val === 1n) return { ok: true, used: true };
    return { ok: false, reason: 'readback bool 해석 불가 — fail-closed' };
  } catch (e: unknown) {
    return { ok: false, reason: `digest readback 실패: ${sanitizeRpcError(e)}` };
  }
}
