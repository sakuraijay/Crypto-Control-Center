/**
 * riskCapital — 위험계산 기준금액 (6H-1 §4).
 *
 * 기본 운용:
 *   dailyRiskCapital      = min(startOfDayEquityUsd,  RISK_POLICY.maxRiskCapitalUsd)
 *   weeklyRiskCapital     = min(startOfWeekEquityUsd, RISK_POLICY.maxRiskCapitalUsd)
 *   positionSizingCapital = min(currentEquityUsd,     RISK_POLICY.maxRiskCapitalUsd)
 *
 * 고정 2026-09-15 Beta 준비:
 *  - 별도 scope를 전달하면 오직 현재 승인 Active 상한 이하로만 risk-capital cap을 낮출 수 있다.
 *  - 400-USDC Beta scope는 PAPER_TEST_ALLOCATION_PLAN의 totalAllocationUsd를 재사용한다.
 *  - 이 모듈은 DB/HWM/Active Capital을 변경하지 않으며 실행·주문·LIVE 권한을 부여하지 않는다.
 *  - active-capital alignment, Owner Approval, Stop, cost, GMX/release gate는 별도로 통과해야 한다.
 *
 * 원칙:
 *  - equity가 정책 상한을 넘어도 목표·포지션 크기·허용손실 자동 증가 금지 (자동 복리 금지)
 *  - equity가 상한 아래면 목표/한도 비례 축소
 *  - scope로 상한을 높이는 것은 금지; 비정상 scope는 fail-closed
 *  - 값이 없거나 stale·비정상이면 기준금액 산출 실패 → 호출측 신규 진입 차단 (fail-closed)
 */

import { PAPER_TEST_ALLOCATION_PLAN, RISK_POLICY } from './riskPolicy';

export type CapitalResult =
  | { ok: true; capitalUsd: number }
  | { ok: false; reason: string };

/** 기준 equity 관측값 — 값 + 기록 시각 (stale 판정용) */
export interface EquityObservation {
  equityUsd: number;
  /** ISO — 비정상 timestamp는 거부 */
  recordedAt: string;
}

/**
 * 위험계산 상한을 더 보수적으로 낮추는 read-only scope.
 * 현재 승인 Active 상한보다 큰 값은 절대 허용하지 않는다.
 */
export interface RiskCapitalScope {
  maxRiskCapitalUsd: number;
}

/**
 * 2026-09-15 고정 Beta의 400-USDC 위험계산 scope.
 * 계획 원본을 재사용하며, 이 상수 자체는 execution authorization이 아니다.
 */
export const FIXED_BETA_RISK_CAPITAL_SCOPE = {
  maxRiskCapitalUsd: PAPER_TEST_ALLOCATION_PLAN.totalAllocationUsd,
} as const satisfies RiskCapitalScope;

/** 관측값 유효성: 유한 수·음수 금지·timestamp 파싱 가능·미래 아님·stale 아님 */
export function validateEquityObservation(
  obs: EquityObservation | null | undefined,
  now: Date,
  maxAgeMs: number,
): CapitalResult {
  if (!obs) return { ok: false, reason: 'equity 관측값 없음 (fail-closed)' };
  const { equityUsd, recordedAt } = obs;
  if (typeof equityUsd !== 'number' || !Number.isFinite(equityUsd)) {
    return { ok: false, reason: 'equity가 NaN/무한대 — 거부' };
  }
  if (equityUsd < 0) return { ok: false, reason: 'equity 음수 — 거부' };
  const ts = Date.parse(recordedAt);
  if (!Number.isFinite(ts)) return { ok: false, reason: '비정상 timestamp — 거부' };
  if (ts > now.getTime() + 60_000) return { ok: false, reason: '미래 timestamp — 거부' };
  if (maxAgeMs > 0 && now.getTime() - ts > maxAgeMs) {
    return { ok: false, reason: `equity 관측값 stale (${Math.round((now.getTime() - ts) / 1000)}s 경과) — 거부` };
  }
  return { ok: true, capitalUsd: equityUsd };
}

/**
 * scope 상한 검증. scope는 current policy보다 더 보수적으로 낮추는 것만 허용한다.
 * 이를 통해 Beta 준비 코드가 실수로 1K→2.5K/5K/10K 자동 승급 우회로가 되는 것을 막는다.
 */
export function resolveRiskCapitalCap(
  scope?: Readonly<RiskCapitalScope> | null,
): CapitalResult {
  const requested = scope?.maxRiskCapitalUsd ?? RISK_POLICY.maxRiskCapitalUsd;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return { ok: false, reason: 'risk-capital scope 비정상 — 거부' };
  }
  if (requested > RISK_POLICY.maxRiskCapitalUsd + 0.005) {
    return { ok: false, reason: 'risk-capital scope가 현재 승인 Active 상한 초과 — 거부' };
  }
  return { ok: true, capitalUsd: requested };
}

function capAtPolicy(
  equityUsd: number,
  scope?: Readonly<RiskCapitalScope> | null,
): CapitalResult {
  const cap = resolveRiskCapitalCap(scope);
  if (!cap.ok) return cap;
  return { ok: true, capitalUsd: Math.min(equityUsd, cap.capitalUsd) };
}

/** dailyRiskCapital = min(startOfDayEquity, scoped cap); scope 생략 시 기존 $1,000 정책 유지 */
export function dailyRiskCapital(
  startOfDay: EquityObservation | null | undefined,
  now: Date,
  maxAgeMs: number,
  scope?: Readonly<RiskCapitalScope> | null,
): CapitalResult {
  const v = validateEquityObservation(startOfDay, now, maxAgeMs);
  if (!v.ok) return v;
  return capAtPolicy(v.capitalUsd, scope);
}

/** weeklyRiskCapital = min(startOfWeekEquity, scoped cap); scope 생략 시 기존 $1,000 정책 유지 */
export function weeklyRiskCapital(
  startOfWeek: EquityObservation | null | undefined,
  now: Date,
  maxAgeMs: number,
  scope?: Readonly<RiskCapitalScope> | null,
): CapitalResult {
  const v = validateEquityObservation(startOfWeek, now, maxAgeMs);
  if (!v.ok) return v;
  return capAtPolicy(v.capitalUsd, scope);
}

/** positionSizingCapital = min(currentEquity, scoped cap); scope 생략 시 기존 $1,000 정책 유지 */
export function positionSizingCapital(
  current: EquityObservation | null | undefined,
  now: Date,
  maxAgeMs: number,
  scope?: Readonly<RiskCapitalScope> | null,
): CapitalResult {
  const v = validateEquityObservation(current, now, maxAgeMs);
  if (!v.ok) return v;
  return capAtPolicy(v.capitalUsd, scope);
}
