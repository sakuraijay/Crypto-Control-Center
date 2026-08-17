/**
 * relayStatus — GMX delegated trading 3단계 웹 헬퍼 (순수 함수 위주).
 *
 * Gelato relay DRY-RUN 경로의 상태 조회·표시 매핑·revoke 흐름 fetch 래퍼.
 * 이 모듈은 어떤 온체인 제출도 하지 않는다. DRY_RUN·TASK_ACCEPTED를
 * 성공처럼 표시하지 않는 것이 UI 계약의 핵심이다.
 */

import { apiUrl, readApiJson, API_ROUTE_MISMATCH_MESSAGE, postApiJson } from './apiUrl';

export interface RelayFeeQuoteView {
  source: string;
  feeToken: string;
  feeAmount: string;
  gasLimit: string;
  gasPrice: string;
  quotedAtMs: number;
  valid: boolean;
  invalidReason: string | null;
}

export interface RelayTaskView {
  id: string;
  kind: string;
  status: string;
  relayTaskId: string | null;
  txHash: string | null;
  orderKey: string | null;
  feeToken: string | null;
  feeAmount: string | null;
  errorClass: string | null;
  resolutionBasis: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RevokeSessionView {
  sessionId: string;
  status: string;
  subaccount: string;
  deadline: string;
  feeToken: string | null;
  feeAmount: string | null;
  userNonce: string | null;
  createdAt: string;
}

export interface RelayStatusResponse {
  ok: boolean;
  mode: string;
  requestedLive: boolean;
  modeReasons: string[];
  submissionEnabled: boolean;
  liveStructurallyDisabled: boolean;
  gate: { allowed: boolean; blockReasons: string[] };
  canonical: {
    confirmed: boolean;
    reason: string | null;
    approvalNonce: string | null;
    isSubaccountListed: boolean | null;
    expiresAt: string | null;
    remaining: string | null;
  };
  feeQuote: RelayFeeQuoteView;
  revokeSession: RevokeSessionView | null;
  recentTasks: RelayTaskView[];
  error?: string;
}

/** 5단계 §9 — activation 진단 상태 플래그 (표시 전용, 부작용 없음) */
export interface ActivationStatusFlags {
  codeReady: boolean;
  /** 6단계 §6 — 네트워크 권한 분리 표시 */
  readonlyNetworkDisabled: boolean;
  submitNetworkDisabled: boolean;
  submissionDisabled: boolean;
  relayMode: 'DISABLED' | 'DRY_RUN' | 'LIVE';
  lastReadinessRefresh: {
    attempted: boolean;
    atMs: number | null;
    ok: boolean;
    basis: string[];
    failures: string[];
  };
  networkDisabled: boolean;
  signerDisabled: boolean;
  canonicalUnverified: boolean;
  canonicalReason: string | null;
  reconciliationIncomplete: boolean;
  reconciliationReasons: string[];
  liveQuoteMissing: boolean;
  liveQuoteReasons: string[];
  revokeActive: boolean;
  unresolvedPresent: boolean;
  unresolvedCount: number;
  liveLocked: boolean;
  readyForControlledCanary: boolean;
  /** 6E-8 §5 — 저장된 배포 검증 스냅샷 (표시 전용; 추가 외부 호출 없음) */
  deploymentVerification?: {
    attempted: boolean;
    atMs: number | null;
    ok: boolean;
    manifestVersion?: string | null;
    basis: string[];
    failures: string[];
  };
  /** 6F-2 §11 — GMX 공식 fee estimate + JSON-RPC transport + sponsor balance (구 fee oracle 대체) */
  gelatoApiConfigured?: boolean;
  transportContract?: string;
  feeEstimate?: { status: 'fresh' | 'stale' | 'unavailable'; atMs: number | null; basis: string[]; failures: string[] };
  sponsorBalance?: { status: 'verified' | 'unverified' | 'insufficient'; atMs: number | null; basis: string[] };
}

export interface ActivationStatusResponse {
  ok: boolean;
  networkEligible: boolean;
  missing: string[];
  statusFlags: ActivationStatusFlags;
  error?: string;
}

// ── 6E-10 §7 — 인증/상태 오류 구분 (silent null 금지) ────────────────────────

export type RelayFetchFailureKind =
  | 'OPERATOR_AUTH_REQUIRED'  // 401/403 — 운영자 인증 실패
  | 'NOT_CONFIGURED'          // 503 — OPERATOR_MASTER_PIN 미설정 (fail-closed)
  | 'UNVERIFIED'              // 네트워크 오류 — 상태 미확인 (fail-closed)
  | 'ERROR';                  // 기타 HTTP/응답 오류

export type RelayFetchResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: RelayFetchFailureKind; message: string };

export function classifyRelayHttpFailure(status: number): { kind: RelayFetchFailureKind; message: string } {
  if (status === 401 || status === 403) {
    return { kind: 'OPERATOR_AUTH_REQUIRED', message: '운영자 인증 실패 (HTTP 401/403) — PIN을 확인하세요.' };
  }
  if (status === 503) {
    return { kind: 'NOT_CONFIGURED', message: 'OPERATOR_MASTER_PIN이 서버에 설정되지 않았습니다 (HTTP 503, fail-closed).' };
  }
  return { kind: 'ERROR', message: `상태 조회 실패 (HTTP ${status})` };
}

export async function fetchActivationStatus(pin: string): Promise<RelayFetchResult<ActivationStatusResponse>> {
  try {
    const res = await fetch(apiUrl('executor/relay/activation'), {
      headers: { 'x-operator-pin': pin },
    });
    if (!res.ok) return classifyRelayHttpFailure(res.status);
    const body = await readApiJson(res);
    if (body.kind !== 'json') return { kind: 'ERROR', message: API_ROUTE_MISMATCH_MESSAGE };
    return { kind: 'ok', data: body.json as ActivationStatusResponse };
  } catch {
    return { kind: 'UNVERIFIED', message: '네트워크 오류 — 상태 미확인 (fail-closed)' };
  }
}

// ── 6E-2 §3 — Readiness Refresh (읽기 전용 검증) fetch 래퍼 ──────────────────

export interface ReadinessRefreshView {
  attempted: boolean;
  atMs: number | null;
  ok: boolean;
  basis: string[];
  failures: string[];
}

/** 6E-10 §2·§3 — 인증된 readiness POST 응답에 동봉되는 서버 저장 스냅샷 */
export interface ReadinessSnapshotView {
  atMs: number;
  deploymentVerification: {
    attempted: boolean; atMs: number | null; ok: boolean;
    manifestVersion: number | null; basis: string[]; failures: string[];
  };
  canonical: {
    confirmed: boolean; reason: string | null; approvalNonce: string | null;
    isSubaccountListed: boolean | null; expiresAt: string | null; remaining: string | null;
    atMs: number;
  } | null;
  lastReadinessRefresh: { attempted: boolean; atMs: number | null; ok: boolean; basis: string[]; failures: string[] };
  statusFlags: {
    readonlyNetworkDisabled: boolean; submitNetworkDisabled: boolean; submissionDisabled: boolean;
    relayMode: 'DISABLED' | 'DRY_RUN' | 'LIVE';
    signerDisabled: boolean; liveLocked: boolean; manifestVersion: number;
    /** 6F-2 §11 — 구서버 호환 optional */
    gelatoApiConfigured?: boolean;
    transportContract?: string;
    feeEstimate?: { status: 'fresh' | 'stale' | 'unavailable'; atMs: number | null };
    sponsorBalance?: { status: 'verified' | 'unverified' | 'insufficient'; atMs: number | null };
    readyForControlledCanary: false;
  };
}

export type ReadinessRefreshResult =
  | { kind: 'ok'; refresh: ReadinessRefreshView; snapshot: ReadinessSnapshotView | null }
  | { kind: 'auth' }            // 401/403 — 운영자 인증 실패 (env 미설정 아님)
  | { kind: 'not_configured' }  // 503 — OPERATOR_MASTER_PIN 미설정
  | { kind: 'error'; message: string };

/**
 * POST /api/executor/relay/readiness/refresh — 유일하게 호출하는 엔드포인트.
 * 서명·주문·nonce 생성·task 생성을 수행하지 않는 읽기 전용 검증이다.
 * PIN은 헤더로만 전달하고 어디에도 저장/로그하지 않는다.
 */
export async function postReadinessRefresh(params: { pin: string }): Promise<ReadinessRefreshResult> {
  try {
    const res = await postApiJson('executor/relay/readiness/refresh', {
      headers: { 'x-operator-pin': params.pin },
    });
    if (res.status === 401 || res.status === 403) return { kind: 'auth' };
    if (res.status === 503) return { kind: 'not_configured' };
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { kind: 'error', message: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; refresh?: ReadinessRefreshView; snapshot?: ReadinessSnapshotView; error?: string }) : null;
    if (!res.ok || !json?.ok || !json.refresh) {
      return { kind: 'error', message: json?.error ?? `readiness refresh 실패 (HTTP ${res.status})` };
    }
    // snapshot은 구서버 호환을 위해 optional — 없으면 null (fail-closed 표시 유지)
    return { kind: 'ok', refresh: json.refresh, snapshot: json.snapshot ?? null };
  } catch (e: unknown) {
    return { kind: 'error', message: (e as Error).message || '네트워크 오류' };
  }
}

export interface DryRunView {
  ok: boolean;
  mode: string;
  kind: string;
  calldataHash: string | null;
  packedPayloadHash: string | null;
  signingDigest: string | null;
  signerRole: string | null;
  actionCount: number | null;
  feeToken: string | null;
  feeAmount: string | null;
  deadline: string | null;
  userNonce: string | null;
  receiverVerified: boolean | null;
  approvalAttached: boolean | null;
  feeQuoteOk: boolean;
  submitEligible: boolean;
  blockReasons: string[];
}

// ── 표시 매핑 ────────────────────────────────────────────────────────────────

export interface StatusView { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' }

/** relay 모드 → UI. LIVE는 이번 단계에서 존재할 수 없으므로 오류로 표시. */
export function mapRelayModeToView(mode: string): StatusView {
  switch (mode) {
    case 'DRY_RUN': return { label: 'DRY-RUN 전용', tone: 'warn' };
    case 'DISABLED': return { label: '비활성', tone: 'muted' };
    case 'LIVE': return { label: 'LIVE(비정상 — 차단)', tone: 'error' };
    default: return { label: mode, tone: 'muted' };
  }
}

/**
 * relay task 상태 → UI. 핵심 계약:
 *  - DRY_RUN_VALIDATED·TASK_ACCEPTED는 "성공"이 아니다 (진행/검증 단계).
 *  - CONFIRMED만 온체인 증거 기반 성공.
 *  - UNRESOLVED는 수동 판정 대기 — 실패로 단정하지 않는다.
 */
export function mapRelayTaskStatusToView(status: string): StatusView {
  switch (status) {
    case 'PREPARED':            return { label: '준비됨', tone: 'muted' };
    case 'DRY_RUN_VALIDATED':   return { label: '드라이런 검증됨 (제출 아님)', tone: 'warn' };
    case 'SUBMITTING':          return { label: '제출 중', tone: 'warn' };
    case 'TASK_ACCEPTED':       return { label: 'relay 접수 (성공 아님)', tone: 'warn' };
    case 'TX_SUBMITTED':        return { label: '트랜잭션 제출됨', tone: 'warn' };
    case 'ORDER_CREATED':       return { label: '주문 생성 감지', tone: 'warn' };
    case 'CONFIRMED':           return { label: '온체인 확정', tone: 'ok' };
    case 'CANCELLED':           return { label: '취소됨', tone: 'error' };
    case 'FAILED_PRE_BROADCAST':return { label: '제출 전 실패', tone: 'error' };
    case 'FAILED':              return { label: '온체인 확정 실패', tone: 'error' };
    case 'UNRESOLVED':          return { label: '판정 불가 — 수동 확인 필요', tone: 'error' };
    default:                    return { label: status, tone: 'muted' };
  }
}

/** wei(문자열) → ETH 표시 문자열 */
export function formatWeiToEth(wei: string | null | undefined): string {
  if (!wei) return '—';
  try {
    const v = BigInt(wei);
    const whole = v / 10n ** 18n;
    const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
    return `${whole}.${frac} ETH`;
  } catch {
    return '—';
  }
}

// ── fetch 래퍼 ───────────────────────────────────────────────────────────────

export async function fetchRelayStatus(pin: string): Promise<RelayFetchResult<RelayStatusResponse>> {
  try {
    const res = await fetch(apiUrl('executor/relay/status'), {
      headers: { 'x-operator-pin': pin },
    });
    if (!res.ok) return classifyRelayHttpFailure(res.status);
    const body = await readApiJson(res);
    const json = body.kind === 'json' ? (body.json as RelayStatusResponse & { ok?: boolean }) : null;
    if (!json?.ok) return { kind: 'ERROR', message: json && 'error' in json && json.error ? json.error : '상태 응답 형식 오류' };
    return { kind: 'ok', data: json };
  } catch {
    return { kind: 'UNVERIFIED', message: '네트워크 오류 — 상태 미확인 (fail-closed)' };
  }
}

export async function postRevokePrepare(params: { pin: string }): Promise<{
  ok: boolean; sessionId?: string; typedData?: unknown; summary?: Record<string, string>; error?: string;
}> {
  try {
    const res = await postApiJson('executor/relay/revoke/prepare', {
      headers: { 'x-operator-pin': params.pin },
    });
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { ok: false, error: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; error?: string; [k: string]: unknown }) : null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `prepare 실패 (HTTP ${res.status})` };
    return json as { ok: boolean; sessionId?: string; typedData?: unknown; summary?: Record<string, string>; error?: string };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postRevokeSignature(params: {
  pin: string; sessionId: string; signature: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await postApiJson('executor/relay/revoke/signature', {
      headers: { 'x-operator-pin': params.pin },
      body: { sessionId: params.sessionId, signature: params.signature },
    });
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { ok: false, error: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; error?: string; [k: string]: unknown }) : null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `서명 저장 실패 (HTTP ${res.status})` };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postRevokeCancel(params: {
  pin: string; sessionId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await postApiJson('executor/relay/revoke/cancel', {
      headers: { 'x-operator-pin': params.pin },
      body: { sessionId: params.sessionId },
    });
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { ok: false, error: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; error?: string; [k: string]: unknown }) : null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `취소 실패 (HTTP ${res.status})` };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

// ── UNRESOLVED 조사 (4단계) ──────────────────────────────────────────────────

export interface UnresolvedTaskView {
  id: string;
  kind: string;
  status: string;
  relayTaskId: string | null;
  txHash: string | null;
  orderKey: string | null;
  userNonce: string | null;
  approvalNonce: string | null;
  errorClass: string | null;
  resolutionBasis: string | null;
  createdAt: string;
  updatedAt: string;
  links: { arbiscanTx: string | null; gelatoTask: string | null };
  blocking: boolean;
}

export async function fetchUnresolvedTasks(pin: string): Promise<RelayFetchResult<UnresolvedTaskView[]>> {
  try {
    const res = await fetch(apiUrl('executor/relay/unresolved'), {
      headers: { 'x-operator-pin': pin },
    });
    if (!res.ok) return classifyRelayHttpFailure(res.status);
    const body = await readApiJson(res);
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; tasks?: UnresolvedTaskView[] }) : null;
    if (!json?.ok) return { kind: 'ERROR', message: '상태 응답 형식 오류' };
    return { kind: 'ok', data: (json.tasks ?? []) as UnresolvedTaskView[] };
  } catch {
    return { kind: 'UNVERIFIED', message: '네트워크 오류 — 상태 미확인 (fail-closed)' };
  }
}

/** 증거 재수집만 — 강제 terminal·재제출·삭제는 서버에 존재하지 않는다 */
export async function postUnresolvedRecheck(params: {
  pin: string; taskId: string;
}): Promise<{ ok: boolean; rechecked?: boolean; reason?: string; error?: string }> {
  try {
    const res = await postApiJson('executor/relay/unresolved/recheck', {
      headers: { 'x-operator-pin': params.pin },
      body: { taskId: params.taskId },
    });
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { ok: false, error: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; error?: string; [k: string]: unknown }) : null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `재조회 실패 (HTTP ${res.status})` };
    return { ok: true, rechecked: json.rechecked === true, reason: json.reason as string | undefined };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postRevokeDryRun(params: { pin: string }): Promise<{
  ok: boolean; dryRun?: DryRunView; error?: string;
}> {
  try {
    const res = await postApiJson('executor/relay/revoke/dry-run', {
      headers: { 'x-operator-pin': params.pin },
    });
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { ok: false, error: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; error?: string; [k: string]: unknown }) : null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `dry-run 실패 (HTTP ${res.status})` };
    return { ok: true, dryRun: json.dryRun as DryRunView };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}
