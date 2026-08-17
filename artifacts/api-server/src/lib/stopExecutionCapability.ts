/**
 * stopExecutionCapability — 6H-2B §11 stop 실행 능력 파생 게이트.
 *
 * isStopExecutionAvailable()의 상수 반환 금지 — 아래 실제 조건들의 논리곱으로만
 * 파생한다. 어떤 조건도 "낙관 기본값 true"를 갖지 않는다 (전부 증거 필요).
 * 현 Production(서명·제출 잠금)에서는 available=false가 정상이다.
 */
import { MIN_SAFE_ACTION_BUDGET } from './actionBudget';

export interface StopCapabilityInput {
  /** §2 — StopLossDecrease 스키마 검증 통과 (골든 테스트로 고정된 빌더 존재) */
  schemaVerified: boolean;
  /** prepare/binding/서명/제출 transport 구성 완료 (live relay config ok) */
  transportConfigured: boolean;
  /** delegated signer 활성 + 초기화 */
  signerReady: boolean;
  /** §3 — durable protection 저장소 접근 가능 (DB ok) */
  durableStoreOk: boolean;
  /** §9 — reconciliation 완료 (blocking intent 0 + startup reconcile ok) */
  reconciliationOk: boolean;
  /** §7 — action 예산 충분 (remaining ≥ MIN_SAFE_ACTION_BUDGET) */
  actionBudgetSufficient: boolean;
  actionBudgetRemaining: number | null;
  /** §10 — 실행 적격 fee/비용 스냅샷 확보 가능 (최근 재조회 성공) */
  freshFeeQuote: boolean;
  /** §5·§6 — stop 미확보(uncovered) 포지션 0건 */
  uncoveredCount: number | null;
  /** §3 — 차단 상태(UNRESOLVED/FROZEN/미완 제출) 보호 주문 0건 */
  blockingProtectionCount: number | null;
  /** 기존 잠금: emergency stop / execution locked / live 모드 아님 등 */
  executionUnlocked: boolean;
}

export interface StopCapabilityResult {
  available: boolean;
  reasons: string[]; // 불가 사유 전체 (운영자 표시용)
}

export function deriveStopExecutionCapability(input: StopCapabilityInput): StopCapabilityResult {
  const reasons: string[] = [];
  if (!input.schemaVerified) reasons.push('StopLossDecrease 스키마 미검증');
  if (!input.transportConfigured) reasons.push('GMX API transport/relay 미구성');
  if (!input.signerReady) reasons.push('delegated signer 비활성/미초기화');
  if (!input.durableStoreOk) reasons.push('durable 보호 주문 저장소 접근 불가');
  if (!input.reconciliationOk) reasons.push('reconciliation 미완료/차단 intent 존재');
  if (!input.actionBudgetSufficient) {
    reasons.push(`action 예산 부족 (remaining=${input.actionBudgetRemaining ?? '조회불가'} < ${MIN_SAFE_ACTION_BUDGET})`);
  }
  if (!input.freshFeeQuote) reasons.push('실행 적격 fee/비용 스냅샷 미확보');
  if (input.uncoveredCount === null) reasons.push('stop coverage 조회 실패');
  else if (input.uncoveredCount > 0) reasons.push(`stop 미확보 포지션 ${input.uncoveredCount}건`);
  if (input.blockingProtectionCount === null) reasons.push('보호 주문 상태 조회 실패');
  else if (input.blockingProtectionCount > 0) reasons.push(`차단 상태 보호 주문 ${input.blockingProtectionCount}건`);
  if (!input.executionUnlocked) reasons.push('실행 잠금 상태 (LIVE 잠금/emergency stop)');
  return { available: reasons.length === 0, reasons };
}

// ── §8 — floor stop 교체 정책 ────────────────────────────────────────────────

/**
 * GMX 공식 API v2의 기존 stop 주문 수정(updateOrder) 경유 "무공백 교체"는
 * 이 프로젝트에서 아직 스키마·원자성 증명이 없다 (§2 감사: prepare 경로는
 * createOrder 계열만 확인됨). 증명 전까지 false 고정 — §8 규칙에 따라
 * 교체가 필요한데 안전 교체를 증명할 수 없으면 잔여 포지션 전량 종료한다.
 */
export const STOP_REPLACEMENT_PROVEN_SAFE = false;

export type FloorStopReplacementPlan =
  | { action: 'REPLACE'; }
  | { action: 'CLOSE_REMAINING'; reason: string };

/** §8 — 70% 축소 후 +3.5% floor stop 교체 계획. 증명 불가 = 잔여 전량 종료. */
export function planFloorStopReplacement(args: {
  existingStopActive: boolean;
  newTriggerComputable: boolean;
  remainingSizeUsd: number;
}): FloorStopReplacementPlan {
  if (!Number.isFinite(args.remainingSizeUsd) || args.remainingSizeUsd <= 0) {
    return { action: 'CLOSE_REMAINING', reason: '잔여 size 비정상 — 전량 종료' };
  }
  if (!args.newTriggerComputable) {
    return { action: 'CLOSE_REMAINING', reason: 'floor stop trigger 계산 불가 — 전량 종료 (방치 금지)' };
  }
  if (!args.existingStopActive) {
    return { action: 'CLOSE_REMAINING', reason: '기존 ACTIVE stop 부재 — 보호 공백 상태, 전량 종료' };
  }
  if (!STOP_REPLACEMENT_PROVEN_SAFE) {
    return { action: 'CLOSE_REMAINING', reason: '무공백 stop 교체 안전성 미증명 — 잔여 전량 종료 (§8 fail-safe)' };
  }
  return { action: 'REPLACE' };
}
