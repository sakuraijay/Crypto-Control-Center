/**
 * gmxApiPrepareStartup — 6G-3 §4 재시작 시 prepare 단계 reconciliation.
 *
 * 규칙 (전부 fail-closed, GMX POST·signer 접근·서명·nonce 할당 0회):
 *  - PREPARED (GMX gen): PREPARE_REQUESTED 전환이 외부 호출보다 먼저 커밋되므로,
 *    재시작 시 PREPARED로 남은 행은 "외부 prepare 미호출 확정" → FAILED_PRE_BROADCAST.
 *    자동 prepare 재호출 금지.
 *  - PREPARE_REQUESTED: prepare 결과 불명 → UNRESOLVED 영속 전환 (자동 재시도 금지).
 *  - API_PREPARED: 자동 서명/제출 재개 금지 — 상태 유지, 개수만 보고 (신규 실행은
 *    countBlockingRelayTasksOrNull로 차단됨).
 *  - 조회/전이 실패: ok=false → LIVE 경로 전체 차단 (activation reconciled=false).
 */

import { desc, eq, and, inArray } from 'drizzle-orm';
import { db, relayTasksTable } from '@workspace/db';
import { transitionRelayTask, RELAY_TASK_STATUS } from './relayLifecycle';
import { GMX_API_TRANSPORT_GEN } from './gmxApiOrders';

export interface GmxPrepareStartupState {
  attempted: boolean;
  ok: boolean;
  atMs: number | null;
  /** PREPARED → FAILED_PRE_BROADCAST (prepare 미호출 확정) 건수 */
  stalePreparedFailed: number;
  /** PREPARE_REQUESTED → UNRESOLVED 건수 */
  requestedToUnresolved: number;
  /** API_PREPARED 유지(자동 재개 금지) 건수 */
  apiPreparedHeld: number;
}

let state: GmxPrepareStartupState = {
  attempted: false, ok: false, atMs: null,
  stalePreparedFailed: 0, requestedToUnresolved: 0, apiPreparedHeld: 0,
};

export function getGmxPrepareStartupState(): GmxPrepareStartupState {
  return { ...state };
}

/** 테스트 전용 초기화 */
export function __resetGmxPrepareStartupStateForTests(): void {
  state = {
    attempted: false, ok: false, atMs: null,
    stalePreparedFailed: 0, requestedToUnresolved: 0, apiPreparedHeld: 0,
  };
}

export async function reconcileGmxPrepareStagesOnStartup(): Promise<GmxPrepareStartupState> {
  const next: GmxPrepareStartupState = {
    attempted: true, ok: false, atMs: Date.now(),
    stalePreparedFailed: 0, requestedToUnresolved: 0, apiPreparedHeld: 0,
  };
  try {
    // 전수 pagination — 배치가 가득 차면 다음 배치 재조회. PREPARED/PREPARE_REQUESTED는
    // 전이되어 다음 조회에서 빠지고, API_PREPARED는 seen 집합으로 중복 없이 집계.
    // 완주를 증명하지 못하면(반복 한도 초과) ok=false.
    const BATCH = 200;
    const MAX_ROUNDS = 50;
    const seenApiPrepared = new Set<string>();
    let allTransitionsOk = true;
    let exhausted = false;

    for (let round = 0; round < MAX_ROUNDS && !exhausted; round++) {
    const rows = await db.select({ id: relayTasksTable.id, status: relayTasksTable.status })
      .from(relayTasksTable)
      .where(and(
        eq(relayTasksTable.transportGen, GMX_API_TRANSPORT_GEN),
        inArray(relayTasksTable.status, [
          RELAY_TASK_STATUS.PREPARED, RELAY_TASK_STATUS.PREPARE_REQUESTED, RELAY_TASK_STATUS.API_PREPARED,
        ]),
      ))
      .orderBy(desc(relayTasksTable.createdAt)).limit(BATCH);

    const pending = rows.filter((r) => !seenApiPrepared.has(r.id));
    if (rows.length < BATCH) exhausted = true;
    if (pending.length === 0) { exhausted = true; break; }
    let progressed = false;
    for (const row of pending) {
      if (row.status === RELAY_TASK_STATUS.PREPARED) {
        const t = await transitionRelayTask({
          taskId: row.id, from: RELAY_TASK_STATUS.PREPARED, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
          patch: { errorClass: 'STARTUP_STALE_PREPARED', resolutionBasis: '재시작: PREPARE_REQUESTED 전환 전 중단 — 외부 prepare 미호출 확정, broadcast 없음' },
        });
        if (t.ok) next.stalePreparedFailed++; else allTransitionsOk = false;
      } else if (row.status === RELAY_TASK_STATUS.PREPARE_REQUESTED) {
        const t = await transitionRelayTask({
          taskId: row.id, from: RELAY_TASK_STATUS.PREPARE_REQUESTED, to: RELAY_TASK_STATUS.UNRESOLVED,
          patch: { errorClass: 'STARTUP_PREPARE_UNRESOLVED', resolutionBasis: '재시작: prepare 결과 불명 — 운영자 확인 필요, 자동 재시도 금지' },
        });
        if (t.ok) next.requestedToUnresolved++; else allTransitionsOk = false;
      } else {
        // API_PREPARED — 자동 서명/제출 재개 금지, 표시·차단만
        next.apiPreparedHeld++;
        seenApiPrepared.add(row.id);
        progressed = true;
      }
    }
    // 전이 실패 행은 다음 배치에도 같은 상태로 남는다 — 무한 루프 방지:
    // 이번 라운드에 아무 진전(전이 성공/신규 API_PREPARED)이 없으면 중단.
    const transitioned = pending.some((r) => r.status !== RELAY_TASK_STATUS.API_PREPARED);
    if (!allTransitionsOk && !progressed && transitioned) break;
    }
    // 완주(exhausted)를 증명하지 못했거나 전이 실패가 있으면 ok=false
    next.ok = allTransitionsOk && exhausted;
  } catch {
    next.ok = false;
  }
  state = next;
  return { ...state };
}
