/**
 * 6I-1 §13 — Learning & Review 지표 (자동학습/자동승격 금지).
 *  - 표본 부족 = INSUFFICIENT_SAMPLE (0/정상 위장 금지)
 *  - Brier score는 실제 calibrated probability가 있을 때만
 *  - isAutoPromotionAllowed()는 항상 false (riskPolicy.ts) — 이 모듈은 승격하지 않음
 */

export const INSUFFICIENT_SAMPLE = 'INSUFFICIENT_SAMPLE' as const;
export const MIN_METRIC_SAMPLES = 30;

export interface ShadowOutcomeRow {
  candidateId: string;
  direction: 'LONG' | 'SHORT';
  regime: string;
  decision: string;                       // ELIGIBLE/SHADOW_ONLY/REJECTED/DATA_UNAVAILABLE
  selected: boolean;
  calibratedProbability: number | null;   // 결정 당시 보정 확률 (대부분 null)
  expectedRMultiple: number | null;
  outcome1hNetUsd: number | null;
  outcome4hNetUsd: number | null;
  hypotheticalGrossPnlUsd: number | null;
  hypotheticalTotalCostUsd: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  complete: boolean;
}

export interface ShadowMetricsSufficient {
  status: 'OK';
  sampleCount: number;
  candidateCount: number;
  noTradeRatio: number | null;
  dataUnavailableRatio: number;
  costRejectedRatio: number;
  byDirection: Record<'LONG' | 'SHORT', { count: number; netExpectancy1h: number | null; netExpectancy4h: number | null }>;
  byRegime: Record<string, { count: number; netExpectancy4h: number | null }>;
  netExpectancy1hUsd: number | null;
  netExpectancy4hUsd: number | null;
  avgMaxFavorableExcursionPct: number | null;
  avgMaxAdverseExcursionPct: number | null;
  profitFactor4h: number | null;
  /** Brier — calibrated probability 있는 표본만. 없으면 null */
  brierScore: number | null;
  brierSampleCount: number;
  costErosionRatio: number | null;       // 비용이 gross PnL을 잠식한 비율 평균
  goodTradeRejectionRate: number | null; // 거부했지만 4h net > 0였던 비율
  badTradeApprovalRate: number | null;   // 선택했지만 4h net < 0였던 비율
  autoPromotionAllowed: false;
}

export interface ShadowMetricsInsufficient {
  status: typeof INSUFFICIENT_SAMPLE;
  sampleCount: number;
  required: number;
  autoPromotionAllowed: false;
}

export type ShadowMetrics = ShadowMetricsSufficient | ShadowMetricsInsufficient;

const avg = (xs: number[]): number | null => xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;

export function computeShadowMetrics(rows: ShadowOutcomeRow[], opts?: { cycleCount?: number; noTradeCycles?: number }): ShadowMetrics {
  const complete = rows.filter(r => r.complete);
  if (complete.length < MIN_METRIC_SAMPLES) {
    return { status: INSUFFICIENT_SAMPLE, sampleCount: complete.length, required: MIN_METRIC_SAMPLES, autoPromotionAllowed: false };
  }
  const n1h = complete.map(r => r.outcome1hNetUsd).filter((v): v is number => v !== null);
  const n4h = complete.map(r => r.outcome4hNetUsd).filter((v): v is number => v !== null);
  const dir = (d: 'LONG' | 'SHORT') => {
    const g = complete.filter(r => r.direction === d);
    return {
      count: g.length,
      netExpectancy1h: avg(g.map(r => r.outcome1hNetUsd).filter((v): v is number => v !== null)),
      netExpectancy4h: avg(g.map(r => r.outcome4hNetUsd).filter((v): v is number => v !== null)),
    };
  };
  const byRegime: Record<string, { count: number; netExpectancy4h: number | null }> = {};
  for (const r of complete) {
    byRegime[r.regime] ??= { count: 0, netExpectancy4h: null };
    byRegime[r.regime].count++;
  }
  for (const k of Object.keys(byRegime)) {
    byRegime[k].netExpectancy4h = avg(complete.filter(r => r.regime === k).map(r => r.outcome4hNetUsd).filter((v): v is number => v !== null));
  }
  const wins = n4h.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const losses = Math.abs(n4h.filter(v => v < 0).reduce((s, v) => s + v, 0));
  // Brier — 결과가 이긴 방향(net>0)을 1로 보는 단순화; calibrated 표본만
  const brierRows = complete.filter(r => r.calibratedProbability !== null && r.outcome4hNetUsd !== null);
  const brier = brierRows.length === 0 ? null
    : avg(brierRows.map(r => {
      const outcome = (r.outcome4hNetUsd as number) > 0 ? 1 : 0;
      return ((r.calibratedProbability as number) - outcome) ** 2;
    }));
  const erosion = complete
    .filter(r => r.hypotheticalGrossPnlUsd !== null && r.hypotheticalTotalCostUsd !== null && (r.hypotheticalGrossPnlUsd as number) > 0)
    .map(r => Math.min(1, (r.hypotheticalTotalCostUsd as number) / (r.hypotheticalGrossPnlUsd as number)));
  const rejected = complete.filter(r => !r.selected && (r.decision === 'REJECTED' || r.decision === 'SHADOW_ONLY') && r.outcome4hNetUsd !== null);
  const approved = complete.filter(r => r.selected && r.outcome4hNetUsd !== null);
  return {
    status: 'OK',
    sampleCount: complete.length,
    candidateCount: rows.length,
    noTradeRatio: opts?.cycleCount && opts.cycleCount > 0 && opts.noTradeCycles !== undefined
      ? opts.noTradeCycles / opts.cycleCount : null,
    dataUnavailableRatio: rows.filter(r => r.decision === 'DATA_UNAVAILABLE').length / rows.length,
    costRejectedRatio: rows.filter(r => r.decision === 'REJECTED' && !r.selected).length / rows.length,
    byDirection: { LONG: dir('LONG'), SHORT: dir('SHORT') },
    byRegime,
    netExpectancy1hUsd: avg(n1h),
    netExpectancy4hUsd: avg(n4h),
    avgMaxFavorableExcursionPct: avg(complete.map(r => r.maxFavorableExcursionPct).filter((v): v is number => v !== null)),
    avgMaxAdverseExcursionPct: avg(complete.map(r => r.maxAdverseExcursionPct).filter((v): v is number => v !== null)),
    profitFactor4h: losses > 0 ? wins / losses : null,
    brierScore: brier,
    brierSampleCount: brierRows.length,
    costErosionRatio: avg(erosion),
    goodTradeRejectionRate: rejected.length > 0 ? rejected.filter(r => (r.outcome4hNetUsd as number) > 0).length / rejected.length : null,
    badTradeApprovalRate: approved.length > 0 ? approved.filter(r => (r.outcome4hNetUsd as number) < 0).length / approved.length : null,
    autoPromotionAllowed: false,
  };
}
