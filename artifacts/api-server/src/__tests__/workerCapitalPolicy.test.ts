import { describe, expect, it } from 'vitest';
import { FIXED_BETA_RISK_CAPITAL_SCOPE } from '../lib/riskCapital';
import {
  FIXED_BETA_HARD_STOP_BINDING_CAPABILITY,
  resolveWorkerCapitalPolicySelection,
} from '../workers/workerCapitalPolicy';

describe('worker capital policy selection', () => {
  it('keeps the existing Standard Active path when no selector is supplied', () => {
    for (const missing of [undefined, null]) {
      const selection = resolveWorkerCapitalPolicySelection(missing);

      expect(selection).toEqual({
        ok: true,
        policyContext: 'STANDARD_ACTIVE',
        betaRequested: false,
        riskCapitalScope: null,
        effectiveTradingCapitalUsd: null,
        blockNewEntries: false,
      });
    }
  });

  it('keeps explicit STANDARD_ACTIVE on the legacy capital domain', () => {
    const selection = resolveWorkerCapitalPolicySelection('STANDARD_ACTIVE');

    expect(selection.ok).toBe(true);
    expect(selection).toMatchObject({
      policyContext: 'STANDARD_ACTIVE',
      betaRequested: false,
      riskCapitalScope: null,
      effectiveTradingCapitalUsd: null,
      blockNewEntries: false,
    });
    expect(selection).not.toHaveProperty('hardStopThresholdBindingCapability');
  });

  it('maps only explicit FIXED_BETA_400 to the existing 400 scope and HARD_STOP capability', () => {
    const selection = resolveWorkerCapitalPolicySelection('FIXED_BETA_400');

    expect(selection.ok).toBe(true);
    expect(selection).toMatchObject({
      policyContext: 'FIXED_BETA_400',
      betaRequested: true,
      riskCapitalScope: FIXED_BETA_RISK_CAPITAL_SCOPE,
      effectiveTradingCapitalUsd: 400,
      hardStopThresholdBindingCapability: FIXED_BETA_HARD_STOP_BINDING_CAPABILITY,
      blockNewEntries: false,
    });
    expect(FIXED_BETA_HARD_STOP_BINDING_CAPABILITY)
      .toBe('RISK_STATE_MACHINE_EXPLICIT_PAIR_V1');
  });

  it('fails closed for any supplied malformed or inferred-looking selector', () => {
    for (const invalid of [
      '',
      ' FIXED_BETA_400',
      'FIXED_BETA_400 ',
      'fixed_beta_400',
      '2026-09-15',
      '400',
      400,
      true,
      {},
    ]) {
      expect(resolveWorkerCapitalPolicySelection(invalid)).toEqual({
        ok: false,
        reason: 'WORKER_CAPITAL_POLICY_CONTEXT_INVALID',
        blockNewEntries: true,
      });
    }
  });
});
