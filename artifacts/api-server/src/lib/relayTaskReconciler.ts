/**
 * relayTaskReconciler — Gelato task 상태 × GMX 온체인 상태 결합 판정 (4단계 §7).
 *
 * 원칙:
 *  - Gelato task 상태와 온체인 주문 상태는 별개다. **Gelato 성공만으로
 *    CONFIRMED 금지** — CONFIRMED는 온체인 OrderExecuted 증거로만.
 *  - tx revert(온체인 증거)만 확정 FAILED.
 *  - OrderFrozen·timeout·불명은 UNRESOLVED (자동 FAILED 금지).
 *  - 판정은 단일 전이 규칙으로만 — relayLifecycle의 전이 테이블·조건부
 *    UPDATE를 그대로 사용해 기존 intent reconciler와 상충하지 않는다.
 *
 * Gelato 상태 원문 (6F-2 — 신형 JSON-RPC relayer_getStatus, gasless v0.0.10):
 *  StatusCode 숫자만 사용한다 — Pending=100, Submitted=110(+hash),
 *  Success=200(+receipt), Rejected=400(+message), Reverted=500.
 *  알 수 없는 코드·schema 불일치 = 증거 불충분 → UNRESOLVED.
 *
 * legacy transport 세대 (§3): transport_gen='legacy-digital' task는 신형
 *  endpoint로 조회 금지 — 조회 없이 UNRESOLVED_LEGACY_TRANSPORT 분류
 *  (자동 재제출 금지, 운영자 조사).
 */

import {
  RELAY_TASK_STATUS, safeTransition, type RelayTaskStatus, type TransitionResult,
} from './relayLifecycle';

export interface OnchainOrderEvidence {
  /**
   * 온체인 이벤트 판정 — null은 미확인.
   * TX_REVERTED는 독립적으로 수집한 온체인 receipt(status=0) 검증 결과 —
   * Gelato 보고만으로는 절대 설정하지 않는다.
   */
  event: 'ORDER_CREATED' | 'ORDER_EXECUTED' | 'ORDER_CANCELLED' | 'ORDER_FROZEN' | 'TX_REVERTED' | null;
  txHash: string | null;
  orderKey: string | null;
  blockNumber: number | null;
}

export interface GelatoTaskEvidence {
  /** gasless v0.0.10 StatusCode(100/110/200/400/500) — null = 조회 실패/불명 */
  statusCode: number | null;
  transactionHash: string | null;
}

/** §3 — legacy 세대 task의 조회 없는 분류 판정 */
export function legacyTransportVerdict(): ReconcileVerdict {
  return {
    to: RELAY_TASK_STATUS.UNRESOLVED,
    basis: 'UNRESOLVED_LEGACY_TRANSPORT — legacy REST(api.gelato.digital) 세대 taskId, 신형 JSON-RPC 조회 금지 · 자동 재제출 금지 · 운영자 조사 필요',
    patch: {},
  };
}

export interface ReconcileVerdict {
  to: RelayTaskStatus | null;    // null = 전이 없음 (대기 유지)
  basis: string;                 // resolution_basis에 기록할 판정 근거
  patch: { txHash?: string; orderKey?: string };
}

/**
 * 순수 판정 함수 — 증거 조합에서 다음 상태를 결정한다.
 * currentStatus는 전이 가능성 판단용 (전이 자체는 lifecycle이 검증).
 */
export function reconcileVerdict(params: {
  gelato: GelatoTaskEvidence;
  onchain: OnchainOrderEvidence;
}): ReconcileVerdict {
  const { gelato, onchain } = params;
  const patch: ReconcileVerdict['patch'] = {};
  if (onchain.txHash ?? gelato.transactionHash) patch.txHash = (onchain.txHash ?? gelato.transactionHash)!;
  if (onchain.orderKey) patch.orderKey = onchain.orderKey;

  // 1) 온체인 증거 최우선 — Gelato 상태보다 강하다
  if (onchain.event === 'ORDER_EXECUTED') {
    return { to: RELAY_TASK_STATUS.CONFIRMED, basis: `온체인 OrderExecuted (tx=${onchain.txHash ?? '?'} block=${onchain.blockNumber ?? '?'})`, patch };
  }
  if (onchain.event === 'ORDER_CANCELLED') {
    return { to: RELAY_TASK_STATUS.CANCELLED, basis: `온체인 OrderCancelled (tx=${onchain.txHash ?? '?'})`, patch };
  }
  if (onchain.event === 'ORDER_FROZEN') {
    return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: '온체인 OrderFrozen — 운영자 조사 필요', patch };
  }
  if (onchain.event === 'ORDER_CREATED') {
    return { to: RELAY_TASK_STATUS.ORDER_CREATED, basis: `온체인 OrderCreated (orderKey=${onchain.orderKey ?? '?'})`, patch };
  }
  if (onchain.event === 'TX_REVERTED') {
    // 독립 수집한 온체인 receipt(status=0)로만 FAILED 확정
    return { to: RELAY_TASK_STATUS.FAILED, basis: `온체인 receipt revert 확인 (tx=${onchain.txHash ?? '?'})`, patch };
  }

  // 2) 온체인 미확인 — Gelato 증거로 중간 상태만 전진 (성공 확정 금지, §9)
  switch (gelato.statusCode) {
    case 500: // Reverted — Gelato 보고만으로 FAILED 금지, 온체인 receipt 검증 필요
      return {
        to: RELAY_TASK_STATUS.UNRESOLVED,
        basis: gelato.transactionHash
          ? 'Gelato Reverted(500) + txHash — 온체인 receipt 검증 필요 (Gelato 보고만으로 FAILED 금지)'
          : 'Gelato Reverted(500)이나 txHash 없음 — 증거 불충분',
        patch,
      };
    case 200: // Success — Gelato 성공만으로 CONFIRMED 금지, TX_SUBMITTED까지만
    case 110: // Submitted — 브로드캐스트됨
      if (gelato.transactionHash) {
        return { to: RELAY_TASK_STATUS.TX_SUBMITTED, basis: `Gelato StatusCode ${gelato.statusCode} — txHash 확보, 온체인 판정 대기 (Gelato Success만으로 CONFIRMED 금지)`, patch };
      }
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: `Gelato StatusCode ${gelato.statusCode}이나 txHash 없음 — 증거 불충분`, patch };
    case 400: // Rejected — pre-broadcast 거부 보고이나 broadcast 부재는 온체인 재확인 필요
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: 'Gelato Rejected(400) — broadcast 여부 온체인 재확인 필요 (자동 FAILED 금지)', patch };
    case 100: // Pending — 대기
      return { to: null, basis: 'Gelato Pending(100) — 대기', patch };
    case null:
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: 'task 상태 불명(timeout/조회 실패) — UNRESOLVED', patch };
    default:
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: `알 수 없는 Gelato StatusCode(${gelato.statusCode}) — gasless v0.0.10 계약 밖, UNRESOLVED`, patch };
  }
}

/**
 * 판정 적용 — lifecycle 전이 테이블·조건부 UPDATE를 통해서만 상태 변경.
 * 전이 불가(이미 terminal 등)면 그대로 보고하고 강제하지 않는다.
 */
export async function applyReconcileVerdict(taskId: string, verdict: ReconcileVerdict): Promise<TransitionResult | { ok: true; noop: true }> {
  if (verdict.to === null) return { ok: true, noop: true };
  return safeTransition({
    taskId,
    to: verdict.to,
    patch: { ...verdict.patch, resolutionBasis: verdict.basis },
  });
}
