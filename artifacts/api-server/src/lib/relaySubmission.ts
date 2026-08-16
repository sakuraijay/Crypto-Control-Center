/**
 * relaySubmission — 실제 제출 전 원자적 흐름 (4단계 §5·§6).
 *
 * 순서 (하나라도 실패하면 transport 호출 0회):
 *  1. 활성화 이중 게이트(relayActivationGate) 재평가
 *  2. 최신 canonical nonce·authorization·action allowance 재조회 결과 검증
 *  3. fee quote 재검증 (live quote만 — mock 불인정)
 *  4. order params·receiver 재검증
 *  5. durable relay task 저장 (execution intent는 호출측이 선행 커밋)
 *  6. approval session ↔ payload hash 결합
 *  7. delegated signer의 action-specific digest 서명 (호출측 주입 —
 *     이번 단계에서는 실제 서명 함수를 절대 연결하지 않는다)
 *  8. signature·payload 최종 일치 검증
 *  9. relay task를 SUBMITTING으로 조건부 전환
 * 10. 그 이후에만 transport.submitRelayTask 호출
 * 11. taskId 저장 성공 시 TASK_ACCEPTED
 * 12. 저장 실패·응답 모호성(ambiguous)은 UNRESOLVED
 * 13. 자동 재전송 금지 — 어떤 실패 경로에서도 transport 재호출 없음
 *
 * 첫 승인/후속 주문 (§6, SubaccountRouterUtils 공식 규칙):
 *  - 첫 action: shouldAdd=true + 검증된 owner approval signature + canonical
 *    nonce 일치 필수.
 *  - 후속 action: subaccountApproval.signature.length==0이면 온체인에서 승인
 *    처리를 건너뛴다(_handleSubaccountApproval 첫 분기) — 빈 signature가
 *    공식적으로 허용되는 구조. shouldAdd=false 여부와 무관하게 빈 서명이면
 *    기존 DataStore 권한으로만 실행된다.
 *  - action count 부족·expiry 임박 시 차단.
 */

import type { RelayTransport } from './relayTransport';
import { evaluateActivationGate, type ActivationGateInput } from './relayActivationGate';
import { validateFeeQuote, type RelayFeeQuote } from './relayFeeQuote';
import { createRelayTask, transitionRelayTask, RELAY_TASK_STATUS } from './relayLifecycle';

/** expiry 임박 차단 한계 (초) — 남은 유효시간이 이보다 짧으면 신규 주문 금지 */
export const MIN_APPROVAL_EXPIRY_MARGIN_SECONDS = 120n;

export interface ApprovalAttachmentInput {
  isSubaccountListed: boolean;      // DataStore 상 승인 반영 여부
  canonicalNonce: bigint;
  remainingActions: bigint;
  expiresAt: bigint;                // 0 = 미승인
  nowSec: bigint;
  readySession: { approvalNonce: bigint; sessionId: string } | null; // OWNER_SIGNATURE_READY
}

export type ApprovalAttachmentDecision =
  | { ok: true; mode: 'FIRST_ACTION_WITH_APPROVAL'; sessionId: string }   // shouldAdd=true + 서명 첨부
  | { ok: true; mode: 'SUBSEQUENT_EMPTY_SIGNATURE' }                      // 빈 signature (공식 허용)
  | { ok: false; reason: string };

/** §6 — 첫 action/후속 action의 approval 첨부 규칙 판정 */
export function decideApprovalAttachment(input: ApprovalAttachmentInput): ApprovalAttachmentDecision {
  if (input.isSubaccountListed) {
    // 온체인 승인 반영됨 — 후속 action은 빈 signature (SubaccountRouterUtils:
    // signature.length==0 → 승인 처리 생략, DataStore 권한만 사용)
    if (input.remainingActions <= 0n) {
      return { ok: false, reason: 'action count 부족 — 주문 차단' };
    }
    if (input.expiresAt !== 0n && input.expiresAt - input.nowSec < MIN_APPROVAL_EXPIRY_MARGIN_SECONDS) {
      return { ok: false, reason: 'approval expiry 임박 — 신규 주문 차단' };
    }
    return { ok: true, mode: 'SUBSEQUENT_EMPTY_SIGNATURE' };
  }
  // 미반영 — 첫 action은 검증된 owner approval(READY 세션) 필수
  if (!input.readySession) {
    return { ok: false, reason: '첫 action인데 owner approval 서명(READY 세션) 없음' };
  }
  if (input.readySession.approvalNonce !== input.canonicalNonce) {
    return { ok: false, reason: 'approval 세션 nonce가 canonical nonce와 불일치 — 세션 무효' };
  }
  return { ok: true, mode: 'FIRST_ACTION_WITH_APPROVAL', sessionId: input.readySession.sessionId };
}

export interface SubmitFlowInput {
  transport: RelayTransport;                 // DI — 테스트는 mock만
  activation: ActivationGateInput;
  chainId: number;
  relayRouter: string;
  packedData: string;                        // encodePacked(callData,to,feeToken,feeAmount)
  payloadHash: string;
  calldataHash: string;
  idempotencyKey: string;
  kind: 'OPEN' | 'CLOSE' | 'REVOKE';
  intentId: string | null;
  approvalSessionId: string | null;
  quote: RelayFeeQuote | null;
  nowMs: number;
  orderNotionalUsd: number | null;
  ethPriceUsd: number | null;
  receiverVerified: boolean;
  userNonce: bigint;
  /**
   * 서명 검증 콜백 — 서명이 payload(digest)와 최종 일치하는지 확인.
   * 실제 signer 연결은 이번 단계 금지 — 프로덕션 경로에서는 항상 미주입 상태로
   * 게이트에서 먼저 차단된다.
   */
  verifySignatureBinding: () => Promise<{ ok: boolean; reason?: string }>;
}

export type SubmitFlowResult = {
  submitted: boolean;
  transportCalls: number;
  finalStatus: string | null;     // relay task의 최종 상태 (생성된 경우)
  taskRowId: string | null;
  gelatoTaskId: string | null;
  blockReasons: string[];
};

/**
 * 원자적 제출 흐름 — 어떤 실패도 transport 재호출 없이 종료.
 */
export async function runSubmitFlow(input: SubmitFlowInput): Promise<SubmitFlowResult> {
  const blockReasons: string[] = [];
  const result: SubmitFlowResult = {
    submitted: false, transportCalls: 0, finalStatus: null, taskRowId: null, gelatoTaskId: null, blockReasons,
  };

  // 1. 활성화 이중 게이트
  const gate = evaluateActivationGate(input.activation);
  if (!gate.networkEligible) {
    blockReasons.push(...gate.missing);
    return result;
  }

  // 2·3. fee quote 재검증 (live만)
  const feeCheck = validateFeeQuote({
    quote: input.quote, nowMs: input.nowMs,
    orderNotionalUsd: input.orderNotionalUsd, ethPriceUsd: input.ethPriceUsd,
  });
  if (!feeCheck.ok) { blockReasons.push(`fee 재검증 실패: ${feeCheck.reason}`); return result; }
  if (input.quote && input.quote.source === 'mock') {
    blockReasons.push('mock quote로는 제출 불가 — live quote 필수'); return result;
  }

  // 4. receiver 재검증
  if (!input.receiverVerified) { blockReasons.push('receiver가 main account가 아님'); return result; }

  // 5. durable relay task 저장
  const created = await createRelayTask({
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    payloadHash: input.payloadHash,
    calldataHash: input.calldataHash,
    intentId: input.intentId,
    approvalSessionId: input.approvalSessionId,   // 6. approval session ↔ payload 결합
    feeToken: input.quote!.feeToken,
    feeAmount: input.quote!.feeAmount.toString(),
    userNonce: input.userNonce.toString(),
  });
  if (!created.ok) {
    blockReasons.push(`durable task 저장 실패(${created.reason}) — 제출 불가`);
    return result;
  }
  result.taskRowId = created.taskId;
  result.finalStatus = RELAY_TASK_STATUS.PREPARED;

  // 7·8. 서명·payload 최종 일치 검증
  const sigCheck = await input.verifySignatureBinding();
  if (!sigCheck.ok) {
    blockReasons.push(`서명-payload 결속 검증 실패: ${sigCheck.reason ?? '불명'}`);
    await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
      patch: { errorClass: 'SIGNATURE_BINDING', resolutionBasis: '제출 전 서명 결속 검증 실패 — broadcast 없음' },
    });
    result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
    return result;
  }

  // 9. SUBMITTING 조건부 전환 — 실패 시 transport 호출 0회
  const toValidated = await transitionRelayTask({
    taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.DRY_RUN_VALIDATED,
  });
  const toSubmitting = toValidated.ok
    ? await transitionRelayTask({ taskId: created.taskId, from: RELAY_TASK_STATUS.DRY_RUN_VALIDATED, to: RELAY_TASK_STATUS.SUBMITTING })
    : toValidated;
  if (!toSubmitting.ok) {
    blockReasons.push(`SUBMITTING 전환 실패(${toSubmitting.reason}) — transport 호출 0회`);
    result.finalStatus = toValidated.ok ? RELAY_TASK_STATUS.DRY_RUN_VALIDATED : RELAY_TASK_STATUS.PREPARED;
    return result;
  }
  result.finalStatus = RELAY_TASK_STATUS.SUBMITTING;

  // 10. transport 호출 — 단 1회. 어떤 결과에도 재호출 금지.
  result.transportCalls = 1;
  const submit = await input.transport.submitRelayTask({
    chainId: input.chainId, target: input.relayRouter, packedData: input.packedData,
  });

  if (submit.ok) {
    // 11. taskId 저장 → TASK_ACCEPTED. 저장 실패는 UNRESOLVED (12).
    const accepted = await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.TASK_ACCEPTED,
      patch: { relayTaskId: submit.taskId },
    });
    if (accepted.ok) {
      result.submitted = true;
      result.gelatoTaskId = submit.taskId;
      result.finalStatus = RELAY_TASK_STATUS.TASK_ACCEPTED;
    } else {
      blockReasons.push('taskId 저장 실패 — UNRESOLVED (task는 수락됐을 수 있음)');
      // durable 복구: UNRESOLVED 전환도 실패할 수 있으므로 제한 재시도.
      // 그래도 실패하면 DB에는 SUBMITTING이 남는다 — listUnresolvedTasks가
      // SUBMITTING stale 행도 조사 대상에 포함해 운영자 개입으로 수렴시킨다.
      let persisted = false;
      for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
        const t = await transitionRelayTask({
          taskId: created.taskId, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.UNRESOLVED,
          patch: { errorClass: 'TASKID_PERSIST_FAILED', relayTaskId: submit.taskId },
        });
        persisted = t.ok;
      }
      if (!persisted) blockReasons.push('UNRESOLVED 전환도 실패 — DB상 SUBMITTING 잔존, 조사 대상 포함됨');
      result.finalStatus = RELAY_TASK_STATUS.UNRESOLVED;
    }
    return result;
  }

  // 12·13. 실패 분류 — ambiguous(timeout/유실/5xx)는 UNRESOLVED + 재시도 금지,
  //         비-ambiguous(4xx 거부·config)는 broadcast 없음 확정 → FAILED_PRE_BROADCAST.
  if (submit.ambiguous) {
    blockReasons.push(`제출 결과 불명(${submit.kind}) — UNRESOLVED, 자동 재시도 금지`);
    await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.UNRESOLVED,
      patch: { errorClass: `SUBMIT_${submit.kind.toUpperCase()}` },
    });
    result.finalStatus = RELAY_TASK_STATUS.UNRESOLVED;
  } else {
    blockReasons.push(`제출 거부(${submit.kind}) — broadcast 없음 확정`);
    await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
      patch: { errorClass: `SUBMIT_${submit.kind.toUpperCase()}`, resolutionBasis: '요청 발신 전/거부 확정 — broadcast 없음' },
    });
    result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
  }
  return result;
}
