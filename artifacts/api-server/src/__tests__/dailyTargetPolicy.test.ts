/**
 * dailyTargetPolicy — #126 RiskPolicy 표시·저장 정합성 테스트.
 *
 * 확정 authoritative 정책:
 *   운용 기준 자본 = min(startOfDayEquity, $1,000)
 *   일일 1차 과열 경계 = +5% ($1,000 기준 $50)
 *   절대 과열 상한 = +10% ($1,000 기준 $100)
 *
 * dailyTargetUSDT(soft KPI)는 정책 상한을 초과해 저장·노출될 수 없고,
 * legacy 저장값($500 등)은 읽기/쓰기 경로 모두에서 클램프된다.
 * RiskEngine 강제 로직(deriveDailyTargets)은 절대 완화되지 않는다.
 */
import { describe, expect, it } from 'vitest';
import {
  RISK_POLICY,
  deriveDailyTargets,
  clampDailyTargetUSDT,
  POLICY_DAILY_TARGET_USD,
  POLICY_DAILY_TARGET_CAP_USD,
} from '../lib/riskPolicy';

describe('deriveDailyTargets — authoritative 파생값 (RiskEngine 불변)', () => {
  it('$1,000 Active 기준 → 과열 $50/$100 · 일일 최대손실 $10 · floor $35', () => {
    const t = deriveDailyTargets(1_000);
    expect(t.primaryProfitTargetUsd).toBe(50);
    expect(t.absoluteProfitCapUsd).toBe(100);
    expect(t.dailyMaxLossUsd).toBe(10);
    expect(t.protectedProfitFloorUsd).toBe(35);
    expect(t.defensiveModeLossUsd).toBe(5);
  });

  it('$900 기준 → $45 / $90', () => {
    const t = deriveDailyTargets(900);
    expect(t.primaryProfitTargetUsd).toBe(45);
    expect(t.absoluteProfitCapUsd).toBe(90);
  });

  it('equity $1,200이어도 기준 자본은 min(equity, $1,000) → $50 / $100 cap', () => {
    const capital = Math.min(1_200, RISK_POLICY.maxRiskCapitalUsd);
    expect(capital).toBe(1_000);
    const t = deriveDailyTargets(capital);
    expect(t.primaryProfitTargetUsd).toBe(50);
    expect(t.absoluteProfitCapUsd).toBe(100);
  });

  it('정책 상수 자체는 완화되지 않았다 (5% / 10% / $1,000)', () => {
    expect(RISK_POLICY.primaryProfitTargetPercent).toBe(5);
    expect(RISK_POLICY.absoluteProfitCapPercent).toBe(10);
    expect(RISK_POLICY.maxRiskCapitalUsd).toBe(1_000);
    expect(POLICY_DAILY_TARGET_USD).toBe(50);
    expect(POLICY_DAILY_TARGET_CAP_USD).toBe(100);
  });
});

describe('clampDailyTargetUSDT — soft KPI 저장·읽기 클램프', () => {
  it('legacy $500 → 정책 상한 $100으로 클램프 (500 그대로 저장·노출 금지)', () => {
    expect(clampDailyTargetUSDT(500)).toBe(100);
    expect(clampDailyTargetUSDT('500')).toBe(100);
  });

  it('정책 범위 내 값은 그대로 통과', () => {
    expect(clampDailyTargetUSDT(50)).toBe(50);
    expect(clampDailyTargetUSDT(0)).toBe(0);
    expect(clampDailyTargetUSDT(100)).toBe(100);
  });

  it('음수 → 0, 비정상 값 → undefined (가짜 0 대체 금지 — 기본값 폴백)', () => {
    expect(clampDailyTargetUSDT(-5)).toBe(0);
    expect(clampDailyTargetUSDT('abc')).toBeUndefined();
    expect(clampDailyTargetUSDT(null)).toBeUndefined();
    expect(clampDailyTargetUSDT(undefined)).toBeUndefined();
    expect(clampDailyTargetUSDT(NaN)).toBeUndefined();
    expect(clampDailyTargetUSDT(Infinity)).toBeUndefined();
  });
});
