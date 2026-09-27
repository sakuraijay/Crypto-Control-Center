/**
 * relayReceiptCollector — 온체인 receipt/EventEmitter 증거 수집기 (5단계 §5).
 *
 * relayTaskReconciler의 OnchainOrderEvidence를 실제 데이터에서 생성한다.
 * 판정 규칙 (reconciler와 동일 원칙):
 *  - receipt status=reverted (독립 조회) → TX_REVERTED (이것만 FAILED 근거)
 *  - OrderExecuted → ORDER_EXECUTED (이것만 CONFIRMED 근거)
 *  - OrderCancelled → ORDER_CANCELLED, OrderFrozen → ORDER_FROZEN
 *  - 복수 orderKey 검출 → 판정 금지 (증거 없음으로 반환)
 *  - emitter는 허용집합(설정 ∪ intent 영속 기록)만
 *  - RPC 오류·모호성 → ok:false (판정 없음, 기존 상태 유지)
 *  - 절대 throw 하지 않는다 — Worker를 중단시키지 않기 위해 전부 결과 객체로.
 *
 * 실제 viem client는 intentReconciler.createViemOnchainClient()를 재사용해
 * 주입한다 — 테스트는 mock client만 사용하고, 이번 단계 프로덕션 경로에서는
 * 호출부가 연결되지 않는다(활성화 게이트 차단).
 */

import type { OnchainClient } from './intentReconciler';
import type { OnchainOrderEvidence } from './relayTaskReconciler';
import {
  extractOrderKeyFromReceiptLogs, classifyOrderResolutionLogs, type RawLog,
} from './gmxOrderEvents';
import { sanitizeRpcError } from './rpcErrorSanitize';

export const ARBITRUM_CHAIN_ID = 42161;

export type CollectResult =
  | { ok: true; evidence: OnchainOrderEvidence }
  | { ok: false; reason: string };

/**
 * txHash 기준 온체인 증거 수집.
 * 반환 evidence.event === null 은 "판정 근거 없음"(전이 없음/UNRESOLVED 유지)을 뜻한다.
 */
export async function collectOnchainEvidence(params: {
  client: OnchainClient;
  txHash: string;
  /** configured emitter ∪ intent에 영속된 emitter — 이 집합 밖 로그는 무시 */
  emitterAllowlist: string[];
}): Promise<CollectResult> {
  const { client, txHash, emitterAllowlist } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'txHash 형식 오류' };
  if (!emitterAllowlist.length) return { ok: false, reason: 'emitter 허용집합 비어있음 — 판정 금지' };

  try {
    const chainId = await client.getChainId();
    if (chainId !== ARBITRUM_CHAIN_ID) {
      return { ok: false, reason: `chainId ${chainId} ≠ ${ARBITRUM_CHAIN_ID} — 판정 금지` };
    }

    const receipt = await client.getTransactionReceipt(txHash);
    if (!receipt) return { ok: false, reason: 'receipt 미확인 (pending/미존재) — 판정 보류' };

    const blockNumber = Number(receipt.blockNumber) || null;

    // 독립 조회한 receipt revert — 유일한 FAILED 근거
    if (receipt.status === 'reverted') {
      return {
        ok: true,
        evidence: { event: 'TX_REVERTED', txHash, orderKey: null, blockNumber },
      };
    }

    // 성공 receipt: OrderCreated orderKey 추출 (복수 key → 판정 금지)
    const logs: RawLog[] = receipt.logs ?? [];
    const extraction = extractOrderKeyFromReceiptLogs(logs, emitterAllowlist);
    if (!extraction.ok) {
      if (extraction.reason === 'ambiguous') {
        return { ok: false, reason: '복수 orderKey 검출 — 판정 금지 (조사 필요)' };
      }
      // OrderCreated 없음 — receipt 성공이지만 주문 생성 증거 없음 → 판정 없음
      return { ok: true, evidence: { event: null, txHash, orderKey: null, blockNumber } };
    }
    const orderKey = extraction.orderKey;

    // 실행/취소/동결 이벤트 — 같은 receipt 로그 + (있으면) 후속 조회 로그
    let resolutionLogs: RawLog[] = logs;
    try {
      const extra = await client.getOrderResolutionLogs(orderKey, receipt.blockNumber, emitterAllowlist);
      resolutionLogs = logs.concat(extra ?? []);
    } catch {
      // 후속 로그 조회 실패 — receipt 로그만으로 판정 (실패해도 수집 자체는 유지)
    }
    const resolution = classifyOrderResolutionLogs(resolutionLogs, orderKey, emitterAllowlist);

    if (!resolution) {
      return { ok: true, evidence: { event: 'ORDER_CREATED', txHash, orderKey, blockNumber } };
    }
    const event =
      resolution.kind === 'executed' ? 'ORDER_EXECUTED' as const :
      resolution.kind === 'cancelled' ? 'ORDER_CANCELLED' as const :
      'ORDER_FROZEN' as const;
    return {
      ok: true,
      evidence: {
        event,
        txHash: resolution.txHash ?? txHash,
        orderKey,
        blockNumber: resolution.blockNumber != null ? Number(resolution.blockNumber) || blockNumber : blockNumber,
      },
    };
  } catch (e: unknown) {
    // RPC URL·응답 원문 노출 금지 — sanitize만 반환, throw 없음
    return { ok: false, reason: `온체인 증거 수집 실패: ${sanitizeRpcError(e)}` };
  }
}
