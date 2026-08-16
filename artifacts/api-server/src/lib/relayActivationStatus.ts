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
  if (input.quote.source !== 'gelato') reasons.push(`quote source '${input.quote.source}' — mock 불인정`);
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
