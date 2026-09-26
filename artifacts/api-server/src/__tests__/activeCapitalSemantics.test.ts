import { describe, expect, it } from 'vitest';
import {
  assessActiveCapitalSemantics,
  buildActiveCapitalWorkerBinding,
} from '../lib/activeCapitalSemantics';

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
    expect(result.hardStopEvaluationGate).toBe('EVALUATE_CURRENT_POLICY');
    expect(result.newHardStopEvaluationAllowed).toBe(true);
    expect(result.historicalHardStopPreserved).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it('keeps standard context fail-closed when runtime capital is 400 instead of the approved 1,000 stage', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 400,
      currentRiskEquityUsd: 400,
      historicalHardStopTriggerReason: null,
    });

    expect(result.policyContext).toBe('STANDARD_ACTIVE');
    expect(result.approvedActiveTradingCapitalUsd).toBe(1_000);
    expect(result.hardStopPolicyEquityUsd).toBe(920);
    expect(result.alignment).toBe('RUNTIME_BELOW_APPROVED_STAGE');
    expect(result.hardStopEvaluationGate).toBe('BLOCK_CAPITAL_CONFIGURATION_DRIFT');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
    expect(result.betaScopeRequested).toBe(false);
    expect(result.betaPlanApplied).toBe(false);
    expect(result.betaExecutionAuthorized).toBe(false);
    expect(result.hardStopThresholdBoundToRiskEngine).toBe(true);
    expect(result.blockers).toEqual(['ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE']);
  });

  it('recognizes the fixed-beta 400 context but blocks risk evaluation until the 368 hard-stop is wired', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 400,
      currentRiskEquityUsd: 400,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
    });

    expect(result.policyContext).toBe('FIXED_BETA_400');
    expect(result.approvedActiveTradingCapitalUsd).toBe(400);
    expect(result.hardStopPolicyEquityUsd).toBe(368);
    expect(result.alignment).toBe('ALIGNED');
    expect(result.runtimeConfiguredCapitalAligned).toBe(true);
    expect(result.betaScopeRequested).toBe(true);
    expect(result.betaPlanApplied).toBe(false);
    expect(result.betaExecutionAuthorized).toBe(false);
    expect(result.hardStopThresholdBoundToRiskEngine).toBe(false);
    expect(result.hardStopEvaluationGate).toBe('BLOCK_FIXED_BETA_HARD_STOP_BINDING');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
    expect(result.blockers).toEqual(['FIXED_BETA_HARD_STOP_BINDING_NOT_WIRED']);
  });

  it('fails closed when fixed-beta context receives a post-beta capital stage instead of 400', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 1_000,
      observedWalletBalanceUsd: 1_000,
      currentRiskEquityUsd: 1_000,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
    });

    expect(result.approvedActiveTradingCapitalUsd).toBe(400);
    expect(result.alignment).toBe('RUNTIME_ABOVE_APPROVED_STAGE');
    expect(result.hardStopEvaluationGate).toBe('BLOCK_CAPITAL_CONFIGURATION_DRIFT');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
    expect(result.blockers).toEqual(['ACTIVE_CAPITAL_RUNTIME_ABOVE_APPROVED_STAGE']);
  });

  it('preserves an existing HARD_STOP review ahead of fixed-beta activation semantics', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 400,
      currentRiskEquityUsd: 400,
      historicalHardStopTriggerReason: 'legacy hard stop',
      policyContext: 'FIXED_BETA_400',
    });

    expect(result.alignment).toBe('ALIGNED');
    expect(result.historicalHardStopReviewRequired).toBe(true);
    expect(result.historicalHardStopPreserved).toBe(true);
    expect(result.automaticHardStopClearAllowed).toBe(false);
    expect(result.hardStopEvaluationGate).toBe('PRESERVE_EXISTING_HARD_STOP_REVIEW');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
    expect(result.blockers).toEqual(['HISTORICAL_HARD_STOP_REQUIRES_OPERATOR_REVIEW']);
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
    expect(result.hardStopEvaluationGate).toBe('PRESERVE_EXISTING_HARD_STOP_REVIEW');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
    expect(result.historicalHardStopPreserved).toBe(true);
  });

  it('blocks a fresh HARD_STOP evaluation when legacy runtime capital is below the approved stage', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 24.5,
      observedWalletBalanceUsd: 24.5,
      currentRiskEquityUsd: 24.5,
      historicalHardStopTriggerReason: null,
    });

    expect(result.alignment).toBe('RUNTIME_BELOW_APPROVED_STAGE');
    expect(result.historicalHardStopReviewRequired).toBe(false);
    expect(result.hardStopEvaluationGate).toBe('BLOCK_CAPITAL_CONFIGURATION_DRIFT');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
    expect(result.historicalHardStopPreserved).toBe(false);
    expect(result.blockers).toEqual(['ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE']);
  });

  it('flags values above the approved stage instead of treating them as an automatic promotion', () => {
    const result = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: 2_500,
      observedWalletBalanceUsd: 5_000,
      currentRiskEquityUsd: 2_500,
      historicalHardStopTriggerReason: null,
    });

    expect(result.alignment).toBe('RUNTIME_ABOVE_APPROVED_STAGE');
    expect(result.hardStopEvaluationGate).toBe('BLOCK_CAPITAL_CONFIGURATION_DRIFT');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
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
    expect(result.hardStopEvaluationGate).toBe('BLOCK_CAPITAL_CONFIGURATION_DRIFT');
    expect(result.newHardStopEvaluationAllowed).toBe(false);
    expect(result.blockers).toEqual(['ACTIVE_CAPITAL_RUNTIME_UNAVAILABLE']);
  });
});

describe('worker active-capital risk binding', () => {
  it('emits only the minimal aligned HARD_STOP gate fields for RiskStateMachine', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 1_000,
      observedWalletBalanceUsd: 24.5,
      currentRiskEquityUsd: 950,
      historicalHardStopTriggerReason: null,
    });

    expect(binding.riskGate).toEqual({
      newHardStopEvaluationAllowed: true,
      activeCapitalConfigurationDriftReason: null,
    });
    expect(binding.diagnostic.observedWalletBalanceUsd).toBe(24.5);
    expect(binding.riskGate).not.toHaveProperty('observedWalletBalanceUsd');
    expect(binding.riskGate).not.toHaveProperty('plannedSeedCapitalUsd');
  });

  it('keeps the fixed-beta worker gate blocked until the beta hard-stop threshold is wired', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 400,
      observedWalletBalanceUsd: 400,
      currentRiskEquityUsd: 400,
      historicalHardStopTriggerReason: null,
      policyContext: 'FIXED_BETA_400',
    });

    expect(binding.diagnostic.alignment).toBe('ALIGNED');
    expect(binding.diagnostic.hardStopPolicyEquityUsd).toBe(368);
    expect(binding.riskGate).toEqual({
      newHardStopEvaluationAllowed: false,
      activeCapitalConfigurationDriftReason: 'FIXED_BETA_HARD_STOP_BINDING_NOT_WIRED',
    });
    expect(binding.riskGate).not.toHaveProperty('observedWalletBalanceUsd');
    expect(binding.riskGate).not.toHaveProperty('plannedSeedCapitalUsd');
  });

  it('turns legacy $24.50 runtime capital into a non-sticky fail-closed drift gate', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 24.5,
      observedWalletBalanceUsd: 10_000,
      currentRiskEquityUsd: 24.5,
      historicalHardStopTriggerReason: null,
    });

    expect(binding.riskGate.newHardStopEvaluationAllowed).toBe(false);
    expect(binding.riskGate.activeCapitalConfigurationDriftReason)
      .toBe('ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE');
    expect(binding.diagnostic.walletBalanceTreatedAsActiveCapital).toBe(false);
  });

  it('preserves historical HARD_STOP review while keeping the risk gate free of wallet/seed values', () => {
    const binding = buildActiveCapitalWorkerBinding({
      runtimeConfiguredCapitalUsd: 24.5,
      observedWalletBalanceUsd: 1_000,
      currentRiskEquityUsd: 24.5,
      historicalHardStopTriggerReason: 'legacy hard stop',
    });

    expect(binding.diagnostic.hardStopEvaluationGate)
      .toBe('PRESERVE_EXISTING_HARD_STOP_REVIEW');
    expect(binding.riskGate.newHardStopEvaluationAllowed).toBe(false);
    expect(binding.riskGate.activeCapitalConfigurationDriftReason)
      .toBe('ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE');
    expect(Object.keys(binding.riskGate).sort()).toEqual([
      'activeCapitalConfigurationDriftReason',
      'newHardStopEvaluationAllowed',
    ]);
  });
});
