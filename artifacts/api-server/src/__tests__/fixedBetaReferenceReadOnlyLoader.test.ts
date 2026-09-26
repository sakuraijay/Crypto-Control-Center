import { describe, expect, it, vi } from 'vitest';
import { FIXED_BETA_REFERENCE_CONTEXT } from '../workers/fixedBetaReferenceContract';
import { createFixedBetaReferenceSnapshotV1 } from '../workers/fixedBetaReferenceState';
import {
  FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
  prepareFixedBetaReferenceWorkerStateRowV1,
} from '../workers/fixedBetaReferenceWorkerState';
import { loadFixedBetaReferenceWorkerStateReadOnlyV1 } from '../workers/fixedBetaReferenceReadOnlyLoader';

function preparedRow(historicalHardStopPresent = false) {
  const created = createFixedBetaReferenceSnapshotV1({
    rawReferenceContext: FIXED_BETA_REFERENCE_CONTEXT,
    rawPolicyContext: 'FIXED_BETA_400',
    configuredTradingCapitalUsd: 1_000,
    currentRiskEquityUsd: 400,
    dailyPeriodKey: '2026-09-10T00:00:00.000Z',
    weeklyPeriodKey: '2026-09-07T00:00:00.000Z',
    historicalHardStopPresent,
  });
  if (!created.ok) throw new Error(created.reason);

  const prepared = prepareFixedBetaReferenceWorkerStateRowV1(
    created.snapshot,
    historicalHardStopPresent,
  );
  if (!prepared.ok) throw new Error(prepared.reason);
  return prepared.row;
}

describe('fixed beta read-only worker_state loader', () => {
  it('requests only the isolated Fixed Beta key and preserves no-write/no-execution authority', async () => {
    const row = preparedRow(false);
    const reader = vi.fn(async (key: string) => {
      expect(key).toBe(FIXED_BETA_REFERENCE_WORKER_STATE_KEY);
      return row;
    });

    const result = await loadFixedBetaReferenceWorkerStateReadOnlyV1(reader, false);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith('fixed_beta_reference_active_v1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.productionStateMutationAuthorized).toBe(false);
    expect(result.betaExecutionAuthorized).toBe(false);
    expect(result.blockNewEntries).toBe(false);
  });

  it('fails closed when the isolated row is absent instead of auto-bootstrapping Beta state', async () => {
    const result = await loadFixedBetaReferenceWorkerStateReadOnlyV1(async () => null, false);
    expect(result).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_NOT_FOUND',
      blockNewEntries: true,
    });
  });

  it('fails closed on read errors and never converts an outage into Beta initialization', async () => {
    const result = await loadFixedBetaReferenceWorkerStateReadOnlyV1(async () => {
      throw new Error('db unavailable');
    }, false);
    expect(result).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_READ_FAILED',
      blockNewEntries: true,
    });
  });

  it('requires authoritative HARD_STOP evidence before attempting any state read', async () => {
    const reader = vi.fn(async () => preparedRow(false));
    const result = await loadFixedBetaReferenceWorkerStateReadOnlyV1(reader, undefined);
    expect(reader).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID',
      blockNewEntries: true,
    });
  });

  it('re-binds a stale local false to a current authoritative HARD_STOP true', async () => {
    const result = await loadFixedBetaReferenceWorkerStateReadOnlyV1(
      async () => preparedRow(false),
      true,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.historicalHardStopPresent).toBe(true);
    expect(result.authoritativeHistoricalHardStopPresent).toBe(true);
  });

  it('passes malformed rows to the existing strict restore contract and remains fail-closed', async () => {
    const result = await loadFixedBetaReferenceWorkerStateReadOnlyV1(async () => ({
      key: FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
      value: '{not-json',
    }), false);
    expect(result).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_PERSISTED_STATE_INVALID',
      blockNewEntries: true,
    });
  });
});
