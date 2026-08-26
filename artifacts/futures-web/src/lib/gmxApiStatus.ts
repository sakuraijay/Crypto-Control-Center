/**
 * gmxApiStatus — 공식 GMX API v2 실행 경로 상태 fetch 헬퍼 (6G-2 §11).
 *
 * 계약:
 *  - 내부 API는 origin root /api만 (apiUrl 헬퍼).
 *  - PIN은 요청 헤더에만 사용, 저장·로그 금지.
 *  - 조회 실패를 "미설정"으로 표시하지 않음 — 401/403/503/network를 구분 반환.
 */

import { apiUrl } from './apiUrl';

export interface GmxApiStatusView {
  transportGen: string;
  legacyDisabled: boolean;
  peers: string[];
  readonlyEnabled: boolean;
  submissionEnabled: boolean;
  signerEnabled: boolean;
  signerInitialized: boolean;
  liveTestExecutionLocked: boolean;
  emergencyStopActive: boolean;
  reconciled: boolean;
  dbOk: boolean;
  canonical: {
    authorized: boolean;
    approvalRemainingOk: boolean;
    reason: string | null;
    expiresAt: string | number | null;
    remaining: string | null;
  };
  paperRelayEvidence?: {
    scope: 'PAPER_READ_ONLY_RELAY_EVIDENCE';
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION';
    executionAuthorized: false;
    evaluatedAtMs: number;
    fresh: true;
    safe: boolean;
    failureIds: string[];
    executionOnly: Array<{
      id: string;
      status: 'verified' | 'failed' | 'not_evaluated';
      fresh: boolean;
      observedAtMs: number | null;
      ageMs: number | null;
      failureId: string | null;
    }>;
    storedSafety: Array<{
      id: string;
      status: 'verified' | 'failed' | 'not_evaluated';
      fresh: boolean;
      observedAtMs: number | null;
      ageMs: number | null;
      failureId: string | null;
    }>;
  } | null;
  approvalSessionReady: boolean | null;
  blockingIntentCount: number | null;
  openRelayTaskCount: number | null;
  unresolvedTaskCount: number | null;
  activeRevokeInProgress: boolean | null;
  gmxConfigOk: boolean;
  deploymentVerification: { attempted: boolean; ok: boolean; atMs: number | null; manifestVersion: string | null };
  manifestVersion: string;
  feeEstimate: { attempted: boolean; ok: boolean; atMs: number | null; fresh: boolean };
  lastReadinessRefresh: { attempted: boolean; atMs: number | null; ok: boolean; basis: string | null };
  gmxTaskCounts: Record<string, number> | null;
  recentGmxTasks: Array<{
    id: string; kind: string; status: string;
    gmxApiStatus: string | null; hasRequestId: boolean;
    txHash: string | null; updatedAt: string | null;
  }> | null;
  readyForControlledCanary: boolean;
  // 6H-2B §12 — stop capability·보호 주문·action 예산 (조회 전용; null = 조회 실패)
  stopExecutionAvailable?: boolean;
  stopCapability?: {
    available: boolean;
    reasons: string[];
    evaluatedAt: string | null;
    scope: 'LIVE_STOP_EXECUTION';
    boundary: 'READ_ONLY_STATUS_NOT_EXECUTION_AUTHORIZATION';
    paperMode: boolean;
    schemaPin: { sdk: string; stopLossDecrease: number };
    /**
     * PAPER Stop readiness diagnostics. Display-only evidence; it cannot grant
     * execution authorization.
     */
    readinessEvidence?: {
      scope: 'PAPER_READ_ONLY_STOP_READINESS';
      boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION';
      readinessComplete: boolean;
      executionAuthorized: false;
      generation: number | null;
      evaluatedAtMs: number | null;
      expiresAtMs: number | null;
      fresh: boolean;
      reasons: string[];
      missingConditionIds: string[];
      conditions: Array<{
        id: string;
        label: string;
        category: 'supporting_readonly' | 'execution_required';
        status: 'verified' | 'failed' | 'stale' | 'not_evaluated';
        source: string | null;
        observedAtMs: number | null;
        ageMs: number | null;
        fresh: boolean;
        failureId: string | null;
        detail: string | null;
      }>;
    };
  };
  protectionCounts?: Record<string, number> | null;
  blockingProtectionCount?: number | null;
  staleStopCount?: number | null;
  emergencyCloseInProgressCount?: number | null;
  actionBudget?: {
    sufficient: boolean;
    remainingActions: number | null;
    requiredActions: number;
    reservedEmergencyActions?: number;
    inFlightReservedActions?: number | null;
    budgetShortfall?: number | null;
    budgetBasis?: string[];
    reasons: string[];
    // ── 6H-2D §6 — 예산 정책 메타 ──
    version?: string;
    autoCancelPolicy?: string;
    worstCasePath?: string;
    recommendedOwnerApprovalCount?: number;
  };
  // ── 6H-2C §10 — decimals·증거 수집기·reconciliation 관측값 ──
  decimalsCache?: Array<{
    key: string; decimals: number; source: string; tokenAddress: string;
    verifiedAtMs: number; ageMs: number; stale: boolean;
  }>;
  priceConversionVerified?: boolean;
  evidenceCollector?: { emitterConfigured: boolean; rpcConfigured: boolean };
  protectionReconciliation?: {
    lastRunAtMs: number | null; complete: boolean; blockNewOpens: boolean;
    uncoveredCount: number | null; staleActiveCount: number | null;
    oversizedCount: number | null; multipleActiveCount: number | null;
    keyMismatchCount: number | null;
    // ── 6H-2D §5·§9 — ambiguous·finality·실행 소스 ──
    ambiguousCount?: number;
    ambiguousReasons?: string[];
    lastSource?: 'startup' | 'periodic' | null;
    confirmationDepth?: number;
  };
  uncoveredStopCount?: number | null;
  executionEligibleCostMaxAgeMs?: number;
  /**
   * PAPER background diagnostic cache. This evidence is display-only and never
   * execution authorization; unknown/stale/failed values remain fail-closed.
   */
  paperRuntimeReadiness?: {
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION';
    paperMode: boolean;
    readonlyEnabled: boolean;
    scheduler: {
      running: boolean;
      inFlight: boolean;
      intervalMs: number;
      lastAttemptAtMs: number | null;
      lastCompletedAtMs: number | null;
      lastSuccessAtMs: number | null;
      nextRefreshAtMs: number | null;
      lastFailureId: string | null;
    };
    decimals: Record<'BTC' | 'ETH', {
      state: 'not_evaluated' | 'verified' | 'stale' | 'failed';
      attemptedAtMs: number | null;
      observedAtMs: number | null;
      ageMs: number | null;
      fresh: boolean;
      failureId: string | null;
      detail: string | null;
      decimals: number | null;
      source: string | null;
      tokenAddress: string | null;
    }>;
    deployment: {
      state: 'not_evaluated' | 'verified' | 'stale' | 'failed';
      attemptedAtMs: number | null;
      observedAtMs: number | null;
      ageMs: number | null;
      fresh: boolean;
      failureId: string | null;
      detail: string | null;
      manifestVersion: number | null;
    };
    rpc: {
      state: 'not_evaluated' | 'verified' | 'stale' | 'failed';
      attemptedAtMs: number | null;
      observedAtMs: number | null;
      ageMs: number | null;
      fresh: boolean;
      failureId: string | null;
      detail: string | null;
      chainId: number | null;
    };
    costs: Record<'BTC' | 'ETH', {
      evidenceRole: 'OBSERVATIONAL_READ_ONLY';
      observationalFresh: boolean;
      state: 'not_evaluated' | 'verified' | 'stale' | 'failed';
      attemptedAtMs: number | null;
      observedAtMs: number | null;
      ageMs: number | null;
      fresh: boolean;
      failureId: string | null;
      detail: string | null;
      symbol: 'BTC' | 'ETH';
      direction: 'LONG';
      notionalUsd: number;
      holdingHours: number;
      capUsd: number | null;
      positionFeeUsd: number | null;
      executionFeeUsd: number | null;
      estimatedPriceImpactUsd: number | null;
      fundingFeeUsd: number | null;
      borrowingFeeUsd: number | null;
      estimatedExitFeeUsd: number | null;
      estimatedExitPriceImpactUsd: number | null;
      tradingFeesUsd: number | null;
      priceImpactTotalUsd: number | null;
      carryCostUsd: number | null;
      otherCostUsd: number | null;
      effectiveRoundTripCostUsd: number | null;
      totalCostRatePct: number | null;
      capDeltaUsd: number | null;
      capExcessUsd: number | null;
      capExcessRatePct: number | null;
      requiredCostReductionUsd: number | null;
      requiredCostReductionPct: number | null;
      breakEvenGrossMoveUsd: number | null;
      breakEvenGrossMovePct: number | null;
      withinCap: boolean | null;
      blockReason: string | null;
      executionSnapshot: {
        fresh: boolean;
        eligible: boolean;
        authorized: false;
        maxAgeMs: number;
        failureId: string | null;
        blockReason: string | null;
      };
      source: string | null;
      apiTimestamp: string | null;
      fetchedAt: string | null;
      diagnostics?: {
        firstFailure?: {
          component: string;
          sourceId: string;
          failureClass: string;
          httpStatus: number | null;
          peerHost: string | null;
          peerPath: string[];
        } | null;
        failures: Array<{
          component: string;
          sourceId: string;
          failureClass: string;
          httpStatus: number | null;
          peerHost: string | null;
          peerPath: string[];
        }>;
        sourceTraces?: Array<{
          sourceId: string;
          attempts: Array<{
            peerHost: string;
            failureClass: string | null;
            httpStatus: number | null;
          }>;
          attemptCount: number;
          retryCount: number;
          failoverCount: number;
        }>;
        attemptCount: number;
        retryCount?: number;
        failoverCount: number;
        lastAttemptAtMs: number | null;
        lastSuccessAtMs: number | null;
        lastFailureAtMs: number | null;
      };
    }>;
    blockerIds: string[];
    manualActionHolds: Array<{
      id: string;
      requestedAt: string;
      requiredAction: string;
      resumeCondition: string;
    }>;
  };
  // 6G-3 §7 — prepare 단계 관측 (조회 전용; null = 조회 실패, "미설정" 위장 금지)
  prepareStageCounts: Record<string, number> | null;
  oldestBlockingTaskAt: string | null;
  prepareStartupReconciliation: {
    attempted: boolean; ok: boolean; atMs: number | null;
    stalePreparedFailed: number; requestedToUnresolved: number; apiPreparedHeld: number;
  };
  blockedReasons: string[];
  notices: string[];
  // ── CLOSE 정산 관측 (읽기 전용; null = Worker 미실행 또는 조회 실패) ──
  settlementReconcile: {
    ok: boolean;
    unsettledCount: number;
    settledNow: number;
    incomplete: boolean;
    reasons: string[];
  } | null;
  legacyZeroFeeCount: number | null;
  unsettledLiveTradeCount: number | null;
}

export type GmxApiFetchFailureKind =
  | 'OPERATOR_AUTH_REQUIRED'   // 401
  | 'FORBIDDEN'                // 403
  | 'SERVICE_UNAVAILABLE'      // 503 (PIN 미구성 포함)
  | 'SERVER_ERROR'             // 5xx 기타
  | 'NETWORK'                  // fetch 실패
  | 'ERROR';                   // 그 외

export type GmxApiFetchResult =
  | { kind: 'ok'; data: GmxApiStatusView }
  | { kind: GmxApiFetchFailureKind; message: string };

export function classifyGmxApiHttpFailure(status: number): { kind: GmxApiFetchFailureKind; message: string } {
  if (status === 401) return { kind: 'OPERATOR_AUTH_REQUIRED', message: '운영자 인증 실패(401) — PIN을 확인하세요.' };
  if (status === 403) return { kind: 'FORBIDDEN', message: '접근 거부(403) — 권한을 확인하세요.' };
  if (status === 503) return { kind: 'SERVICE_UNAVAILABLE', message: '서버 준비 안 됨(503) — 운영자 PIN 미구성 또는 서버 시작 중입니다.' };
  if (status >= 500) return { kind: 'SERVER_ERROR', message: `서버 오류(${status}) — 잠시 후 다시 시도하세요.` };
  return { kind: 'ERROR', message: `요청 실패(HTTP ${status})` };
}

async function requestJson(path: string, pin: string, method: 'GET' | 'POST'): Promise<GmxApiFetchResult> {
  try {
    const res = await fetch(apiUrl(path), {
      method,
      headers: {
        'x-operator-pin': pin,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    if (!res.ok) return classifyGmxApiHttpFailure(res.status);
    const body = (await res.json()) as { ok: boolean; status?: GmxApiStatusView; error?: string };
    if (!body.ok || !body.status) return { kind: 'ERROR', message: body.error ?? '서버 응답 구조 오류' };
    return { kind: 'ok', data: body.status };
  } catch {
    return { kind: 'NETWORK', message: '네트워크 오류 — 서버에 연결할 수 없습니다.' };
  }
}

export function fetchGmxApiStatus(pin: string): Promise<GmxApiFetchResult> {
  return requestJson('executor/gmx-api/status', pin, 'GET');
}

export function postGmxApiReadinessRefresh(pin: string): Promise<GmxApiFetchResult> {
  return requestJson('executor/gmx-api/readiness/refresh', pin, 'POST');
}
