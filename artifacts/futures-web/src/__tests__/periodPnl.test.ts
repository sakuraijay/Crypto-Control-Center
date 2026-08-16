/**
 * usePeriodPnl 순수 헬퍼 테스트 — 표시 규칙 (N/A vs Unavailable vs 값).
 *
 * 규칙:
 *  - API 오류/필드 부재  → 'unavailable' → "Unavailable" (0 추정 금지)
 *  - 기준점 미수립(null) → 'na'          → "N/A" (가짜 0 금지)
 *  - 정상               → 서명 포함 달러 포맷
 */
import { describe, expect, it } from 'vitest';
import { derivePeriodPnlStatus, formatPeriodPnl, type PeriodPnlData } from '../hooks/usePeriodPnl';

const data = (over: Partial<PeriodPnlData> = {}): PeriodPnlData => ({
  dailyPnlUsd: 12.5, weeklyPnlUsd: -30, dailyBaseline: null, weeklyBaseline: null,
  dailyRealizedPnlUsd: 10, weeklyRealizedPnlUsd: -25, currentEquityUsd: 10_012.5,
  ...over,
});

describe('derivePeriodPnlStatus', () => {
  it('fetch 실패 또는 데이터 없음 → unavailable', () => {
    expect(derivePeriodPnlStatus(false, data())).toBe('unavailable');
    expect(derivePeriodPnlStatus(true, null)).toBe('unavailable');
  });

  it('기준점 미수립(둘 다 null) → na — 가짜 0으로 대체하지 않음', () => {
    expect(derivePeriodPnlStatus(true, data({ dailyPnlUsd: null, weeklyPnlUsd: null }))).toBe('na');
  });

  it('정상 값 → ok (0도 유효한 값)', () => {
    expect(derivePeriodPnlStatus(true, data())).toBe('ok');
    expect(derivePeriodPnlStatus(true, data({ dailyPnlUsd: 0, weeklyPnlUsd: 0 }))).toBe('ok');
  });
});

describe('formatPeriodPnl', () => {
  it('unavailable → "Unavailable" (숫자 표시 금지)', () => {
    expect(formatPeriodPnl(123, 'unavailable')).toBe('Unavailable');
    expect(formatPeriodPnl(null, 'unavailable')).toBe('Unavailable');
  });

  it('값 null(기준점 없음) → "N/A"', () => {
    expect(formatPeriodPnl(null, 'ok')).toBe('N/A');
    expect(formatPeriodPnl(null, 'na')).toBe('N/A');
  });

  it('trades 0·positions 0 초기 상태 → 정확히 +$0.00', () => {
    expect(formatPeriodPnl(0, 'ok')).toBe('+$0.00');
  });

  it('양수/음수 서명 포맷', () => {
    expect(formatPeriodPnl(1234.5, 'ok')).toBe('+$1,234.50');
    expect(formatPeriodPnl(-56.789, 'ok')).toBe('-$56.79');
  });

  it('loading → "…"', () => {
    expect(formatPeriodPnl(null, 'loading')).toBe('…');
  });
});
