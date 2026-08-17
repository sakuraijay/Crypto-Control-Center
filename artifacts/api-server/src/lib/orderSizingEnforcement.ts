/**
 * orderSizingEnforcement — OPEN 실행 직전 서버 최종 사이징 강제 (6H-2 §3, §11).
 *
 * 클라이언트/AI 요청값은 절대 그대로 주문에 사용하지 않는다:
 *  - 요청값 < 서버 계산값 → 작은 값(요청값) 사용 가능
 *  - 요청값 > 서버 계산값 → 서버 값으로 clamp (감사로그 필수)
 *  - stop/비용/유동성 중 하나라도 불명 → 주문 0회 (intent도 생성 금지)
 *  - GMX 최소 주문 미달 → 거래하지 않음
 *  - Canary 활성 시: final = min(RiskEngine, Canary, market, operator) — §11
 */

import { CANARY_POLICY, RISK_POLICY } from './riskPolicy';
import { computePositionSize } from './riskSizing';
import {
  validateCostSnapshot, type CostSnapshot, COST_DATA_UNAVAILABLE,
} from './costSnapshot';

/** GMX 최소 주문 보수값 — DataStore minCollateralUsd 확인 전까지 보수적 고정 */
export const MIN_ORDER_NOTIONAL_USD = 2.2;
export const MIN_ORDER_COLLATERAL_USD = 1.1;

export interface EnforcementInput {
  requestedSizeUsd: number;
  requestedCollateralUsd: number;
  requestedLeverage: number;
  positionSizingCapitalUsd: number;
  /** null = stop 불명 → OPEN 금지 */
  stopDistanceFraction: number | null;
  /** null = 비용 불명 → OPEN 금지 */
  costSnapshot: CostSnapshot | null;
  /** null = 유동성 불명 → OPEN 금지 */
  liquidityCapUsd: number | null;
  tierNotionalCapUsd: number;
  defensiveMode: boolean;
  /** LIVE 경로 여부 — LIVE에서 PAPER_GMX_ESTIMATE 등 비-LIVE 스냅샷 거부 */
  liveMode: boolean;
  canaryActive: boolean;
  /** 운영자 승인 상한 (없으면 null) — §11 min() 요소 */
  operatorApprovedNotionalCapUsd?: number | null;
  expected: { market: string; isLong: boolean; orderType: 'MarketIncrease' };
  now: Date;
}

export type EnforcementResult =
  | {
      ok: true;
      finalNotionalUsd: number;
      finalCollateralUsd: number;
      finalLeverage: number;
      allowedRiskUsd: number;
      effectiveStopLossFraction: number;
      serverMaxNotionalUsd: number;
      clamped: boolean;
      clampDetails: string[];
      estimatedRoundTripCostUsd: number;
    }
  | { ok: false; reason: string };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function enforceOrderSizing(input: EnforcementInput): EnforcementResult {
  // stop 불명 → 진입 금지 (§3)
  if (input.stopDistanceFraction === null || !fin(input.stopDistanceFraction) || input.stopDistanceFraction <= 0) {
    return { ok: false, reason: 'stop distance 불명 — OPEN 0회 (fail-closed)' };
  }
  // 유동성 불명 → 진입 금지
  if (input.liquidityCapUsd === null || !fin(input.liquidityCapUsd) || input.liquidityCapUsd <= 0) {
    return { ok: false, reason: '유동성/impact 상한 불명 — OPEN 0회 (fail-closed)' };
  }
  // 비용 스냅샷 검증 → 실패 시 진입 금지
  if (!input.costSnapshot) {
    return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: 비용 스냅샷 없음 — OPEN 0회` };
  }
  // source 게이트 (6H-2A §2·§3): LIVE는 실측 소스만, PAPER는 공식 read-only 추정만.
  // 합성/고정 모델(구 PAPER_MODEL)·미지의 source 문자열은 어느 경로에서도 거부.
  const src = input.costSnapshot.source as string;
  if (input.liveMode) {
    if (src !== 'GMX_API' && src !== 'RPC_DATASTORE') {
      return { ok: false, reason: `LIVE 경로에 비-LIVE 비용 source(${src}) 사용 금지 — OPEN 0회` };
    }
  } else if (src !== 'PAPER_GMX_ESTIMATE' && src !== 'GMX_API' && src !== 'RPC_DATASTORE') {
    return { ok: false, reason: `PAPER 경로에 허용되지 않은 비용 source(${src}) — OPEN 0회 (고정 모델/zero-fee 금지)` };
  }
  const cost = validateCostSnapshot(input.costSnapshot, {
    market: input.expected.market, isLong: input.expected.isLong,
    orderType: input.expected.orderType, notionalUsd: input.requestedSizeUsd,
  }, input.now.getTime());
  if (!cost.ok) return { ok: false, reason: `비용 스냅샷 무효: ${cost.reason} — OPEN 0회` };

  if (!fin(input.requestedSizeUsd) || input.requestedSizeUsd <= 0) {
    return { ok: false, reason: '요청 sizeUsd 비정상 — 거부' };
  }
  if (!fin(input.requestedLeverage) || input.requestedLeverage <= 0) {
    return { ok: false, reason: '요청 레버리지 비정상 — 거부' };
  }

  // 왕복 비용 fraction 분해 — sizing 입력 (impact는 스냅샷 유효비용에 이미 반영)
  const snap = input.costSnapshot;
  const feesFraction = (snap.positionFeeUsd + snap.executionFeeUsd + snap.estimatedExitFeeUsd) / snap.notionalUsd;
  const impactFraction = Math.max(snap.estimatedPriceImpactUsd, 0) / snap.notionalUsd;
  const fundingBorrowFraction = (snap.fundingFeeUsd + snap.borrowingFeeUsd) / snap.notionalUsd;

  const sizing = computePositionSize({
    positionSizingCapitalUsd: input.positionSizingCapitalUsd,
    stopDistanceFraction: input.stopDistanceFraction,
    roundTripFeesFraction: feesFraction,
    adverseImpactBufferFraction: impactFraction,
    fundingBorrowingBufferFraction: fundingBorrowFraction,
    requestedLeverage: input.requestedLeverage,
    liquidityCapUsd: input.liquidityCapUsd,
    tierNotionalCapUsd: input.tierNotionalCapUsd,
    defensiveMode: input.defensiveMode,
  });
  if (!sizing.ok) return { ok: false, reason: sizing.reason };

  const clampDetails: string[] = [];

  // 레버리지: min(요청, RiskEngine 허용, Canary)
  let finalLeverage = Math.min(input.requestedLeverage, sizing.allowedLeverage);
  if (input.canaryActive) finalLeverage = Math.min(finalLeverage, CANARY_POLICY.canaryMaxLeverage);
  if (finalLeverage < input.requestedLeverage) {
    clampDetails.push(`leverage ${input.requestedLeverage}x → ${finalLeverage}x`);
  }
  // 5x 경로 무조건 비활성 (computePositionSize가 이미 거부하지만 이중 방어)
  if (finalLeverage > RISK_POLICY.baseMaxLeverage) {
    return { ok: false, reason: `레버리지 ${finalLeverage}x > ${RISK_POLICY.baseMaxLeverage}x — 거부` };
  }

  // 서버 최대 notional
  let serverMaxNotionalUsd = sizing.finalNotionalUsd;
  if (input.canaryActive) {
    // Canary: 자본 $15 × 레버리지가 절대 상한 — $1,000 기준 주문 금지 (§11)
    serverMaxNotionalUsd = Math.min(
      serverMaxNotionalUsd, CANARY_POLICY.canaryMaxCapitalAtRiskUsd * finalLeverage,
    );
  }
  if (fin(input.operatorApprovedNotionalCapUsd) && (input.operatorApprovedNotionalCapUsd as number) > 0) {
    serverMaxNotionalUsd = Math.min(serverMaxNotionalUsd, input.operatorApprovedNotionalCapUsd as number);
  }

  // 요청 vs 서버: 작은 쪽 (요청이 더 크면 clamp + 감사)
  let finalNotionalUsd = Math.min(input.requestedSizeUsd, serverMaxNotionalUsd);
  if (input.requestedSizeUsd > serverMaxNotionalUsd * (1 + 1e-9)) {
    clampDetails.push(`notional $${input.requestedSizeUsd.toFixed(2)} → $${serverMaxNotionalUsd.toFixed(2)} (서버 상한)`);
  }

  let finalCollateralUsd = finalNotionalUsd / finalLeverage;
  if (input.canaryActive && finalCollateralUsd > CANARY_POLICY.canaryMaxCapitalAtRiskUsd) {
    finalCollateralUsd = CANARY_POLICY.canaryMaxCapitalAtRiskUsd;
    finalNotionalUsd = finalCollateralUsd * finalLeverage;
    clampDetails.push(`Canary 담보 상한 $${CANARY_POLICY.canaryMaxCapitalAtRiskUsd}`);
  }

  // GMX 최소 주문 검증 — 미달이면 거래하지 않음 (부풀리기 금지)
  if (finalNotionalUsd < MIN_ORDER_NOTIONAL_USD || finalCollateralUsd < MIN_ORDER_COLLATERAL_USD) {
    return {
      ok: false,
      reason: `최종 산정값(notional $${finalNotionalUsd.toFixed(2)}, 담보 $${finalCollateralUsd.toFixed(2)})이 GMX 최소 주문 미달 — 거래하지 않음`,
    };
  }

  return {
    ok: true,
    finalNotionalUsd, finalCollateralUsd, finalLeverage,
    allowedRiskUsd: sizing.allowedRiskUsd,
    effectiveStopLossFraction: sizing.effectiveStopLossFraction,
    serverMaxNotionalUsd,
    clamped: clampDetails.length > 0,
    clampDetails,
    estimatedRoundTripCostUsd: cost.effectiveRoundTripCostUsd,
  };
}
