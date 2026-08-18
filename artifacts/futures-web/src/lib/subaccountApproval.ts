/**
 * subaccountApproval — GMX delegated trading 2단계 웹 헬퍼 (순수 함수 위주).
 *
 * MetaMask owner approval 흐름의 가드·상태 매핑·권한 요약을 UI에서 분리해
 * 테스트 가능하게 유지한다. 이 모듈은 절대 서명·전송을 직접 수행하지 않는다
 * (서명은 브라우저 지갑 eth_signTypedData_v4 전용).
 */

import { apiUrl, readApiJson, API_ROUTE_MISMATCH_MESSAGE, postApiJson } from './apiUrl';

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
  // #125 — 주소 출처·보안 상태 (stored_public = 저장된 공개 주소, 개인키 미복호화)
  signerAddressSource?: 'runtime' | 'stored_public' | null;
  privateKeyDecrypted?: boolean;
  orderSubmissionEnabled?: boolean;
  relayRouter: string | null;
  relayConfigured: boolean;
  configReasons: string[];
  onchain: SubaccountAuthOnchainSummary | null;
  onchainError: string | null;
  readySession: ReadySessionSummary | null;
  /** #125 — 순수 canonical 판정 (서명 능력 무관) */
  authEligible?: boolean;
  /** 실제 LIVE 적격 (canonical + 런타임 signer 서명 능력) */
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
  // 6E-2 §2 — HTTP/인증 오류를 구성 오류와 구분해 표시 (401/403 ≠ env 미설정)
  OPERATOR_AUTH_REQUIRED:   { label: '운영자 인증 필요',  tone: 'error', description: '운영자 PIN 인증이 실패했거나 필요합니다 (HTTP 401/403). 환경변수 미설정이 아닙니다.' },
  NOT_AUTHORIZED:           { label: '온체인 미승인',     tone: 'warn',  description: 'canonical 온체인 approval이 아직 등록되지 않았습니다.' },
  SIGNER_NOT_INITIALIZED:   { label: 'Signer 미초기화',   tone: 'muted', description: '서버 delegated signer가 아직 초기화되지 않았습니다.' },
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

// ── Prepare 활성화 가드 (6E-2 §5 — fail-closed) ─────────────────────────────

export interface PrepareGateInput {
  guard: SignGuardResult;
  auth: SubaccountAuthResponse | null;
  /** fetch가 HTTP/네트워크 오류로 실패했는지 (auth=null과 구분) */
  fetchErrorState: string | null;   // 'OPERATOR_AUTH_REQUIRED' | 'NOT_CONFIGURED' | 'ERROR' | 'UNVERIFIED' | null
}

export type PrepareGateResult = { ok: true } | { ok: false; reasons: string[] };

/** Prepare 버튼 활성 조건 — 모든 조건 충족 전 비활성 (PIN만으로는 절대 진행 불가) */
export function canPrepareApproval(input: PrepareGateInput): PrepareGateResult {
  const reasons: string[] = [];
  if (input.fetchErrorState) {
    reasons.push(`서버 상태 조회 실패 (${input.fetchErrorState}) — 상태 확인 전 Prepare 불가`);
  }
  if (!input.guard.ok) reasons.push(input.guard.reason);
  const a = input.auth;
  if (!a) {
    reasons.push('subaccount-auth 상태를 확인할 수 없습니다 (fail-closed)');
    return { ok: false, reasons };
  }
  if (!a.relayConfigured) {
    reasons.push(`GMX relay 구성 미완료${a.configReasons.length ? `: ${a.configReasons.join(', ')}` : ''}`);
  }
  if (!a.mainAccount) reasons.push('main wallet(GMX_WALLET_ADDRESS) 미설정');
  if (!a.signerAddress) reasons.push('delegated signer 미초기화 — signer 준비 전 Prepare 불가');
  if (a.chainId !== ARBITRUM_ONE_CHAIN_ID) reasons.push(`서버 chainId ${a.chainId} ≠ 42161`);
  // 상태 기반 차단: 조회오류·미확인·해지 진행 등은 전부 차단
  const blocked = new Set(['ERROR', 'UNVERIFIED', 'REVOKED', 'NOT_CONFIGURED', 'SIGNER_DISABLED']);
  if (blocked.has(a.state)) reasons.push(`현재 상태(${a.state})에서는 Prepare가 차단됩니다`);
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

// ── API 호출 (순수 fetch 래퍼 — 서명 없음) ───────────────────────────────────

export type AuthFetchResult =
  | { kind: 'ok'; data: SubaccountAuthResponse }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  /** 200인데 JSON이 아님 — 정적 SPA fallback이 API 경로를 삼킨 경우 (API_ROUTE_MISMATCH) */
  | { kind: 'route_mismatch' };

/** 6E-2 §2 — HTTP status → 표시 상태 매핑. 401/403은 절대 NOT_CONFIGURED로 변환하지 않는다. */
export function mapAuthFetchToDisplayState(result: AuthFetchResult): string | null {
  if (result.kind === 'ok') return null;
  if (result.kind === 'network') return 'UNVERIFIED';
  if (result.kind === 'route_mismatch') return 'ERROR';
  if (result.status === 401 || result.status === 403) return 'OPERATOR_AUTH_REQUIRED';
  if (result.status === 503) return 'NOT_CONFIGURED';
  return 'ERROR';
}

export async function fetchSubaccountAuthDetailed(): Promise<AuthFetchResult> {
  try {
    const res = await fetch(apiUrl('executor/subaccount-auth'));
    if (!res.ok) return { kind: 'http', status: res.status };
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { kind: 'route_mismatch' };
    const json = body.kind === 'json' ? (body.json as SubaccountAuthResponse & { ok?: boolean }) : null;
    if (!json?.ok) return { kind: 'http', status: 500 };
    return { kind: 'ok', data: json };
  } catch {
    return { kind: 'network' };
  }
}

/** @deprecated 호환용 — 상태 구분이 필요한 곳은 fetchSubaccountAuthDetailed 사용 */
export async function fetchSubaccountAuth(): Promise<SubaccountAuthResponse | null> {
  const r = await fetchSubaccountAuthDetailed();
  return r.kind === 'ok' ? r.data : null;
}

export interface PrepareResponse {
  ok: boolean;
  sessionId?: string;
  typedData?: unknown;
  summary?: Record<string, string | number | boolean>;
  error?: string;
}

/** Canary 세션 요청 실행 횟수 (#124-C) — 서버가 1~10 범위로 clamp (자동 확대 없음) */
export const CANARY_REQUESTED_MAX_ALLOWED_COUNT = 8;

export async function postPrepareApproval(params: {
  pin: string; walletAddress: string; maxAllowedCount?: number;
}): Promise<PrepareResponse> {
  try {
    const res = await postApiJson('executor/subaccount-approval/prepare', {
      headers: { 'x-operator-pin': params.pin },
      body: {
        walletAddress: params.walletAddress,
        ...(params.maxAllowedCount !== undefined ? { maxAllowedCount: params.maxAllowedCount } : {}),
      },
    });
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { ok: false, error: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; error?: string; [k: string]: unknown }) : null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `prepare 실패 (HTTP ${res.status})` };
    return json as PrepareResponse;
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}

export async function postApprovalSignature(params: {
  pin: string; sessionId: string; signature: string;
}): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const res = await postApiJson('executor/subaccount-approval/signature', {
      headers: { 'x-operator-pin': params.pin },
      body: { sessionId: params.sessionId, signature: params.signature },
    });
    const body = await readApiJson(res);
    if (body.kind === 'route_mismatch') return { ok: false, error: API_ROUTE_MISMATCH_MESSAGE };
    const json = body.kind === 'json' ? (body.json as { ok?: boolean; error?: string; [k: string]: unknown }) : null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `서명 저장 실패 (HTTP ${res.status})` };
    return json as { ok: boolean; status?: string };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message || '네트워크 오류' };
  }
}
