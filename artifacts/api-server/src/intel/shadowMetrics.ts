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
  rank: number | null;
  calibratedProbability: number | null;   // 결정 당시 보정 확률 (대부분 null)
  expectedRMultiple: number | null;
  outcome1hNetUsd: number | null;
  outcome4hNetUsd: number | null;
  hypotheticalGrossPnlUsd: number | null;
  hypotheticalTotalCostUsd: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  complete: boolean;
  outcomeStatus4h: string | null;         // COMPLETE|INCOMPLETE|AMBIGUOUS_INTRABAR|DATA_UNAVAILABLE|null(legacy)
  firstTouch: string | null;
}

/** 6I-2 §8 — NO_TRADE counterfactual 분류 */
export type CounterfactualLabel =
  | 'CORRECT_REJECTION' | 'MISSED_OPPORTUNITY' | 'RISK_AVOIDED' | 'COST_AVOIDED'
  | 'DATA_UNAVAILABLE' | 'AMBIGUOUS' | 'INCOMPLETE';

/**
 * 비선택 상위 후보의 가상 결과 분류 — "안 한 것이 옳았나"를 정직하게 기록.
 * 순서: 데이터 없음 → 모호 → 미완 → stop 터치(위험 회피) → net>0(기회 상실)
 *      → gross>0이나 비용 잠식(비용 회피) → 그 외 net≤0(올바른 거부).
 */
export function classifyCounterfactual(row: ShadowOutcomeRow): CounterfactualLabel {
  if (row.outcomeStatus4h === 'DATA_UNAVAILABLE') return 'DATA_UNAVAILABLE';
  if (row.outcomeStatus4h === 'AMBIGUOUS_INTRABAR' || row.firstTouch === 'AMBIGUOUS_INTRABAR') return 'AMBIGUOUS';
  if (!row.complete) return 'INCOMPLETE';
  if (row.firstTouch === 'STOP') return 'RISK_AVOIDED';
  if (row.outcome4hNetUsd !== null && row.outcome4hNetUsd > 0) return 'MISSED_OPPORTUNITY';
  if (row.outcome4hNetUsd === null) {
    // net 미상(비용 미상) — gross만으로 이익 단정 금지
    return row.hypotheticalGrossPnlUsd !== null && row.hypotheticalGrossPnlUsd > 0 ? 'INCOMPLETE' : 'CORRECT_REJECTION';
  }
  if (row.hypotheticalGrossPnlUsd !== null && row.hypotheticalGrossPnlUsd > 0 && row.outcome4hNetUsd <= 0) return 'COST_AVOIDED';
  return 'CORRECT_REJECTION';
}

export interface CounterfactualSummary {
  evaluated: number;
  byLabel: Record<CounterfactualLabel, number>;
}

/** 비선택 rank=1 후보(NO_TRADE 사이클의 top rejected)만 대상으로 counterfactual 집계 */
export function summarizeCounterfactuals(rows: ShadowOutcomeRow[]): CounterfactualSummary {
  const byLabel: Record<CounterfactualLabel, number> = {
    CORRECT_REJECTION: 0, MISSED_OPPORTUNITY: 0, RISK_AVOIDED: 0, COST_AVOIDED: 0,
    DATA_UNAVAILABLE: 0, AMBIGUOUS: 0, INCOMPLETE: 0,
  };
  const targets = rows.filter(r => !r.selected && r.rank === 1);
  for (const r of targets) byLabel[classifyCounterfactual(r)]++;
  return { evaluated: targets.length, byLabel };
}

/** 6I-2 §10 — 표본 성숙도 정책 (자동 승격·자율 LIVE 구조적 금지) */
export const RESEARCH_PREVIEW_MIN = 30;
export const MANUAL_REVIEW_MIN = 100;

export interface ShadowMaturity {
  sampleCount4h: number;                  // 4h COMPLETE만 (1h 혼합 금지)
  ambiguousCount: number;
  directionCounts: { LONG: number; SHORT: number };
  regimeCounts: Record<string, number>;
  researchPreviewEligible: boolean;       // ≥30 — 연구용 미리보기만
  manualReviewSampleEligible: boolean;    // ≥100 — 수동 검토 최소선
  calibrationEligible: boolean;           // ≥100 + 방향·regime 편중 아님
  autoPromotionAllowed: false;
  autonomousLiveEligible: false;
  blockedReasons: string[];
}

export function computeShadowMaturity(rows: ShadowOutcomeRow[]): ShadowMaturity {
  // 4h COMPLETE 표본만 — AMBIGUOUS/INCOMPLETE/1h-only는 세지 않음
  const complete4h = rows.filter(r => r.complete && (r.outcomeStatus4h === null || r.outcomeStatus4h === 'COMPLETE'));
  const ambiguousCount = rows.filter(r => r.outcomeStatus4h === 'AMBIGUOUS_INTRABAR').length;
  const dirCounts = { LONG: complete4h.filter(r => r.direction === 'LONG').length, SHORT: complete4h.filter(r => r.direction === 'SHORT').length };
  const regimeCounts: Record<string, number> = {};
  for (const r of complete4h) regimeCounts[r.regime] = (regimeCounts[r.regime] ?? 0) + 1;

  const n = complete4h.length;
  const blockedReasons: string[] = [];
  if (n < RESEARCH_PREVIEW_MIN) blockedReasons.push(`표본 부족: ${n} < ${RESEARCH_PREVIEW_MIN} (research preview 최소)`);
  if (n < MANUAL_REVIEW_MIN) blockedReasons.push(`표본 부족: ${n} < ${MANUAL_REVIEW_MIN} (수동 검토 최소)`);
  // 방향 편중: 한 방향이 85% 초과 시 보정 검토 불가
  const dirSkewed = n > 0 && Math.max(dirCounts.LONG, dirCounts.SHORT) / n > 0.85;
  if (dirSkewed) blockedReasons.push('방향 편중 — 한 방향이 85% 초과 (보정 검토 불가)');
  // regime 편중: 단일 regime이 90% 초과
  const regimeSkewed = n > 0 && Math.max(0, ...Object.values(regimeCounts)) / n > 0.9;
  if (regimeSkewed) blockedReasons.push('regime 편중 — 단일 regime 90% 초과 (보정 검토 불가)');
  blockedReasons.push('자동 승격·자율 LIVE는 정책상 항상 차단 (수동 검토 전용)');

  return {
    sampleCount4h: n,
    ambiguousCount,
    directionCounts: dirCounts,
    regimeCounts,
    researchPreviewEligible: n >= RESEARCH_PREVIEW_MIN,
    manualReviewSampleEligible: n >= MANUAL_REVIEW_MIN,
    calibrationEligible: n >= MANUAL_REVIEW_MIN && !dirSkewed && !regimeSkewed,
    autoPromotionAllowed: false,
    autonomousLiveEligible: false,
    blockedReasons,
  };
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
