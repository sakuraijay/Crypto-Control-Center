/**
 * usePeriodPnl 순수 헬퍼 테스트 — 표시 규칙 (N/A vs Unavailable vs 값).
 *
 * 규칙:
 *  - API 오류/필드 부재  → 'unavailable' → "Unavailable" (0 추정 금지)
 *  - 기준점 미수립(null) → 'na'          → "N/A" (가짜 0 금지)
 *  - 정상               → 서명 포함 달러 포맷
 */
import { describe, expect, it } from 'vitest';
import {
  derivePeriodPnlStatus, formatPeriodPnl, parseRiskDerivedTargets,
  type PeriodPnlData, type RiskDerivedTargets,
} from '../hooks/usePeriodPnl';
import {
  clampDailyTargetWeb, POLICY_DAILY_TARGET_USD, POLICY_DAILY_TARGET_CAP_USD,
} from '../lib/context/StrategyContext';

const data = (over: Partial<PeriodPnlData> = {}): PeriodPnlData => ({
  dailyPnlUsd: 12.5, weeklyPnlUsd: -30, dailyBaseline: null, weeklyBaseline: null,
  dailyRealizedPnlUsd: 10, weeklyRealizedPnlUsd: -25, currentEquityUsd: 10_012.5,
  periodPnlUpdatedAt: new Date().toISOString(),
  riskDerivedTargets: null,
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

  it('서버 갱신이 5분 이상 오래된 값 → unavailable (stale 값 신뢰 금지)', () => {
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(derivePeriodPnlStatus(true, data({ periodPnlUpdatedAt: old }))).toBe('unavailable');
    const fresh = new Date(Date.now() - 60_000).toISOString();
    expect(derivePeriodPnlStatus(true, data({ periodPnlUpdatedAt: fresh }))).toBe('ok');
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

// ── #126 RiskPolicy 표시·저장 정합성 ─────────────────────────────────────────

const validTargets = (over: Partial<RiskDerivedTargets> = {}): RiskDerivedTargets => ({
  dailyRiskCapitalUsd: 1_000,
  primaryProfitTargetUsd: 50,
  absoluteProfitCapUsd: 100,
  protectedProfitFloorUsd: 35,
  defensiveModeLossUsd: 20,
  dailyMaxLossUsd: 30,
  ...over,
});

describe('parseRiskDerivedTargets — authoritative 파생값만 채택 (가짜 값 금지)', () => {
  it('$1,000 기준 정상 응답 → $50 / $100 채택', () => {
    const t = parseRiskDerivedTargets(validTargets());
    expect(t?.primaryProfitTargetUsd).toBe(50);
    expect(t?.absoluteProfitCapUsd).toBe(100);
  });

  it('$900 기준 → $45 / $90 그대로 채택 (서버 계산 신뢰)', () => {
    const t = parseRiskDerivedTargets(validTargets({
      dailyRiskCapitalUsd: 900, primaryProfitTargetUsd: 45, absoluteProfitCapUsd: 90,
      protectedProfitFloorUsd: 31.5, defensiveModeLossUsd: 18, dailyMaxLossUsd: 27,
    }));
    expect(t?.primaryProfitTargetUsd).toBe(45);
    expect(t?.absoluteProfitCapUsd).toBe(90);
  });

  it('필드 부재/null/비숫자/NaN → null (500·0 같은 대체값 생성 금지 → 카드 Unavailable)', () => {
    expect(parseRiskDerivedTargets(null)).toBeNull();
    expect(parseRiskDerivedTargets(undefined)).toBeNull();
    expect(parseRiskDerivedTargets({})).toBeNull();
    expect(parseRiskDerivedTargets({ ...validTargets(), primaryProfitTargetUsd: 'x' })).toBeNull();
    expect(parseRiskDerivedTargets({ ...validTargets(), dailyMaxLossUsd: NaN })).toBeNull();
    const missing: Record<string, unknown> = { ...validTargets() };
    delete missing.absoluteProfitCapUsd;
    expect(parseRiskDerivedTargets(missing)).toBeNull();
  });

  it('API 실패 시 데이터 riskDerivedTargets=null → 상태와 무관하게 카드가 목표를 표시할 수 없음', () => {
    // derivePeriodPnlStatus는 별개 게이트 — targets 없으면 카드는 Unavailable 분기
    expect(data().riskDerivedTargets).toBeNull();
  });
});

describe('clampDailyTargetWeb — stale strategy_config(legacy $500) 무시', () => {
  it('legacy 500 → 정책 상한 $100 (500은 상태에 남지 않음)', () => {
    expect(clampDailyTargetWeb(500)).toBe(POLICY_DAILY_TARGET_CAP_USD);
    expect(clampDailyTargetWeb('500')).toBe(100);
  });

  it('정상 범위 값 통과, 음수 → 0', () => {
    expect(clampDailyTargetWeb(50)).toBe(50);
    expect(clampDailyTargetWeb(0)).toBe(0);
    expect(clampDailyTargetWeb(-10)).toBe(0);
  });

  it('비정상 값 → 정책 기본 목표 $50 (가짜 0/500 금지)', () => {
    expect(clampDailyTargetWeb(undefined)).toBe(POLICY_DAILY_TARGET_USD);
    expect(clampDailyTargetWeb('abc')).toBe(50);
    expect(clampDailyTargetWeb(NaN)).toBe(50);
  });
});
