/**
 * Durable Execution Intents — LIVE 주문 온체인 제출 전 영속화 계층.
 *
 * 목적: 온체인 제출 직후 DB 저장이 실패해도, 제출 "의도"가 이미 커밋되어 있어
 * 재시작 후 reconciliation이 상태불명 주문을 반드시 발견하고 신규 LIVE 주문을
 * 영구 차단할 수 있게 한다 (fail-closed).
 *
 * 규칙:
 *  - writeContract 전에 PREPARED 저장 성공이 필수. INSERT 실패 → 제출 절대 금지.
 *  - id = idempotency key. PK 충돌(onConflictDoNothing → 0행)은 중복 제출 시도로
 *    간주하고 차단한다.
 *  - PREPARED는 "미제출"로 가정하지 않는다 — 재시작 시 UNRESOLVED로 취급.
 *  - FAILED 전환은 broadcast 이전이 확실한 오류에서만. 시간 경과·타임아웃·
 *    네트워크 오류로는 절대 자동 FAILED 전환하지 않는다 (UNRESOLVED 유지).
 *  - 차단 상태: PREPARED / SUBMITTED / UNRESOLVED. 조회 실패도 차단 (fail-closed).
 *  - PAPER 경로는 이 모듈을 호출하지 않는다 (LIVE 실행 경로 전용).
 */

import { db, executionIntentsTable } from '@workspace/db';
import { eq, inArray } from 'drizzle-orm';

export type IntentStatus = 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNRESOLVED';

/** 신규 LIVE 주문을 차단해야 하는 상태 (해소는 온체인 확인 또는 운영자 판정으로만) */
export const BLOCKING_INTENT_STATUSES: IntentStatus[] = ['PREPARED', 'SUBMITTED', 'UNRESOLVED'];

export interface NewIntent {
  /** idempotency key — 같은 결정·주문 유형이면 항상 같은 값 */
  id:            string;
  decisionId:    string;
  cycleNumber:   number;
  symbol:        string;
  orderType:     'open' | 'close';
  isLong:        boolean;
  sizeUsd:       number;
  collateralUsd: number;
}

export type CreateIntentResult = 'created' | 'duplicate' | 'error';

/** idempotency key 생성 — decisionId + 주문 유형으로 결정적(deterministic) 생성 */
export function buildIntentId(decisionId: string, orderType: 'open' | 'close'): string {
  return `intent:${orderType}:${decisionId}`;
}

/**
 * PREPARED intent 저장. 성공('created')일 때만 온체인 제출이 허용된다.
 *
 * 충돌 → 'duplicate' (0행 반환): 두 경우 모두 차단 대상이다.
 *  - PK 충돌: 같은 idempotency key의 두 번째 제출 시도
 *  - 단일 활성 intent 부분 유니크 인덱스 충돌 (migration 0011):
 *    다른 차단 상태 intent가 이미 존재 — check-then-insert 경합도 DB가 차단
 * 그 외 모든 실패는 'error' (fail-closed).
 */
export async function createPreparedIntent(intent: NewIntent): Promise<CreateIntentResult> {
  try {
    const inserted = await db.insert(executionIntentsTable)
      .values({
        id:            intent.id,
        decisionId:    intent.decisionId,
        cycleNumber:   intent.cycleNumber,
        symbol:        intent.symbol,
        orderType:     intent.orderType,
        isLong:        intent.isLong,
        sizeUsd:       String(intent.sizeUsd),
        collateralUsd: String(intent.collateralUsd),
        txHash:        null,
        status:        'PREPARED',
        error:         null,
      })
      .onConflictDoNothing() // 대상 미지정: PK 충돌 + 단일 활성 intent 인덱스 충돌 모두 0행 처리
      .returning({ id: executionIntentsTable.id });
    return inserted.length > 0 ? 'created' : 'duplicate';
  } catch (e) {
    console.error('[ExecutionIntents] PREPARED intent 저장 실패 — 온체인 제출 차단 (fail-closed):', e);
    return 'error';
  }
}

/**
 * 제출 성공 후 txHash + SUBMITTED 기록.
 * @returns 저장 성공 여부. 실패 시 기존 PREPARED 행은 그대로 남아
 *          재시작 reconciliation이 반드시 발견한다.
 */
export async function markIntentSubmitted(id: string, txHash: string): Promise<boolean> {
  try {
    const updated = await db.update(executionIntentsTable)
      .set({ status: 'SUBMITTED', txHash, updatedAt: new Date() })
      .where(eq(executionIntentsTable.id, id))
      .returning({ id: executionIntentsTable.id });
    return updated.length > 0;
  } catch (e) {
    console.error(`[ExecutionIntents] SUBMITTED 전환 실패 (id=${id}) — PREPARED 기록 보존됨:`, e);
    return false;
  }
}

/**
 * broadcast 여부 불명(타임아웃/네트워크/unknown 오류) → UNRESOLVED.
 * 저장 실패해도 기존 PREPARED 행이 남으므로 차단은 유지된다.
 */
export async function markIntentUnresolved(id: string, error: string): Promise<boolean> {
  try {
    const updated = await db.update(executionIntentsTable)
      .set({ status: 'UNRESOLVED', error, updatedAt: new Date() })
      .where(eq(executionIntentsTable.id, id))
      .returning({ id: executionIntentsTable.id });
    return updated.length > 0;
  } catch (e) {
    console.error(`[ExecutionIntents] UNRESOLVED 전환 실패 (id=${id}) — PREPARED 기록이 차단 유지:`, e);
    return false;
  }
}

/**
 * broadcast **이전**이 확실한 실패에서만 FAILED 전환.
 * (예: 트랜잭션 서명 클라이언트 생성 실패 — 네트워크 요청 발생 전)
 * 호출자는 오류 지점이 broadcast 이전임을 보장해야 한다.
 */
export async function markIntentFailedPreBroadcast(id: string, error: string): Promise<boolean> {
  try {
    const updated = await db.update(executionIntentsTable)
      .set({ status: 'FAILED', error, updatedAt: new Date() })
      .where(eq(executionIntentsTable.id, id))
      .returning({ id: executionIntentsTable.id });
    return updated.length > 0;
  } catch (e) {
    console.error(`[ExecutionIntents] FAILED 전환 실패 (id=${id}):`, e);
    return false;
  }
}

/**
 * 차단 상태 intent(PREPARED/SUBMITTED/UNRESOLVED) 존재 여부.
 * 조회 실패 시 true (fail-closed — 상태를 모르면 차단).
 */
export async function hasBlockingIntents(): Promise<boolean> {
  try {
    const rows = await db.select({ id: executionIntentsTable.id })
      .from(executionIntentsTable)
      .where(inArray(executionIntentsTable.status, BLOCKING_INTENT_STATUSES))
      .limit(1);
    return rows.length > 0;
  } catch (e) {
    console.error('[ExecutionIntents] 차단 intent 조회 실패 — 차단 유지 (fail-closed):', e);
    return true;
  }
}

export interface IntentReconcileResult {
  ok:            boolean;
  blockingCount: number;
}

/**
 * 재시작 reconciliation:
 *  - PREPARED  → UNRESOLVED ("미제출" 가정 금지 — broadcast 여부 불명)
 *  - SUBMITTED → UNRESOLVED (txHash 보존, 온체인 확인 필요)
 *  - UNRESOLVED 는 그대로 유지 (해소는 온체인 확인 또는 운영자 판정으로만)
 * 조회/갱신 실패 시 ok=false (호출자는 reconciliation을 완료 상태로 만들면 안 됨).
 */
export async function reconcileIntentsOnRestart(): Promise<IntentReconcileResult> {
  try {
    const stale = await db.select({ id: executionIntentsTable.id, status: executionIntentsTable.status })
      .from(executionIntentsTable)
      .where(inArray(executionIntentsTable.status, BLOCKING_INTENT_STATUSES));

    const toMark = stale.filter(r => r.status === 'PREPARED' || r.status === 'SUBMITTED');
    if (toMark.length > 0) {
      await db.update(executionIntentsTable)
        .set({
          status:    'UNRESOLVED',
          error:     '서버 재시작 시 상태 불명 — 온체인 확인 전까지 UNRESOLVED 유지',
          updatedAt: new Date(),
        })
        .where(inArray(executionIntentsTable.status, ['PREPARED', 'SUBMITTED']));
      console.warn(`[ExecutionIntents] 재시작 reconciliation: ${toMark.length}개 intent를 UNRESOLVED로 마킹 (txHash 보존)`);
    }
    return { ok: true, blockingCount: stale.length };
  } catch (e) {
    console.error('[ExecutionIntents] 재시작 reconciliation 실패 — 신규 LIVE 주문 차단 (fail-closed):', e);
    return { ok: false, blockingCount: -1 };
  }
}
