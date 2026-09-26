import { describe, expect, it } from 'vitest';
import { FIXED_BETA_RISK_CAPITAL_SCOPE } from '../lib/riskCapital';
import {
  FIXED_BETA_REFERENCE_CONTEXT,
  FIXED_BETA_REFERENCE_STATE_KEYS,
  resolveFixedBetaReferenceContract,
} from '../workers/fixedBetaReferenceContract';

const LEGACY_PAPER_STATE_KEYS = [
  'equity_baseline_daily',
  'equity_baseline_weekly',
  'paper_epoch_active_v1',
] as const;

describe('fixed beta reference contract', () => {
  it('binds explicit Fixed Beta to an isolated 400-USDC reference namespace only', () => {
    const result = resolveFixedBetaReferenceContract(
      FIXED_BETA_REFERENCE_CONTEXT,
      'FIXED_BETA_400',
      1_000,
    );

    expect(result).toMatchObject({
      ok: true,
      referenceContext: FIXED_BETA_REFERENCE_CONTEXT,
      schemaVersion: 1,
      policyContext: 'FIXED_BETA_400',
      referenceCapitalUsd: FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd,
      reuseLegacyDailyWeeklyBaselines: false,
      reuseLegacyPaperEpoch: false,
      reuseLegacyHighWaterMark: false,
      historicalHardStopSticky: true,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
      blockNewEntries: false,
    });

    expect(FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd).toBe(400);
    for (const key of Object.values(FIXED_BETA_REFERENCE_STATE_KEYS)) {
      expect(LEGACY_PAPER_STATE_KEYS).not.toContain(key);
    }
  });

  it('fails closed if Fixed Beta reference identity is missing or malformed', () => {
    for (const invalid of [
      undefined,
      null,
      '',
      'FIXED_BETA_REFERENCE',
      ' FIXED_BETA_REFERENCE_V1',
      'FIXED_BETA_REFERENCE_V1 ',
      '2026-09-15',
      400,
      true,
      {},
    ]) {
      expect(resolveFixedBetaReferenceContract(invalid, 'FIXED_BETA_400', 1_000)).toEqual({
        ok: false,
        reason: 'FIXED_BETA_REFERENCE_CONTEXT_INVALID',
        blockNewEntries: true,
      });
    }
  });

  it('never allows a Fixed Beta reference contract on the Standard Active capital domain', () => {
    expect(resolveFixedBetaReferenceContract(
      FIXED_BETA_REFERENCE_CONTEXT,
      'STANDARD_ACTIVE',
      1_000,
    )).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_POLICY_MISMATCH',
      blockNewEntries: true,
    });
  });

  it('preserves malformed worker-policy failure instead of inferring Fixed Beta', () => {
    expect(resolveFixedBetaReferenceContract(
      FIXED_BETA_REFERENCE_CONTEXT,
      '2026-09-15',
      1_000,
    )).toEqual({
      ok: false,
      reason: 'WORKER_CAPITAL_POLICY_CONTEXT_INVALID',
      blockNewEntries: true,
    });
  });

  it('never increases undersized configured capital to manufacture a 400-USDC reference domain', () => {
    expect(resolveFixedBetaReferenceContract(
      FIXED_BETA_REFERENCE_CONTEXT,
      'FIXED_BETA_400',
      399.99,
    )).toEqual({
      ok: false,
      reason: 'WORKER_FIXED_BETA_CAPITAL_UNDERSIZED',
      blockNewEntries: true,
    });
  });

  it('fails closed for invalid configured capital and grants no persistence or execution authority', () => {
    for (const invalid of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      expect(resolveFixedBetaReferenceContract(
        FIXED_BETA_REFERENCE_CONTEXT,
        'FIXED_BETA_400',
        invalid,
      )).toEqual({
        ok: false,
        reason: 'WORKER_CONFIGURED_TRADING_CAPITAL_INVALID',
        blockNewEntries: true,
      });
    }
  });
});
