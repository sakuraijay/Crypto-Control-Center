/**
 * 6I-1 §3 — 캔들 시리즈 검증.
 *  - 누락(gap)·중복·역순·시간 간격 오류 검사
 *  - 미래 시각·NaN·Infinity·음수 가격 거부
 *  - 억지로 timeframe을 만들지 않음 — 부족하면 completeness/UNAVAILABLE로 표현
 */
import { Candle, Timeframe, TIMEFRAME_MS } from './types';

export interface CandleValidation {
  ok: boolean;
  issues: string[];
  /** 기대 캔들 수 대비 확보 비율 (0..1). 검증 실패는 0 */
  completeness: number;
  /** 검증 통과 캔들(정렬·정합) — ok=false면 null */
  candles: Candle[] | null;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateCandleSeries(
  raw: Candle[] | null | undefined,
  timeframe: Timeframe,
  opts: { nowMs: number; expectedCount: number; minCount: number },
): CandleValidation {
  const issues: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, issues: ['캔들 없음'], completeness: 0, candles: null };
  }
  const step = TIMEFRAME_MS[timeframe];
  const seen = new Set<number>();
  let prevT = -Infinity;
  for (const c of raw) {
    if (!fin(c.t) || !fin(c.o) || !fin(c.h) || !fin(c.l) || !fin(c.c)) {
      issues.push('비정상 값(NaN/Infinity) 포함'); break;
    }
    if (c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0 || (c.v !== null && (!fin(c.v) || c.v < 0))) {
      issues.push('음수/0 가격 또는 음수 거래량'); break;
    }
    if (c.h < c.l || c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) {
      issues.push('OHLC 정합성 위반 (h<l 등)'); break;
    }
    if (c.t > opts.nowMs + 5_000) { issues.push('미래 시각 캔들'); break; }
    if (seen.has(c.t)) { issues.push('중복 캔들 시각'); break; }
    if (c.t < prevT) { issues.push('역순 캔들'); break; }
    if (prevT !== -Infinity && c.t - prevT !== step) {
      issues.push(`시간 간격 오류/gap: ${prevT}→${c.t} (기대 ${step}ms)`); break;
    }
    seen.add(c.t); prevT = c.t;
  }
  if (issues.length > 0) return { ok: false, issues, completeness: 0, candles: null };
  const completeness = Math.min(1, raw.length / Math.max(1, opts.expectedCount));
  if (raw.length < opts.minCount) {
    return { ok: false, issues: [`캔들 부족: ${raw.length} < 최소 ${opts.minCount}`], completeness, candles: null };
  }
  return { ok: true, issues: [], completeness, candles: raw };
}

/** ATR% (기간 평균 true range / 마지막 종가) — 검증 통과 캔들에서만 계산 */
export function computeAtrPct(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  const lastClose = slice[slice.length - 1].c;
  if (lastClose <= 0) return null;
  return (sum / period / lastClose) * 100;
}

/** 단순 추세 점수 -1..1 — (마지막 종가 - 기간 시작 종가)/시작, ±cap%에서 포화 */
export function computeTrendScore(candles: Candle[], lookback: number, capPct = 5): number | null {
  if (candles.length < lookback + 1) return null;
  const start = candles[candles.length - 1 - lookback].c;
  const end = candles[candles.length - 1].c;
  if (start <= 0) return null;
  const pct = ((end - start) / start) * 100;
  return Math.max(-1, Math.min(1, pct / capPct));
}

/** 모멘텀 -1..1 — 최근 절반 vs 이전 절반 평균 종가 변화율 기반 */
export function computeMomentumScore(candles: Candle[], lookback: number, capPct = 3): number | null {
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const half = Math.floor(lookback / 2);
  if (half < 1) return null;
  const avg = (cs: Candle[]) => cs.reduce((s, c) => s + c.c, 0) / cs.length;
  const older = avg(slice.slice(0, half));
  const newer = avg(slice.slice(half));
  if (older <= 0) return null;
  const pct = ((newer - older) / older) * 100;
  return Math.max(-1, Math.min(1, pct / capPct));
}
