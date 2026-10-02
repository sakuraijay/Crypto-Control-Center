import { describe, expect, it, vi } from 'vitest';
import { FIXED_BETA_REFERENCE_CONTEXT } from '../workers/fixedBetaReferenceContract';
import { createFixedBetaReferenceSnapshotV1 } from '../workers/fixedBetaReferenceState';
import { prepareFixedBetaReferenceWorkerStateRowV1 } from '../workers/fixedBetaReferenceWorkerState';
import { resolveFixedBetaWorkerCycleCapitalContextV1 } from '../workers/fixedBetaWorkerCycleCapitalContext';

function preparedRow() {
  const created = createFixedBetaReferenceSnapshotV1({
    rawReferenceContext: FIXED_BETA_REFERENCE_CONTEXT,
    rawPolicyContext: 'FIXED_BETA_400',
    configuredTradingCapitalUsd: 1_000,
    currentRiskEquityUsd: 400,
    dailyPeriodKey: '2026-09-10T00:00:00.000Z',
    weeklyPeriodKey: '2026-09-07T00:00:00.000Z',
    historicalHardStopPresent: false,
  });
  if (!created.ok) throw new Error(created.reason);

  const prepared = prepareFixedBetaReferenceWorkerStateRowV1(created.snapshot, false);
  if (!prepared.ok) throw new Error(prepared.reason);
  return prepared.row;
}

describe('fixed beta worker cycle capital context', () => {
  it('preserves Standard Active capital and never reads Fixed Beta state', async () => {
    const reader = vi.fn(async () => preparedRow());
    const result = await resolveFixedBetaWorkerCycleCapitalContextV1({
      rawPolicyContext: 'STANDARD_ACTIVE',
      configuredTradingCapitalUsd: 1_000,
      authoritativeHistoricalHardStopPresent: undefined,
      readWorkerStateRow: reader,
    });

    expect(reader).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      betaRequested: false,
      policyContext: 'STANDARD_ACTIVE',
      configuredTradingCapitalUsd: 1_000,
      effectiveTradingCapitalUsd: 1_000,
      riskCapitalScope: null,
      hardStopThresholdBindingCapability: null,
      fixedBetaReference: null,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
      blockNewEntries: false,
    });
  });

  it('scopes an explicitly selected Fixed Beta cycle to 400 and requires the isolated reference row', async () => {
    const row = preparedRow();
    const reader = vi.fn(async () => row);
    const result = await resolveFixedBetaWorkerCycleCapitalContextV1({
      rawPolicyContext: 'FIXED_BETA_400',
      configuredTradingCapitalUsd: 1_000,
      authoritativeHistoricalHardStopPresent: false,
      readWorkerStateRow: reader,
    });

    expect(reader).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.betaRequested) return;
    expect(result.effectiveTradingCapitalUsd).toBe(400);
    expect(result.riskCapitalScope).toEqual({ maxRiskCapitalUsd: 400 });
    expect(result.hardStopThresholdBindingCapability).toBe('RISK_STATE_MACHINE_EXPLICIT_PAIR_V1');
    expect(result.fixedBetaReference.snapshot.referenceCapitalUsd).toBe(400);
    expect(result.fixedBetaReference.metrics).toEqual({
      dailyPnlUsd: 0,
      weeklyPnlUsd: 0,
      drawdownPercent: 0,
    });
    expect(result.productionStateMutationAuthorized).toBe(false);
    expect(result.betaExecutionAuthorized).toBe(false);
    expect(result.blockNewEntries).toBe(false);
  });

  it('fails closed before any state read when configured capital is smaller than the 400 beta scope', async () => {
    const reader = vi.fn(async () => preparedRow());
    const result = await resolveFixedBetaWorkerCycleCapitalContextV1({
      rawPolicyContext: 'FIXED_BETA_400',
      configuredTradingCapitalUsd: 399.99,
      authoritativeHistoricalHardStopPresent: false,
      readWorkerStateRow: reader,
    });

    expect(reader).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: 'WORKER_FIXED_BETA_CAPITAL_UNDERSIZED',
      blockNewEntries: true,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
    });
  });

  it('fails closed when beta is selected but no read-only state reader is supplied', async () => {
    const result = await resolveFixedBetaWorkerCycleCapitalContextV1({
      rawPolicyContext: 'FIXED_BETA_400',
      configuredTradingCapitalUsd: 1_000,
      authoritativeHistoricalHardStopPresent: false,
      readWorkerStateRow: null,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_READER_UNAVAILABLE',
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
      blockNewEntries: true,
    });
  });

  it('requires fresh authoritative HARD_STOP evidence for beta and does not weaken a true lock', async () => {
    const row = preparedRow();
    const reader = vi.fn(async () => row);

    const unavailable = await resolveFixedBetaWorkerCycleCapitalContextV1({
      rawPolicyContext: 'FIXED_BETA_400',
      configuredTradingCapitalUsd: 1_000,
      authoritativeHistoricalHardStopPresent: undefined,
      readWorkerStateRow: reader,
    });
    expect(reader).not.toHaveBeenCalled();
    expect(unavailable).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID',
      blockNewEntries: true,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
    });

    const locked = await resolveFixedBetaWorkerCycleCapitalContextV1({
      rawPolicyContext: 'FIXED_BETA_400',
      configuredTradingCapitalUsd: 1_000,
      authoritativeHistoricalHardStopPresent: true,
      readWorkerStateRow: async () => row,
    });
    expect(locked.ok).toBe(true);
    if (!locked.ok || !locked.betaRequested) return;
    expect(locked.fixedBetaReference.snapshot.historicalHardStopPresent).toBe(true);
  });
});
