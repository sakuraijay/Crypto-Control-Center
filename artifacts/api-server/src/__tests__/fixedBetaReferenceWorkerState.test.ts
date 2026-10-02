import { describe, expect, it } from 'vitest';
import { BASELINE_DAILY_KEY, BASELINE_WEEKLY_KEY } from '../lib/equityBaselines';
import { PAPER_EPOCH_ACTIVE_KEY } from '../lib/paperEpochState';
import { RISK_ENGINE_STATE_KEY } from '../lib/riskEngineState';
import { FIXED_BETA_REFERENCE_CONTEXT } from '../workers/fixedBetaReferenceContract';
import {
  advanceFixedBetaReferenceSnapshotV1,
  createFixedBetaReferenceSnapshotV1,
} from '../workers/fixedBetaReferenceState';
import {
  FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
  prepareFixedBetaReferenceWorkerStateRowV1,
  restoreFixedBetaReferenceWorkerStateRowV1,
} from '../workers/fixedBetaReferenceWorkerState';

const baseInput = {
  rawReferenceContext: FIXED_BETA_REFERENCE_CONTEXT,
  rawPolicyContext: 'FIXED_BETA_400',
  configuredTradingCapitalUsd: 1_000,
  currentRiskEquityUsd: 400,
  dailyPeriodKey: '2026-09-10T00:00:00.000Z',
  weeklyPeriodKey: '2026-09-07T00:00:00.000Z',
  historicalHardStopPresent: false,
} as const;

function createSnapshot(historicalHardStopPresent = false) {
  const created = createFixedBetaReferenceSnapshotV1({
    ...baseInput,
    historicalHardStopPresent,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.snapshot;
}

describe('fixed beta worker_state adapter', () => {
  it('serializes only the isolated active key and grants no Production or execution authority', () => {
    const result = prepareFixedBetaReferenceWorkerStateRowV1(createSnapshot(), false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.row.key).toBe('fixed_beta_reference_active_v1');
    expect(result.row.key).toBe(FIXED_BETA_REFERENCE_WORKER_STATE_KEY);
    expect(result.productionStateMutationAuthorized).toBe(false);
    expect(result.betaExecutionAuthorized).toBe(false);
    expect(result.blockNewEntries).toBe(false);
    expect(result.metrics).toEqual({
      dailyPnlUsd: 0,
      weeklyPnlUsd: 0,
      drawdownPercent: 0,
    });

    const serialized = JSON.parse(result.row.value) as Record<string, unknown>;
    expect(serialized.productionStateMutationAuthorized).toBe(false);
    expect(serialized.betaExecutionAuthorized).toBe(false);
  });

  it('re-binds current authoritative HARD_STOP so stale local false cannot weaken Risk Engine authority', () => {
    const prepared = prepareFixedBetaReferenceWorkerStateRowV1(createSnapshot(false), false);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.snapshot.historicalHardStopPresent).toBe(false);

    const restored = restoreFixedBetaReferenceWorkerStateRowV1(prepared.row, true);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.snapshot.historicalHardStopPresent).toBe(true);
    expect(restored.authoritativeHistoricalHardStopPresent).toBe(true);
  });

  it('keeps a persisted historical HARD_STOP sticky when a later authoritative observation is false', () => {
    const prepared = prepareFixedBetaReferenceWorkerStateRowV1(createSnapshot(true), true);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const restored = restoreFixedBetaReferenceWorkerStateRowV1(prepared.row, false);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.snapshot.historicalHardStopPresent).toBe(true);
  });

  it('preserves isolated 400-USDC period metrics across a worker_state round trip', () => {
    const initial = createSnapshot();
    const advanced = advanceFixedBetaReferenceSnapshotV1(initial, {
      currentRiskEquityUsd: 390,
      dailyPeriodKey: baseInput.dailyPeriodKey,
      weeklyPeriodKey: baseInput.weeklyPeriodKey,
      historicalHardStopPresent: false,
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;

    const prepared = prepareFixedBetaReferenceWorkerStateRowV1(advanced.snapshot, false);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const restored = restoreFixedBetaReferenceWorkerStateRowV1({
      ...prepared.row,
      updatedAt: new Date().toISOString(),
    }, false);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(restored.snapshot.dailyStartEquityUsd).toBe(400);
    expect(restored.snapshot.weeklyStartEquityUsd).toBe(400);
    expect(restored.snapshot.currentRiskEquityUsd).toBe(390);
    expect(restored.metrics.dailyPnlUsd).toBe(-10);
    expect(restored.metrics.weeklyPnlUsd).toBe(-10);
    expect(restored.metrics.drawdownPercent).toBeCloseTo(2.5, 8);
  });

  it('rejects legacy Standard/PAPER/HWM/Risk keys instead of aliasing them into Fixed Beta state', () => {
    const prepared = prepareFixedBetaReferenceWorkerStateRowV1(createSnapshot(), false);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    for (const key of [
      BASELINE_DAILY_KEY,
      BASELINE_WEEKLY_KEY,
      PAPER_EPOCH_ACTIVE_KEY,
      RISK_ENGINE_STATE_KEY,
      'equityHwm',
    ]) {
      expect(restoreFixedBetaReferenceWorkerStateRowV1({
        key,
        value: prepared.row.value,
      }, false)).toEqual({
        ok: false,
        reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_KEY_INVALID',
        blockNewEntries: true,
      });
    }
  });

  it('fails closed for malformed values, tampered snapshots, and missing authoritative HARD_STOP evidence', () => {
    const prepared = prepareFixedBetaReferenceWorkerStateRowV1(createSnapshot(), false);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(restoreFixedBetaReferenceWorkerStateRowV1({
      key: FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
      value: 400,
    }, false)).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_VALUE_INVALID',
      blockNewEntries: true,
    });

    const tampered = {
      ...(JSON.parse(prepared.row.value) as Record<string, unknown>),
      betaExecutionAuthorized: true,
    };
    expect(restoreFixedBetaReferenceWorkerStateRowV1({
      key: FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
      value: JSON.stringify(tampered),
    }, false)).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_PERSISTED_STATE_INVALID',
      blockNewEntries: true,
    });

    expect(restoreFixedBetaReferenceWorkerStateRowV1(prepared.row, undefined)).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID',
      blockNewEntries: true,
    });
  });
});
