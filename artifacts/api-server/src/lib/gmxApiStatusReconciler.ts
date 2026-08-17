/**
 * gmxApiStatusReconciler — 공식 GMX API v2 주문 상태 reconciliation (6G-2 §9).
 *
 * 대상: transportGen='GMX_API_V2' relay task 중 미종결(TASK_ACCEPTED/SUBMITTING/
 * TX_SUBMITTED/ORDER_CREATED/UNRESOLVED) 상태.
 *
 * 원칙:
 *  - fetchOrderStatus({requestId})는 readonly 조회 — GMX_API_READONLY_ENABLED
 *    아니면 호출 0회 (transport가 구조적으로 차단, 상태 유지 = fail-closed).
 *  - CONFIRMED는 GMX 상태 보고만으로 금지 — executed 보고 + 온체인 receipt
 *    success + 허용 emitter의 OrderExecuted 이벤트가 있어야 전이한다.
 *  - FAILED는 온체인 TX_REVERTED(receipt status=reverted)만 — relay_reverted
 *    보고 단독으로는 전이 금지.
 *  - not-found/decode/알 수 없는 상태 = UNRESOLVED. network/timeout/5xx =
 *    일시 장애 — 전이 없음(다음 주기 재시도), 시간 경과에 따른 FAILED 금지.
 *  - 자동 재제출·자동 종결 없음. terminal 역행 없음(lifecycle 전이 테이블 강제).
 *  - 응답 원문·서명·API base URL은 저장·로그 금지 — 상태 문자열과
 *    txHash/orderKey 증거만 기록한다.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, relayTasksTable, type RelayTaskRow } from '@workspace/db';
import { RELAY_TASK_STATUS, transitionRelayTask, type RelayTaskStatus } from './relayLifecycle';
import { GMX_API_TRANSPORT_GEN, mapGmxApiStatus } from './gmxApiOrders';
import type { GmxApiTransport } from './gmxApiTransport';
import { createGmxApiTransport } from './gmxApiTransport';
import {
  classifyOrderResolutionLogs,
  extractOrderKeyFromReceiptLogs,
  resolveGmxEventEmitterAddress,
  type RawLog,
} from './gmxOrderEvents';
import { createViemOnchainClient, type OnchainClient } from './intentReconciler';
import { resolveIntentTerminal } from './executionIntents';

const OPEN_GMX_STATUSES: RelayTaskStatus[] = [
  RELAY_TASK_STATUS.SUBMITTING,
  RELAY_TASK_STATUS.TASK_ACCEPTED,
  RELAY_TASK_STATUS.TX_SUBMITTED,
  RELAY_TASK_STATUS.ORDER_CREATED,
  RELAY_TASK_STATUS.UNRESOLVED,
];

export interface GmxStatusFetchResult {
  ok: boolean;
  /** ok=true일 때: 상태 문자열 + 선택적 증거 필드 */
  status?: string;
  requestId?: string | null;
  executionTxHash?: string | null;
  orderKeys?: string[];
  /** ok=false일 때: transport 오류 분류 */
  kind?: string;
}

/** `/orders/txns/status` 응답의 방어적 추출 — 원문 저장·로그 금지 */
function extractStatusFields(raw: unknown): GmxStatusFetchResult {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return { ok: false, kind: 'decode' };
  const status = typeof r.status === 'string' ? r.status : null;
  if (!status) return { ok: false, kind: 'decode' };
  const tx = typeof r.executionTxHash === 'string' ? r.executionTxHash
    : typeof r.transactionHash === 'string' ? r.transactionHash
    : typeof r.txHash === 'string' ? r.txHash : null;
  const keysRaw = Array.isArray(r.orderKeys) ? r.orderKeys
    : typeof r.orderKey === 'string' ? [r.orderKey] : [];
  const orderKeys = keysRaw.filter((k): k is string => typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k));
  return {
    ok: true,
    status,
    requestId: typeof r.requestId === 'string' ? r.requestId : null,
    executionTxHash: tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : null,
    orderKeys,
  };
}

export async function fetchGmxApiOrderStatus(
  transport: GmxApiTransport,
  requestId: string,
): Promise<GmxStatusFetchResult> {
  const res = await transport.postJson<unknown>('/orders/txns/status', { requestId }, 'readonly');
  if (!res.ok) return { ok: false, kind: res.kind };
  return extractStatusFields(res.data);
}

export interface GmxReconcileDeps {
  transport: GmxApiTransport;
  onchain: OnchainClient | null;   // null = RPC 미설정 → 온체인 판정 불가(전이 보류)
  nowMs: () => number;
}

export interface GmxReconcileSummary {
  scanned: number;
  transitioned: number;
  unresolvedMarked: number;
  skippedTransient: number;
  errors: number;
}

function allowedEmitters(): string[] {
  const r = resolveGmxEventEmitterAddress();
  return r.ok ? [r.address] : [];
}

async function patchTask(
  taskId: string,
  patch: Partial<{ gmxApiStatus: string; gmxExecutionTxHash: string; gmxOrderKeys: string }>,
): Promise<void> {
  try {
    await db.update(relayTasksTable).set({ ...patch, updatedAt: new Date() })
      .where(eq(relayTasksTable.id, taskId));
  } catch { /* 기록 실패 — 상태 전이는 transitionRelayTask가 별도 판단 */ }
}

/** 연결된 execution intent를 relay task 종결과 함께 해소 (증거 동봉) */
async function resolveLinkedIntent(
  row: RelayTaskRow,
  status: 'CONFIRMED' | 'FAILED' | 'CANCELLED',
  evidence: { txHash: string | null; orderKey: string | null; basis: string },
): Promise<void> {
  if (!row.intentId) return;
  try {
    await resolveIntentTerminal(row.intentId, status, {
      resolutionTxHash: evidence.txHash,
      orderKey: evidence.orderKey ?? undefined,
      resolutionReason: evidence.basis,
    });
  } catch { /* intent 해소 실패 → blocking 유지 (fail-closed) */ }
}

/** 단일 task 판정 — 순수 로직 분리를 위해 receipt 증거 수집 포함 */
async function reconcileOneTask(row: RelayTaskRow, deps: GmxReconcileDeps, summary: GmxReconcileSummary): Promise<void> {
  const requestId = row.gmxRequestId ?? row.relayTaskId;
  if (!requestId) {
    // requestId 자체가 없으면 조회 불가 — UNRESOLVED 유지/전환 (조사 대상)
    if (row.status !== RELAY_TASK_STATUS.UNRESOLVED) {
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: 'GMX requestId 미확보 — 상태 조회 불가, 운영자 조사 필요' },
      });
      if (t.ok) summary.unresolvedMarked += 1;
    }
    return;
  }

  let st: GmxStatusFetchResult;
  try { st = await fetchGmxApiOrderStatus(deps.transport, requestId); }
  catch { st = { ok: false, kind: 'network' }; }

  if (!st.ok) {
    // 일시 장애(network/timeout/5xx)는 전이 없음 — 다음 주기 재시도.
    // 4xx(not-found)/decode는 UNRESOLVED (peer가 요청을 모름 = 조사 대상).
    if (st.kind === 'http_4xx' || st.kind === 'decode') {
      if (row.status !== RELAY_TASK_STATUS.UNRESOLVED) {
        const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: `status 조회 ${st.kind} (not-found/구조 불일치) — 자동 종결 금지, 조사 필요` },
      });
        if (t.ok) summary.unresolvedMarked += 1;
      }
    } else {
      summary.skippedTransient += 1;
    }
    return;
  }

  // peer 응답 requestId 불일치 = UNRESOLVED (§10)
  if (st.requestId && st.requestId !== requestId) {
    const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: 'status 응답 requestId 불일치 (peer 교차 응답) — 조사 필요' },
      });
    if (t.ok) summary.unresolvedMarked += 1;
    return;
  }

  const statusStr = st.status!;
  await patchTask(row.id, {
    gmxApiStatus: statusStr,
    ...(st.executionTxHash ? { gmxExecutionTxHash: st.executionTxHash } : {}),
    ...(st.orderKeys && st.orderKeys.length > 0 ? { gmxOrderKeys: JSON.stringify(st.orderKeys) } : {}),
  });

  const verdict = mapGmxApiStatus(statusStr);

  if (verdict.action === 'blocking') return; // 비종결 — 대기 (시간 경과 FAILED 금지)

  const txHash = st.executionTxHash ?? row.gmxExecutionTxHash ?? null;
  const storedKeys: string[] = (() => {
    if (st.orderKeys && st.orderKeys.length > 0) return st.orderKeys;
    try { return row.gmxOrderKeys ? (JSON.parse(row.gmxOrderKeys) as string[]) : []; }
    catch { return []; }
  })();

  if (verdict.action === 'failed_pre_broadcast') {
    // relay_failed + pre-broadcast 근거 — 여기(수락 이후)에서는 근거가 없으므로
    // mapGmxApiStatus가 blocking을 반환한다. 이 분기는 방어적 잔여 처리.
    return;
  }

  // executed/cancelled/relay_reverted — 전부 온체인 증거 필요
  if (!deps.onchain) return; // RPC 미설정 — 판정 보류 (차단 유지)
  if (!txHash) {
    // 종결 보고인데 txHash 없음 — 증거 불충분, UNRESOLVED
    const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: `GMX 보고 ${statusStr}이나 txHash 없음 — 온체인 검증 불가, 조사 필요` },
      });
    if (t.ok) summary.unresolvedMarked += 1;
    return;
  }

  let receipt: Awaited<ReturnType<OnchainClient['getTransactionReceipt']>>;
  try { receipt = await deps.onchain.getTransactionReceipt(txHash); }
  catch { summary.skippedTransient += 1; return; } // RPC 오류 — 다음 주기
  if (!receipt) return; // receipt 미존재/pending — 대기

  const emitters = allowedEmitters();

  if (verdict.action === 'fail_pending_receipt') {
    // relay_reverted: 온체인 receipt reverted일 때만 FAILED
    if (receipt.status === 'reverted') {
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.FAILED,
        patch: { txHash, resolutionBasis: `GMX relay_reverted + 온체인 receipt revert 확인 (tx=${txHash})` },
      });
      if (t.ok) {
        summary.transitioned += 1;
        await resolveLinkedIntent(row, 'FAILED', { txHash, orderKey: null, basis: '온체인 receipt revert' });
      }
    } else {
      // 보고와 온체인 모순 — 조사 필요
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: 'GMX relay_reverted 보고 ↔ 온체인 receipt success 모순 — 조사 필요' },
      });
      if (t.ok) summary.unresolvedMarked += 1;
    }
    return;
  }

  if (receipt.status !== 'success') {
    // executed/cancelled 보고인데 receipt revert — 모순, 조사 필요
    const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: `GMX 보고 ${statusStr} ↔ 온체인 receipt revert 모순 — 조사 필요` },
      });
    if (t.ok) summary.unresolvedMarked += 1;
    return;
  }

  // orderKey 확정 — 다중/부재는 UNRESOLVED (§9)
  let orderKey: string | null = storedKeys.length === 1 ? storedKeys[0] : null;
  if (!orderKey) {
    const extraction = extractOrderKeyFromReceiptLogs(receipt.logs as RawLog[], emitters);
    if (extraction.ok) orderKey = extraction.orderKey;
    else {
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { txHash, resolutionBasis: `orderKey 확정 불가(${storedKeys.length > 1 ? '다중 보고' : (extraction.ok ? '미확인' : extraction.reason)}) — 자동 종결 금지` },
      });
      if (t.ok) summary.unresolvedMarked += 1;
      return;
    }
  }

  const resolution = classifyOrderResolutionLogs(receipt.logs as RawLog[], orderKey, emitters);

  if (verdict.action === 'confirm_pending_onchain') {
    if (resolution?.kind === 'executed') {
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.CONFIRMED,
        patch: { txHash, orderKey, resolutionBasis: `GMX executed + 온체인 OrderExecuted (tx=${txHash} orderKey=${orderKey})` },
      });
      if (t.ok) {
        summary.transitioned += 1;
        await patchTask(row.id, { gmxExecutionTxHash: txHash, gmxOrderKeys: JSON.stringify([orderKey]) });
        await resolveLinkedIntent(row, 'CONFIRMED', { txHash, orderKey, basis: '온체인 OrderExecuted' });
      }
    } else {
      // executed 보고인데 온체인 OrderExecuted 이벤트 없음 — 보고만으로 CONFIRMED 금지
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: 'GMX executed 보고이나 허용 emitter OrderExecuted 이벤트 미확인 — 조사 필요' },
      });
      if (t.ok) summary.unresolvedMarked += 1;
    }
    return;
  }

  // cancelled — 온체인 OrderCancelled 근거 확인 후에만 CANCELLED
  if (verdict.action === 'cancelled') {
    if (resolution?.kind === 'cancelled') {
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.CANCELLED,
        patch: { txHash, orderKey, resolutionBasis: `GMX cancelled + 온체인 OrderCancelled (tx=${txHash})` },
      });
      if (t.ok) {
        summary.transitioned += 1;
        await resolveLinkedIntent(row, 'CANCELLED', { txHash, orderKey, basis: '온체인 OrderCancelled' });
      }
    } else {
      const t = await transitionRelayTask({
        taskId: row.id, from: row.status as RelayTaskStatus, to: RELAY_TASK_STATUS.UNRESOLVED,
        patch: { resolutionBasis: 'GMX cancelled 보고이나 온체인 OrderCancelled 이벤트 미확인 — 조사 필요' },
      });
      if (t.ok) summary.unresolvedMarked += 1;
    }
  }
}

/**
 * GMX API v2 미종결 task 일괄 reconciliation.
 * readonly 플래그 꺼짐 = 외부 호출 0회, 전이 0회 (fail-closed 유지).
 */
export async function reconcileGmxApiTasks(deps: GmxReconcileDeps): Promise<GmxReconcileSummary> {
  const summary: GmxReconcileSummary = { scanned: 0, transitioned: 0, unresolvedMarked: 0, skippedTransient: 0, errors: 0 };
  if (!deps.transport.readonlyEnabled) return summary; // 조회 불가 — 상태 유지

  let rows: RelayTaskRow[];
  try {
    rows = await db.select().from(relayTasksTable)
      .where(and(
        eq(relayTasksTable.transportGen, GMX_API_TRANSPORT_GEN),
        inArray(relayTasksTable.status, OPEN_GMX_STATUSES as string[]),
      ))
      .limit(50);
  } catch {
    summary.errors += 1;
    return summary;
  }

  for (const row of rows) {
    summary.scanned += 1;
    try { await reconcileOneTask(row, deps, summary); }
    catch { summary.errors += 1; }
  }
  return summary;
}

// ── 주기 실행 + 재시작 훅 ─────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function makeProductionDeps(): GmxReconcileDeps {
  let onchain: OnchainClient | null = null;
  try { onchain = createViemOnchainClient(); } catch { onchain = null; }
  return { transport: createGmxApiTransport(process.env), onchain, nowMs: () => Date.now() };
}

/** 재시작 reconciliation — index.ts 시작 시 1회 호출 (자동 재제출 없음) */
export async function reconcileGmxApiTasksOnStartup(): Promise<GmxReconcileSummary> {
  const summary = await reconcileGmxApiTasks(makeProductionDeps());
  if (summary.scanned > 0) {
    console.info(`[GmxApiReconciler] startup — scanned=${summary.scanned} transitioned=${summary.transitioned} unresolved=${summary.unresolvedMarked}`);
  }
  return summary;
}

/** 5분 주기 reconciliation 시작 (idempotent) */
export function startPeriodicGmxApiReconciliation(intervalMs = 5 * 60_000): void {
  if (_timer) return;
  _timer = setInterval(() => {
    void reconcileGmxApiTasks(makeProductionDeps()).catch(() => { /* 다음 주기 재시도 */ });
  }, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}

export function stopPeriodicGmxApiReconciliation(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
