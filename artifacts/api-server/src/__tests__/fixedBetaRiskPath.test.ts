import { describe, expect, it } from 'vitest';
import { buildActiveCapitalWorkerBinding } from '../lib/activeCapitalSemantics';
import {
  FIXED_BETA_RISK_CAPITAL_SCOPE,
  dailyRiskCapital,
  weeklyRiskCapital,
} from '../lib/riskCapital';
import {
  EMPTY_LOCKS,
  evaluateRiskState,
  type RiskEvaluationInput,
} from '../lib/riskStateMachine';

const NOW = new Date('2026-09-10T13:00:00.000Z');
const FRESH = '2026-09-10T12:59:30.000Z';
const MAX_AGE_MS = 60_000;

function baseInput(overrides: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    dailyRiskCapitalUsd: 400,
    weeklyRiskCapitalUsd: 400,
    currentEquityUsd: 400,
    dailyRealizedNetPnlUsd: 0,
    dailyLossAwareNetPnlUsd: 0,
    estimatedExitNetPnlUsd: null,
    weeklyRealizedNetPnlUsd: 0,
    dailyEntryCount: 0,
    consecutiveLossCount: 0,
    openPositionCount: 0,
    dbOk: true,
    feeDataOk: true,
    marketDataFresh: true,
    locks: { ...EMPTY_LOCKS },
    ...overrides,
  };
}

describe('fixed beta risk path composition', () => {
  it('binds the explicit $368/$400 hard-stop pair and keeps 400-domain loss math out of the standard 1K path', () => {
    const daily = dailyRiskCapital(
      { equityUsd: 400, recordedAt: FRESH },
      NOW,
      MAX_AGE_MS,
      FIXED_BETA_RISK_CAPITAL_SCOPE,
    );
    const weekly = weeklyRiskCapital(
      { equityUsd: 400, recordedAt: FRESH },
      NOW,
      MAX_AGE_MS,
      FIXED_BETA_RISK_CAPITAL_SCOPE,
    );

    expect(daily).toEqual({ ok: true, capitalUsd: 400 });
    expect(weekly).toEqual({ ok: true, capitalUsd: 400 });

    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: null,
      currentRiskEquityUsd: 390,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
      hardStopThresholdBindingCapability: 'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1',
    });

    expect(binding.riskGate).toEqual({
      newHardStopEvaluationAllowed: true,
      activeCapitalConfigurationDriftReason: null,
      hardStopPolicyEquityUsd: 368,
      hardStopPolicyReferenceCapitalUsd: 400,
    });
    expect(binding.diagnostic.betaExecutionAuthorized).toBe(false);

    const result = evaluateRiskState(baseInput({
      dailyRiskCapitalUsd: daily.ok ? daily.capitalUsd : null,
      weeklyRiskCapitalUsd: weekly.ok ? weekly.capitalUsd : null,
      currentEquityUsd: 390,
      dailyRealizedNetPnlUsd: -10,
      dailyLossAwareNetPnlUsd: -10,
      weeklyRealizedNetPnlUsd: -10,
      ...binding.riskGate,
    }));

    expect(result.state).not.toBe('HARD_STOPPED');
    expect(result.locks.hardStopReason).toBeNull();
    expect(result.blockReasons.join(' ')).not.toContain('$920');
  });

  it('hard-stops at the explicit fixed-beta threshold without falling back to the standard $920 threshold', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: null,
      currentRiskEquityUsd: 368,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
      hardStopThresholdBindingCapability: 'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1',
    });

    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 368,
      dailyRealizedNetPnlUsd: -32,
      dailyLossAwareNetPnlUsd: -32,
      weeklyRealizedNetPnlUsd: -32,
      ...binding.riskGate,
    }));

    expect(result.state).toBe('HARD_STOPPED');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual(expect.arrayContaining([
      'CLOSE_ALL_POSITIONS',
      'CANCEL_ALL_ORDERS',
    ]));
    expect(result.locks.hardStopReason).toContain('hard stop $368');
    expect(result.locks.hardStopReason).toContain('Active $400');
    expect(result.locks.hardStopReason).not.toContain('$920');
  });

  it('fails closed when the fixed-beta hard-stop capability is not explicitly supplied', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: null,
      currentRiskEquityUsd: 390,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
    });

    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 390,
      ...binding.riskGate,
    }));

    expect(binding.riskGate.newHardStopEvaluationAllowed).toBe(false);
    expect(result.entryAllowed).toBe(false);
    expect(result.locks.hardStopReason).toBeNull();
    expect(result.blockReasons.join(' ')).toContain('FIXED_BETA_HARD_STOP_BINDING_NOT_WIRED');
  });

  it('preserves the standard 1K hard-stop semantics when no beta context is selected', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 1_000,
      observedWalletBalanceUsd: null,
      currentRiskEquityUsd: 919.99,
      historicalHardStopTriggerReason: null,
    });

    expect(binding.riskGate).toEqual({
      newHardStopEvaluationAllowed: true,
      activeCapitalConfigurationDriftReason: null,
    });

    const result = evaluateRiskState(baseInput({
      dailyRiskCapitalUsd: 1_000,
      weeklyRiskCapitalUsd: 1_000,
      currentEquityUsd: 919.99,
      ...binding.riskGate,
    }));

    expect(result.state).toBe('HARD_STOPPED');
    expect(result.locks.hardStopReason).toContain('hard stop $920');
  });
});
