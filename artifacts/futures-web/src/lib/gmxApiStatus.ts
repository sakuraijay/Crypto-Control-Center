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
  // 6G-3 §7 — prepare 단계 관측 (조회 전용; null = 조회 실패, "미설정" 위장 금지)
  prepareStageCounts: Record<string, number> | null;
  oldestBlockingTaskAt: string | null;
  prepareStartupReconciliation: {
    attempted: boolean; ok: boolean; atMs: number | null;
    stalePreparedFailed: number; requestedToUnresolved: number; apiPreparedHeld: number;
  };
  blockedReasons: string[];
  notices: string[];
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
