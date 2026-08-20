/**
 * gmxapi routes — 공식 GMX API v2 실행 경로 상태 조회 (6G-2 §13).
 *
 * 원칙 (조회 전용):
 *  - signer 접근·서명·prepare/submit POST·자동 재시도 절대 없음.
 *  - GET status는 외부 호출 0회 — 저장 스냅샷·DB 파생값만 조립한다.
 *  - POST readiness/refresh는 readonly 조회만 — peer health GET(/markets/tickers)
 *    + decimals/cost/stop capability의 read-only evidence 갱신.
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
import {
  isDelegatedSignerEnabled,
  isManualCanarySignerRestoreAllowed,
  isSignerInitialized,
} from '../lib/delegatedSigner';
import { isLiveTestExecutionLocked } from '../lib/liveTestGate';
import {
  isEmergencyStopActive, isReconciled, isStopExecutionAvailable, getStopExecutionCapability,
  refreshStopExecutionCapability,
  STOP_EXECUTION_UNAVAILABLE, getProtectionReconState, countInFlightReservedActions,
  verifyPriceConversionGolden,
} from '../workers/liveTestExecutor';
import { getDecimalsCacheSnapshot } from '../lib/indexTokenDecimals';
import { resolveGmxEventEmitterAddress } from '../lib/gmxOrderEvents';
import { listActiveProtections, PROTECTION_BLOCKING_SET } from '../lib/protectionOrders';
import {
  evaluateActionBudget, ACTION_BUDGET_VERSION, AUTO_CANCEL_BUDGET_POLICY,
  worstCasePathName, RECOMMENDED_OWNER_APPROVAL_COUNT,
} from '../lib/actionBudget';
import { EXECUTION_ELIGIBLE_MAX_AGE_MS, getExecutionEligibleCostEvidence } from '../lib/costSnapshot';
import { listUncovered } from '../lib/stopLossPlan';
import { loadStopCoverage } from '../workers/liveTestExecutor';
import { getWorkerStatus } from '../workers/aiWorker';
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import { APPROVAL_PURPOSE, SESSION_STATUS } from '../lib/ownerApprovalSession';
import { getGmxPrepareStartupState } from '../lib/gmxApiPrepareStartup';
import { sanitizeRpcError } from '../lib/rpcErrorSanitize';
import { getLastPreflight, isPreflightPassedFresh, runGmxLivePreflight, PREFLIGHT_TTL_MS } from '../lib/gmxLivePreflight';
import { deriveCanaryDecimalsReadiness } from '../lib/canaryDecimalsReadiness';
import { getPaperRuntimeReadinessSnapshot } from '../lib/paperRuntimeReadiness';
import { runGmxApiReadinessRefresh } from '../lib/gmxApiReadinessCoordinator';

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
  const manualCanaryPosture = isManualCanarySignerRestoreAllowed(env);
  const executionCostEvidence = getExecutionEligibleCostEvidence(Date.now());
  const paperRuntimeReadiness = getPaperRuntimeReadinessSnapshot(Date.now(), env);
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
  // stop 실행 능력 (§7) — 경로 구현 여부가 아니라 현재 capability/evidence로 판정
  const stopExecutionAvailable = isStopExecutionAvailable();
  if (!stopExecutionAvailable) {
    blockedReasons.push(`${STOP_EXECUTION_UNAVAILABLE} — Stop-Loss 경로 구현됨, 현재 capability/evidence 미충족`);
  }
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
  const canaryDecimals = deriveCanaryDecimalsReadiness(decimalsCache);
  const decimalsReady = canaryDecimals.BTC && canaryDecimals.ETH;
  if (!decimalsReady) blockedReasons.push('BTC/ETH index token decimals 증거 미확보/만료');
  if (!executionCostEvidence.fresh) blockedReasons.push('30초 실행 적격 비용 스냅샷 미확보/만료');
  const evidenceCollector = {
    emitterConfigured: resolveGmxEventEmitterAddress().ok,
    rpcConfigured: Boolean(process.env.GMX_RPC_URL?.trim()),
  };
  const priceConversionVerified = verifyPriceConversionGolden();
  if (!protectionRecon.complete || protectionRecon.blockNewOpens) {
    blockedReasons.push('보호 주문 reconciliation 미완료/불일치 — 신규 OPEN 차단');
  }
  // ── 6H-2D §5·§7 — ambiguous 증거·예산 상한 차단 사유 ──
  if (protectionRecon.ambiguousCount > 0) {
    blockedReasons.push(`모호(ambiguous) 온체인 증거 ${protectionRecon.ambiguousCount}건 — 전이 금지·수동 조사 필요`);
  }
  if (actionBudget.requiredActions > 10) {
    blockedReasons.push(`필요 action 예산 ${actionBudget.requiredActions} > 10 — 경로 재감사 전 Canary 금지 (§7)`);
  }

  // readyForControlledCanary — 전 항목 파생값의 논리곱 (fail-closed; 어느 하나
  // null/false면 false). 현 단계는 submissionEnabled=false라 항상 false.
  const readyForControlledCanary =
    readonlyEnabled && submissionEnabled && signerEnabled && signerInitialized &&
    !liveLocked && !emergencyStop && reconciled && dbOk &&
    canonicalAuthorized && approvalRemainingOk && approvalSessionReady === true &&
    blockingIntents === 0 && (unresolvedCount ?? 1) === 0 && revoke === false &&
    manualCanaryPosture.allowed && dv.ok && executionCostEvidence.fresh && decimalsReady &&
    stopExecutionAvailable && uncoveredStopCount === 0 && settlementComplete &&
    legacyZeroFeeCount === 0 && unsettledLiveTradeCount === 0 &&
    blockingProtectionCount === 0 && (staleStopCount ?? 1) === 0 && actionBudget.sufficient &&
    priceConversionVerified && protectionRecon.complete && !protectionRecon.blockNewOpens &&
    protectionRecon.ambiguousCount === 0 && actionBudget.requiredActions <= 10;

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
    manualCanaryPosture,
    executionEligibleCostEvidence: executionCostEvidence,
    paperRuntimeReadiness,
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
      scope: 'LIVE_STOP_EXECUTION',
      boundary: 'READ_ONLY_STATUS_NOT_EXECUTION_AUTHORIZATION',
      paperMode: process.env.WORKER_ENGINE_MODE === 'PAPER',
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
      // ── 6H-2D §6 — 예산 정책 메타 ──
      version: ACTION_BUDGET_VERSION,
      autoCancelPolicy: AUTO_CANCEL_BUDGET_POLICY,
      worstCasePath: worstCasePathName(),
      recommendedOwnerApprovalCount: RECOMMENDED_OWNER_APPROVAL_COUNT,
    },
    // ── 6H-2C §10 — decimals·증거 수집기·reconciliation 관측값 ────────────────
    decimalsCache,
    canaryDecimals,
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
      // ── 6H-2D §5·§9 — ambiguous·finality·실행 소스 관측값 ──
      ambiguousCount: protectionRecon.ambiguousCount,
      ambiguousReasons: protectionRecon.ambiguousReasons,
      lastSource: protectionRecon.lastSource,
      confirmationDepth: protectionRecon.confirmationDepth,
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
// 허용: peer health GET + decimals/cost/RPC capability readback.
// 금지: reconciliation·DB 상태 전이·signer 접근·서명·prepare/submit·task/intent 생성·자동 재시도.
router.post('/executor/gmx-api/readiness/refresh', requireOperatorAuth, async (_req, res) => {
  try {
    const t = transport();
    const refreshResult = await runGmxApiReadinessRefresh({
      transport: t,
      peerTransportFactory: injectedTransport
        ? () => injectedTransport as GmxApiTransport
        : undefined,
      singlePeerOnly: injectedTransport !== null,
      forceDeployment: true,
    });

    const snapshot = await buildGmxApiStatusSnapshot();
    return res.json({
      ok: true,
      refresh: {
        generation: refreshResult.generation,
        readonlyEnabled: refreshResult.readonlyEnabled,
        peerHealth: refreshResult.peerHealth,
        reconciliation: {
          ran: false,
          readOnly: true,
          reason: 'readiness refresh에서는 durable reconciliation을 실행하지 않음',
        },
        canaryEvidence: refreshResult.canaryEvidence,
        paperRuntimeReadiness: refreshResult.paperRuntimeReadiness,
        stopCapability: refreshResult.stopCapability,
      },
      status: snapshot,
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// ── #131 LIVE preflight ─────────────────────────────────────────────────────
// GET — 저장 스냅샷만 노출 (외부 호출 0회, readiness-snapshot 패턴)
router.get('/executor/live-preflight', requireOperatorAuth, (_req, res) => {
  const last = getLastPreflight();
  return res.json({
    ok: true,
    preflight: last,
    fresh: isPreflightPassedFresh(),
    ttlMs: PREFLIGHT_TTL_MS,
    manifestVersion: GMX_DEPLOYMENT_MANIFEST.manifestVersion,
  });
});

// POST — read-only preflight 실행 (eth_getCode/eth_call만; 서명·제출·상태 변경 0회)
router.post('/executor/live-preflight/run', requireOperatorAuth, async (_req, res) => {
  try {
    const result = await runGmxLivePreflight();
    return res.json({ ok: true, preflight: result, fresh: isPreflightPassedFresh() });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

export default router;
