/**
 * 6I-1 §6·§7·§8 — Opportunity Candidate 모델과 확률·순기대값의 정직한 처리.
 *
 *  - rawSignalScore ≠ 확률. calibratedWinProbability는 실측 보정 표본이 충분할 때만.
 *  - 보정 확률 없으면 expectedNetValueUsd=null (가짜 50% 금지, 0 대체 금지).
 *  - 연구용 순위 점수는 uncalibratedRankingScore라는 별도 이름 — 예상 수익으로 표시 금지.
 *  - 비용은 전 항목 분리, 누락 비용 0 대체 금지 → DATA_UNAVAILABLE.
 */
import { MarketRegime, RegimeResult } from './regime';
import { DataQuality } from './types';

export type CandidateDirection = 'LONG' | 'SHORT';
export type CandidateDecision = 'ELIGIBLE' | 'SHADOW_ONLY' | 'REJECTED' | 'DATA_UNAVAILABLE';
export type ProbabilityCalibrationStatus = 'UNCALIBRATED' | 'CALIBRATING' | 'CALIBRATED' | 'STALE';

/** 보정 인정 최소 완료 shadow 표본 수 */
export const MIN_CALIBRATION_SAMPLES = 200;
/** CALIBRATING 진입 최소 표본 */
export const MIN_CALIBRATING_SAMPLES = 30;
/** 보정 데이터 최대 age (초과=STALE) */
export const CALIBRATION_MAX_AGE_MS = 14 * 24 * 3_600_000;

export interface CostBreakdownUsd {
  entryFeeUsd: number | null;
  estimatedExitFeeUsd: number | null;
  fundingCostUsd: number | null;
  borrowingCostUsd: number | null;
  priceImpactUsd: number | null;
  slippageUsd: number | null;
  gasExecutionFeeUsd: number | null;
  latencyRiskReserveUsd: number | null;
  failureRiskReserveUsd: number | null;
  /** 보유시간 가정 (시간) — funding/borrowing 계산 basis */
  holdingHoursAssumed: number | null;
  costBasis: string | null;
  /** 비용 스냅샷 출처 — PAPER estimate는 LIVE 사용 금지 */
  costSource: string | null;
  costSnapshotFetchedAtMs: number | null;
  /** 6I-4 — rate 출처 pin (endpoint+SDK 버전+단위 계약). 미확보=null */
  sourcePin?: string | null;
  /** 6I-4 — 성분별 관측 시각 (stale 감사용) */
  componentObservedAtMs?: {
    feeParamsAtMs: number | null;
    ratesAtMs: number | null;
    ethPriceAtMs: number | null;
    /** 6I-5 — impact 입력(markets/info) 관측 시각. impact null이면 null */
    impactAtMs?: number | null;
  } | null;
  /**
   * 6I-5 — SDK 계약 impact 산출 상세 (source pin·exponent raw·factor raw·VI/cap
   * 적용 여부·관측 시각). 산출 실패 시 null — 실패 reason은 costBasis에 명시.
   */
  impactDetail?: {
    entryImpactUsd: number;
    exitImpactUsd: number;
    impactCostUsd: number;
    rebateCountedUsd: number;
    exponentPositiveRaw: string;
    exponentNegativeRaw: string;
    factorPositiveRaw: string;
    factorNegativeRaw: string;
    virtualInventoryConfigured: boolean;
    virtualInventoryApplied: boolean;
    capsEvaluated: string[];
    sourcePin: string;
    observedAtMs: number;
  } | null;
}

export interface OpportunityCandidate {
  symbol: string;
  market: string;
  indexToken: string | null;
  direction: CandidateDirection;
  regime: MarketRegime;
  dataQuality: DataQuality;
  rawSignalScore: number;              // 0..100 상대 점수 (확률 아님)
  trendScore: number | null;
  momentumScore: number | null;
  volumeScore: number | null;
  multiTimeframeAlignment: number | null;  // -1..1
  btcAlignment: number | null;             // -1..1
  fundingScore: number | null;
  borrowingScore: number | null;
  liquidityScore: number | null;
  volatilityRisk: number | null;           // 0..1
  executionRisk: number | null;            // 0..1
  expectedEntryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  finalNotionalUsd: number | null;
  expectedGrossWinUsd: number | null;
  expectedGrossLossUsd: number | null;     // 양수 (손실 크기)
  /** 실측 보정 확률 — 표본 부족 시 null (가짜 50% 금지) */
  winProbability: number | null;
  probabilityCalibrationStatus: ProbabilityCalibrationStatus;
  cost: CostBreakdownUsd;
  totalExpectedCostUsd: number | null;
  /** 보정 확률 없으면 null — 절대 0/근사값 대체 금지 */
  expectedNetValueUsd: number | null;
  expectedNetValuePct: number | null;
  expectedRMultiple: number | null;
  costToGrossEdgeRatio: number | null;
  /** 연구용 순위 점수 (확률/수익 아님) */
  uncalibratedRankingScore: number | null;
  rejectionReasons: string[];
  decision: CandidateDecision;
  /** 6I-3 — regime×방향 bucket 보정 관측치 (API/UI fail-closed 표기용, 선택적) */
  calibrationBucket?: {
    key: string;
    decisiveSamples: number;
    targetCount: number;
    stopCount: number;
    noneCount: number;
    requiredSamples: number;
    reason: string | null;
  } | null;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 보정 상태 판정 — 표본 수 + 최신성 */
export function deriveCalibrationStatus(input: { completedSamples: number; lastSampleAtMs: number | null; nowMs: number }): ProbabilityCalibrationStatus {
  if (input.completedSamples >= MIN_CALIBRATION_SAMPLES) {
    if (input.lastSampleAtMs === null || input.nowMs - input.lastSampleAtMs > CALIBRATION_MAX_AGE_MS) return 'STALE';
    return 'CALIBRATED';
  }
  if (input.completedSamples >= MIN_CALIBRATING_SAMPLES) return 'CALIBRATING';
  return 'UNCALIBRATED';
}

/** 비용 합계 — 하나라도 null이면 null (누락 비용 0 대체 금지) */
export function totalCostUsd(c: CostBreakdownUsd): number | null {
  const parts = [
    c.entryFeeUsd, c.estimatedExitFeeUsd, c.fundingCostUsd, c.borrowingCostUsd,
    c.priceImpactUsd, c.slippageUsd, c.gasExecutionFeeUsd,
    c.latencyRiskReserveUsd, c.failureRiskReserveUsd,
  ];
  if (parts.some(p => p === null || !fin(p))) return null;
  return (parts as number[]).reduce((s, v) => s + v, 0);
}

/**
 * §7 순기대값 공식 — 명시적 구현.
 * calibratedWinProbability가 null이면 null 반환 (가짜 확률 대입 금지).
 */
export function computeExpectedNetValueUsd(input: {
  calibratedWinProbability: number | null;
  calibrationStatus: ProbabilityCalibrationStatus;
  expectedGrossWinUsd: number | null;
  expectedGrossLossUsd: number | null;
  cost: CostBreakdownUsd;
}): number | null {
  const p = input.calibratedWinProbability;
  if (p === null || input.calibrationStatus !== 'CALIBRATED') return null;
  if (!fin(p) || p < 0 || p > 1) return null;
  if (input.expectedGrossWinUsd === null || input.expectedGrossLossUsd === null) return null;
  if (!fin(input.expectedGrossWinUsd) || !fin(input.expectedGrossLossUsd)) return null;
  const cost = totalCostUsd(input.cost);
  if (cost === null) return null;
  return p * input.expectedGrossWinUsd - (1 - p) * input.expectedGrossLossUsd - cost;
}

/** 연구용 순위 점수 — 확률·수익 표시 금지 이름 그대로 노출 */
export function computeUncalibratedRankingScore(input: {
  rawSignalScore: number;
  costToGrossEdgeRatio: number | null;
  volatilityRisk: number | null;
  executionRisk: number | null;
}): number | null {
  if (!fin(input.rawSignalScore)) return null;
  if (input.costToGrossEdgeRatio === null || !fin(input.costToGrossEdgeRatio)) return null;
  const volPenalty = input.volatilityRisk === null ? 0.5 : input.volatilityRisk;
  const execPenalty = input.executionRisk === null ? 0.5 : input.executionRisk;
  // 점수 = 신호 × (1 - 비용잠식) × (1 - 위험 평균) — 0..100 상대치
  const costFactor = Math.max(0, 1 - Math.min(1, input.costToGrossEdgeRatio));
  const riskFactor = Math.max(0, 1 - (volPenalty + execPenalty) / 2);
  return input.rawSignalScore * costFactor * riskFactor;
}

/** expected R = (익절 기대 − 비용) / (손절 기대 + 비용) — 비용/입력 누락 시 null */
export function computeExpectedRMultiple(input: {
  expectedGrossWinUsd: number | null;
  expectedGrossLossUsd: number | null;
  totalCostUsd: number | null;
}): number | null {
  const { expectedGrossWinUsd: w, expectedGrossLossUsd: l, totalCostUsd: c } = input;
  if (w === null || l === null || c === null || !fin(w) || !fin(l) || !fin(c)) return null;
  const denom = l + c;
  if (denom <= 0) return null;
  return (w - c) / denom;
}

/** 비용/edge 잠식비 — grossEdge = p 불문 단순 win 기대 크기 사용 불가 → gross win 기준 */
export function computeCostToGrossEdgeRatio(input: { expectedGrossWinUsd: number | null; totalCostUsd: number | null }): number | null {
  const { expectedGrossWinUsd: w, totalCostUsd: c } = input;
  if (w === null || c === null || !fin(w) || !fin(c) || w <= 0) return null;
  return c / w;
}
