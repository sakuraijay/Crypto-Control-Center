import { describe, expect, it } from 'vitest';
import { buildActiveCapitalWorkerBinding } from '../lib/activeCapitalSemantics';
import {
  EMPTY_LOCKS,
  evaluateRiskState,
  type RiskEvaluationInput,
} from '../lib/riskStateMachine';

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

describe('fixed beta explicit HARD_STOP binding capability', () => {
  it('emits the exact $368/$400 pair only with explicit fixed-beta capability', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 10_000,
      currentRiskEquityUsd: 400,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
      hardStopThresholdBindingCapability: 'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1',
    });

    expect(binding.diagnostic.alignment).toBe('ALIGNED');
    expect(binding.diagnostic.hardStopThresholdBoundToRiskEngine).toBe(true);
    expect(binding.diagnostic.newHardStopEvaluationAllowed).toBe(true);
    expect(binding.diagnostic.betaPlanApplied).toBe(false);
    expect(binding.diagnostic.betaExecutionAuthorized).toBe(false);
    expect(binding.riskGate).toEqual({
      newHardStopEvaluationAllowed: true,
      activeCapitalConfigurationDriftReason: null,
      hardStopPolicyEquityUsd: 368,
      hardStopPolicyReferenceCapitalUsd: 400,
    });
    expect(binding.riskGate).not.toHaveProperty('observedWalletBalanceUsd');
    expect(binding.riskGate).not.toHaveProperty('plannedSeedCapitalUsd');
  });

  it('keeps fixed beta fail-closed when capability is omitted', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 400,
      currentRiskEquityUsd: 400,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
    });

    expect(binding.diagnostic.hardStopThresholdBoundToRiskEngine).toBe(false);
    expect(binding.riskGate).toEqual({
      newHardStopEvaluationAllowed: false,
      activeCapitalConfigurationDriftReason: 'FIXED_BETA_HARD_STOP_BINDING_NOT_WIRED',
    });
  });

  it('does not let the capability bypass fixed-beta capital drift', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 1_000,
      observedWalletBalanceUsd: 1_000,
      currentRiskEquityUsd: 1_000,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
      hardStopThresholdBindingCapability: 'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1',
    });

    expect(binding.diagnostic.alignment).toBe('RUNTIME_ABOVE_APPROVED_STAGE');
    expect(binding.riskGate).toEqual({
      newHardStopEvaluationAllowed: false,
      activeCapitalConfigurationDriftReason: 'ACTIVE_CAPITAL_RUNTIME_ABOVE_APPROVED_STAGE',
    });
    expect(binding.riskGate).not.toHaveProperty('hardStopPolicyEquityUsd');
    expect(binding.riskGate).not.toHaveProperty('hardStopPolicyReferenceCapitalUsd');
  });

  it('feeds the explicit beta pair into RiskStateMachine without falling back to $920', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 400,
      currentRiskEquityUsd: 368,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
      hardStopThresholdBindingCapability: 'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1',
    });

    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 368,
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
    expect(result.locks.hardStopReason).not.toContain('hard stop $920');
  });

  it('preserves historical HARD_STOP review even with the capability present', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 400,
      currentRiskEquityUsd: 400,
      historicalHardStopTriggerReason: 'legacy hard stop',
      policyContext: 'FIXED_BETA_400',
      hardStopThresholdBindingCapability: 'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1',
    });

    expect(binding.diagnostic.hardStopEvaluationGate)
      .toBe('PRESERVE_EXISTING_HARD_STOP_REVIEW');
    expect(binding.riskGate.newHardStopEvaluationAllowed).toBe(false);
    expect(binding.riskGate).not.toHaveProperty('hardStopPolicyEquityUsd');
    expect(binding.riskGate).not.toHaveProperty('hardStopPolicyReferenceCapitalUsd');
  });
});
