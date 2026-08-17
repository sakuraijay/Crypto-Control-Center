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
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, relayTasksTable, subaccountApprovalSessionsTable } from '@workspace/db';
import { requireOperatorAuth } from '../lib/operatorAuthGuard';
import { createGmxApiTransport, GMX_API_PEERS, type GmxApiTransport } from '../lib/gmxApiTransport';
import { GMX_API_TRANSPORT_GEN } from '../lib/gmxApiOrders';
import { RELAY_TASK_STATUS } from '../lib/relayLifecycle';
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
import { isEmergencyStopActive, isReconciled } from '../workers/liveTestExecutor';
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import { APPROVAL_PURPOSE, SESSION_STATUS } from '../lib/ownerApprovalSession';
import { reconcileGmxApiTasks, makeProductionDeps } from '../lib/gmxApiStatusReconciler';
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
  try {
    const rows = await db.select().from(relayTasksTable)
      .where(eq(relayTasksTable.transportGen, GMX_API_TRANSPORT_GEN))
      .orderBy(desc(relayTasksTable.updatedAt))
      .limit(20);
    gmxTaskCounts = {};
    for (const r of rows) gmxTaskCounts[r.status] = (gmxTaskCounts[r.status] ?? 0) + 1;
    recentGmxTasks = rows.slice(0, 10).map((r) => ({
      id: r.id, kind: r.kind, status: r.status,
      gmxApiStatus: r.gmxApiStatus ?? null,
      hasRequestId: !!(r.gmxRequestId ?? r.relayTaskId),
      txHash: r.txHash ?? r.gmxExecutionTxHash ?? null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    }));
  } catch { gmxTaskCounts = null; recentGmxTasks = null; }

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

  // readyForControlledCanary — 전 항목 파생값의 논리곱 (fail-closed; 어느 하나
  // null/false면 false). 현 단계는 submissionEnabled=false라 항상 false.
  const readyForControlledCanary =
    readonlyEnabled && submissionEnabled && signerEnabled && signerInitialized &&
    !liveLocked && !emergencyStop && reconciled && dbOk &&
    canonicalAuthorized && approvalRemainingOk && approvalSessionReady === true &&
    blockingIntents === 0 && (unresolvedCount ?? 1) === 0 && revoke === false &&
    gmxConfigOk && dv.ok && feeEstimateFresh;

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
    readyForControlledCanary,
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
