import { describe, expect, it } from 'vitest';
import { FIXED_BETA_RISK_CAPITAL_SCOPE } from '../lib/riskCapital';
import {
  FIXED_BETA_HARD_STOP_BINDING_CAPABILITY,
  resolveWorkerCapitalExecutionDomain,
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

describe('worker capital execution domain', () => {
  it('preserves configured Standard Active capital exactly', () => {
    expect(resolveWorkerCapitalExecutionDomain(undefined, 1_000)).toEqual({
      ok: true,
      selection: {
        ok: true,
        policyContext: 'STANDARD_ACTIVE',
        betaRequested: false,
        riskCapitalScope: null,
        effectiveTradingCapitalUsd: null,
        blockNewEntries: false,
      },
      configuredTradingCapitalUsd: 1_000,
      effectiveTradingCapitalUsd: 1_000,
      blockNewEntries: false,
    });
  });

  it('scopes explicit Fixed Beta calculations to 400 without mutating the configured 1K domain', () => {
    const domain = resolveWorkerCapitalExecutionDomain('FIXED_BETA_400', 1_000);

    expect(domain).toMatchObject({
      ok: true,
      configuredTradingCapitalUsd: 1_000,
      effectiveTradingCapitalUsd: 400,
      blockNewEntries: false,
      selection: {
        policyContext: 'FIXED_BETA_400',
        betaRequested: true,
        riskCapitalScope: FIXED_BETA_RISK_CAPITAL_SCOPE,
        effectiveTradingCapitalUsd: 400,
        hardStopThresholdBindingCapability: FIXED_BETA_HARD_STOP_BINDING_CAPABILITY,
      },
    });
  });

  it('never increases an undersized configured capital domain to reach the 400 beta scope', () => {
    expect(resolveWorkerCapitalExecutionDomain('FIXED_BETA_400', 399.99)).toEqual({
      ok: false,
      reason: 'WORKER_FIXED_BETA_CAPITAL_UNDERSIZED',
      blockNewEntries: true,
    });
  });

  it('fails closed for invalid configured capital instead of manufacturing a usable domain', () => {
    for (const invalid of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      expect(resolveWorkerCapitalExecutionDomain('STANDARD_ACTIVE', invalid)).toEqual({
        ok: false,
        reason: 'WORKER_CONFIGURED_TRADING_CAPITAL_INVALID',
        blockNewEntries: true,
      });
    }
  });

  it('preserves malformed selector failure instead of falling back to Standard Active', () => {
    expect(resolveWorkerCapitalExecutionDomain('2026-09-15', 1_000)).toEqual({
      ok: false,
      reason: 'WORKER_CAPITAL_POLICY_CONTEXT_INVALID',
      blockNewEntries: true,
    });
  });
});
