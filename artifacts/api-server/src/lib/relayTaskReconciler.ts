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
 * Gelato taskState 원문 (공식 status API):
 *  CheckPending | ExecPending | WaitingForConfirmation | ExecSuccess |
 *  ExecReverted | Cancelled | Blacklisted | NotFound
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
  taskState: string | null;      // null = 조회 실패/불명
  transactionHash: string | null;
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

  // 2) 온체인 미확인 — Gelato 증거로 중간 상태만 전진 (성공 확정 금지)
  switch (gelato.taskState) {
    case 'ExecReverted':
      // Gelato 보고만으로 FAILED 금지 — FAILED는 독립 수집한 온체인 receipt
      // (onchain.event='TX_REVERTED')로만. 여기서는 UNRESOLVED 유지.
      return {
        to: RELAY_TASK_STATUS.UNRESOLVED,
        basis: gelato.transactionHash
          ? 'Gelato ExecReverted + txHash — 온체인 receipt 검증 필요 (Gelato 보고만으로 FAILED 금지)'
          : 'ExecReverted이나 txHash 없음 — 증거 불충분',
        patch,
      };
    case 'ExecSuccess':
    case 'WaitingForConfirmation':
      // Gelato 성공/브로드캐스트만으로 CONFIRMED 금지 — TX_SUBMITTED까지만
      if (gelato.transactionHash) {
        return { to: RELAY_TASK_STATUS.TX_SUBMITTED, basis: `Gelato ${gelato.taskState} — txHash 확보, 온체인 판정 대기`, patch };
      }
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: `Gelato ${gelato.taskState}이나 txHash 없음`, patch };
    case 'Cancelled':
    case 'Blacklisted':
      // Gelato가 실행 전 취소 — 온체인 broadcast 없음이 명시된 경우에만 pre-broadcast 실패
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: `Gelato ${gelato.taskState} — broadcast 여부 온체인 재확인 필요`, patch };
    case 'CheckPending':
    case 'ExecPending':
      return { to: null, basis: `Gelato ${gelato.taskState} — 대기`, patch };
    case 'NotFound':
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: 'Gelato task NotFound — 제출 여부 불명', patch };
    default:
      return { to: RELAY_TASK_STATUS.UNRESOLVED, basis: 'task 상태 불명(timeout/조회 실패) — UNRESOLVED', patch };
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
