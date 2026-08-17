/**
 * costSnapshot — 주문 전 비용 스냅샷 (6H-2 §4).
 *
 * 원칙 (fail-closed):
 *  - 고정 수수료율 fallback 금지, 임의의 0 금지, stale snapshot 금지
 *  - 다른 market/direction/orderType/상위 주문금액에 quote 재사용 금지
 *  - 음수·NaN·비정상 거부, positive impact는 비용 상쇄에 20%까지만 반영
 *  - LIVE 조회 실패/readonly 플래그 꺼짐 → COST_DATA_UNAVAILABLE (가짜 성공 금지)
 *  - PAPER는 명시적 PAPER_MODEL 비용을 차감 (수수료 0 처리 금지 — §13.15)
 */

export const COST_DATA_UNAVAILABLE = 'COST_DATA_UNAVAILABLE';

export type CostSnapshotSource = 'GMX_API' | 'RPC_DATASTORE' | 'PAPER_MODEL';

export interface CostSnapshot {
  market: string;
  isLong: boolean;
  orderType: 'MarketIncrease' | 'MarketDecrease';
  notionalUsd: number;
  positionFeeUsd: number;
  executionFeeUsd: number;
  /** 부호 있는 추정 impact — 양수 = 불리(비용), 음수 = 유리(rebate) */
  estimatedPriceImpactUsd: number;
  fundingFeeUsd: number;
  borrowingFeeUsd: number;
  estimatedExitFeeUsd: number;
  totalEstimatedRoundTripCostUsd: number;
  source: CostSnapshotSource;
  blockNumber: number | null;
  apiTimestamp: string | null;
  fetchedAt: string;
  expiresAt: string;
}

export interface CostSnapshotExpectation {
  market: string;
  isLong: boolean;
  orderType: 'MarketIncrease' | 'MarketDecrease';
  notionalUsd: number;
}

export type CostValidation =
  | { ok: true; effectiveRoundTripCostUsd: number; roundTripFraction: number }
  | { ok: false; reason: string };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v: unknown): v is number => fin(v) && v >= 0;

/** positive impact가 상쇄할 수 있는 최대 비율 (다른 비용 합계 대비) */
export const MAX_POSITIVE_IMPACT_OFFSET_FRACTION = 0.2;

/** 스냅샷 유효기간 기본값 (ms) */
export const COST_SNAPSHOT_TTL_MS = 60_000;

/** 오류 메시지 새니타이즈 — URL/토큰 패턴 제거 (§13.14) */
export function sanitizeCostError(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"']+/gi, '[URL]')
    .replace(/(api[-_]?key|token|secret|authorization)[=:]\s*[^\s&"']+/gi, '$1=[REDACTED]');
}

export function validateCostSnapshot(
  snap: CostSnapshot | null | undefined,
  expected: CostSnapshotExpectation,
  nowMs: number,
): CostValidation {
  if (!snap) return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: 비용 스냅샷 없음` };

  // 결속: market / direction / orderType
  if (snap.market.toLowerCase() !== expected.market.toLowerCase()) {
    return { ok: false, reason: '다른 market의 quote 재사용 금지' };
  }
  if (snap.isLong !== expected.isLong) return { ok: false, reason: '다른 direction의 quote 재사용 금지' };
  if (snap.orderType !== expected.orderType) return { ok: false, reason: '다른 orderType의 quote 재사용 금지' };

  // notional 결속 — 상위 주문금액에 하위 quote 재사용 금지 (1% 허용오차)
  if (!fin(snap.notionalUsd) || snap.notionalUsd <= 0) return { ok: false, reason: 'snapshot notional 비정상' };
  if (expected.notionalUsd > snap.notionalUsd * 1.01) {
    return { ok: false, reason: `상위 주문금액($${expected.notionalUsd.toFixed(2)})에 하위 quote($${snap.notionalUsd.toFixed(2)}) 재사용 금지` };
  }

  // 수치 유효성 — 음수/NaN 거부 (impact만 부호 허용)
  for (const [k, v] of Object.entries({
    positionFeeUsd: snap.positionFeeUsd, executionFeeUsd: snap.executionFeeUsd,
    fundingFeeUsd: snap.fundingFeeUsd, borrowingFeeUsd: snap.borrowingFeeUsd,
    estimatedExitFeeUsd: snap.estimatedExitFeeUsd,
  })) {
    if (!nonNeg(v)) return { ok: false, reason: `${k} 음수/NaN — 거부` };
  }
  if (!fin(snap.estimatedPriceImpactUsd)) return { ok: false, reason: 'estimatedPriceImpactUsd NaN — 거부' };
  if (!fin(snap.totalEstimatedRoundTripCostUsd)) return { ok: false, reason: 'total NaN — 거부' };

  // staleness
  const fetched = Date.parse(snap.fetchedAt);
  const expires = Date.parse(snap.expiresAt);
  if (!Number.isFinite(fetched) || !Number.isFinite(expires)) return { ok: false, reason: '스냅샷 시각 파싱 불가' };
  if (fetched > nowMs + 5_000) return { ok: false, reason: '스냅샷 fetchedAt이 미래 — 거부' };
  if (nowMs > expires) return { ok: false, reason: `stale snapshot (expiresAt=${snap.expiresAt}) — 거부` };

  // positive impact 상쇄 제한
  const otherCosts = snap.positionFeeUsd + snap.executionFeeUsd + snap.fundingFeeUsd
    + snap.borrowingFeeUsd + snap.estimatedExitFeeUsd;
  const impactCost = Math.max(
    snap.estimatedPriceImpactUsd,
    -(otherCosts * MAX_POSITIVE_IMPACT_OFFSET_FRACTION),
  );
  const effective = otherCosts + impactCost;
  if (!fin(effective) || effective < 0) return { ok: false, reason: '유효 비용 비정상 — 거부' };

  return { ok: true, effectiveRoundTripCostUsd: effective, roundTripFraction: effective / snap.notionalUsd };
}

// ── PAPER 비용 모델 (명시적 — fallback이 아니라 PAPER 시뮬레이션 정의) ──────────
/**
 * PAPER 시뮬레이션 비용 모델. LIVE 경로에는 절대 사용 금지 —
 * enforceOrderSizing이 source='PAPER_MODEL'을 LIVE에서 거부한다.
 * 값 근거: GMX V2 position fee 0.06%/side, 실행비 고정 $0.20/side,
 * 불리 impact 버퍼 0.05%, funding/borrowing 버퍼 0.05%.
 */
export const PAPER_COST_MODEL = {
  positionFeeFractionPerSide: 0.0006,
  executionFeeUsdPerSide: 0.2,
  adverseImpactFraction: 0.0005,
  fundingBorrowingFraction: 0.0005,
} as const;

export function buildPaperCostSnapshot(args: {
  market: string; isLong: boolean; orderType: 'MarketIncrease' | 'MarketDecrease';
  notionalUsd: number; now: Date;
}): CostSnapshot {
  const m = PAPER_COST_MODEL;
  const n = args.notionalUsd;
  const positionFeeUsd = n * m.positionFeeFractionPerSide;
  const estimatedExitFeeUsd = n * m.positionFeeFractionPerSide;
  const executionFeeUsd = m.executionFeeUsdPerSide * 2;
  const estimatedPriceImpactUsd = n * m.adverseImpactFraction;
  const fundingFeeUsd = n * m.fundingBorrowingFraction / 2;
  const borrowingFeeUsd = n * m.fundingBorrowingFraction / 2;
  return {
    market: args.market, isLong: args.isLong, orderType: args.orderType, notionalUsd: n,
    positionFeeUsd, executionFeeUsd, estimatedPriceImpactUsd, fundingFeeUsd, borrowingFeeUsd,
    estimatedExitFeeUsd,
    totalEstimatedRoundTripCostUsd:
      positionFeeUsd + executionFeeUsd + estimatedPriceImpactUsd + fundingFeeUsd + borrowingFeeUsd + estimatedExitFeeUsd,
    source: 'PAPER_MODEL', blockNumber: null, apiTimestamp: null,
    fetchedAt: args.now.toISOString(),
    expiresAt: new Date(args.now.getTime() + COST_SNAPSHOT_TTL_MS).toISOString(),
  };
}

// ── LIVE 비용 스냅샷 조회 (주입식 — 이번 단계 실제 네트워크 호출 금지) ──────────

export interface LiveCostFetchers {
  /** readonly 플래그 상태 — false면 조회 없이 COST_DATA_UNAVAILABLE */
  readonlyEnabled: boolean;
  /** 비용 필드 조회 (mock/fixture 주입) — 하나라도 실패/결측이면 전체 실패 */
  fetchCosts?: (args: { market: string; isLong: boolean; notionalUsd: number }) => Promise<{
    positionFeeUsd: number; executionFeeUsd: number; estimatedPriceImpactUsd: number;
    fundingFeeUsd: number; borrowingFeeUsd: number; estimatedExitFeeUsd: number;
    blockNumber: number | null; apiTimestamp: string | null;
  }>;
}

export async function fetchLiveCostSnapshot(
  args: { market: string; isLong: boolean; orderType: 'MarketIncrease' | 'MarketDecrease'; notionalUsd: number; now: Date },
  fetchers: LiveCostFetchers,
): Promise<{ ok: true; snapshot: CostSnapshot } | { ok: false; reason: string }> {
  if (!fetchers.readonlyEnabled) {
    return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: readonly 네트워크 플래그 비활성 — 비용 조회 불가 (가짜 성공 금지)` };
  }
  if (!fetchers.fetchCosts) {
    return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: 비용 조회 경로 미구성` };
  }
  try {
    const c = await fetchers.fetchCosts({ market: args.market, isLong: args.isLong, notionalUsd: args.notionalUsd });
    const snap: CostSnapshot = {
      market: args.market, isLong: args.isLong, orderType: args.orderType, notionalUsd: args.notionalUsd,
      positionFeeUsd: c.positionFeeUsd, executionFeeUsd: c.executionFeeUsd,
      estimatedPriceImpactUsd: c.estimatedPriceImpactUsd,
      fundingFeeUsd: c.fundingFeeUsd, borrowingFeeUsd: c.borrowingFeeUsd,
      estimatedExitFeeUsd: c.estimatedExitFeeUsd, source: 'GMX_API',
      blockNumber: c.blockNumber, apiTimestamp: c.apiTimestamp,
      totalEstimatedRoundTripCostUsd:
        c.positionFeeUsd + c.executionFeeUsd + c.estimatedPriceImpactUsd
        + c.fundingFeeUsd + c.borrowingFeeUsd + c.estimatedExitFeeUsd,
      fetchedAt: args.now.toISOString(),
      expiresAt: new Date(args.now.getTime() + COST_SNAPSHOT_TTL_MS).toISOString(),
    };
    const valid = validateCostSnapshot(snap, args, args.now.getTime());
    if (!valid.ok) return { ok: false, reason: sanitizeCostError(valid.reason) };
    return { ok: true, snapshot: snap };
  } catch (err) {
    return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: ${sanitizeCostError((err as Error).message)}` };
  }
}
