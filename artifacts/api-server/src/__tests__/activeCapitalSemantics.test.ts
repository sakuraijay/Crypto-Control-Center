import { describe, expect, it } from 'vitest';
import { assessActiveCapitalSemantics } from '../lib/activeCapitalSemantics';

describe('active capital semantics', () => {
  it('keeps observed wallet balance separate from the approved Active Capital stage', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 1_000,
      observedWalletBalanceUsd: 24.5,
      currentRiskEquityUsd: 1_000,
      historicalHardStopTriggerReason: null,
    });

    expect(result.alignment).toBe('ALIGNED');
    expect(result.runtimeConfiguredCapitalAligned).toBe(true);
    expect(result.approvedActiveTradingCapitalUsd).toBe(1_000);
    expect(result.plannedSeedCapitalUsd).toBe(10_000);
    expect(result.observedWalletBalanceUsd).toBe(24.5);
    expect(result.walletBalanceTreatedAsActiveCapital).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it('flags a legacy under-allocated runtime value without fabricating funds or clearing locks', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 24.5,
      observedWalletBalanceUsd: 24.5,
      currentRiskEquityUsd: 24.5,
      historicalHardStopTriggerReason: 'equity $24.50 <= historical hard stop',
    });

    expect(result.alignment).toBe('RUNTIME_BELOW_APPROVED_STAGE');
    expect(result.runtimeConfiguredCapitalAligned).toBe(false);
    expect(result.blockers).toEqual([
      'ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE',
      'HISTORICAL_HARD_STOP_REQUIRES_OPERATOR_REVIEW',
    ]);
    expect(result.historicalHardStopReviewRequired).toBe(true);
    expect(result.automaticHardStopClearAllowed).toBe(false);
  });

  it('flags values above the approved stage instead of treating them as an automatic promotion', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 2_500,
      observedWalletBalanceUsd: 5_000,
      currentRiskEquityUsd: 2_500,
      historicalHardStopTriggerReason: null,
    });

    expect(result.alignment).toBe('RUNTIME_ABOVE_APPROVED_STAGE');
    expect(result.blockers).toContain('ACTIVE_CAPITAL_RUNTIME_ABOVE_APPROVED_STAGE');
  });

  it('fails closed for missing or invalid runtime capital while preserving unknown observations as null', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: Number.NaN,
      observedWalletBalanceUsd: -1,
      currentRiskEquityUsd: Number.POSITIVE_INFINITY,
      historicalHardStopTriggerReason: '',
    });

    expect(result.alignment).toBe('UNAVAILABLE');
    expect(result.runtimeConfiguredCapitalUsd).toBeNull();
    expect(result.observedWalletBalanceUsd).toBeNull();
    expect(result.currentRiskEquityUsd).toBeNull();
    expect(result.blockers).toEqual(['ACTIVE_CAPITAL_RUNTIME_UNAVAILABLE']);
  });
});
