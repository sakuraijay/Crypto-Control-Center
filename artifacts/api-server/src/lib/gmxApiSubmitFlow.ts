/**
 * gmxApiSubmitFlow — 공식 GMX API v2 durable 주문 흐름 (6G-1 §7, 6G-3 §3 보강).
 *
 * 6G-3 상태 머신 (외부 prepare 호출 전 영속화 필수):
 *   durable PREPARED(생성) → PREPARE_REQUESTED → [외부 prepare 1회] →
 *   API_PREPARED(requestId·비민감 증거 저장 완료) → sign → 게이트 재평가 →
 *   SUBMITTING → submit 정확히 1회 → TASK_ACCEPTED | UNRESOLVED | FAILED_PRE_BROADCAST.
 *
 * 원칙:
 *  1. Worker/risk/LIVE 중앙 게이트(evaluateActivationGate) 통과 전 아무것도 안 함.
 *  2. durable task 생성(PREPARED) + PREPARE_REQUESTED 전환 성공 전 prepare 호출 0회.
 *     같은 flow idempotency key로 prepare가 2회 나가는 것은 구조적으로 불가능하다.
 *  3. PREPARE_REQUESTED 이후 timeout/network/5xx/decode/echo 불일치 = UNRESOLVED
 *     (자동 재시도 금지). 확정적인 4xx만 FAILED_PRE_BROADCAST.
 *  4. requestId 등 증거 저장 실패 = UNRESOLVED — 서명·제출 0회, 신규 실행 차단 유지.
 *  5. 서명 직전 typed data 재계산·결속 검증 실패 = 서명 0회.
 *  6. submit 직전 게이트 재평가 + 다른 blocking relay task 재확인(자기 task 1건만 제외).
 *  7. submit은 정확히 1회 — ambiguous는 UNRESOLVED, 4xx는 FAILED_PRE_BROADCAST,
 *     429는 차단(rate_limited·재시도 금지).
 *  8. 자동 재제출·자동 peer 재시도 금지 (transport가 구조적으로 차단).
 *  9. 어떤 응답/로그에도 서명·typed data 전문·개인키 미포함.
 */

import { evaluateActivationGate, type ActivationGateInput } from './relayActivationGate';
import {
  createRelayTask, transitionRelayTask, countBlockingRelayTasksOrNull, RELAY_TASK_STATUS,
} from './relayLifecycle';
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
  /** confirmed OPEN 보호 handoff의 finality 검증된 source OPEN 결속 한 건만 제외. */
  allowedBlockingSourceOpen?: {
    taskId: string;
    intentId: string;
  } | null;
  approvalSessionId: string | null;
  /**
   * 6G-3 §3 — 외부 prepare 호출 전에 결정 가능한 flow idempotency key.
   * (prepare 응답의 idempotencyKey가 아님 — 그것은 증거로 별도 저장된다.)
   * 같은 key로 두 번째 실행은 duplicate로 차단되어 prepare 0회.
   */
  flowIdempotencyKey: string;
  /** prepare 요청 파라미터의 결정적 hash — durable task 생성 시 payload hash */
  requestPayloadHash: string;
  /**
   * prepare 호출 콜백 — durable PREPARE_REQUESTED 전환 성공 후에만 호출된다.
   * 내부적으로 transport.postJson('/orders/txns/prepare', ..., 'readonly') 사용
   * (prepare는 broadcast가 아니므로 safe peer failover 허용).
   */
  prepareOrder: () => Promise<GmxApiResult<unknown>>;
  /** prepare 원시 응답 → 검증 뷰 (요청 파라미터 결속 포함) */
  toView: (raw: unknown) => { ok: true; view: PreparedOrderView } | { ok: false; reason: string };
  expected: PrepareValidationInput['expected'];
  /** §5 비민감 증거 추출 (primaryType·서버 재계산 digest) — 실패 시 null 허용 */
  extractEvidence?: (view: PreparedOrderView) => { primaryType: string | null; typedDataDigest: string | null };
  /**
   * 서명 직전 typed data 재계산·결속 검증 (§6) — domain/types/message/digest를
   * 서버가 재계산해 request와 결속. 실패 = 서명 0회.
   */
  verifyTypedDataBinding: (view: PreparedOrderView) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * 외부 delegated signer 서명 콜백 — API_PREPARED 영속 성공 후에만 호출.
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
  gmxRequestId: string; gmxIdempotencyKey: string; preparedPayloadHash: string;
  gmxPrimaryType: string | null; gmxTypedDataDigest: string | null; gmxPreparePeer: string | null;
  gmxPrepareRequestedAt: Date; gmxPreparedAt: Date;
}>): Promise<boolean> {
  try {
    const updated = await db.update(relayTasksTable).set({ ...patch, updatedAt: new Date() })
      .where(eq(relayTasksTable.id, taskRowId)).returning({ id: relayTasksTable.id });
    return updated.length === 1;
  } catch {
    return false;
  }
}

/** prepare 실패 분류 — 확정 4xx만 FAILED_PRE_BROADCAST, 나머지 전부 UNRESOLVED (§3.4) */
function classifyPrepareFailure(r: { kind: string; httpStatus: number | null; ambiguous: boolean }): 'FAILED_PRE_BROADCAST' | 'UNRESOLVED' {
  if (r.ambiguous) return 'UNRESOLVED';
  if (r.kind === 'rate_limited') return 'FAILED_PRE_BROADCAST'; // 429 = 서버가 요청 거부 확정
  if (r.kind === 'http' && r.httpStatus !== null && r.httpStatus >= 400 && r.httpStatus < 500) {
    return 'FAILED_PRE_BROADCAST';
  }
  return 'UNRESOLVED';
}

export async function runGmxApiSubmitFlow(input: GmxSubmitFlowInput): Promise<GmxSubmitFlowResult> {
  const blockReasons: string[] = [];
  const result: GmxSubmitFlowResult = {
    submitted: false, prepareCalls: 0, signCalls: 0, submitCalls: 0,
    finalStatus: null, taskRowId: null, gmxRequestId: null, blockReasons,
  };

  // 실제 durable flow의 주문 의미와 activation gate의 의미를 먼저 결속한다.
  // OPEN을 CLOSE로 위장해 Manual Canary canonical 검증을 우회하는 모순 입력은
  // durable task 생성·prepare·서명·submit 이전에 fail-closed.
  if (input.activation.kind !== input.kind) {
    blockReasons.push(
      `activation kind ${input.activation.kind} ≠ flow kind ${input.kind} — prepare·서명·제출 0회 (fail-closed)`,
    );
    return result;
  }

  // 1. 중앙 게이트 — 미충족이면 durable 기록·prepare 호출 0회 (PAPER/LOCK 포함)
  const gate = evaluateActivationGate(input.activation);
  if (!gate.networkEligible) {
    blockReasons.push(...gate.missing);
    return result;
  }
  if (!input.transport.submissionEnabled) {
    blockReasons.push('GMX_API_ORDER_SUBMISSION_ENABLED!=true — 흐름 차단 (fail-closed)');
    return result;
  }

  // 1b. §6 — 다른 blocking relay task 존재/조회 실패 시 신규 실행 차단 (prepare 0회)
  const sourceOpen = input.allowedBlockingSourceOpen ?? null;
  const blockingBefore = await countBlockingRelayTasksOrNull({
    transportGen: GMX_API_TRANSPORT_GEN,
    excludeSourceOpen: sourceOpen,
  });
  if (blockingBefore === null) {
    blockReasons.push('blocking relay task 조회 실패 — 신규 실행 차단 (fail-closed)');
    return result;
  }
  if (blockingBefore > 0) {
    blockReasons.push(`미종결 relay task ${blockingBefore}건 존재 — 운영자 확인 전 신규 실행 차단`);
    return result;
  }

  // 2. durable PREPARED 생성 — 외부 prepare 호출 전 영속화 (§3.1)
  const created = await createRelayTask({
    idempotencyKey: input.flowIdempotencyKey,
    kind: input.kind,
    payloadHash: input.requestPayloadHash,
    intentId: input.intentId,
    approvalSessionId: input.approvalSessionId,
    transportGen: GMX_API_TRANSPORT_GEN,
  });
  if (!created.ok) {
    blockReasons.push(created.reason === 'duplicate'
      ? '같은 flow idempotency key의 relay task 존재 — prepare·서명·제출 0회'
      : 'durable PREPARED 저장 실패(db_error) — prepare·서명·제출 0회');
    return result;
  }
  result.taskRowId = created.taskId;
  result.finalStatus = RELAY_TASK_STATUS.PREPARED;

  // 2b. 삽입 후 재확인 fence — 1b 카운트와 삽입은 원자적이지 않으므로, 자기 행을
  // 제외하고 다시 센다. 동시 flow가 있으면 양쪽 다 여기서 CANCELLED(외부 호출 0회)
  // — 승자 선출 대신 fail-closed. 조회 실패도 CANCELLED.
  const blockingAfterInsert = await countBlockingRelayTasksOrNull({
    transportGen: GMX_API_TRANSPORT_GEN,
    excludeTaskIds: [created.taskId],
    excludeSourceOpen: sourceOpen,
  });
  if (blockingAfterInsert === null || blockingAfterInsert > 0) {
    blockReasons.push(blockingAfterInsert === null
      ? '삽입 후 blocking 재확인 조회 실패 — prepare 0회 취소 (fail-closed)'
      : `동시 실행 감지 — 다른 미종결 relay task ${blockingAfterInsert}건, prepare 0회 취소 (fail-closed)`);
    await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.CANCELLED,
      patch: { errorClass: 'CONCURRENT_FLOW_FENCE', resolutionBasis: '외부 prepare 미호출 — broadcast 없음' },
    });
    result.finalStatus = RELAY_TASK_STATUS.CANCELLED;
    return result;
  }

  // 3. PREPARED → PREPARE_REQUESTED 조건부 전환 — 실패 시 prepare 0회.
  //    이 전환이 커밋된 후에만 외부 호출이 나가므로, 재시작 시 PREPARED로 남은
  //    행은 "외부 prepare 미호출 확정"으로 분류할 수 있다 (§4.1).
  const toRequested = await transitionRelayTask({
    taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.PREPARE_REQUESTED,
  });
  if (!toRequested.ok) {
    blockReasons.push(`PREPARE_REQUESTED 전환 실패(${toRequested.reason}) — prepare·서명·제출 0회`);
    return result;
  }
  const stampOk = await patchGmxFields(created.taskId, {
    gmxApiStatus: 'prepare_requested', gmxPrepareRequestedAt: new Date(input.nowMs),
  });
  if (!stampOk) {
    // 외부 호출 전 — broadcast 없음 확정. 증거 기록조차 못 하면 진행 금지.
    blockReasons.push('prepare 요청 증거 저장 실패 — prepare 0회 (fail-closed)');
    await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARE_REQUESTED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
      patch: { errorClass: 'PREPARE_STAMP_PERSIST_FAILED', resolutionBasis: '외부 prepare 미호출 — broadcast 없음' },
    });
    result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
    return result;
  }
  result.finalStatus = RELAY_TASK_STATUS.PREPARE_REQUESTED;

  // 실패 시 PREPARE_REQUESTED에서 목표 상태로 전이하는 공용 헬퍼
  const failPrepare = async (to: 'FAILED_PRE_BROADCAST' | 'UNRESOLVED', errorClass: string, basis: string) => {
    await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARE_REQUESTED,
      to: RELAY_TASK_STATUS[to],
      patch: { errorClass, resolutionBasis: basis },
    });
    result.finalStatus = RELAY_TASK_STATUS[to];
  };

  // 4. 외부 prepare — 정확히 1회
  result.prepareCalls = 1;
  let prepared: PreparedOrderView;
  {
    let raw: GmxApiResult<unknown>;
    try { raw = await input.prepareOrder(); }
    catch { raw = { ok: false, kind: 'network', httpStatus: null, ambiguous: true, message: 'prepare 예외', peerHost: null }; }
    if (!raw.ok) {
      const to = classifyPrepareFailure(raw);
      blockReasons.push(`prepare 실패(${raw.kind}) — ${to === 'UNRESOLVED' ? '결과 불명, 자동 재시도 금지' : '확정 거부'} · 서명·제출 0회`);
      await failPrepare(to, `PREPARE_${raw.kind.toUpperCase()}`,
        to === 'UNRESOLVED' ? 'prepare 결과 불명 — 운영자 확인 필요' : '확정 4xx — 외부 요청 거부, broadcast 없음');
      return result;
    }
    const view = input.toView(raw.data);
    if (!view.ok) {
      // decode 오류 — 외부 호출은 성공했으나 응답을 해석 못 함 → UNRESOLVED (§3.4)
      blockReasons.push(`prepare 응답 구조 오류: ${view.reason} — UNRESOLVED, 자동 재시도 금지`);
      await failPrepare('UNRESOLVED', 'PREPARE_DECODE', 'prepare 응답 decode 실패 — 운영자 확인 필요');
      return result;
    }
    const check = validatePreparedOrder({ prepared: view.view, expected: input.expected });
    if (!check.ok) {
      // echo 불일치 — prepare는 이미 발생, 응답이 요청과 결속되지 않음 → UNRESOLVED (보수적)
      blockReasons.push(...check.reasons.map((r) => `prepare 검증 실패: ${r}`));
      blockReasons.push('prepare 응답이 요청과 불일치 — UNRESOLVED, 자동 재시도 금지');
      await failPrepare('UNRESOLVED', 'PREPARE_ECHO_MISMATCH', 'prepare 응답 echo 불일치 — 운영자 확인 필요');
      return result;
    }
    prepared = view.view;
    result.gmxRequestId = prepared.requestId;

    // 5. §5 비민감 증거 저장 — 실패 시 UNRESOLVED + 서명·제출 0회 (§3.6)
    const evidence = (() => {
      try { return input.extractEvidence?.(prepared) ?? { primaryType: prepared.typedData?.primaryType ?? null, typedDataDigest: null }; }
      catch { return { primaryType: null, typedDataDigest: null }; }
    })();
    const patched = await patchGmxFields(created.taskId, {
      gmxRequestId: prepared.requestId,
      gmxIdempotencyKey: prepared.idempotencyKey,
      preparedPayloadHash: check.payloadHash,
      gmxApiStatus: 'prepared',
      gmxPrimaryType: evidence.primaryType,
      gmxTypedDataDigest: evidence.typedDataDigest,
      gmxPreparePeer: raw.peerHost,
      gmxPreparedAt: new Date(),
    });
    if (!patched) {
      blockReasons.push('gmx_request_id 증거 저장 실패 — UNRESOLVED, 서명·제출 0회 (fail-closed)');
      await failPrepare('UNRESOLVED', 'GMX_BINDING_PERSIST_FAILED',
        `requestId 영속 실패 — 운영자 확인 필요 (requestId=${prepared.requestId})`);
      return result;
    }
    const toApiPrepared = await transitionRelayTask({
      taskId: created.taskId, from: RELAY_TASK_STATUS.PREPARE_REQUESTED, to: RELAY_TASK_STATUS.API_PREPARED,
    });
    if (!toApiPrepared.ok) {
      blockReasons.push(`API_PREPARED 전환 실패(${toApiPrepared.reason}) — UNRESOLVED, 서명·제출 0회`);
      await failPrepare('UNRESOLVED', 'API_PREPARED_TRANSITION_FAILED', 'API_PREPARED 전환 실패 — 운영자 확인 필요');
      return result;
    }
    result.finalStatus = RELAY_TASK_STATUS.API_PREPARED;
  }

  // 6. typed data 재계산·결속 검증 — 실패 시 서명 0회 (로컬 검증 → FAILED_PRE_BROADCAST)
  const binding = await input.verifyTypedDataBinding(prepared);
  if (!binding.ok) {
    blockReasons.push(`typed data 결속 검증 실패: ${binding.reason ?? '불명'} — 서명 금지`);
    await transitionRelayTask({
      taskId: result.taskRowId!, from: RELAY_TASK_STATUS.API_PREPARED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
      patch: { errorClass: 'TYPED_DATA_BINDING', resolutionBasis: '서명 전 결속 검증 실패 — broadcast 없음' },
    });
    result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
    return result;
  }

  // 7. 외부 delegated signer 서명 (API_PREPARED 영속 후에만)
  result.signCalls = 1;
  let signature: string;
  {
    let signed: { ok: true; signature: string } | { ok: false; reason: string };
    try { signed = await input.signTypedData(prepared); }
    catch { signed = { ok: false, reason: '서명 예외' }; }
    if (!signed.ok) {
      blockReasons.push(`서명 실패: ${signed.reason} — 제출 0회`);
      await transitionRelayTask({
        taskId: result.taskRowId!, from: RELAY_TASK_STATUS.API_PREPARED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
        patch: { errorClass: 'SIGNING_FAILED', resolutionBasis: '서명 실패 — broadcast 없음' },
      });
      result.finalStatus = RELAY_TASK_STATUS.FAILED_PRE_BROADCAST;
      return result;
    }
    signature = signed.signature;
  }

  // 8. submit 직전 게이트 재평가 + blocking task 재확인 (자기 task 정확히 1건만 제외)
  const cancelBeforeSubmit = async (reason: string) => {
    blockReasons.push(reason);
    await transitionRelayTask({
      taskId: result.taskRowId!, from: RELAY_TASK_STATUS.API_PREPARED, to: RELAY_TASK_STATUS.CANCELLED,
      patch: { errorClass: 'PRE_SUBMIT_GATE', resolutionBasis: '제출 전 게이트/차단 재확인 미충족 — 제출 0회' },
    });
    result.finalStatus = RELAY_TASK_STATUS.CANCELLED;
  };
  let regate: ActivationGateInput;
  try { regate = await input.reevaluateActivation(); }
  catch {
    await cancelBeforeSubmit('게이트 재평가 실패 — 제출 0회 (fail-closed)');
    return result;
  }
  if (regate.kind !== input.kind) {
    await cancelBeforeSubmit(
      `제출 직전 activation kind ${regate.kind} ≠ flow kind ${input.kind} — 제출 0회 (fail-closed)`,
    );
    return result;
  }
  const gate2 = evaluateActivationGate(regate);
  if (!gate2.networkEligible) {
    blockReasons.push(...gate2.missing);
    await cancelBeforeSubmit('제출 직전 게이트 재평가 미충족 — 제출 0회');
    return result;
  }
  const blockingAtSubmit = await countBlockingRelayTasksOrNull({
    transportGen: GMX_API_TRANSPORT_GEN,
    excludeTaskIds: [result.taskRowId!],
    excludeSourceOpen: sourceOpen,
  });
  if (blockingAtSubmit === null || blockingAtSubmit > 0) {
    await cancelBeforeSubmit(blockingAtSubmit === null
      ? 'blocking relay task 재조회 실패 — 제출 0회 (fail-closed)'
      : `다른 미종결 relay task ${blockingAtSubmit}건 — 제출 0회`);
    return result;
  }

  // 9. API_PREPARED → SUBMITTING 전환 — 실패 시 제출 0회
  const toSubmitting = await transitionRelayTask({
    taskId: result.taskRowId!, from: RELAY_TASK_STATUS.API_PREPARED, to: RELAY_TASK_STATUS.SUBMITTING,
  });
  if (!toSubmitting.ok) {
    blockReasons.push(`SUBMITTING 전환 실패(${toSubmitting.reason}) — 제출 0회`);
    return result;
  }
  result.finalStatus = RELAY_TASK_STATUS.SUBMITTING;

  // 10. submit — 정확히 1회, transport가 단일 peer·무재시도 보장
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
      gmxApiPeer: submit.peerHost ?? undefined,
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

  // 11. submit 실패 분류 — §3 peer 정책
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
