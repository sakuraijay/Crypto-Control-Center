/**
 * holdingCosts — PAPER 보유시간 funding/borrowing 비용 누적 (6H-2A §4).
 *
 * 원칙:
 *  - 무조건 0/임의 고정값 금지 — 공식 rate × 실제 경과시간으로 누적
 *  - rate가 갱신되면 구간별 누적 (segments)
 *  - 데이터 공백 구간 → UNAVAILABLE (비용을 0으로 만들지 않음)
 *  - 보수적 방향: 비용은 센트 단위 올림 (이익 축소 방향), 절대 내림 금지
 *  - 보유시간이 길수록 누적비용은 단조 증가
 */

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const HOLDING_COST_UNAVAILABLE = 'HOLDING_COST_UNAVAILABLE';

export interface RateSegment {
  fromMs: number;
  toMs: number;
  /** 시간당 funding rate (notional 대비 비율). null = 해당 구간 데이터 누락 */
  fundingRatePerHourFraction: number | null;
  /** 시간당 borrowing rate. null = 누락 */
  borrowingRatePerHourFraction: number | null;
}

export type HoldingCostResult =
  | { ok: true; fundingUsd: number; borrowingUsd: number; totalUsd: number; coveredMs: number }
  | { ok: false; reason: string };

/** 센트 단위 올림 — 비용을 작게 만들지 않는 보수적 방향 */
const ceilCents = (v: number): number => Math.ceil(v * 100 - 1e-9) / 100;

/**
 * 구간별 rate로 보유시간 비용 누적.
 * openedAtMs~closedAtMs 전체가 세그먼트로 빈틈없이 덮여야 한다 —
 * 공백/누락 rate 구간이 있으면 UNAVAILABLE (0 대체 금지).
 */
export function accrueHoldingCosts(args: {
  notionalUsd: number;
  openedAtMs: number;
  closedAtMs: number;
  segments: RateSegment[];
}): HoldingCostResult {
  const { notionalUsd, openedAtMs, closedAtMs } = args;
  if (!fin(notionalUsd) || notionalUsd <= 0) return { ok: false, reason: `${HOLDING_COST_UNAVAILABLE}: notional 비정상` };
  if (!fin(openedAtMs) || !fin(closedAtMs) || closedAtMs < openedAtMs) {
    return { ok: false, reason: `${HOLDING_COST_UNAVAILABLE}: 보유시간 비정상 (open=${openedAtMs}, close=${closedAtMs})` };
  }
  if (closedAtMs === openedAtMs) return { ok: true, fundingUsd: 0, borrowingUsd: 0, totalUsd: 0, coveredMs: 0 };

  // 세그먼트 정렬 후 커버리지 검사 — 공백 구간이 있으면 UNAVAILABLE
  const segs = [...args.segments].sort((a, b) => a.fromMs - b.fromMs);
  let cursor = openedAtMs;
  let fundingUsd = 0;
  let borrowingUsd = 0;
  for (const s of segs) {
    if (s.toMs <= cursor) continue;               // 이미 지나간 구간
    if (s.fromMs > cursor) {
      return { ok: false, reason: `${HOLDING_COST_UNAVAILABLE}: rate 데이터 공백 구간 (${new Date(cursor).toISOString()}~) — 0 대체 금지` };
    }
    const from = Math.max(s.fromMs, cursor);
    const to = Math.min(s.toMs, closedAtMs);
    if (to <= from) continue;
    if (s.fundingRatePerHourFraction === null || s.borrowingRatePerHourFraction === null) {
      return { ok: false, reason: `${HOLDING_COST_UNAVAILABLE}: 구간 rate 누락 (${new Date(from).toISOString()}) — 0으로 추정 금지` };
    }
    if (!fin(s.fundingRatePerHourFraction) || s.fundingRatePerHourFraction < 0
      || !fin(s.borrowingRatePerHourFraction) || s.borrowingRatePerHourFraction < 0) {
      return { ok: false, reason: `${HOLDING_COST_UNAVAILABLE}: rate 음수/NaN — 거부` };
    }
    const hours = (to - from) / 3_600_000;
    fundingUsd += notionalUsd * s.fundingRatePerHourFraction * hours;
    borrowingUsd += notionalUsd * s.borrowingRatePerHourFraction * hours;
    cursor = to;
    if (cursor >= closedAtMs) break;
  }
  if (cursor < closedAtMs) {
    return { ok: false, reason: `${HOLDING_COST_UNAVAILABLE}: rate 데이터가 청산 시각까지 덮지 않음 (${new Date(cursor).toISOString()}~) — 0 대체 금지` };
  }
  const f = ceilCents(fundingUsd);
  const b = ceilCents(borrowingUsd);
  return { ok: true, fundingUsd: f, borrowingUsd: b, totalUsd: f + b, coveredMs: closedAtMs - openedAtMs };
}

/**
 * 단일 진입 스냅샷 rate 기반 누적 — rate 갱신 데이터가 없을 때의 최소 경로.
 * 진입 시점 rate가 null이면 UNAVAILABLE (0 대체 금지).
 */
export function accrueHoldingCostsFromEntryRates(args: {
  notionalUsd: number;
  openedAtMs: number;
  closedAtMs: number;
  fundingRatePerHourFraction: number | null;
  borrowingRatePerHourFraction: number | null;
}): HoldingCostResult {
  return accrueHoldingCosts({
    notionalUsd: args.notionalUsd,
    openedAtMs: args.openedAtMs,
    closedAtMs: args.closedAtMs,
    segments: [{
      fromMs: args.openedAtMs, toMs: args.closedAtMs,
      fundingRatePerHourFraction: args.fundingRatePerHourFraction,
      borrowingRatePerHourFraction: args.borrowingRatePerHourFraction,
    }],
  });
}

// ── PAPER 순 PnL (ESTIMATED — SETTLED 아님) ──────────────────────────────────

export type PaperNetPnlResult =
  | { ok: true; netPnlUsd: number; kind: 'ESTIMATED' }
  | { ok: false; reason: string };

/**
 * paperNetPnl = simulatedGrossPnl − 진입비용 − 청산비용 − 보유 funding − 보유 borrowing.
 * 결과는 항상 ESTIMATED — 실제 정산(SETTLED)처럼 표시 금지.
 */
export function computePaperNetPnl(args: {
  simulatedGrossPnlUsd: number;
  estimatedEntryCostsUsd: number;
  estimatedExitCostsUsd: number;
  elapsedHoldingFundingUsd: number;
  elapsedHoldingBorrowingUsd: number;
}): PaperNetPnlResult {
  const costs = {
    estimatedEntryCostsUsd: args.estimatedEntryCostsUsd,
    estimatedExitCostsUsd: args.estimatedExitCostsUsd,
    elapsedHoldingFundingUsd: args.elapsedHoldingFundingUsd,
    elapsedHoldingBorrowingUsd: args.elapsedHoldingBorrowingUsd,
  };
  for (const [k, v] of Object.entries(costs)) {
    if (!fin(v) || v < 0) return { ok: false, reason: `${k} 음수/NaN — 순 PnL 산정 거부` };
  }
  if (!fin(args.simulatedGrossPnlUsd)) return { ok: false, reason: 'gross PnL NaN — 거부' };
  const net = args.simulatedGrossPnlUsd
    - args.estimatedEntryCostsUsd - args.estimatedExitCostsUsd
    - args.elapsedHoldingFundingUsd - args.elapsedHoldingBorrowingUsd;
  if (!fin(net)) return { ok: false, reason: '순 PnL 계산 불가 — 거부' };
  return { ok: true, netPnlUsd: net, kind: 'ESTIMATED' };
}
