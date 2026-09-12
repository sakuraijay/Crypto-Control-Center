import { describe, expect, it } from 'vitest';
import {
  FIXED_BETA_RISK_CAPITAL_SCOPE,
  dailyRiskCapital,
  positionSizingCapital,
  resolveRiskCapitalCap,
  weeklyRiskCapital,
} from '../lib/riskCapital';

const NOW = new Date('2026-09-09T00:00:00.000Z');
const MAX_AGE_MS = 60_000;

function equity(equityUsd: number, recordedAt = '2026-09-08T23:59:30.000Z') {
  return { equityUsd, recordedAt };
}

describe('fixed beta risk-capital scope', () => {
  it('preserves the existing 1,000-USDC policy when no scope is supplied', () => {
    expect(positionSizingCapital(equity(1_500), NOW, MAX_AGE_MS)).toEqual({
      ok: true,
      capitalUsd: 1_000,
    });
  });

  it('binds daily, weekly and position-sizing risk capital to the dedicated 400-USDC beta cap', () => {
    expect(FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd).toBe(400);
    expect(dailyRiskCapital(equity(900), NOW, MAX_AGE_MS, FIXED_BETA_RISK_CAPITAL_SCOPE))
      .toEqual({ ok: true, capitalUsd: 400 });
    expect(weeklyRiskCapital(equity(900), NOW, MAX_AGE_MS, FIXED_BETA_RISK_CAPITAL_SCOPE))
      .toEqual({ ok: true, capitalUsd: 400 });
    expect(positionSizingCapital(equity(900), NOW, MAX_AGE_MS, FIXED_BETA_RISK_CAPITAL_SCOPE))
      .toEqual({ ok: true, capitalUsd: 400 });
  });

  it('uses actual lower equity instead of fabricating the full 400-USDC beta cap', () => {
    expect(positionSizingCapital(equity(275), NOW, MAX_AGE_MS, FIXED_BETA_RISK_CAPITAL_SCOPE))
      .toEqual({ ok: true, capitalUsd: 275 });
  });

  it('fails closed when a scope attempts to promote risk capital above the approved 1,000-USDC stage', () => {
    const result = resolveRiskCapitalCap({ maxRiskCapitalUsd: 2_500 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('현재 승인 Active 상한 초과');
    }
  });

  it('fails closed for invalid scoped caps', () => {
    expect(resolveRiskCapitalCap({ maxRiskCapitalUsd: Number.NaN }).ok).toBe(false);
    expect(resolveRiskCapitalCap({ maxRiskCapitalUsd: 0 }).ok).toBe(false);
    expect(resolveRiskCapitalCap({ maxRiskCapitalUsd: -1 }).ok).toBe(false);
  });

  it('keeps stale/invalid equity fail-closed even when the beta scope itself is valid', () => {
    const stale = positionSizingCapital(
      equity(400, '2026-09-08T23:50:00.000Z'),
      NOW,
      MAX_AGE_MS,
      FIXED_BETA_RISK_CAPITAL_SCOPE,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toContain('stale');
    }

    expect(positionSizingCapital(
      equity(Number.POSITIVE_INFINITY),
      NOW,
      MAX_AGE_MS,
      FIXED_BETA_RISK_CAPITAL_SCOPE,
    ).ok).toBe(false);
  });
});
