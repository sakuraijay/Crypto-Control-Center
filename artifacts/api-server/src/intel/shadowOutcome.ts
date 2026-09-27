/**
 * 6I-1 §12 + 6I-2 §7 — Shadow outcome 계산 (순수 모듈, lookahead 방지).
 *  - 결정 시각(decidedAtMs) 이후 "폐쇄된" 캔들만 사용 — 미래/진행 중 데이터 차단
 *  - horizon 미경과/데이터 미확보 = incomplete (0 기록 금지)
 *  - 같은 캔들에서 stop과 target 모두 터치 = AMBIGUOUS_INTRABAR (임의 선택 금지;
 *    참고용 exit은 보수적으로 stop이되 상태는 명시적으로 ambiguous)
 */
import { Candle } from './types';

export type ShadowOutcomeStatus = 'COMPLETE' | 'INCOMPLETE' | 'AMBIGUOUS_INTRABAR' | 'DATA_UNAVAILABLE';
export type FirstTouch = 'STOP' | 'TARGET' | 'NONE' | 'AMBIGUOUS_INTRABAR';

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
  /** 캔들 간격(ms) — 폐쇄 캔들 판정용. 기본 15m */
  candleIntervalMs?: number;
  nowMs: number;
}

export interface ShadowOutcomeResult {
  complete: boolean;
  status: ShadowOutcomeStatus;
  incompleteReason: string | null;
  hypotheticalGrossPnlUsd: number | null;
  hypotheticalTotalCostUsd: number | null;
  hypotheticalNetPnlUsd: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  firstTouch: FirstTouch | null;
  exitPrice: number | null;
  measuredAtMs: number;
  /** horizon 종료 시각 (결정+horizon) */
  horizonEndMs: number;
  /** 사용된 폐쇄 캔들의 horizon 커버 비율 (0..1) */
  dataCoverage: number | null;
  /** 사용된 폐쇄 캔들 open time 범위 (증거) */
  sourceCandleFromMs: number | null;
  sourceCandleToMs: number | null;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function computeShadowOutcome(input: ShadowOutcomeInput): ShadowOutcomeResult {
  const horizonEnd = input.decidedAtMs + input.horizonMs;
  const incomplete = (reason: string, status: ShadowOutcomeStatus = 'INCOMPLETE'): ShadowOutcomeResult => ({
    complete: false, status, incompleteReason: reason,
    hypotheticalGrossPnlUsd: null, hypotheticalTotalCostUsd: null, hypotheticalNetPnlUsd: null,
    maxFavorableExcursionPct: null, maxAdverseExcursionPct: null,
    firstTouch: null, exitPrice: null, measuredAtMs: input.nowMs,
    horizonEndMs: horizonEnd, dataCoverage: null, sourceCandleFromMs: null, sourceCandleToMs: null,
  });

  if (!fin(input.entryPrice) || input.entryPrice <= 0) return incomplete('entry price 비정상', 'DATA_UNAVAILABLE');
  if (!fin(input.notionalUsd) || input.notionalUsd <= 0) return incomplete('notional 비정상', 'DATA_UNAVAILABLE');
  if (input.nowMs < horizonEnd) return incomplete('horizon 미경과 — enrichment는 경과 후 별도 실행');

  // lookahead 방지 — 결정 시각 이전/동시 캔들 금지 + "폐쇄된" 캔들만 사용.
  // 캔들 t는 open time이므로 close time(t+interval)이 horizonEnd와 nowMs를 모두
  // 넘지 않아야 한다 — horizon 경계에 걸친/진행 중 캔들의 high/low 주입 차단.
  const interval = input.candleIntervalMs ?? 900_000;
  const closedBy = Math.min(horizonEnd, input.nowMs);
  const after = input.candlesAfter.filter(c => c.t > input.decidedAtMs && c.t + interval <= closedBy);
  if (after.length === 0) return incomplete('미래 데이터 미확보 — 0 기록 금지 (incomplete)');
  // 시리즈가 horizon을 실제로 커버하는지 — 마지막 폐쇄 캔들의 close time 기준
  const lastClose = after[after.length - 1].t + interval;
  const coverage = Math.max(0, Math.min(1, (lastClose - input.decidedAtMs) / input.horizonMs));
  if (horizonEnd - lastClose > input.horizonMs * 0.25) {
    return incomplete('horizon 커버리지 부족 — incomplete');
  }

  const dir = input.direction === 'LONG' ? 1 : -1;
  let firstTouch: FirstTouch = 'NONE';
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
      if (hitStop && hitTarget) {
        // 같은 캔들에서 둘 다 터치 — 순서를 알 수 없다. 임의로 유리한 쪽 선택 금지.
        // 참고 exit은 보수적으로 stop이되, 상태는 명시적으로 AMBIGUOUS_INTRABAR.
        firstTouch = 'AMBIGUOUS_INTRABAR'; exitPrice = input.stopPrice;
      }
      else if (hitStop) { firstTouch = 'STOP'; exitPrice = input.stopPrice; }
      else if (hitTarget) { firstTouch = 'TARGET'; exitPrice = input.takeProfitPrice; }
    }
  }
  if (exitPrice === null) exitPrice = after[after.length - 1].c;

  const gross = dir * ((exitPrice - input.entryPrice) / input.entryPrice) * input.notionalUsd;
  const cost = input.totalCostUsd;
  const ambiguous = firstTouch === 'AMBIGUOUS_INTRABAR';
  return {
    complete: !ambiguous,             // ambiguous는 보정 표본으로 세지 않음
    status: ambiguous ? 'AMBIGUOUS_INTRABAR' : 'COMPLETE',
    incompleteReason: ambiguous ? '같은 캔들에서 stop·target 모두 터치 — 순서 판정 불가' : null,
    hypotheticalGrossPnlUsd: gross,
    hypotheticalTotalCostUsd: cost,
    hypotheticalNetPnlUsd: cost === null ? null : gross - cost,  // 비용 미상이면 net도 미상 (0 대체 금지)
    maxFavorableExcursionPct: maxFav * 100,
    maxAdverseExcursionPct: maxAdv * 100,
    firstTouch, exitPrice, measuredAtMs: input.nowMs,
    horizonEndMs: horizonEnd,
    dataCoverage: coverage,
    sourceCandleFromMs: after[0].t,
    sourceCandleToMs: after[after.length - 1].t,
  };
}
