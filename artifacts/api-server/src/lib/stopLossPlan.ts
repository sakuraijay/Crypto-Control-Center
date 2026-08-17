/**
 * stopLossPlan — 필수 stop-loss 계약 + +3.5% 보호 floor stop (6H-2 §7, §8).
 *
 *  - 모든 OPEN은 진입 전에 stop trigger가 계산돼 있어야 한다
 *  - stop이 청산가와 충분히 분리되지 않으면 OPEN 금지
 *  - 보호 stop trigger가 시장가의 잘못된 방향이면 즉시 잔여 전량 종료
 *  - OPEN과 stop을 원자화할 수 없으므로 coverage 상태 머신으로 다룬다:
 *    "OPEN 성공"만으로 안전 완료 처리 금지
 */

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 서버 기본 stop 거리 (진입가 대비 fraction).
 * 근거: 3x 레버리지·거래당 1% 자본 위험에서 notional 대비 1% 손절이
 * RiskEngine sizing 역산과 일관. stateEngine이 stop을 제공하지 않는 동안의
 * 서버 authoritative 값 — 클라이언트/AI가 덮어쓸 수 없다.
 */
export const DEFAULT_STOP_DISTANCE_FRACTION = 0.01;

/** stop trigger와 청산가 사이 최소 분리 간격 (fraction of price) */
export const MIN_STOP_LIQUIDATION_GAP_FRACTION = 0.005;

export interface StopPlan {
  triggerPriceUsd: number;
  stopDistanceFraction: number;
  isLong: boolean;
}

export type StopPlanResult = { ok: true; plan: StopPlan } | { ok: false; reason: string };

/** 진입 전 stop trigger 계산 (§8 진입 전 계약) */
export function computeStopTrigger(args: {
  entryPriceUsd: number;
  isLong: boolean;
  stopDistanceFraction?: number;
}): StopPlanResult {
  const dist = args.stopDistanceFraction ?? DEFAULT_STOP_DISTANCE_FRACTION;
  if (!fin(args.entryPriceUsd) || args.entryPriceUsd <= 0) return { ok: false, reason: '진입가 비정상 — stop 계산 불가 → OPEN 금지' };
  if (!fin(dist) || dist <= 0 || dist >= 0.5) return { ok: false, reason: 'stop distance 비정상 — OPEN 금지' };
  const triggerPriceUsd = args.isLong
    ? args.entryPriceUsd * (1 - dist)
    : args.entryPriceUsd * (1 + dist);
  return { ok: true, plan: { triggerPriceUsd, stopDistanceFraction: dist, isLong: args.isLong } };
}

/** stop trigger가 청산가와 충분히 분리됐는지 (§8) — 불충분 시 OPEN 금지 */
export function validateStopVsLiquidation(args: {
  triggerPriceUsd: number;
  liquidationPriceUsd: number | null;
  isLong: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (args.liquidationPriceUsd === null || !fin(args.liquidationPriceUsd) || args.liquidationPriceUsd <= 0) {
    return { ok: false, reason: '청산가 불명 — stop 안전 간격 검증 불가 (fail-closed)' };
  }
  const gap = args.isLong
    ? (args.triggerPriceUsd - args.liquidationPriceUsd) / args.triggerPriceUsd
    : (args.liquidationPriceUsd - args.triggerPriceUsd) / args.triggerPriceUsd;
  if (gap < MIN_STOP_LIQUIDATION_GAP_FRACTION) {
    return { ok: false, reason: `stop-청산가 간격 ${(gap * 100).toFixed(2)}% < 최소 ${(MIN_STOP_LIQUIDATION_GAP_FRACTION * 100).toFixed(1)}% — OPEN 금지` };
  }
  return { ok: true };
}

// ── +3.5% 보호 floor stop (§7) ────────────────────────────────────────────────

export type ProtectiveStopResult =
  | { ok: true; triggerPriceUsd: number; guaranteedDailyNetUsd: number }
  | { ok: false; action: 'CLOSE_REMAINING'; reason: string };

/**
 * 70% 축소 확인 후, 잔여 포지션에 당일 총 순수익 +floorUsd를 보장하는 stop trigger.
 * 계산 불가/방향 오류/시장가 이미 초과 → 잔여 전량 종료 (포지션 방치 금지).
 */
export function computeProtectiveFloorStop(args: {
  dailyRealizedNetPnlUsd: number;
  floorUsd: number;
  remainingSizeUsd: number;
  remainingEntryPriceUsd: number;
  currentPriceUsd: number;
  isLong: boolean;
  estimatedExitCostUsd: number;
}): ProtectiveStopResult {
  const { dailyRealizedNetPnlUsd: realized, floorUsd, remainingSizeUsd: size,
    remainingEntryPriceUsd: entry, currentPriceUsd: mark, isLong, estimatedExitCostUsd: exitCost } = args;

  for (const [k, v] of Object.entries({ realized, floorUsd, size, entry, mark, exitCost })) {
    if (!fin(v)) return { ok: false, action: 'CLOSE_REMAINING', reason: `${k} 비정상 — 계산 불가 → 잔여 전량 종료` };
  }
  if (size <= 0 || entry <= 0 || mark <= 0 || exitCost < 0) {
    return { ok: false, action: 'CLOSE_REMAINING', reason: '잔여 포지션/가격/비용 비정상 → 잔여 전량 종료' };
  }

  // 필요한 잔여 포지션 PnL = floor − realized + 예상 종료 비용
  const requiredPositionPnlUsd = floorUsd - realized + exitCost;
  // PnL = size × (trigger − entry)/entry × dir  →  trigger 역산
  const dir = isLong ? 1 : -1;
  const triggerPriceUsd = entry * (1 + dir * requiredPositionPnlUsd / size);

  if (!fin(triggerPriceUsd) || triggerPriceUsd <= 0) {
    return { ok: false, action: 'CLOSE_REMAINING', reason: '보호 stop trigger 계산 불가 → 잔여 전량 종료' };
  }

  // trigger가 시장가 대비 잘못된 방향(이미 통과)이면 즉시 전량 종료
  const wrongDirection = isLong ? triggerPriceUsd >= mark : triggerPriceUsd <= mark;
  if (wrongDirection) {
    return {
      ok: false, action: 'CLOSE_REMAINING',
      reason: `보호 stop trigger($${triggerPriceUsd.toFixed(2)})가 시장가($${mark.toFixed(2)})의 잘못된 방향 — 즉시 잔여 전량 종료`,
    };
  }

  return { ok: true, triggerPriceUsd, guaranteedDailyNetUsd: floorUsd };
}

// ── Stop coverage 상태 머신 (§8 진입 후 계약) ─────────────────────────────────

export type StopCoverageStatus = 'PENDING' | 'COVERED' | 'FAILED_CLOSING' | 'UNRESOLVED';

export interface StopCoverageRecord {
  positionRef: string;          // positionKey 또는 intentId
  status: StopCoverageStatus;
  stopOrderKey: string | null;  // 중복 생성 금지 근거
  triggerPriceUsd: number | null;
  updatedAt: string;
}

export type StopCoverageMap = Record<string, StopCoverageRecord>;

/** COVERED가 아닌 열린 포지션이 하나라도 있으면 신규 주문 금지 (§8) */
export function listUncovered(map: StopCoverageMap): StopCoverageRecord[] {
  return Object.values(map).filter(r => r.status !== 'COVERED');
}

/** stop orderKey 중복 생성 금지 — 이미 orderKey가 있으면 재생성 거부 (§13.28) */
export function canCreateStopOrder(rec: StopCoverageRecord | undefined): { ok: true } | { ok: false; reason: string } {
  if (rec?.stopOrderKey) return { ok: false, reason: `stop orderKey 이미 존재 (${rec.stopOrderKey}) — 중복 생성 금지` };
  if (rec?.status === 'UNRESOLVED') return { ok: false, reason: 'stop 생성 상태 불명 — 재생성 금지, 운영자 확인 필요' };
  return { ok: true };
}
