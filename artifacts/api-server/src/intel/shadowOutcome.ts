/**
 * 6I-1 §12 — Shadow outcome 계산 (순수 모듈, lookahead 방지).
 *  - 결정 시각(decidedAtMs) 이후의 캔들만 사용 — 미래 데이터가 판단 입력에 섞이지 않음
 *  - horizon 미경과/미래 데이터 미확보 = incomplete (0 기록 금지)
 *  - stop/target first-touch 판정 포함
 */
import { Candle } from './types';

export interface ShadowOutcomeInput {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  notionalUsd: number;
  totalCostUsd: number | null;      // 결정 당시 비용 breakdown 합 (null=미상)
  decidedAtMs: number;
  horizonMs: number;                // 1h=3.6e6, 4h=1.44e7
  /** decidedAt 이후 캔들 (검증된 시리즈) — 부족하면 incomplete */
  candlesAfter: Candle[];
  nowMs: number;
}

export interface ShadowOutcomeResult {
  complete: boolean;
  incompleteReason: string | null;
  hypotheticalGrossPnlUsd: number | null;
  hypotheticalTotalCostUsd: number | null;
  hypotheticalNetPnlUsd: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  firstTouch: 'STOP' | 'TARGET' | 'NONE' | null;
  exitPrice: number | null;
  measuredAtMs: number;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function computeShadowOutcome(input: ShadowOutcomeInput): ShadowOutcomeResult {
  const incomplete = (reason: string): ShadowOutcomeResult => ({
    complete: false, incompleteReason: reason,
    hypotheticalGrossPnlUsd: null, hypotheticalTotalCostUsd: null, hypotheticalNetPnlUsd: null,
    maxFavorableExcursionPct: null, maxAdverseExcursionPct: null,
    firstTouch: null, exitPrice: null, measuredAtMs: input.nowMs,
  });

  if (!fin(input.entryPrice) || input.entryPrice <= 0) return incomplete('entry price 비정상');
  if (!fin(input.notionalUsd) || input.notionalUsd <= 0) return incomplete('notional 비정상');
  const horizonEnd = input.decidedAtMs + input.horizonMs;
  if (input.nowMs < horizonEnd) return incomplete('horizon 미경과 — enrichment는 경과 후 별도 실행');

  // lookahead 방지 — 결정 시각 이전/동시 캔들 절대 사용 금지
  const after = input.candlesAfter.filter(c => c.t > input.decidedAtMs && c.t <= horizonEnd);
  if (after.length === 0) return incomplete('미래 데이터 미확보 — 0 기록 금지 (incomplete)');
  // 시리즈가 horizon을 실제로 커버하는지 — 마지막 캔들이 horizon 근처여야 함
  const lastT = after[after.length - 1].t;
  if (horizonEnd - lastT > input.horizonMs * 0.25) {
    return incomplete('horizon 커버리지 부족 — incomplete');
  }

  const dir = input.direction === 'LONG' ? 1 : -1;
  let firstTouch: 'STOP' | 'TARGET' | 'NONE' = 'NONE';
  let exitPrice: number | null = null;
  let maxFav = 0, maxAdv = 0;
  for (const c of after) {
    const fav = dir === 1 ? (c.h - input.entryPrice) / input.entryPrice : (input.entryPrice - c.l) / input.entryPrice;
    const adv = dir === 1 ? (input.entryPrice - c.l) / input.entryPrice : (c.h - input.entryPrice) / input.entryPrice;
    maxFav = Math.max(maxFav, fav);
    maxAdv = Math.max(maxAdv, adv);
    if (firstTouch === 'NONE') {
      const hitStop = input.stopPrice !== null && (dir === 1 ? c.l <= input.stopPrice : c.h >= input.stopPrice);
      const hitTarget = input.takeProfitPrice !== null && (dir === 1 ? c.h >= input.takeProfitPrice : c.l <= input.takeProfitPrice);
      // 같은 캔들에서 둘 다 닿으면 보수적으로 STOP 우선 (낙관 가정 금지)
      if (hitStop) { firstTouch = 'STOP'; exitPrice = input.stopPrice; }
      else if (hitTarget) { firstTouch = 'TARGET'; exitPrice = input.takeProfitPrice; }
    }
  }
  if (exitPrice === null) exitPrice = after[after.length - 1].c;

  const gross = dir * ((exitPrice - input.entryPrice) / input.entryPrice) * input.notionalUsd;
  const cost = input.totalCostUsd;
  return {
    complete: true, incompleteReason: null,
    hypotheticalGrossPnlUsd: gross,
    hypotheticalTotalCostUsd: cost,
    hypotheticalNetPnlUsd: cost === null ? null : gross - cost,  // 비용 미상이면 net도 미상 (0 대체 금지)
    maxFavorableExcursionPct: maxFav * 100,
    maxAdverseExcursionPct: maxAdv * 100,
    firstTouch, exitPrice, measuredAtMs: input.nowMs,
  };
}
