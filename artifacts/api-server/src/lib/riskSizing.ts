/**
 * riskSizing — 거래당 위험 기반 포지션 크기 역산 (6H-1 §9).
 *
 *   baseRiskUsd        = positionSizingCapital × 0.75%
 *   absoluteMaxRiskUsd = positionSizingCapital × 1%
 *
 *   effectiveStopLossFraction = stopDistance + round-trip fees
 *                               + adverse impact buffer + funding/borrowing buffer
 *   maxNotionalByRisk = allowedRiskUsd / effectiveStopLossFraction
 *
 *   최종 notional = min(maxNotionalByRisk,
 *                       positionSizingCapital × allowedLeverage,
 *                       liquidity/impact cap, tier notional cap)
 *
 * 금지 (§9): stop 없이 진입, stop 축소로 크기 부풀리기, 목표 미달 레버리지 증가,
 * 손실 후 size 증가, 물타기/revenge, 남은 일일 목표액 기반 size.
 * 5x 경로는 conditional5xEnabled=false인 동안 무조건 차단.
 */

import { RISK_POLICY, deriveTradeRiskUsd } from './riskPolicy';

export type SizingResult =
  | {
      ok: true;
      baseRiskUsd: number;
      absoluteMaxRiskUsd: number;
      allowedRiskUsd: number;
      effectiveStopLossFraction: number;
      maxNotionalByRisk: number;
      finalNotionalUsd: number;
      allowedLeverage: number;
    }
  | { ok: false; reason: string };

export interface SizingInput {
  positionSizingCapitalUsd: number;
  /** stop 거리 (진입가 대비 fraction, 예: 0.01 = 1%) — 없거나 0 이하면 진입 금지 */
  stopDistanceFraction: number;
  /** 왕복 수수료 (fraction) — 결측 시 fail-closed */
  roundTripFeesFraction: number;
  /** 불리한 price impact 버퍼 (fraction) */
  adverseImpactBufferFraction: number;
  /** funding/borrowing 버퍼 (fraction) */
  fundingBorrowingBufferFraction: number;
  /** 요청 레버리지 — 정책 상한으로 클램프, 5x 경로 차단 */
  requestedLeverage: number;
  /** 시장 유동성/impact 상한 (USD). null = 알 수 없음 → fail-closed */
  liquidityCapUsd: number | null;
  /** 활성 tier notional 상한 (USD) */
  tierNotionalCapUsd: number;
  /** true면 absoluteMaxRiskUsd까지 허용 (기본은 baseRiskUsd) */
  useAbsoluteMaxRisk?: boolean;
  /** 프로필이 허용한 거래당 위험 %. 절대 1% 정책 상한과 교차한다. */
  riskBudgetPct?: number;
  /** Defensive Mode — 명목 50% 축소, 레버리지 2x */
  defensiveMode?: boolean;
}

function isPosFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
function isNonNegFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** 현재 정책에서 허용되는 최대 레버리지 — 5x는 구조적으로 차단 */
export function allowedMaxLeverage(defensiveMode: boolean): number {
  // conditional5xEnabled는 컴파일 타임 false — 향후 활성화되어도
  // 별도 운영자 승인 경로 없이는 이 함수가 5를 반환해선 안 된다.
  const base = defensiveMode ? 2 : RISK_POLICY.baseMaxLeverage;
  return Math.min(base, RISK_POLICY.baseMaxLeverage);
}

export function computePositionSize(input: SizingInput): SizingResult {
  const cap = input.positionSizingCapitalUsd;
  if (!isPosFinite(cap)) return { ok: false, reason: 'positionSizingCapital 비정상 — 진입 차단' };

  // stop 없이 진입 금지
  if (!isPosFinite(input.stopDistanceFraction)) {
    return { ok: false, reason: 'stop distance 없음/0 이하 — stop 없이 진입 금지' };
  }
  // 비용 fraction 결측 시 fail-closed (가짜 0 금지)
  if (!isNonNegFinite(input.roundTripFeesFraction)) return { ok: false, reason: '왕복 수수료 fraction 결측 — fail-closed' };
  if (!isNonNegFinite(input.adverseImpactBufferFraction)) return { ok: false, reason: 'impact 버퍼 결측 — fail-closed' };
  if (!isNonNegFinite(input.fundingBorrowingBufferFraction)) return { ok: false, reason: 'funding/borrowing 버퍼 결측 — fail-closed' };
  if (input.liquidityCapUsd === null || !isPosFinite(input.liquidityCapUsd)) {
    return { ok: false, reason: '시장 유동성/impact 상한 불명 — fail-closed' };
  }
  if (!isPosFinite(input.tierNotionalCapUsd)) return { ok: false, reason: 'tier notional cap 비정상 — fail-closed' };
  if (!isPosFinite(input.requestedLeverage)) return { ok: false, reason: '레버리지 비정상 — 거부' };

  // 5x 경로 무조건 차단 (conditional5xEnabled=false)
  const maxLev = allowedMaxLeverage(Boolean(input.defensiveMode));
  if (input.requestedLeverage > maxLev && input.requestedLeverage > RISK_POLICY.baseMaxLeverage) {
    // 요청이 base를 초과하면 조용히 부풀리지 않고 클램프하되 5x 요청은 명시 거부
    if (input.requestedLeverage >= RISK_POLICY.conditionalMaxLeverage && !RISK_POLICY.conditional5xEnabled) {
      return { ok: false, reason: `조건부 ${RISK_POLICY.conditionalMaxLeverage}x 비활성 — 요청 ${input.requestedLeverage}x 거부` };
    }
  }
  const allowedLeverage = Math.min(input.requestedLeverage, maxLev);

  const { baseRiskUsd, absoluteMaxRiskUsd } = deriveTradeRiskUsd(cap);
  const requestedRiskPct = input.riskBudgetPct;
  const profileRiskUsd =
    typeof requestedRiskPct === 'number' && Number.isFinite(requestedRiskPct)
      ? cap * Math.max(0, Math.min(requestedRiskPct, RISK_POLICY.maxRiskPerTradePercent)) / 100
      : null;
  const allowedRiskUsd = Math.min(
    absoluteMaxRiskUsd,
    profileRiskUsd ?? (input.useAbsoluteMaxRisk ? absoluteMaxRiskUsd : baseRiskUsd),
  );

  const effectiveStopLossFraction =
    input.stopDistanceFraction
    + input.roundTripFeesFraction
    + input.adverseImpactBufferFraction
    + input.fundingBorrowingBufferFraction;
  if (!isPosFinite(effectiveStopLossFraction)) {
    return { ok: false, reason: 'effectiveStopLossFraction 비정상 — 거부' };
  }

  const maxNotionalByRisk = allowedRiskUsd / effectiveStopLossFraction;
  const defensiveFactor = input.defensiveMode ? 0.5 : 1;

  const finalNotionalUsd = Math.min(
    maxNotionalByRisk,
    cap * allowedLeverage,
    input.liquidityCapUsd,
    input.tierNotionalCapUsd,
  ) * defensiveFactor;

  if (!isPosFinite(finalNotionalUsd)) return { ok: false, reason: '최종 notional 비정상 — 거부' };

  return {
    ok: true,
    baseRiskUsd, absoluteMaxRiskUsd, allowedRiskUsd,
    effectiveStopLossFraction, maxNotionalByRisk, finalNotionalUsd, allowedLeverage,
  };
}
