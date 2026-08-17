/**
 * gmxapi routes — 공식 GMX API v2 실행 경로 상태 조회 (6G-2 §13).
 *
 * 원칙 (조회 전용):
 *  - signer 접근·서명·prepare/submit POST·자동 재시도 절대 없음.
 *  - GET status는 외부 호출 0회 — 저장 스냅샷·DB 파생값만 조립한다.
 *  - POST readiness/refresh는 readonly 조회만 — peer health GET(/markets/tickers)
 *    + 기존 미종결 task의 status readback(§9 reconciler 1회 실행).
 *    readonly 플래그 꺼짐 = 외부 호출 0회.
 *  - API base URL 전문·응답 원문·서명은 노출하지 않는다 (host명·상태 문자열만).
 */

import { Router } from 'express';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db, relayTasksTable, subaccountApprovalSessionsTable, tradesTable } from '@workspace/db';
import { requireOperatorAuth } from '../lib/operatorAuthGuard';
import { createGmxApiTransport, GMX_API_PEERS, type GmxApiTransport } from '../lib/gmxApiTransport';
import { GMX_API_TRANSPORT_GEN } from '../lib/gmxApiOrders';
import { RELAY_TASK_STATUS, TERMINAL_STATUSES } from '../lib/relayLifecycle';
import { countBlockingIntentsOrNull } from '../lib/executionIntents';
import { countOpenRelayTasksOrNull, listUnresolvedTasks } from '../lib/relayLifecycle';
import {
  getCanonicalSnapshot,
  getDeploymentVerificationState,
  getFeeEstimateState,
  getReadinessRefreshState,
} from '../lib/relayActivationStatus';
import { getActiveRevokeSession } from '../lib/revokeSession';
import { resolveGmxLiveRelayConfig } from '../lib/gmxLiveConfig';
import { isDelegatedSignerEnabled, isSignerInitialized } from '../lib/delegatedSigner';
import { isLiveTestExecutionLocked } from '../lib/liveTestGate';
import {
  isEmergencyStopActive, isReconciled, isStopExecutionAvailable, getStopExecutionCapability,
  STOP_EXECUTION_UNAVAILABLE, getProtectionReconState, countInFlightReservedActions,
  verifyPriceConversionGolden,
} from '../workers/liveTestExecutor';
import { getDecimalsCacheSnapshot } from '../lib/indexTokenDecimals';
import { resolveGmxEventEmitterAddress } from '../lib/gmxOrderEvents';
import { listActiveProtections, PROTECTION_BLOCKING_SET } from '../lib/protectionOrders';
import { evaluateActionBudget } from '../lib/actionBudget';
import { EXECUTION_ELIGIBLE_MAX_AGE_MS } from '../lib/costSnapshot';
import { listUncovered } from '../lib/stopLossPlan';
import { loadStopCoverage } from '../workers/liveTestExecutor';
import { getWorkerStatus } from '../workers/aiWorker';
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import { APPROVAL_PURPOSE, SESSION_STATUS } from '../lib/ownerApprovalSession';
import { reconcileGmxApiTasks, makeProductionDeps } from '../lib/gmxApiStatusReconciler';
import { getGmxPrepareStartupState } from '../lib/gmxApiPrepareStartup';
import { sanitizeRpcError } from '../lib/rpcErrorSanitize';

const router = Router();

// 테스트 주입용 transport override (readonly 조회 전용)
let injectedTransport: GmxApiTransport | null = null;
export function __setGmxApiRouteTransportForTests(t: GmxApiTransport | null): void {
  injectedTransport = t;
}
function transport(): GmxApiTransport {
  return injectedTransport ?? createGmxApiTransport(process.env);
}

/** GMX API v2 상태 스냅샷 조립 — 외부 호출 0회 (DB read + 메모리 getter만) */
async function buildGmxApiStatusSnapshot() {
  const env = process.env;
  const snap = getCanonicalSnapshot();
  const canonicalAuthorized = !!snap && snap.confirmed && snap.isSubaccountListed === true;
  let approvalRemainingOk = false;
  if (snap?.remaining && snap?.expiresAt) {
    try {
      approvalRemainingOk = BigInt(snap.remaining) > 0n && Number(snap.expiresAt) * 1000 > Date.now();
    } catch { approvalRemainingOk = false; }
  }

  const [blockingIntents, openRelayTasks] = await Promise.all([
    countBlockingIntentsOrNull(),
    countOpenRelayTasksOrNull(),
  ]);
  const dbOk = blockingIntents !== null && openRelayTasks !== null;

  let revoke: boolean | null = null;
  try { revoke = (await getActiveRevokeSession()) !== null; } catch { revoke = null; }

  // Owner approval 세션 준비 여부 — 복호화·signer 접근 없음 (행 존재 여부만)
  let approvalSessionReady: boolean | null = null;
  try {
    const rows = await db.select({ id: subaccountApprovalSessionsTable.id })
      .from(subaccountApprovalSessionsTable)
      .where(and(
        eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.OWNER_SIGNATURE_READY),
      ))
      .limit(1);
    approvalSessionReady = rows.length > 0;
  } catch { approvalSessionReady = null; }

  // GMX API v2 세대 task 현황
  let gmxTaskCounts: Record<string, number> | null = null;
  let recentGmxTasks: Array<{
    id: string; kind: string; status: string;
    gmxApiStatus: string | null; hasRequestId: boolean;
    txHash: string | null; updatedAt: string | null;
  }> | null = null;
  // 6G-3 §7 — prepare 단계별 blocking task 집계 (조회 실패 = null, fail-closed 표시)
  let prepareStageCounts: Record<string, number> | null = null;
  let oldestBlockingTaskAt: string | null = null;
  try {
    const rows = await db.select().from(relayTasksTable)
      .where(eq(relayTasksTable.transportGen, GMX_API_TRANSPORT_GEN))
      .orderBy(desc(relayTasksTable.updatedAt))
      .limit(20);
    gmxTaskCounts = {};
    for (const r of rows) gmxTaskCounts[r.status] = (gmxTaskCounts[r.status] ?? 0) + 1;
    // blocking 집계는 최근 20행이 아니라 전체 non-terminal GMX task 기준 (limit 없음)
    const nonTerminal = (Object.values(RELAY_TASK_STATUS) as string[])
      .filter((s) => !(TERMINAL_STATUSES as readonly string[]).includes(s));
    const blockingRows = await db.select({ status: relayTasksTable.status, createdAt: relayTasksTable.createdAt })
      .from(relayTasksTable)
      .where(and(
        eq(relayTasksTable.transportGen, GMX_API_TRANSPORT_GEN),
        inArray(relayTasksTable.status, nonTerminal as never),
      ));
    prepareStageCounts = {};
    for (const s of nonTerminal) prepareStageCounts[s] = 0;
    let oldest: Date | null = null;
    for (const r of blockingRows) {
      prepareStageCounts[r.status] = (prepareStageCounts[r.status] ?? 0) + 1;
      const created = r.createdAt ? new Date(r.createdAt) : null;
      if (created && (!oldest || created < oldest)) oldest = created;
    }
    oldestBlockingTaskAt = oldest ? oldest.toISOString() : null;
    recentGmxTasks = rows.slice(0, 10).map((r) => ({
      id: r.id, kind: r.kind, status: r.status,
      gmxApiStatus: r.gmxApiStatus ?? null,
      hasRequestId: !!(r.gmxRequestId ?? r.relayTaskId),
      txHash: r.txHash ?? r.gmxExecutionTxHash ?? null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    }));
  } catch { gmxTaskCounts = null; recentGmxTasks = null; prepareStageCounts = null; oldestBlockingTaskAt = null; }

  let unresolvedCount: number | null = null;
  try { unresolvedCount = (await listUnresolvedTasks(50)).length; } catch { unresolvedCount = null; }

  const fe = getFeeEstimateState();
  const dv = getDeploymentVerificationState();
  const lastRefresh = getReadinessRefreshState();

  const readonlyEnabled = env.GMX_API_READONLY_ENABLED === 'true';
  const submissionEnabled = env.GMX_API_ORDER_SUBMISSION_ENABLED === 'true';
  const signerEnabled = isDelegatedSignerEnabled();
  const signerInitialized = isSignerInitialized();
  const liveLocked = isLiveTestExecutionLocked();
  const emergencyStop = isEmergencyStopActive();
  const reconciled = isReconciled();
  const gmxConfigOk = resolveGmxLiveRelayConfig().ok;
  const feeEstimateFresh =
    fe.attempted && fe.ok && fe.atMs !== null && Date.now() - fe.atMs < 10 * 60_000;

  // 6G-3 §7 — startup prepare reconciliation 상태 (메모리 getter만, 외부 호출 0회)
  const prepareStartup = getGmxPrepareStartupState();

  // 6G-3 §7 — 신규 주문 차단 사유 전체 (표시 전용, 파생값만)
  const blockedReasons: string[] = [];
  if (!submissionEnabled) blockedReasons.push('order submission flag 비활성 — 구조적 차단');
  if (isLiveTestExecutionLocked()) blockedReasons.push('LIVE_TEST_EXECUTION_LOCKED — 실행 잠금');
  if (isEmergencyStopActive()) blockedReasons.push('Emergency Stop 활성');
  if (!isReconciled()) blockedReasons.push('intent reconciliation 미완료');
  if (!prepareStartup.attempted || !prepareStartup.ok) blockedReasons.push('prepare 단계 startup reconciliation 미완료/실패');
  if (!dbOk) blockedReasons.push('DB 조회 실패 (fail-closed)');
  if (blockingIntents === null || blockingIntents > 0) blockedReasons.push(`blocking intent ${blockingIntents ?? '조회 실패'}`);
  if (prepareStageCounts === null) {
    blockedReasons.push('relay task 단계 집계 조회 실패 (fail-closed)');
  } else {
    const blockingTasks = Object.values(prepareStageCounts).reduce((a, b) => a + b, 0);
    if (blockingTasks > 0) blockedReasons.push(`미종결 relay task ${blockingTasks}건 — 운영자 확인 필요`);
  }
  if ((unresolvedCount ?? 1) > 0) blockedReasons.push(`UNRESOLVED task ${unresolvedCount ?? '조회 실패'} — 자동 재시도 없음`);

  // ── 6H-2A §10 — Canary 적격 조건 확장 (전부 fail-closed) ────────────────────
  // stop 실행 능력 (§7) — trigger 주문 경로 미구현 = 부적격
  const stopExecutionAvailable = isStopExecutionAvailable();
  if (!stopExecutionAvailable) blockedReasons.push(`${STOP_EXECUTION_UNAVAILABLE} — stop(trigger) 주문 제출 경로 미구현`);
  // stop 미확보 포지션 0건 필수 (§7)
  let uncoveredStopCount: number | null = null;
  try {
    const cov = await loadStopCoverage();
    uncoveredStopCount = cov.ok ? listUncovered(cov.map).length : null;
  } catch { uncoveredStopCount = null; }
  if ((uncoveredStopCount ?? 1) > 0) blockedReasons.push(`STOP_UNCOVERED ${uncoveredStopCount ?? '조회 실패'}건 — stop 미확보 포지션 존재/조회 실패`);
  // LIVE 정산 능력 (§5) — reconciliation 미완료/미실행 = 부적격
  const settlementReconcile = getWorkerStatus().settlementReconcile;
  const settlementComplete = settlementReconcile !== null && !settlementReconcile.incomplete;
  if (!settlementComplete) {
    blockedReasons.push(`LIVE_SETTLEMENT_INCOMPLETE — ${settlementReconcile?.reasons[0] ?? '정산 reconciliation 미실행'}`);
  }
  // legacy zero-fee/UNSETTLED LIVE 거래 잔존 0건 필수 (§2·§10)
  let legacyZeroFeeCount: number | null = null;
  let unsettledLiveTradeCount: number | null = null;
  try {
    const rows = await db.select({ st: tradesTable.settlementStatus, tm: tradesTable.testMode })
      .from(tradesTable)
      .where(or(
        eq(tradesTable.settlementStatus, 'PAPER_ZERO_FEE'),
        and(eq(tradesTable.testMode, true), eq(tradesTable.settlementStatus, 'UNSETTLED')),
      ));
    legacyZeroFeeCount = rows.filter(r => r.st === 'PAPER_ZERO_FEE').length;
    unsettledLiveTradeCount = rows.filter(r => r.tm === true && r.st === 'UNSETTLED').length;
  } catch { legacyZeroFeeCount = null; unsettledLiveTradeCount = null; }
  if ((legacyZeroFeeCount ?? 1) > 0) blockedReasons.push(`legacy PAPER_ZERO_FEE 거래 ${legacyZeroFeeCount ?? '조회 실패'}건 잔존`);
  if ((unsettledLiveTradeCount ?? 1) > 0) blockedReasons.push(`UNSETTLED LIVE 거래 ${unsettledLiveTradeCount ?? '조회 실패'}건 — 정산 증거 확보 전 canary 부적격`);
  // 비용 스냅샷 능력 — readonly 조회 경로 활성 필수 (§3; zero-fee/고정 모델 경로는 코드에서 제거됨)
  if (!readonlyEnabled) blockedReasons.push('COST_DATA_UNAVAILABLE — readonly 비용 조회 경로 비활성');

  // ── 6H-2B §12 — 보호 주문(durable protection) 관측값 (조회 전용) ────────────
  const stopCapability = getStopExecutionCapability();
  let protectionCounts: Record<string, number> | null = null;
  let blockingProtectionCount: number | null = null;
  let staleStopCount: number | null = null;
  let emergencyCloseInProgressCount: number | null = null;
  try {
    const listed = await listActiveProtections();
    if (listed.ok) {
      protectionCounts = {};
      let blocking = 0; let stale = 0; let emergency = 0;
      const nowMs = Date.now();
      for (const r of listed.rows) {
        protectionCounts[r.status] = (protectionCounts[r.status] ?? 0) + 1;
        if ((PROTECTION_BLOCKING_SET as readonly string[]).includes(r.status)) blocking += 1;
        // stale: SUBMITTING/SUBMITTED가 10분 이상 정체 = 조사 대상 (자동 전환 없음)
        const updated = r.updatedAt ? new Date(r.updatedAt).getTime() : nowMs;
        if ((r.status === 'SUBMITTING' || r.status === 'SUBMITTED') && nowMs - updated > 10 * 60_000) stale += 1;
        if (r.purpose === 'EMERGENCY_CLOSE') emergency += 1;
      }
      blockingProtectionCount = blocking;
      staleStopCount = stale;
      emergencyCloseInProgressCount = emergency;
    }
  } catch { /* null 유지 (fail-closed 표시) */ }
  if (blockingProtectionCount === null) blockedReasons.push('보호 주문 상태 조회 실패 (fail-closed)');
  else if (blockingProtectionCount > 0) blockedReasons.push(`차단 상태 보호 주문 ${blockingProtectionCount}건 — 해소 전 신규 OPEN 금지`);
  // §7 — action 예산 (canonical remaining 기준, 표시 전용)
  const actionBudget = evaluateActionBudget({
    remaining: snap?.remaining ?? null,
    expiresAt: snap?.expiresAt ?? null,
    nowMs: Date.now(),
    inFlightReservedActions: await countInFlightReservedActions(),
  });
  if (!actionBudget.sufficient) blockedReasons.push(`action 예산 부족/조회불가 — ${actionBudget.reasons[0] ?? ''}`);
  // ── 6H-2C §10 — decimals·증거 수집기·reconciliation 관측값 (저장 스냅샷만) ──
  const protectionRecon = getProtectionReconState();
  const decimalsCache = getDecimalsCacheSnapshot(Date.now());
  const evidenceCollector = {
    emitterConfigured: resolveGmxEventEmitterAddress().ok,
    rpcConfigured: Boolean(process.env.GMX_RPC_URL?.trim()),
  };
  const priceConversionVerified = verifyPriceConversionGolden();
  if (!protectionRecon.complete || protectionRecon.blockNewOpens) {
    blockedReasons.push('보호 주문 reconciliation 미완료/불일치 — 신규 OPEN 차단');
  }

  // readyForControlledCanary — 전 항목 파생값의 논리곱 (fail-closed; 어느 하나
  // null/false면 false). 현 단계는 submissionEnabled=false라 항상 false.
  const readyForControlledCanary =
    readonlyEnabled && submissionEnabled && signerEnabled && signerInitialized &&
    !liveLocked && !emergencyStop && reconciled && dbOk &&
    canonicalAuthorized && approvalRemainingOk && approvalSessionReady === true &&
    blockingIntents === 0 && (unresolvedCount ?? 1) === 0 && revoke === false &&
    gmxConfigOk && dv.ok && feeEstimateFresh &&
    stopExecutionAvailable && uncoveredStopCount === 0 && settlementComplete &&
    legacyZeroFeeCount === 0 && unsettledLiveTradeCount === 0 &&
    blockingProtectionCount === 0 && (staleStopCount ?? 1) === 0 && actionBudget.sufficient &&
    priceConversionVerified && protectionRecon.complete && !protectionRecon.blockNewOpens;

  return {
    transportGen: GMX_API_TRANSPORT_GEN,
    legacyDisabled: true,
    peers: GMX_API_PEERS.map((p) => new URL(p).host),
    readonlyEnabled,
    submissionEnabled,
    signerEnabled,
    signerInitialized,
    liveTestExecutionLocked: liveLocked,
    emergencyStopActive: emergencyStop,
    reconciled,
    dbOk,
    canonical: {
      authorized: canonicalAuthorized,
      approvalRemainingOk,
      reason: snap?.reason ?? 'canonical readback 미조회 — 저장 스냅샷 없음 (fail-closed)',
      expiresAt: snap?.expiresAt ?? null,
      remaining: snap?.remaining ?? null,
    },
    approvalSessionReady,
    blockingIntentCount: blockingIntents,
    openRelayTaskCount: openRelayTasks,
    unresolvedTaskCount: unresolvedCount,
    activeRevokeInProgress: revoke,
    gmxConfigOk,
    deploymentVerification: { attempted: dv.attempted, ok: dv.ok, atMs: dv.atMs, manifestVersion: dv.manifestVersion },
    manifestVersion: GMX_DEPLOYMENT_MANIFEST.manifestVersion,
    feeEstimate: { attempted: fe.attempted, ok: fe.ok, atMs: fe.atMs, fresh: feeEstimateFresh },
    lastReadinessRefresh: {
      attempted: lastRefresh.attempted, atMs: lastRefresh.atMs,
      ok: lastRefresh.ok, basis: lastRefresh.basis,
    },
    gmxTaskCounts,
    recentGmxTasks,
    // ── 6H-2A §10 — canary 적격 조건 확장 관측값 ─────────────────────────────
    stopExecutionAvailable,
    // ── 6H-2B §12 — stop capability·보호 주문·action 예산 관측값 ─────────────
    stopCapability: {
      available: stopCapability.available,
      reasons: stopCapability.reasons,
      evaluatedAt: stopCapability.evaluatedAt,
      schemaPin: { sdk: '@gmx-io/sdk@1.7.0', stopLossDecrease: 6 },
    },
    protectionCounts,
    blockingProtectionCount,
    staleStopCount,
    emergencyCloseInProgressCount,
    actionBudget: {
      sufficient: actionBudget.sufficient,
      remainingActions: actionBudget.remainingActions,
      requiredActions: actionBudget.requiredActions,
      reservedEmergencyActions: actionBudget.reservedEmergencyActions,
      inFlightReservedActions: actionBudget.inFlightReservedActions,
      budgetShortfall: actionBudget.budgetShortfall,
      budgetBasis: actionBudget.budgetBasis,
      reasons: actionBudget.reasons,
    },
    // ── 6H-2C §10 — decimals·증거 수집기·reconciliation 관측값 ────────────────
    decimalsCache,
    priceConversionVerified,
    evidenceCollector,
    protectionReconciliation: {
      lastRunAtMs: protectionRecon.lastRunAtMs,
      complete: protectionRecon.complete,
      blockNewOpens: protectionRecon.blockNewOpens,
      uncoveredCount: protectionRecon.anomalies?.uncoveredCount ?? null,
      staleActiveCount: protectionRecon.anomalies?.staleActiveCount ?? null,
      oversizedCount: protectionRecon.anomalies?.oversizedCount ?? null,
      multipleActiveCount: protectionRecon.anomalies?.multipleActiveCount ?? null,
      keyMismatchCount: protectionRecon.anomalies?.keyMismatchCount ?? null,
    },
    executionEligibleCostMaxAgeMs: EXECUTION_ELIGIBLE_MAX_AGE_MS,
    uncoveredStopCount,
    settlementReconcile,
    legacyZeroFeeCount,
    unsettledLiveTradeCount,
    readyForControlledCanary,
    // 6G-3 §7 — prepare 단계 관측·차단 사유 (조회 전용)
    prepareStageCounts,
    oldestBlockingTaskAt,
    prepareStartupReconciliation: {
      attempted: prepareStartup.attempted, ok: prepareStartup.ok, atMs: prepareStartup.atMs,
      stalePreparedFailed: prepareStartup.stalePreparedFailed,
      requestedToUnresolved: prepareStartup.requestedToUnresolved,
      apiPreparedHeld: prepareStartup.apiPreparedHeld,
    },
    blockedReasons,
    notices: [
      '자동 재시도 없음 — UNRESOLVED/API_PREPARED는 운영자 확인 전 어떤 자동 조치도 하지 않습니다.',
      '운영자 확인 전 서명·제출 금지 — 이 화면은 조회 전용이며 강제 완료·삭제·재제출 기능이 없습니다.',
    ],
  };
}

// GET /executor/gmx-api/status — 조회 전용 (외부 호출 0회)
router.get('/executor/gmx-api/status', requireOperatorAuth, async (_req, res) => {
  try {
    const snapshot = await buildGmxApiStatusSnapshot();
    return res.json({ ok: true, status: snapshot });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// POST /executor/gmx-api/readiness/refresh — readonly 조회만.
// 허용: peer health GET + 기존 미종결 task status readback(§9, 자동 재제출 0회).
// 금지: signer 접근·서명·prepare/submit·task/intent 생성·자동 재시도.
router.post('/executor/gmx-api/readiness/refresh', requireOperatorAuth, async (_req, res) => {
  try {
    const t = transport();
    let peerHealth: Array<{ peerHost: string; ok: boolean; kind?: string }> | null = null;
    if (t.readonlyEnabled) {
      peerHealth = [];
      for (const base of t.peers) {
        const single = injectedTransport ?? createGmxApiTransport(process.env, { peers: [base] });
        const r = await single.getJson('/markets/tickers');
        peerHealth.push(r.ok
          ? { peerHost: r.peerHost, ok: true }
          : { peerHost: new URL(base).host, ok: false, kind: r.kind });
        if (injectedTransport) break; // 테스트 주입 시 단일 transport로만
      }
    }

    // §9 reconciliation 1회 — readonly 게이트 내장 (플래그 꺼짐 = scanned 0)
    const recon = await reconcileGmxApiTasks(
      injectedTransport
        ? { transport: injectedTransport, onchain: null, nowMs: () => Date.now() }
        : makeProductionDeps(),
    );

    const snapshot = await buildGmxApiStatusSnapshot();
    return res.json({
      ok: true,
      refresh: { readonlyEnabled: t.readonlyEnabled, peerHealth, reconciliation: recon },
      status: snapshot,
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

export default router;
