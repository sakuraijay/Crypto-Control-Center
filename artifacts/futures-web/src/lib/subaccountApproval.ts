/**
 * subaccountApproval — GMX delegated trading 2단계 웹 헬퍼 (순수 함수 위주).
 *
 * MetaMask owner approval 흐름의 가드·상태 매핑·권한 요약을 UI에서 분리해
 * 테스트 가능하게 유지한다. 이 모듈은 절대 서명·전송을 직접 수행하지 않는다
 * (서명은 브라우저 지갑 eth_signTypedData_v4 전용).
 */

export const ARBITRUM_ONE_CHAIN_ID = 42161;

// ── 서버 subaccount-auth 응답 타입 (요약) ────────────────────────────────────

export interface SubaccountAuthOnchainSummary {
  isSubaccountListed: boolean;
  expiresAt: string;
  maxAllowedCount: string;
  usedCount: string;
  remaining: string;
  integrationId: string;
  approvalNonce: string;
  featureDisabled: boolean;
  integrationDisabled: boolean;
  blockTimestamp: string | null;
}

export interface ReadySessionSummary {
  sessionId: string;
  status: string;
  subaccount: string;
  expiresAt: string;
  maxAllowedCount: string;
  approvalNonce: string;
  deadline: string;
  createdAt?: string;
}

export interface SubaccountAuthResponse {
  ok: boolean;
  state: string;
  displayState: string;
  chainId: number;
  mainAccount: string | null;
  signerAddress: string | null;
  relayRouter: string | null;
  relayConfigured: boolean;
  configReasons: string[];
  onchain: SubaccountAuthOnchainSummary | null;
  onchainError: string | null;
  readySession: ReadySessionSummary | null;
  liveEligible: boolean;
  liveBlockedReason: string | null;
  error?: string;
}

// ── 상태 → UI 매핑 ───────────────────────────────────────────────────────────

export interface AuthStateView {
  label: string;          // 한국어 라벨
  tone: 'ok' | 'warn' | 'error' | 'muted';
  description: string;
}

const STATE_VIEWS: Record<string, AuthStateView> = {
  NOT_CONFIGURED:           { label: '구성 안 됨',        tone: 'muted', description: 'GMX relay 환경변수가 아직 설정되지 않았습니다.' },
  SIGNER_DISABLED:          { label: 'Signer 미초기화',   tone: 'muted', description: 'delegated signer가 아직 초기화되지 않았습니다.' },
  SIGNER_READY:             { label: 'Signer 준비됨',     tone: 'warn',  description: 'signer는 준비됐지만 DELEGATED_SIGNER_ENABLED가 꺼져 있습니다.' },
  UNVERIFIED:               { label: '온체인 미확인',     tone: 'warn',  description: '온체인 상태를 아직 확인하지 못했습니다. LIVE는 차단됩니다.' },
  ERROR:                    { label: '조회 오류',         tone: 'error', description: 'RPC 조회 실패 — fail-closed로 LIVE가 차단됩니다.' },
  OWNER_SIGNATURE_REQUIRED: { label: 'Owner 서명 필요',   tone: 'warn',  description: '메인 지갑(MetaMask)의 approval 서명이 필요합니다.' },
  OWNER_SIGNATURE_READY:    { label: '서명 저장됨',       tone: 'warn',  description: '서명이 서버에 안전하게 저장됨 — 온체인 등록 전이므로 LIVE는 계속 차단됩니다.' },
  EXPIRED:                  { label: '만료됨',            tone: 'error', description: '온체인 approval이 만료되었습니다. 재서명이 필요합니다.' },
  REVOKED:                  { label: '해지됨/비활성',     tone: 'error', description: '온체인에서 해지되었거나 feature/integration이 비활성입니다.' },
  ACTION_LIMIT_REACHED:     { label: '실행 한도 소진',    tone: 'error', description: '허용된 실행 횟수를 모두 사용했습니다.' },
  AUTHORIZED:               { label: '온체인 승인됨',     tone: 'ok',    description: '온체인 approval이 활성 상태입니다. (LIVE 잠금은 별도)' },
};

export function mapAuthStateToView(state: string): AuthStateView {
  return STATE_VIEWS[state] ?? { label: state, tone: 'muted', description: '알 수 없는 상태 — 안전을 위해 차단으로 간주합니다.' };
}

// ── 서명 가드 (fail-closed) ──────────────────────────────────────────────────

export interface SignGuardInput {
  walletStatus: string;          // 'connected' 등
  isArbitrum: boolean;
  walletAddress: string | null;
  mainAccount: string | null;    // 서버 GMX_WALLET_ADDRESS
}

export type SignGuardResult = { ok: true } | { ok: false; reason: string };

/** MetaMask 서명 요청 전 가드 — 체인 42161 + 계정 일치 강제 */
export function canRequestOwnerSignature(input: SignGuardInput): SignGuardResult {
  if (input.walletStatus !== 'connected') {
    return { ok: false, reason: '지갑이 연결되어 있지 않습니다. MetaMask를 먼저 연결하세요.' };
  }
  if (!input.isArbitrum) {
    return { ok: false, reason: `Arbitrum One(chainId ${ARBITRUM_ONE_CHAIN_ID})으로 전환해야 서명할 수 있습니다.` };
  }
  if (!input.mainAccount) {
    return { ok: false, reason: '서버에 main wallet(GMX_WALLET_ADDRESS)이 설정되지 않았습니다.' };
  }
  if (!input.walletAddress || input.walletAddress.toLowerCase() !== input.mainAccount.toLowerCase()) {
    return { ok: false, reason: '연결된 계정이 구성된 main wallet과 다릅니다. MetaMask에서 올바른 계정을 선택하세요.' };
  }
  return { ok: true };
}

/** eth_signTypedData_v4 오류 → 사용자 메시지 (취소는 오류가 아님) */
export function mapSignError(err: unknown): { cancelled: boolean; message: string } {
  const e = err as { code?: number; message?: string } | null;
  if (e && (e.code === 4001 || /denied|rejected/i.test(e.message ?? ''))) {
    return { cancelled: true, message: '서명이 취소되었습니다. 저장된 것은 없습니다.' };
  }
  return { cancelled: false, message: e?.message ? `서명 실패: ${e.message}` : '서명 실패 — 알 수 없는 오류' };
}

// ── 권한 요약 (고정 문구) ────────────────────────────────────────────────────

export const APPROVAL_GRANTS: string[] = [
  '서브계정이 GMX V2 주문 생성·수정·취소를 대행할 수 있습니다',
  '주문 담보와 relay 수수료(WNT/담보 토큰)를 주문 실행 목적에 한해 사용할 수 있습니다',
  '실행 횟수(maxAllowedCount)와 만료 시각(expiresAt)으로 권한이 제한됩니다',
];

export const APPROVAL_DENIALS: string[] = [
  '메인 지갑 자금 출금·이체는 불가능합니다 (receiver는 항상 메인 지갑 고정)',
  '보상 claim·포지션 소유권 이전·타 컨트랙트 호출은 불가능합니다',
  '만료·한도 소진·온체인 해지 시 즉시 권한이 사라집니다',
];

// ── 타임스탬프 표시 헬퍼 ─────────────────────────────────────────────────────

export function formatUnixSeconds(value: string | null | undefined): string {
  if (!value) return '—';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n * 1000).toLocaleString();
}

// ── API 호출 (순수 fetch 래퍼 — 서명 없음) ───────────────────────────────────

export async function fetchSubaccountAuth(apiBase: string): Promise<SubaccountAuthResponse | null> {
  try {
    const res = await fetch(`${apiBase}executor/subaccount-auth`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ok ? (json as SubaccountAuthResponse) : null;
  } catch {
    return null;   // 네트워크 오류 → UNVERIFIED 취급은 호출측에서
  }
}

export interface PrepareResponse {
  ok: boolean;
  sessionId?: string;
  typedData?: unknown;
  summary?: Record<string, string | number | boolean>;
  error?: string;
}

export async function postPrepareApproval(params: {
  apiBase: string; pin: string; walletAddress: string;
}): Promise<PrepareResponse> {
  try {
    const res = await fetch(`${params.apiBase}executor/subaccount-approval/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': params.pin },
      body: JSON.stringify({ walletAddress: params.walletAddress }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `prepare 실패 (HTTP ${res.status})` };
    return json as PrepareResponse;
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postApprovalSignature(params: {
  apiBase: string; pin: string; sessionId: string; signature: string;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const res = await fetch(`${params.apiBase}executor/subaccount-approval/signature`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': params.pin },
      body: JSON.stringify({ sessionId: params.sessionId, signature: params.signature }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `서명 저장 실패 (HTTP ${res.status})` };
    return json as { ok: boolean; status?: string };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}
