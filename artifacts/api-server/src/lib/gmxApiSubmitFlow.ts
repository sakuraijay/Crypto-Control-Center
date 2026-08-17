/**
 * gmxApiSubmitFlow — 공식 GMX API v2 durable 주문 흐름 (6G-1 §7).
 *
 * prepare → validate → durable PREPARED → sign(외부 delegated signer) →
 * 게이트 재평가 → submit 정확히 1회 → status 저장.
 *
 * 원칙:
 *  1. Worker/risk/LIVE 중앙 게이트(evaluateActivationGate) 통과 전 아무것도 안 함.
 *  2. prepare는 transport DI 콜백 — PAPER/게이트 미충족이면 호출 0회.
 *  3. prepare 결과 검증(validatePreparedOrder) 실패 = 서명 금지.
 *  4. durable PREPARED(gmx_request_id/idempotency_key/prepared_payload_hash 포함)
 *     저장 성공 후에만 signer 접근.
 *  5. 서명 직전 typed data 재검증 콜백(verifyTypedDataBinding) — 예상치 못한
 *     target/chain/receiver/token/order kind면 서명 금지.
 *  6. submit 직전 게이트 재평가 — 통과 실패 시 제출 0회.
 *  7. submit은 정확히 1회 — ambiguous(timeout/network/5xx/decode)는 UNRESOLVED,
 *     400(4xx)은 FAILED_PRE_BROADCAST, 429는 차단(rate_limited·재시도 금지).
 *  8. 자동 재제출·자동 peer 재시도 금지 (transport가 구조적으로 차단).
 *  9. 어떤 응답/로그에도 서명·typed data 전문·개인키 미포함.
 */

import { evaluateActivationGate, type ActivationGateInput } from './relayActivationGate';
import { createRelayTask, transitionRelayTask, RELAY_TASK_STATUS } from './relayLifecycle';
import { db, relayTasksTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  GMX_API_TRANSPORT_GEN,
  validatePreparedOrder,
  type PreparedOrderView,
  type PrepareValidationInput,
} from './gmxApiOrders';
import type { GmxApiResult, GmxApiTransport } from './gmxApiTransport';

export interface GmxSubmitFlowInput {
  transport: GmxApiTransport;                 // DI — 테스트는 mock만
  activation: ActivationGateInput;
  kind: 'OPEN' | 'CLOSE';
  intentId: string | null;
  approvalSessionId: string | null;
  /**
   * prepare 호출 콜백 — 게이트 통과 후에만 호출된다. 내부적으로
   * transport.postJson('/orders/txns/prepare', ..., 'readonly') 사용
   * (prepare는 broadcast가 아니므로 safe peer failover 허용).
   */
  prepareOrder: () => Promise<GmxApiResult<unknown>>;
  /** prepare 원시 응답 → 검증 뷰 (요청 파라미터 결속 포함) */
  toView: (raw: unknown) => { ok: true; view: PreparedOrderView } | { ok: false; reason: string };
  expected: PrepareValidationInput['expected'];
  /**
   * 서명 직전 typed data 재계산·결속 검증 (§6) — domain/types/message/digest를
   * 서버가 재계산해 request와 결속. 실패 = 서명 0회.
   */
  verifyTypedDataBinding: (view: PreparedOrderView) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * 외부 delegated signer 서명 콜백 — durable PREPARED 성공 후에만 호출.
   * main wallet signer는 존재하지 않는다 (PrivateKeySigner 금지).
   * 반환값은 서명 문자열이지만 로그/응답에 절대 노출하지 않는다.
   */
  signTypedData: (view: PreparedOrderView) => Promise<{ ok: true; signature: string } | { ok: false; reason: string }>;
  /** submit 직전 게이트 재평가용 입력 재취득 (최신 상태) */
  reevaluateActivation: () => Promise<ActivationGateInput>;
  /** submit body 조립 — 서명 포함 (조립만, 전송은 flow가 transport로 수행) */
  buildSubmitBody: (view: PreparedOrderView, signature: string) => unknown;
  nowMs: number;
}

export type GmxSubmitFlowResult = {
  submitted: boolean;
  prepareCalls: number;
  signCalls: number;
  submitCalls: number;
  finalStatus: string | null;
  taskRowId: string | null;
  gmxRequestId: string | null;
  blockReasons: string[];
};

async function patchGmxFields(taskRowId: string, patch: Partial<{
  gmxApiStatus: string; gmxExecutionTxHash: string; gmxOrderKeys: string; gmxApiPeer: string;
}>): Promise<boolean> {
  try {
    const updated = await db.update(relayTasksTable).set({ ...patch, updatedAt: new Date() })
      .where(eq(relayTasksTable.id, taskRowId)).returning({ id: relayTasksTable.id });
    return updated.length === 1;
  } catch {
    return false;
  }
}

export async function runGmxApiSubmitFlow(input: GmxSubmitFlowInput): Promise<GmxSubmitFlowResult> {
  const blockReasons: string[] = [];
  const result: GmxSubmitFlowResult = {
    submitted: false, prepareCalls: 0, signCalls: 0, submitCalls: 0,
    finalStatus: null, taskRowId: null, gmxRequestId: null, blockReasons,
  };

  // 1. 중앙 게이트 — 미충족이면 prepare 호출 0회 (PAPER/LOCK 포함)
  const gate = evaluateActivationGate(input.activation);
  if (!gate.networkEligible) {
    blockReasons.push(...gate.missing);
    return result;
  }
  if (!input.transport.submissionEnabled) {
    blockReasons.push('GMX_API_ORDER_SUBMISSION_ENABLED!=true — 흐름 차단 (fail-closed)');
    return result;
  }

  // 2·3. prepare + 검증
  result.prepareCalls = 1;
  let prepared: PreparedOrderView;
  {
    let raw: GmxApiResult<unknown>;
    try { raw = await input.prepareOrder(); }
    catch { raw = { ok: false, kind: 'network', httpStatus: null, ambiguous: true, message: 'prepare 예외', peerHost: null }; }
    if (!raw.ok) {
      blockReasons.push(`prepare 실패(${raw.kind}) — 서명·제출 0회`);
      return result;
    }
    const view = input.toView(raw.data);
    if (!view.ok) { blockReasons.push(`prepare 응답 구조 오류: ${view.reason}`); return result; }
    const check = validatePreparedOrder({ prepared: view.view, expected: input.expected });
    if (!check.ok) {
      blockReasons.push(...check.reasons.map((r) => `prepare 검증 실패: ${r}`));
      return result;
    }
    prepared = view.view;
    result.gmxRequestId = prepared.requestId;

    // 4. durable PREPARED — 저장 성공 전 signer 접근 금지
    const created = await createRelayTask({
      idempotencyKey: `gmxapi:${prepared.idempotencyKey}`,
      kind: input.kind,
      payloadHash: check.payloadHash,
      intentId: input.intentId,
      approvalSessionId: input.approvalSessionId,
      transportGen: GMX_API_TRANSPORT_GEN,
    });
    if (!created.ok) {
      blockReasons.push(`durable PREPARED 저장 실패(${created.reason}) — 서명·제출 0회`);
      return result;
    }
    result.taskRowId = created.taskId;
    result.finalStatus = RELAY_TASK_STATUS.PREPARED;
    // GMX 전용 필드 — 저장 실패 시 서명 진행 금지 (결속 유실 방지)
    const patched = await (async () => {
      try {
        const updated = await db.update(relayTasksTable).set({
          gmxRequestId: prepared.requestId,
          gmxIdempotencyKey: prepared.idempotencyKey,
          preparedPayloadHash: check.payloadHash,
          gmxApiStatus: 'prepared',
          updatedAt: new Date(),
        }).where(eq(relayTasksTable.id, created.taskId)).returning({ id: relayTasksTable.id });
        return updated.length === 1;
      } catch { return false; }
    })();
    if (!patched) {
      blockReasons.push('gmx_request_id 결속 저장 실패 — 서명·제출 0회 (fail-closed)');
      await transitionRelayTask({
        taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
        patch: { errorClass: 'GMX_BINDING_PERSIST_FAILED', resolutionBasis: '결속 저장 실패 — broadcast 없음' },
      });
      result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
      return result;
    }
  }

  // 5. typed data 재계산·결속 검증 — 실패 시 서명 0회
  const binding = await input.verifyTypedDataBinding(prepared);
  if (!binding.ok) {
    blockReasons.push(`typed data 결속 검증 실패: ${binding.reason ?? '불명'} — 서명 금지`);
    await transitionRelayTask({
      taskId: result.taskRowId!, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
      patch: { errorClass: 'TYPED_DATA_BINDING', resolutionBasis: '서명 전 결속 검증 실패 — broadcast 없음' },
    });
    result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
    return result;
  }

  // 6. 외부 delegated signer 서명 (durable 저장 후에만)
  result.signCalls = 1;
  let signature: string;
  {
    let signed: { ok: true; signature: string } | { ok: false; reason: string };
    try { signed = await input.signTypedData(prepared); }
    catch { signed = { ok: false, reason: '서명 예외' }; }
    if (!signed.ok) {
      blockReasons.push(`서명 실패: ${signed.reason} — 제출 0회`);
      await transitionRelayTask({
        taskId: result.taskRowId!, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
        patch: { errorClass: 'SIGNING_FAILED', resolutionBasis: '서명 실패 — broadcast 없음' },
      });
      result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
      return result;
    }
    signature = signed.signature;
  }

  // 7. submit 직전 게이트 재평가
  let regate: ActivationGateInput;
  try { regate = await input.reevaluateActivation(); }
  catch {
    blockReasons.push('게이트 재평가 실패 — 제출 0회 (fail-closed)');
    return result;
  }
  const gate2 = evaluateActivationGate(regate);
  if (!gate2.networkEligible) {
    blockReasons.push('제출 직전 게이트 재평가 미충족 — 제출 0회');
    blockReasons.push(...gate2.missing);
    return result;
  }

  // 8. SUBMITTING 전환 — 실패 시 제출 0회
  const toValidated = await transitionRelayTask({
    taskId: result.taskRowId!, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.DRY_RUN_VALIDATED,
  });
  const toSubmitting = toValidated.ok
    ? await transitionRelayTask({ taskId: result.taskRowId!, from: RELAY_TASK_STATUS.DRY_RUN_VALIDATED, to: RELAY_TASK_STATUS.SUBMITTING })
    : toValidated;
  if (!toSubmitting.ok) {
    blockReasons.push(`SUBMITTING 전환 실패(${toSubmitting.reason}) — 제출 0회`);
    result.finalStatus = toValidated.ok ? RELAY_TASK_STATUS.DRY_RUN_VALIDATED : RELAY_TASK_STATUS.PREPARED;
    return result;
  }
  result.finalStatus = RELAY_TASK_STATUS.SUBMITTING;

  // 9. submit — 정확히 1회, transport가 단일 peer·무재시도 보장
  result.submitCalls = 1;
  const submit = await input.transport.postJson<Record<string, unknown>>(
    '/orders/txns/submit', input.buildSubmitBody(prepared, signature), 'submit',
  );

  if (submit.ok) {
    const accepted = await transitionRelayTask({
      taskId: result.taskRowId!, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.TASK_ACCEPTED,
      patch: { relayTaskId: prepared.requestId },
    });
    await patchGmxFields(result.taskRowId!, {
      gmxApiStatus: String((submit.data as { status?: unknown })?.status ?? 'relay_accepted'),
      gmxApiPeer: submit.peerHost,
    });
    if (accepted.ok) {
      result.submitted = true;
      result.finalStatus = RELAY_TASK_STATUS.TASK_ACCEPTED;
    } else {
      blockReasons.push('submit 수락 상태 저장 실패 — UNRESOLVED (제출은 수락됐을 수 있음)');
      let persisted = false;
      for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
        const t = await transitionRelayTask({
          taskId: result.taskRowId!, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.UNRESOLVED,
          patch: { errorClass: 'SUBMIT_PERSIST_FAILED', relayTaskId: prepared.requestId },
        });
        persisted = t.ok;
      }
      result.finalStatus = RELAY_TASK_STATUS.UNRESOLVED;
    }
    return result;
  }

  // 10. 실패 분류 — §3 peer 정책
  if (submit.kind === 'rate_limited') {
    blockReasons.push('429 rate limit — 신규 제출 차단·backoff, 자동 재시도 금지');
    await transitionRelayTask({
      taskId: result.taskRowId!, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
      patch: { errorClass: 'SUBMIT_RATE_LIMITED', resolutionBasis: '429 — 서버가 요청을 거부 (pre-broadcast 확정)' },
    });
    result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
  } else if (submit.ambiguous) {
    blockReasons.push(`제출 결과 불명(${submit.kind}) — UNRESOLVED, 자동 재시도·재제출 금지`);
    await transitionRelayTask({
      taskId: result.taskRowId!, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.UNRESOLVED,
      patch: { errorClass: `SUBMIT_${submit.kind.toUpperCase()}` },
    });
    result.finalStatus = RELAY_TASK_STATUS.UNRESOLVED;
  } else {
    blockReasons.push(`제출 거부(${submit.kind}) — broadcast 없음 확정 (FAILED_PRE_BROADCAST)`);
    await transitionRelayTask({
      taskId: result.taskRowId!, from: RELAY_TASK_STATUS.SUBMITTING, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
      patch: { errorClass: `SUBMIT_${submit.kind.toUpperCase()}`, resolutionBasis: '4xx 검증 거부 — broadcast 없음' },
    });
    result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
  }
  return result;
}
