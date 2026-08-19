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
import { and, desc, eq, inArray } from 'drizzle-orm';

export type IntentStatus =
  | 'PREPARED' | 'SUBMITTED'                     // 차단 (진행 중)
  | 'UNRESOLVED'                                 // 차단 (판정 불가)
  | 'CONFIRMED' | 'FAILED' | 'CANCELLED';        // terminal (역행 금지)

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
      // PREPARED에서만 전환 — 지연 호출이 terminal/UNRESOLVED 행을 덮어쓰지 못함
      .where(and(
        eq(executionIntentsTable.id, id),
        eq(executionIntentsTable.status, 'PREPARED'),
      ))
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
      // 차단 상태에서만 전환 — terminal 행 역행 금지
      .where(and(
        eq(executionIntentsTable.id, id),
        inArray(executionIntentsTable.status, BLOCKING_INTENT_STATUSES),
      ))
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
      // broadcast 이전 실패는 PREPARED에서만 발생 — 다른 상태 덮어쓰기 금지
      .where(and(
        eq(executionIntentsTable.id, id),
        eq(executionIntentsTable.status, 'PREPARED'),
      ))
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

/**
 * blocking intent 수 — 조회 실패는 null (호출측 fail-closed 판단용, 5단계).
 * excludeIntentId: 실행 흐름이 방금 스스로 생성한 intent를 제외하기 위한 값
 * (6G-2 리뷰 반영 — 자기 intent가 자기 gate를 영구 차단하는 결함 수정).
 * 다른 프로세스/과거의 blocking intent는 여전히 카운트되어 차단한다.
 */
export async function countBlockingIntentsOrNull(excludeIntentId?: string | null): Promise<number | null> {
  try {
    const rows = await db.select({ id: executionIntentsTable.id })
      .from(executionIntentsTable)
      .where(inArray(executionIntentsTable.status, BLOCKING_INTENT_STATUSES));
    if (excludeIntentId) {
      return rows.filter((r) => r.id !== excludeIntentId).length;
    }
    return rows.length;
  } catch {
    return null;
  }
}

// ── 온체인 판정 (터미널 전환 + 근거 영속화) ──────────────────────────────────

export type TerminalIntentStatus = 'CONFIRMED' | 'FAILED' | 'CANCELLED';

export interface IntentEvidence {
  receiptStatus?:       'success' | 'reverted';
  orderKey?:            string;
  orderCreatedBlock?:   string;
  /** OrderCreated에 실제 일치한 EventEmitter 주소 — 주소 교체 후 reconcile 근거 */
  orderEmitterAddress?: string;
  resolutionTxHash?:    string | null;
  resolutionBlock?:     string | null;
  resolutionReason:     string;
}

/**
 * 차단 상태(PREPARED/SUBMITTED/UNRESOLVED)에서만 terminal 상태로 원자적 전환.
 * 조건부 UPDATE(status IN 차단집합)라서:
 *  - terminal → blocking 역행 불가
 *  - 여러 프로세스가 동시에 reconcile해도 한 쪽만 전환 성공 (0행 = 이미 처리됨)
 */
export async function resolveIntentTerminal(
  id: string,
  toStatus: TerminalIntentStatus,
  evidence: IntentEvidence,
): Promise<boolean> {
  try {
    const updated = await db.update(executionIntentsTable)
      .set({
        status:            toStatus,
        receiptStatus:       evidence.receiptStatus ?? null,
        orderKey:            evidence.orderKey ?? null,
        orderCreatedBlock:   evidence.orderCreatedBlock ?? null,
        orderEmitterAddress: evidence.orderEmitterAddress ?? null,
        resolutionTxHash:  evidence.resolutionTxHash ?? null,
        resolutionBlock:   evidence.resolutionBlock ?? null,
        resolutionReason:  evidence.resolutionReason,
        resolvedAt:        new Date(),
        updatedAt:         new Date(),
      })
      .where(and(
        eq(executionIntentsTable.id, id),
        inArray(executionIntentsTable.status, BLOCKING_INTENT_STATUSES),
      ))
      .returning({ id: executionIntentsTable.id });
    return updated.length > 0;
  } catch (e) {
    console.error(`[ExecutionIntents] terminal 전환 실패 (id=${id} → ${toStatus}) — 차단 유지:`, e);
    return false;
  }
}

/**
 * 차단 상태를 유지한 채 온체인 근거(order key, receipt status 등)만 영속화.
 * 조건부 UPDATE — terminal 상태 행은 건드리지 않는다.
 */
export async function updateIntentEvidence(
  id: string,
  evidence: Partial<IntentEvidence> & { error?: string },
): Promise<boolean> {
  try {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (evidence.receiptStatus     !== undefined) set.receiptStatus     = evidence.receiptStatus;
    if (evidence.orderKey          !== undefined) set.orderKey          = evidence.orderKey;
    if (evidence.orderCreatedBlock !== undefined) set.orderCreatedBlock = evidence.orderCreatedBlock;
    if (evidence.orderEmitterAddress !== undefined) set.orderEmitterAddress = evidence.orderEmitterAddress;
    if (evidence.resolutionReason  !== undefined) set.resolutionReason  = evidence.resolutionReason;
    if (evidence.error             !== undefined) set.error             = evidence.error;
    const updated = await db.update(executionIntentsTable)
      .set(set)
      .where(and(
        eq(executionIntentsTable.id, id),
        inArray(executionIntentsTable.status, BLOCKING_INTENT_STATUSES),
      ))
      .returning({ id: executionIntentsTable.id });
    return updated.length > 0;
  } catch (e) {
    console.error(`[ExecutionIntents] 근거 저장 실패 (id=${id}) — 차단 유지:`, e);
    return false;
  }
}

/** 차단 상태 intent 전체 조회 (온체인 reconciliation 대상). 실패 시 null (fail-closed). */
export async function listBlockingIntents(): Promise<
  Array<typeof executionIntentsTable.$inferSelect> | null
> {
  try {
    return await db.select()
      .from(executionIntentsTable)
      .where(inArray(executionIntentsTable.status, BLOCKING_INTENT_STATUSES));
  } catch (e) {
    console.error('[ExecutionIntents] 차단 intent 목록 조회 실패 (fail-closed):', e);
    return null;
  }
}

/** 최근 intent 목록 (read-only 상태 API용). 실패 시 null. */
export async function listRecentIntents(limit = 50): Promise<
  Array<typeof executionIntentsTable.$inferSelect> | null
> {
  try {
    return await db.select()
      .from(executionIntentsTable)
      .orderBy(desc(executionIntentsTable.createdAt))
      .limit(limit);
  } catch (e) {
    console.error('[ExecutionIntents] intent 목록 조회 실패:', e);
    return null;
  }
}

/** 단일 intent 권위 행 조회. 조회 실패/부재는 null로 fail-closed 처리한다. */
export async function getExecutionIntent(id: string): Promise<
  typeof executionIntentsTable.$inferSelect | null
> {
  try {
    const rows = await db.select().from(executionIntentsTable)
      .where(eq(executionIntentsTable.id, id)).limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
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
