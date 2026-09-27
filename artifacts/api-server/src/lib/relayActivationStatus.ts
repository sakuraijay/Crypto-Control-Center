/**
 * relayActivationStatus — activation 진단의 실제 상태 계산 (5단계 §4·§8).
 *
 * 기존 /executor/relay/activation의 하드코딩(reconciliationComplete=false,
 * freshLiveFeeQuote=false)을 실제 파생값으로 교체한다. 단, 이 모듈의 계산은
 * 어떤 외부 네트워크 호출도 유발하지 않는다 — DB 조회 + 메모리 상태 +
 * 저장된 quote 검증만.
 *
 * fail-closed 원칙: DB 조회 실패·stale·미수행은 전부 false.
 */

import { validateFeeQuote, type RelayFeeQuote } from './relayFeeQuote';

/**
 * 최우선 구조적 네트워크 게이트 (5단계 리뷰 반영).
 * true면 canonical RPC readback·signer 저장소 접근·transport 발신 등
 * 어떤 실제 외부 접근도 시작해서는 안 된다 (fail-closed 결과만 반환).
 */
export function isRelayNetworkStructurallyDisabled(env: NodeJS.ProcessEnv): boolean {
  return env['GMX_RELAY_NETWORK_ENABLED'] !== 'true';
}

/**
 * 6단계 — 읽기 전용 네트워크 플래그. 정확히 문자열 'true'일 때만 활성.
 * canonical auth eth_call·digest readback·receipt/log 조회·Gelato fee oracle
 * GET·task status GET 등 **읽기 전용** 요청만 이 플래그로 허용된다.
 * 어떤 기존 플래그(GMX_RELAY_NETWORK_ENABLED 등)도 이 값을 암묵적으로
 * true로 만들지 않는다.
 */
export function isRelayReadonlyNetworkEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['GMX_RELAY_READONLY_NETWORK_ENABLED'] === 'true';
}

// ── 6E-5 §6 — relay 설정 파생 상태 (boolean만, Secret 원문 절대 미포함) ──────

export interface RelayEnvFlags {
  relayReadonlyNetworkEnabled: boolean;
  relaySubmitNetworkEnabled: boolean;
  relaySubmissionEnabled: boolean;
  relayMode: 'DISABLED' | 'DRY_RUN' | 'LIVE';
  relayManifestConfigured: boolean;
  relayDeploymentVerified: boolean;
  operatorPinConfigured: boolean;
  delegatedSignerEnabled: boolean;
}

/**
 * runtime env에서 파생한 relay 설정 인식 상태. 값·주소·URL·PIN 원문은
 * 절대 포함하지 않는다 — 오직 boolean/enum 파생값만.
 * relayManifestConfigured는 순환 import를 피하기 위해 호출측에서 주입한다.
 */
export function deriveRelayEnvFlags(
  env: NodeJS.ProcessEnv,
  manifestConfigured: boolean,
): RelayEnvFlags {
  const modeRaw = (env['GMX_RELAY_MODE'] ?? '').trim();
  const relayMode: RelayEnvFlags['relayMode'] =
    modeRaw === 'LIVE' ? 'LIVE' : modeRaw === 'DRY_RUN' ? 'DRY_RUN' : 'DISABLED';
  const dv = getDeploymentVerificationState();
  return {
    relayReadonlyNetworkEnabled: isRelayReadonlyNetworkEnabled(env),
    relaySubmitNetworkEnabled: env['GMX_RELAY_NETWORK_ENABLED'] === 'true',
    relaySubmissionEnabled: env['GMX_RELAY_SUBMISSION_ENABLED'] === 'true',
    relayMode,
    relayManifestConfigured: manifestConfigured,
    relayDeploymentVerified: dv.attempted && dv.ok,
    operatorPinConfigured: (env['OPERATOR_MASTER_PIN'] ?? '').trim().length > 0,
    delegatedSignerEnabled: env['DELEGATED_SIGNER_ENABLED'] === 'true',
  };
}

// ── 명시적 읽기 전용 readiness refresh 상태 (모듈 메모리, 6단계 §7) ──────────

export interface ReadinessRefreshState {
  attempted: boolean;
  atMs: number | null;
  ok: boolean;                 // 모든 읽기 성공 시에만 true (조회 실패 = fail-closed)
  basis: string[];             // 수행한 읽기 작업·결과 근거 (민감정보 없음)
  failures: string[];          // 실패 사유 (sanitize된 것만)
}

let readinessRefreshState: ReadinessRefreshState = {
  attempted: false, atMs: null, ok: false, basis: [], failures: ['readiness refresh 미수행'],
};

export function recordReadinessRefresh(state: Omit<ReadinessRefreshState, 'attempted'>): void {
  readinessRefreshState = { attempted: true, ...state, basis: [...state.basis], failures: [...state.failures] };
}

export function getReadinessRefreshState(): ReadinessRefreshState {
  return { ...readinessRefreshState, basis: [...readinessRefreshState.basis], failures: [...readinessRefreshState.failures] };
}

export function __resetReadinessRefreshForTests(): void {
  readinessRefreshState = { attempted: false, atMs: null, ok: false, basis: [], failures: ['readiness refresh 미수행'] };
  canonicalSnapshot = null;
}

// ── canonical readback 저장 스냅샷 (모듈 메모리) ─────────────────────────────
// 실제 eth_call을 수행한 경로(status/dry-run/readiness refresh)만 기록하고,
// activation GET 같은 무호출 상태 조회는 이 저장값만 읽는다 — 외부 호출 0회 보장.

export interface CanonicalSnapshot {
  atMs: number;
  confirmed: boolean;
  reason: string | null;
  approvalNonce: string | null;
  isSubaccountListed: boolean | null;
  /** canonical DataStore feature gate. 누락/null은 authorization 미확인으로 취급한다. */
  featureDisabled?: boolean | null;
  /** canonical integration gate. 누락/null은 authorization 미확인으로 취급한다. */
  integrationDisabled?: boolean | null;
  expiresAt: string | null;
  remaining: string | null;
}

let canonicalSnapshot: CanonicalSnapshot | null = null;

export function recordCanonicalSnapshot(s: CanonicalSnapshot): void {
  canonicalSnapshot = { ...s };
}

/** 저장된 canonical readback 결과 — 없으면 null (미조회, fail-closed로 취급) */
export function getCanonicalSnapshot(): CanonicalSnapshot | null {
  return canonicalSnapshot ? { ...canonicalSnapshot } : null;
}

// ── 6C §7: 배포 코드 존재 검증 스냅샷 (모듈 메모리) ─────────────────────────
// 읽기 전용 readiness refresh 경로에서만 갱신되고, activation GET·게이트는
// 저장값만 읽는다. 미수행 = ok:false (fail-closed).

export interface DeploymentVerificationState {
  attempted: boolean;
  atMs: number | null;
  ok: boolean;             // 모든 검증(코드 존재·decode·manifest 일치·chainId) 성공 시에만 true
  manifestVersion: number | null;
  basis: string[];
  failures: string[];
}

let deploymentVerification: DeploymentVerificationState = {
  attempted: false, atMs: null, ok: false, manifestVersion: null,
  basis: [], failures: ['배포 코드 존재 검증 미수행'],
};

export function recordDeploymentVerification(state: Omit<DeploymentVerificationState, 'attempted'>): void {
  deploymentVerification = { attempted: true, ...state, basis: [...state.basis], failures: [...state.failures] };
}

export function getDeploymentVerificationState(): DeploymentVerificationState {
  return { ...deploymentVerification, basis: [...deploymentVerification.basis], failures: [...deploymentVerification.failures] };
}

export function __resetDeploymentVerificationForTests(): void {
  deploymentVerification = {
    attempted: false, atMs: null, ok: false, manifestVersion: null,
    basis: [], failures: ['배포 코드 존재 검증 미수행'],
  };
}

// ── 6F-2 §6·§10 — GMX fee estimate 입력·sponsor balance 스냅샷 (모듈 메모리) ──
// readiness refresh(읽기 전용 경로)에서만 갱신; GET은 저장값만 읽는다.

export interface FeeEstimateState {
  attempted: boolean;
  atMs: number | null;
  ok: boolean;                  // gasPrice + multiplierFactor 둘 다 확보 시에만 true
  basis: string[];
  failures: string[];
}

let feeEstimateState: FeeEstimateState = {
  attempted: false, atMs: null, ok: false, basis: [], failures: ['GMX fee estimate 입력 미조회'],
};

export function recordFeeEstimateState(state: Omit<FeeEstimateState, 'attempted'>): void {
  feeEstimateState = { attempted: true, ...state, basis: [...state.basis], failures: [...state.failures] };
}
export function getFeeEstimateState(): FeeEstimateState {
  return { ...feeEstimateState, basis: [...feeEstimateState.basis], failures: [...feeEstimateState.failures] };
}

/** §10 — 범주형만: verified/unverified/insufficient. 원시 잔액·key는 절대 미노출 */
export interface SponsorBalanceState {
  attempted: boolean;
  atMs: number | null;
  status: 'verified' | 'unverified' | 'insufficient';
  basis: string[];
}

let sponsorBalanceState: SponsorBalanceState = {
  attempted: false, atMs: null, status: 'unverified', basis: ['sponsor balance 미조회'],
};

export function recordSponsorBalanceState(state: Omit<SponsorBalanceState, 'attempted'>): void {
  sponsorBalanceState = { attempted: true, ...state, basis: [...state.basis] };
}
export function getSponsorBalanceState(): SponsorBalanceState {
  return { ...sponsorBalanceState, basis: [...sponsorBalanceState.basis] };
}

export function __resetFeeAndSponsorStateForTests(): void {
  feeEstimateState = { attempted: false, atMs: null, ok: false, basis: [], failures: ['GMX fee estimate 입력 미조회'] };
  sponsorBalanceState = { attempted: false, atMs: null, status: 'unverified', basis: ['sponsor balance 미조회'] };
}

/** 재조정(reconciliation) 결과가 유효하다고 보는 최대 age */
export const RECONCILIATION_FRESHNESS_MS = 10 * 60_000; // 10분

// ── 시작 시 relay reconciliation 상태 (모듈 메모리) ──────────────────────────

export interface StartupReconciliationState {
  attempted: boolean;
  complete: boolean;          // 모든 단계 성공 시에만 true
  atMs: number | null;        // 마지막 수행 시각
  reasons: string[];          // 미완료 사유
}

let startupState: StartupReconciliationState = {
  attempted: false, complete: false, atMs: null, reasons: ['startup reconciliation 미수행'],
};
let reconciliationRunning = false;

export function getStartupReconciliationState(): StartupReconciliationState {
  return { ...startupState, reasons: [...startupState.reasons] };
}
export function isReconciliationRunning(): boolean {
  return reconciliationRunning;
}
export function __resetActivationStatusForTests(): void {
  startupState = { attempted: false, complete: false, atMs: null, reasons: ['startup reconciliation 미수행'] };
  reconciliationRunning = false;
}

/** 시작 시 reconciliation 각 단계의 결과 — 호출측(index.ts/테스트)이 주입 */
export interface StartupReconciliationDeps {
  /** migration 완료 여부 (readiness 게이트 통과) */
  migrationsComplete(): boolean;
  /** execution intent reconciliation — blocking intent 수 (null=조회 실패) */
  countBlockingIntents(): Promise<number | null>;
  /** relay task reconciliation — PREPARED/SUBMITTING/UNRESOLVED 등 미종결 수 (null=조회 실패) */
  countOpenRelayTasks(): Promise<number | null>;
  /** nonce/task 결속 검증 — 결속 깨진 allocation 수 (null=조회 실패) */
  countUnboundNonces(): Promise<number | null>;
  /** revoke 상태 복구 — 활성 revoke 존재 여부 (null=조회 실패) */
  hasActiveRevoke(): Promise<boolean | null>;
  /**
   * canonical authorization readback — 이번 단계 프로덕션 기본값은
   * "미수행(네트워크 비활성)" 고정. 테스트만 fixture 주입.
   */
  canonicalReadback(): Promise<{ performed: boolean; ok: boolean; reason?: string }>;
  nowMs(): number;
}

/**
 * 서버 시작 시 relay reconciliation 수행 (§8 순서).
 * 어떤 실패도 throw 하지 않는다 — 결과는 상태로만 기록 (Worker 불중단).
 */
export async function runStartupRelayReconciliation(deps: StartupReconciliationDeps): Promise<StartupReconciliationState> {
  reconciliationRunning = true;
  const reasons: string[] = [];
  try {
    if (!deps.migrationsComplete()) reasons.push('migration 미완료');

    const blocking = await deps.countBlockingIntents();
    if (blocking === null) reasons.push('execution intent 조회 실패 (fail-closed)');
    else if (blocking > 0) reasons.push(`blocking execution intent ${blocking}건`);

    const openTasks = await deps.countOpenRelayTasks();
    if (openTasks === null) reasons.push('relay task 조회 실패 (fail-closed)');
    else if (openTasks > 0) reasons.push(`미종결 relay task ${openTasks}건 (PREPARED/SUBMITTING/UNRESOLVED 등)`);

    const unbound = await deps.countUnboundNonces();
    if (unbound === null) reasons.push('nonce/task 결속 조회 실패 (fail-closed)');
    else if (unbound > 0) reasons.push(`task 미결속 nonce allocation ${unbound}건`);

    const revoke = await deps.hasActiveRevoke();
    if (revoke === null) reasons.push('revoke 상태 조회 실패 (fail-closed)');
    else if (revoke) reasons.push('활성 revoke 세션 존재');

    const canonical = await deps.canonicalReadback();
    if (!canonical.performed) reasons.push(canonical.reason ?? 'canonical authorization readback 미수행');
    else if (!canonical.ok) reasons.push(`canonical readback 실패: ${canonical.reason ?? '불명'}`);
  } catch (e: unknown) {
    reasons.push('startup reconciliation 예외 — fail-closed');
  } finally {
    reconciliationRunning = false;
  }

  startupState = {
    attempted: true,
    complete: reasons.length === 0,
    atMs: deps.nowMs(),
    reasons,
  };
  return getStartupReconciliationState();
}

// ── reconciliationComplete 파생값 ────────────────────────────────────────────

export interface ReconciliationCompleteDeps {
  countBlockingIntents(): Promise<number | null>;
  countOpenRelayTasks(): Promise<number | null>;
  hasActiveRevoke(): Promise<boolean | null>;
  getStartupState(): StartupReconciliationState;
  isRunning(): boolean;
  nowMs(): number;
}

export async function computeReconciliationComplete(
  deps: ReconciliationCompleteDeps,
): Promise<{ complete: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const startup = deps.getStartupState();

  if (deps.isRunning()) reasons.push('reconciliation 실행 중');
  if (!startup.attempted) reasons.push('startup reconciliation 미수행');
  else if (!startup.complete) reasons.push(...startup.reasons.map((r) => `startup: ${r}`));
  else if (startup.atMs === null || deps.nowMs() - startup.atMs > RECONCILIATION_FRESHNESS_MS) {
    reasons.push('reconciliation 결과 stale (freshness 초과)');
  }

  const blocking = await deps.countBlockingIntents();
  if (blocking === null) reasons.push('execution intent 조회 실패 (fail-closed)');
  else if (blocking > 0) reasons.push(`blocking execution intent ${blocking}건`);

  const openTasks = await deps.countOpenRelayTasks();
  if (openTasks === null) reasons.push('relay task 조회 실패 (fail-closed)');
  else if (openTasks > 0) reasons.push(`미종결 relay task ${openTasks}건 — 온체인 판정 대상 잔존`);

  const revoke = await deps.hasActiveRevoke();
  if (revoke === null) reasons.push('revoke 상태 조회 실패 (fail-closed)');
  else if (revoke) reasons.push('활성 revoke 세션 존재');

  return { complete: reasons.length === 0, reasons };
}

// ── freshLiveFeeQuote 파생값 ─────────────────────────────────────────────────

export interface FreshLiveQuoteInput {
  quote: RelayFeeQuote | null;      // 저장된 quote — 이 계산이 네트워크 호출을 유발하면 안 됨
  chainId: number | null;           // quote가 대상으로 한 체인
  nowMs: number;
  orderNotionalUsd: number | null;
  ethPriceUsd: number | null;
  /** quote가 결속된 payload hash ↔ 실제 제출 대상 payload hash 일치 확인 */
  quoteBoundPayloadHash: string | null;
  targetPayloadHash: string | null;
}

export function evaluateFreshLiveQuote(input: FreshLiveQuoteInput): { fresh: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.quote) {
    return { fresh: false, reasons: ['live quote 저장 없음'] };
  }
  if (input.quote.source !== 'gmx_official_estimate') reasons.push(`quote source '${input.quote.source}' — gmx_official_estimate만 인정`);
  if (input.chainId !== 42161) reasons.push(`quote chainId ${input.chainId ?? '미확인'} ≠ 42161`);
  const check = validateFeeQuote({
    quote: input.quote, nowMs: input.nowMs,
    orderNotionalUsd: input.orderNotionalUsd, ethPriceUsd: input.ethPriceUsd,
  });
  if (!check.ok) reasons.push(`quote 검증 실패: ${check.reason}`);
  if (!input.quoteBoundPayloadHash || !input.targetPayloadHash) {
    reasons.push('quote-payload 결속 미확인');
  } else if (input.quoteBoundPayloadHash.toLowerCase() !== input.targetPayloadHash.toLowerCase()) {
    reasons.push('quote-payload 결속 불일치');
  }
  return { fresh: reasons.length === 0, reasons };
}
