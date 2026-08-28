/**
 * relayLifecycle — durable relay task lifecycle (3단계).
 *
 * 원칙 (지시서 §3):
 *  1. 외부 relay 호출 전에 durable intent(payload hash 포함)를 커밋한다.
 *  2. DB 저장 실패 시 relay 호출 0회.
 *  3. timeout·응답 유실은 자동 FAILED 금지 — UNRESOLVED.
 *  4. task id·txHash 저장 실패 시 UNRESOLVED 차단.
 *  5. 같은 idempotency key 중복 제출 금지 (DB unique index + 사전 조회).
 *  6. 재시작 시 SUBMITTING/TASK_ACCEPTED/TX_SUBMITTED/ORDER_CREATED 복구 대상.
 *  7. terminal 상태 역행 금지 (전이 테이블 + 조건부 UPDATE).
 *  8. relay task accepted만으로 approval session CONSUMED 금지.
 *  9. canonical nonce 증가/DataStore 반영 + 온체인 주문 증거 후에만 CONSUMED.
 * 10. PREPARED+무taskId도 broadcast 가능성 불명이면 fail-closed.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, relayTasksTable, type RelayTaskRow } from '@workspace/db';

export const RELAY_TASK_STATUS = {
  PREPARED: 'PREPARED',
  /** 6G-3 §3 — 외부 prepare 호출 직전 영속 전환 (이 상태에서 crash = prepare 결과 불명) */
  PREPARE_REQUESTED: 'PREPARE_REQUESTED',
  /** 6G-3 §3 — prepare 성공·requestId 등 비민감 증거 저장 완료 */
  API_PREPARED: 'API_PREPARED',
  DRY_RUN_VALIDATED: 'DRY_RUN_VALIDATED',
  SUBMITTING: 'SUBMITTING',
  TASK_ACCEPTED: 'TASK_ACCEPTED',
  TX_SUBMITTED: 'TX_SUBMITTED',
  ORDER_CREATED: 'ORDER_CREATED',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  FAILED_PRE_BROADCAST: 'FAILED_PRE_BROADCAST',
  /** broadcast 이후 확정 실패 (tx revert 등 온체인 증거 필수) — 4단계 */
  FAILED: 'FAILED',
  UNRESOLVED: 'UNRESOLVED',
} as const;
export type RelayTaskStatus = (typeof RELAY_TASK_STATUS)[keyof typeof RELAY_TASK_STATUS];

export const TERMINAL_STATUSES: readonly RelayTaskStatus[] = [
  RELAY_TASK_STATUS.CONFIRMED,
  RELAY_TASK_STATUS.CANCELLED,
  RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
  RELAY_TASK_STATUS.FAILED,
];

/** 재시작 시 복구(재판정) 대상 — 외부 제출이 있었을 수 있는 모든 상태 */
export const RECOVERY_STATUSES: readonly RelayTaskStatus[] = [
  RELAY_TASK_STATUS.SUBMITTING,
  RELAY_TASK_STATUS.TASK_ACCEPTED,
  RELAY_TASK_STATUS.TX_SUBMITTED,
  RELAY_TASK_STATUS.ORDER_CREATED,
  RELAY_TASK_STATUS.UNRESOLVED,
];

/** 허용 전이 테이블 — 명시되지 않은 전이는 전부 거부 */
const ALLOWED_TRANSITIONS: Record<string, readonly RelayTaskStatus[]> = {
  PREPARED: ['PREPARE_REQUESTED', 'DRY_RUN_VALIDATED', 'CANCELLED', 'FAILED_PRE_BROADCAST', 'UNRESOLVED'],
  // prepare 결과 불명(timeout/network/5xx/decode) → UNRESOLVED만. 확정 4xx → FAILED_PRE_BROADCAST.
  PREPARE_REQUESTED: ['API_PREPARED', 'FAILED_PRE_BROADCAST', 'UNRESOLVED', 'CANCELLED'],
  // API_PREPARED에서 자동 재개 금지 — SUBMITTING 전환은 현행 flow 안에서만.
  API_PREPARED: ['SUBMITTING', 'FAILED_PRE_BROADCAST', 'UNRESOLVED', 'CANCELLED'],
  DRY_RUN_VALIDATED: ['SUBMITTING', 'CANCELLED', 'FAILED_PRE_BROADCAST', 'UNRESOLVED'],
  SUBMITTING: ['TASK_ACCEPTED', 'FAILED_PRE_BROADCAST', 'UNRESOLVED'],
  TASK_ACCEPTED: ['TX_SUBMITTED', 'UNRESOLVED', 'CANCELLED', 'FAILED'],
  TX_SUBMITTED: ['ORDER_CREATED', 'CONFIRMED', 'UNRESOLVED', 'CANCELLED', 'FAILED'],
  ORDER_CREATED: ['CONFIRMED', 'UNRESOLVED', 'CANCELLED', 'FAILED'],
  // UNRESOLVED → terminal은 온체인/task 증거(resolutionBasis) 기반 전이만 —
  // 자동·수동 강제 FAILED 금지는 reconciler 정책에서 강제한다.
  UNRESOLVED: ['TASK_ACCEPTED', 'TX_SUBMITTED', 'ORDER_CREATED', 'CONFIRMED', 'CANCELLED', 'FAILED'],
  // terminal — 전이 없음
  CONFIRMED: [],
  CANCELLED: [],
  FAILED_PRE_BROADCAST: [],
  FAILED: [],
};

export function isTransitionAllowed(from: string, to: RelayTaskStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export type CreateRelayTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; reason: 'duplicate' | 'db_error' };

/**
 * durable relay task 생성 — 외부 호출 전 필수 선행.
 * 같은 idempotencyKey가 이미 있으면 duplicate (relay 호출 0회).
 */
export async function createRelayTask(params: {
  idempotencyKey: string;
  kind: 'OPEN' | 'CLOSE' | 'REVOKE';
  payloadHash: string;
  intentId?: string | null;
  approvalSessionId?: string | null;
  feeToken?: string | null;
  feeAmount?: string | null;
  userNonce?: string | null;
  approvalNonce?: string | null;
  calldataHash?: string | null;
  /** 6F-2 §3 — 신규 제출은 반드시 'jsonrpc-gasless-0.0.10'을 명시 */
  transportGen?: string;
}): Promise<CreateRelayTaskResult> {
  try {
    const existing = await db.select({ id: relayTasksTable.id }).from(relayTasksTable)
      .where(eq(relayTasksTable.idempotencyKey, params.idempotencyKey)).limit(1);
    if (existing.length > 0) return { ok: false, reason: 'duplicate' };
  } catch {
    return { ok: false, reason: 'db_error' };
  }

  const id = randomUUID();
  try {
    await db.insert(relayTasksTable).values({
      id,
      idempotencyKey: params.idempotencyKey,
      intentId: params.intentId ?? null,
      approvalSessionId: params.approvalSessionId ?? null,
      kind: params.kind,
      status: RELAY_TASK_STATUS.PREPARED,
      payloadHash: params.payloadHash,
      calldataHash: params.calldataHash ?? null,
      feeToken: params.feeToken ?? null,
      feeAmount: params.feeAmount ?? null,
      userNonce: params.userNonce ?? null,
      approvalNonce: params.approvalNonce ?? null,
      ...(params.transportGen ? { transportGen: params.transportGen } : {}),
    });
  } catch {
    // unique index 충돌(동시 중복) 포함 — 전부 fail-closed
    return { ok: false, reason: 'db_error' };
  }
  return { ok: true, taskId: id };
}

export type TransitionResult = { ok: true } | { ok: false; reason: string };

/**
 * 조건부 상태 전이 — 현재 상태가 from과 일치할 때만 UPDATE (경합/역행 차단).
 */
export async function transitionRelayTask(params: {
  taskId: string;
  from: RelayTaskStatus;
  to: RelayTaskStatus;
  patch?: Partial<{
    calldataHash: string; relayTaskId: string; txHash: string; orderKey: string;
    errorClass: string; resolutionBasis: string;
  }>;
}): Promise<TransitionResult> {
  if (!isTransitionAllowed(params.from, params.to)) {
    return { ok: false, reason: `전이 금지: ${params.from} → ${params.to}` };
  }
  const isTerminal = TERMINAL_STATUSES.includes(params.to);
  try {
    const updated = await db.update(relayTasksTable)
      .set({
        status: params.to,
        ...(params.patch ?? {}),
        updatedAt: new Date(),
        ...(isTerminal ? { resolvedAt: new Date() } : {}),
      })
      // 조건부 UPDATE: 현재 상태가 from과 일치하는 행만 — 경합·역행 원자적 차단
      .where(and(eq(relayTasksTable.id, params.taskId), eq(relayTasksTable.status, params.from)))
      .returning({ id: relayTasksTable.id });
    if (updated.length !== 1) return { ok: false, reason: `조건부 전이 실패 — 현재 상태가 ${params.from}이 아님(경합/역행 차단)` };
  } catch {
    return { ok: false, reason: 'DB 전이 실패 — fail-closed' };
  }
  return { ok: true };
}

/**
 * 안전 전이 — 현재 상태를 읽고 전이 테이블 검사 후 조건부 UPDATE.
 * (terminal 역행은 여기서도, 전이 테이블에서도 이중 차단)
 */
export async function safeTransition(params: {
  taskId: string;
  to: RelayTaskStatus;
  patch?: Parameters<typeof transitionRelayTask>[0]['patch'];
}): Promise<TransitionResult> {
  let row: RelayTaskRow | undefined;
  try {
    const rows = await db.select().from(relayTasksTable)
      .where(eq(relayTasksTable.id, params.taskId)).limit(1);
    row = rows[0];
  } catch {
    return { ok: false, reason: 'task 조회 실패 — fail-closed' };
  }
  if (!row) return { ok: false, reason: 'task 없음' };
  if (TERMINAL_STATUSES.includes(row.status as RelayTaskStatus)) {
    return { ok: false, reason: `terminal 상태 ${row.status} — 역행 금지` };
  }
  return transitionRelayTask({ taskId: params.taskId, from: row.status as RelayTaskStatus, to: params.to, patch: params.patch });
}

/** 재시작 복구 대상 조회 — 자동 FAILED 처리 금지, 판정 근거 없으면 UNRESOLVED 유지 */
export async function listRecoveryTasks(): Promise<RelayTaskRow[]> {
  try {
    return await db.select().from(relayTasksTable)
      .where(inArray(relayTasksTable.status, [...RECOVERY_STATUSES]))
      .orderBy(desc(relayTasksTable.createdAt)).limit(100);
  } catch {
    return [];
  }
}

/** 단건 조회 (UNRESOLVED 조사용) — 민감정보 없는 원본 row */
export async function getRelayTaskById(taskId: string): Promise<RelayTaskRow | null> {
  try {
    const rows = await db.select().from(relayTasksTable)
      .where(eq(relayTasksTable.id, taskId)).limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** UNRESOLVED task 목록 (조사 UI용) */
export async function listUnresolvedTasks(limit = 50): Promise<RelayTaskRow[]> {
  try {
    // SUBMITTING 포함: transport 호출 후 상태 저장에 실패한 stale 행도
    // 조사 대상에 포함해 운영자 개입으로 수렴시킨다 (자동 종결 금지).
    return await db.select().from(relayTasksTable)
      .where(inArray(relayTasksTable.status, [RELAY_TASK_STATUS.UNRESOLVED, RELAY_TASK_STATUS.SUBMITTING]))
      .orderBy(desc(relayTasksTable.createdAt)).limit(limit);
  } catch {
    return [];
  }
}

/**
 * UNRESOLVED/SUBMITTING 조사 대상 수 — 조회 실패는 null.
 * 상태/안전 evidence에서 빈 배열 fallback을 정상 0건으로 오인하지 않도록 분리한다.
 */
export async function countUnresolvedTasksOrNull(): Promise<number | null> {
  try {
    const rows = await db.select({ id: relayTasksTable.id }).from(relayTasksTable)
      .where(inArray(relayTasksTable.status, [
        RELAY_TASK_STATUS.UNRESOLVED,
        RELAY_TASK_STATUS.SUBMITTING,
      ]));
    return rows.length;
  } catch {
    return null;
  }
}

/**
 * 미종결(non-terminal) relay task 수 — 조회 실패는 null (fail-closed 판단용, 5단계).
 * listUnresolvedTasks와 달리 오류를 빈 배열로 삼키지 않는다.
 */
export async function countOpenRelayTasksOrNull(): Promise<number | null> {
  const nonTerminal = (Object.values(RELAY_TASK_STATUS) as RelayTaskStatus[])
    .filter((s) => !TERMINAL_STATUSES.includes(s));
  try {
    const rows = await db.select({ id: relayTasksTable.id }).from(relayTasksTable)
      .where(inArray(relayTasksTable.status, nonTerminal));
    return rows.length;
  } catch {
    return null;
  }
}

/**
 * 6G-3 §6 — 특정 transportGen의 미종결(blocking) relay task 수.
 * excludeTaskId/excludeTaskIds는 호출자가 명시한 정확한 task만 제외한다.
 * 조회 실패 = null (fail-closed 판단용).
 */
export async function countBlockingRelayTasksOrNull(params: {
  transportGen: string;
  excludeTaskId?: string | null;
  excludeTaskIds?: readonly string[];
  /** exact OPEN task+intent 결속이 모두 맞을 때만 source handoff task를 제외한다. */
  excludeSourceOpen?: { taskId: string; intentId: string } | null;
}): Promise<number | null> {
  const nonTerminal = (Object.values(RELAY_TASK_STATUS) as RelayTaskStatus[])
    .filter((s) => !TERMINAL_STATUSES.includes(s));
  try {
    const rows = await db.select({
      id: relayTasksTable.id,
      kind: relayTasksTable.kind,
      intentId: relayTasksTable.intentId,
    }).from(relayTasksTable)
      .where(and(
        eq(relayTasksTable.transportGen, params.transportGen),
        inArray(relayTasksTable.status, nonTerminal),
      ));
    const excluded = new Set([
      ...(params.excludeTaskIds ?? []),
      ...(params.excludeTaskId ? [params.excludeTaskId] : []),
    ]);
    return rows.filter((r) => {
      if (excluded.has(r.id)) return false;
      const source = params.excludeSourceOpen;
      return !(source
        && r.id === source.taskId
        && r.kind === 'OPEN'
        && r.intentId === source.intentId);
    }).length;
  } catch {
    return null;
  }
}

/** 미종결 task의 id/relayTaskId만 — 읽기 전용 readiness refresh용 (6단계 §7). 실패=null */
export async function listOpenRelayTaskIdsOrNull(): Promise<{ id: string; relayTaskId: string | null; transportGen: string }[] | null> {
  const nonTerminal = (Object.values(RELAY_TASK_STATUS) as RelayTaskStatus[])
    .filter((s) => !TERMINAL_STATUSES.includes(s));
  try {
    return await db.select({ id: relayTasksTable.id, relayTaskId: relayTasksTable.relayTaskId, transportGen: relayTasksTable.transportGen })
      .from(relayTasksTable)
      .where(inArray(relayTasksTable.status, nonTerminal));
  } catch {
    return null;
  }
}

/** 최근 relay task 조회 (상태 API용) — 민감정보 없는 컬럼만 반환 */
export async function listRecentRelayTasks(limit = 20): Promise<Array<{
  id: string; kind: string; status: string; relayTaskId: string | null; txHash: string | null;
  orderKey: string | null; feeToken: string | null; feeAmount: string | null;
  errorClass: string | null; resolutionBasis: string | null; createdAt: string; updatedAt: string;
}>> {
  try {
    const rows = await db.select().from(relayTasksTable)
      .orderBy(desc(relayTasksTable.createdAt)).limit(limit);
    return rows.map((r) => ({
      id: r.id, kind: r.kind, status: r.status, relayTaskId: r.relayTaskId, txHash: r.txHash,
      orderKey: r.orderKey, feeToken: r.feeToken, feeAmount: r.feeAmount,
      errorClass: r.errorClass, resolutionBasis: r.resolutionBasis,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    }));
  } catch {
    return [];
  }
}
