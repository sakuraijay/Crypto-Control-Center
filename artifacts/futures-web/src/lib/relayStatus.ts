/**
 * relayStatus — GMX delegated trading 3단계 웹 헬퍼 (순수 함수 위주).
 *
 * Gelato relay DRY-RUN 경로의 상태 조회·표시 매핑·revoke 흐름 fetch 래퍼.
 * 이 모듈은 어떤 온체인 제출도 하지 않는다. DRY_RUN·TASK_ACCEPTED를
 * 성공처럼 표시하지 않는 것이 UI 계약의 핵심이다.
 */

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
}

export interface ActivationStatusResponse {
  ok: boolean;
  networkEligible: boolean;
  missing: string[];
  statusFlags: ActivationStatusFlags;
  error?: string;
}

export async function fetchActivationStatus(apiBase: string, pin: string): Promise<ActivationStatusResponse | null> {
  try {
    const res = await fetch(`${apiBase}executor/relay/activation`, {
      headers: { 'x-operator-pin': pin },
    });
    if (!res.ok) return null;
    return (await res.json()) as ActivationStatusResponse;
  } catch {
    return null;
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

export async function fetchRelayStatus(apiBase: string, pin: string): Promise<RelayStatusResponse | null> {
  try {
    const res = await fetch(`${apiBase}executor/relay/status`, {
      headers: { 'x-operator-pin': pin },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ok ? (json as RelayStatusResponse) : null;
  } catch {
    return null;
  }
}

export async function postRevokePrepare(params: { apiBase: string; pin: string }): Promise<{
  ok: boolean; sessionId?: string; typedData?: unknown; summary?: Record<string, string>; error?: string;
}> {
  try {
    const res = await fetch(`${params.apiBase}executor/relay/revoke/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': params.pin },
      body: '{}',
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `prepare 실패 (HTTP ${res.status})` };
    return json;
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postRevokeSignature(params: {
  apiBase: string; pin: string; sessionId: string; signature: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${params.apiBase}executor/relay/revoke/signature`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': params.pin },
      body: JSON.stringify({ sessionId: params.sessionId, signature: params.signature }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `서명 저장 실패 (HTTP ${res.status})` };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postRevokeCancel(params: {
  apiBase: string; pin: string; sessionId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${params.apiBase}executor/relay/revoke/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': params.pin },
      body: JSON.stringify({ sessionId: params.sessionId }),
    });
    const json = await res.json().catch(() => null);
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

export async function fetchUnresolvedTasks(apiBase: string, pin: string): Promise<UnresolvedTaskView[] | null> {
  try {
    const res = await fetch(`${apiBase}executor/relay/unresolved`, {
      headers: { 'x-operator-pin': pin },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ok ? (json.tasks as UnresolvedTaskView[]) : null;
  } catch {
    return null;
  }
}

/** 증거 재수집만 — 강제 terminal·재제출·삭제는 서버에 존재하지 않는다 */
export async function postUnresolvedRecheck(params: {
  apiBase: string; pin: string; taskId: string;
}): Promise<{ ok: boolean; rechecked?: boolean; reason?: string; error?: string }> {
  try {
    const res = await fetch(`${params.apiBase}executor/relay/unresolved/recheck`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': params.pin },
      body: JSON.stringify({ taskId: params.taskId }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `재조회 실패 (HTTP ${res.status})` };
    return { ok: true, rechecked: json.rechecked === true, reason: json.reason };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postRevokeDryRun(params: { apiBase: string; pin: string }): Promise<{
  ok: boolean; dryRun?: DryRunView; error?: string;
}> {
  try {
    const res = await fetch(`${params.apiBase}executor/relay/revoke/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': params.pin },
      body: '{}',
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `dry-run 실패 (HTTP ${res.status})` };
    return { ok: true, dryRun: json.dryRun as DryRunView };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}
