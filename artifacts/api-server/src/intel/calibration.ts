/**
 * 6I-3 §1 — regime×방향 bucket 승률 캘리브레이션 (db-free 순수 모듈).
 *
 * 원칙 (fail-closed):
 *  - COMPLETE 4h shadow outcome만 표본 (INCOMPLETE/AMBIGUOUS/1h-only 혼합 금지)
 *  - decisive 표본 = firstTouch TARGET 또는 STOP (NONE=horizon 만료 — 승률 분모 제외)
 *  - bucket 표본 미달·stale = winProbability null (가짜 50%/전역 평균 대체 금지)
 *  - lookahead 방지는 표본 소스 계약으로 강제: complete=true는 shadowOutcome.ts가
 *    horizon 경과+폐쇄 캔들만으로 판정한 것만 존재한다.
 *  - bucket 오염 금지 — 다른 regime/방향 표본 혼입 없음 (조회 계층에서 정확 일치 group by)
 */
import { ProbabilityCalibrationStatus, MIN_CALIBRATION_SAMPLES, MIN_CALIBRATING_SAMPLES, CALIBRATION_MAX_AGE_MS } from './candidate';

export interface CalibrationBucketRaw {
  regime: string;
  direction: 'LONG' | 'SHORT';
  /** firstTouch=TARGET (4h COMPLETE) */
  targetCount: number;
  /** firstTouch=STOP (4h COMPLETE) */
  stopCount: number;
  /** firstTouch=NONE (horizon 만료 청산) — 분모 제외, 관측치로만 노출 */
  noneCount: number;
  /** bucket 내 마지막 decisive 표본 측정 시각 (ms). null=표본 없음 */
  lastDecisiveAtMs: number | null;
}

export interface BucketCalibration {
  bucketKey: string;                     // `${regime}:${direction}`
  regime: string;
  direction: 'LONG' | 'SHORT';
  decisiveSamples: number;               // target+stop
  targetCount: number;
  stopCount: number;
  noneCount: number;
  /** decisive 표본 기반 승률. 표본 미달/stale이면 null (0.5 대체 금지) */
  winProbability: number | null;
  status: ProbabilityCalibrationStatus;
  lastDecisiveAtMs: number | null;
  /** null 사유 (표본수/stale) — API·UI fail-closed 표기용 */
  reason: string | null;
  requiredSamples: number;
}

export function bucketKeyOf(regime: string, direction: 'LONG' | 'SHORT'): string {
  return `${regime}:${direction}`;
}

/**
 * bucket 하나의 보정 판정.
 *  - decisive ≥ MIN_CALIBRATION_SAMPLES(200) + 최신성(14일) → CALIBRATED + p
 *  - decisive ≥ MIN_CALIBRATING_SAMPLES(30) → CALIBRATING (p는 여전히 null — ENV 산출 금지)
 *  - 그 외 → UNCALIBRATED / STALE
 */
export function calibrateBucket(raw: CalibrationBucketRaw, nowMs: number): BucketCalibration {
  const decisive = raw.targetCount + raw.stopCount;
  const base = {
    bucketKey: bucketKeyOf(raw.regime, raw.direction),
    regime: raw.regime, direction: raw.direction,
    decisiveSamples: decisive,
    targetCount: raw.targetCount, stopCount: raw.stopCount, noneCount: raw.noneCount,
    lastDecisiveAtMs: raw.lastDecisiveAtMs,
    requiredSamples: MIN_CALIBRATION_SAMPLES,
  };
  if (decisive >= MIN_CALIBRATION_SAMPLES) {
    if (raw.lastDecisiveAtMs === null || nowMs - raw.lastDecisiveAtMs > CALIBRATION_MAX_AGE_MS) {
      return { ...base, winProbability: null, status: 'STALE', reason: `보정 데이터 stale (마지막 decisive 표본 ${raw.lastDecisiveAtMs === null ? '없음' : new Date(raw.lastDecisiveAtMs).toISOString()}) — p 사용 금지` };
    }
    // 미래 시각 표본 = 데이터 오염 신호 — p 사용 금지 (lookahead/시계 오류 방어)
    if (raw.lastDecisiveAtMs > nowMs + 60_000) {
      return { ...base, winProbability: null, status: 'STALE', reason: '표본 측정 시각이 미래 — 데이터 오염 의심, p 사용 금지' };
    }
    const p = raw.targetCount / decisive;
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      return { ...base, winProbability: null, status: 'STALE', reason: '승률 산출값 비정상 — p 사용 금지' };
    }
    return { ...base, winProbability: p, status: 'CALIBRATED', reason: null };
  }
  if (decisive >= MIN_CALIBRATING_SAMPLES) {
    return { ...base, winProbability: null, status: 'CALIBRATING', reason: `bucket decisive 표본 ${decisive} < ${MIN_CALIBRATION_SAMPLES} — 승률 추정 보류 (CALIBRATING)` };
  }
  return { ...base, winProbability: null, status: 'UNCALIBRATED', reason: `bucket decisive 표본 ${decisive} < ${MIN_CALIBRATING_SAMPLES} — 미보정` };
}

/** 전체 bucket 목록 → Map(bucketKey → BucketCalibration) */
export function calibrateBuckets(raws: CalibrationBucketRaw[], nowMs: number): Map<string, BucketCalibration> {
  const map = new Map<string, BucketCalibration>();
  for (const raw of raws) {
    const c = calibrateBucket(raw, nowMs);
    map.set(c.bucketKey, c);
  }
  return map;
}

/** bucket 미존재 시의 기본 (표본 0) — 조회 실패와 구분해 사용할 것 */
export function emptyBucket(regime: string, direction: 'LONG' | 'SHORT', nowMs: number): BucketCalibration {
  return calibrateBucket({ regime, direction, targetCount: 0, stopCount: 0, noneCount: 0, lastDecisiveAtMs: null }, nowMs);
}
