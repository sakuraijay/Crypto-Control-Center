/**
 * riskCapital — 위험계산 기준금액 (6H-1 §4).
 *
 *   dailyRiskCapital    = min(startOfDayEquityUsd,  maxRiskCapitalUsd)
 *   weeklyRiskCapital   = min(startOfWeekEquityUsd, maxRiskCapitalUsd)
 *   positionSizingCapital = min(currentEquityUsd,   maxRiskCapitalUsd)
 *
 * 원칙:
 *  - equity가 $1,000을 넘어도 목표·포지션 크기·허용손실 자동 증가 금지 (자동 복리 금지)
 *  - equity가 $1,000 아래면 목표/한도 비례 축소
 *  - 값이 없거나 stale·비정상이면 기준금액 산출 실패 → 호출측 신규 진입 차단 (fail-closed)
 */

import { RISK_POLICY } from './riskPolicy';

export type CapitalResult =
  | { ok: true; capitalUsd: number }
  | { ok: false; reason: string };

/** 기준 equity 관측값 — 값 + 기록 시각 (stale 판정용) */
export interface EquityObservation {
  equityUsd: number;
  /** ISO — 비정상 timestamp는 거부 */
  recordedAt: string;
}

/** 관측값 유효성: 유한 수·음수 금지·timestamp 파싱 가능·미래 아님·stale 아님 */
export function validateEquityObservation(
  obs: EquityObservation | null | undefined,
  now: Date,
  maxAgeMs: number,
): CapitalResult {
  if (!obs) return { ok: false, reason: 'equity 관측값 없음 (fail-closed)' };
  const { equityUsd, recordedAt } = obs;
  if (typeof equityUsd !== 'number' || !Number.isFinite(equityUsd)) {
    return { ok: false, reason: 'equity가 NaN/무한대 — 거부' };
  }
  if (equityUsd < 0) return { ok: false, reason: 'equity 음수 — 거부' };
  const ts = Date.parse(recordedAt);
  if (!Number.isFinite(ts)) return { ok: false, reason: '비정상 timestamp — 거부' };
  if (ts > now.getTime() + 60_000) return { ok: false, reason: '미래 timestamp — 거부' };
  if (maxAgeMs > 0 && now.getTime() - ts > maxAgeMs) {
    return { ok: false, reason: `equity 관측값 stale (${Math.round((now.getTime() - ts) / 1000)}s 경과) — 거부` };
  }
  return { ok: true, capitalUsd: equityUsd };
}

function capAtPolicy(equityUsd: number): number {
  return Math.min(equityUsd, RISK_POLICY.maxRiskCapitalUsd);
}

/** dailyRiskCapital = min(startOfDayEquity, 1000) */
export function dailyRiskCapital(startOfDay: EquityObservation | null | undefined, now: Date, maxAgeMs: number): CapitalResult {
  const v = validateEquityObservation(startOfDay, now, maxAgeMs);
  if (!v.ok) return v;
  return { ok: true, capitalUsd: capAtPolicy(v.capitalUsd) };
}

/** weeklyRiskCapital = min(startOfWeekEquity, 1000) */
export function weeklyRiskCapital(startOfWeek: EquityObservation | null | undefined, now: Date, maxAgeMs: number): CapitalResult {
  const v = validateEquityObservation(startOfWeek, now, maxAgeMs);
  if (!v.ok) return v;
  return { ok: true, capitalUsd: capAtPolicy(v.capitalUsd) };
}

/** positionSizingCapital = min(currentEquity, 1000) */
export function positionSizingCapital(current: EquityObservation | null | undefined, now: Date, maxAgeMs: number): CapitalResult {
  const v = validateEquityObservation(current, now, maxAgeMs);
  if (!v.ok) return v;
  return { ok: true, capitalUsd: capAtPolicy(v.capitalUsd) };
}
