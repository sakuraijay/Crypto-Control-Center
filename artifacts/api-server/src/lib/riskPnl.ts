/**
 * riskPnl — 실현 수익과 미실현 위험 분리 (6H-1 §5).
 *
 * 목표 달성용 (authoritative):
 *   realizedNetPnl = gross realized − position fees − execution fees
 *                    − price impact − funding − borrowing − 기타 실제 정산 비용
 *   → 수수료 전 PnL·미실현 수익으로 목표 달성 처리 금지.
 *
 * 위험 축소용 (보수적 추정):
 *   estimatedExitNetPnl = realizedNetPnl + unrealizedPnl
 *                         − estimated exit fee − estimated negative impact
 *                         − accrued funding/borrowing
 *   → 양수: Profit Protection 축소 트리거 전용.
 *   → 음수: 손실 게이트 즉시 포함.
 *   → 목표 달성/성과 확정에는 절대 사용 금지.
 *
 * 비용 자료 없으면: 이익 보수적 낮게 / 손실 보수적 크게 / 가짜 0 금지 /
 * 신규 진입 차단 (fail-closed).
 */

export type PnlResult =
  | { ok: true; pnlUsd: number }
  | { ok: false; reason: string };

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 실현 순수익 비용 내역 — 전 항목 필수, 하나라도 결측이면 실패 (fail-closed) */
export interface RealizedCostBreakdown {
  grossRealizedPnlUsd: number;
  positionFeesUsd: number;
  executionFeesUsd: number;
  priceImpactUsd: number;      // 불리한 impact를 양수 비용으로 전달
  fundingFeesUsd: number;
  borrowingFeesUsd: number;
  otherSettlementCostsUsd: number;
}

/** 목표 달성용 authoritative 실현 순수익 */
export function realizedNetPnl(b: Partial<RealizedCostBreakdown> | null | undefined): PnlResult {
  if (!b) return { ok: false, reason: '실현 PnL 비용 내역 없음 — fail-closed' };
  const fields: (keyof RealizedCostBreakdown)[] = [
    'grossRealizedPnlUsd', 'positionFeesUsd', 'executionFeesUsd',
    'priceImpactUsd', 'fundingFeesUsd', 'borrowingFeesUsd', 'otherSettlementCostsUsd',
  ];
  const vals: number[] = [];
  for (const f of fields) {
    const v = finiteOrNull(b[f]);
    if (v === null) return { ok: false, reason: `${f} 결측/비정상 — 가짜 0 대체 금지 (fail-closed)` };
    vals.push(v);
  }
  const [gross, ...costs] = vals;
  const net = gross - costs.reduce((s, c) => s + Math.max(0, c), 0);
  return { ok: true, pnlUsd: net };
}

/** 위험 축소용 보수적 추정 exit 순수익 입력 */
export interface EstimatedExitInput {
  realizedNetPnlUsd: number;
  unrealizedPnlUsd: number;
  estimatedExitFeeUsd: number;
  estimatedNegativeImpactUsd: number;
  accruedFundingBorrowingUsd: number;
}

/** 열린 포지션 포함 보수적 추정치 — Profit Protection/손실 게이트 전용 */
export function estimatedExitNetPnl(i: Partial<EstimatedExitInput> | null | undefined): PnlResult {
  if (!i) return { ok: false, reason: 'estimated exit 입력 없음 — fail-closed' };
  const fields: (keyof EstimatedExitInput)[] = [
    'realizedNetPnlUsd', 'unrealizedPnlUsd', 'estimatedExitFeeUsd',
    'estimatedNegativeImpactUsd', 'accruedFundingBorrowingUsd',
  ];
  const vals: number[] = [];
  for (const f of fields) {
    const v = finiteOrNull(i[f]);
    if (v === null) return { ok: false, reason: `${f} 결측/비정상 — fail-closed` };
    vals.push(v);
  }
  const [realized, unrealized, exitFee, negImpact, funding] = vals;
  const est = realized + unrealized
    - Math.max(0, exitFee) - Math.max(0, negImpact) - Math.max(0, funding);
  return { ok: true, pnlUsd: est };
}

/**
 * 손실 게이트용 PnL — 보수적으로 더 나쁜 쪽.
 * estimated가 없으면(포지션 없음 등) realizedNet만 사용.
 * estimated가 실패(ok:false)했는데 열린 포지션이 있으면 게이트 판단 불가 → 실패 전파.
 */
export function lossAwareNetPnl(
  realized: PnlResult,
  estimated: PnlResult | null,
  hasOpenPositions: boolean,
): PnlResult {
  if (!realized.ok) return realized;
  if (estimated === null) {
    if (hasOpenPositions) return { ok: false, reason: '열린 포지션 존재하나 estimated exit PnL 없음 — fail-closed' };
    return realized;
  }
  if (!estimated.ok) {
    if (hasOpenPositions) return estimated;
    return realized;
  }
  return { ok: true, pnlUsd: Math.min(realized.pnlUsd, estimated.pnlUsd) };
}
