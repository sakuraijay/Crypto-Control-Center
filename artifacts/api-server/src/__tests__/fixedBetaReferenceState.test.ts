import { describe, expect, it } from 'vitest';
import { FIXED_BETA_REFERENCE_CONTEXT } from '../workers/fixedBetaReferenceContract';
import {
  advanceFixedBetaReferenceSnapshotV1,
  createFixedBetaReferenceSnapshotV1,
  restoreFixedBetaReferenceSnapshotV1,
} from '../workers/fixedBetaReferenceState';

const baseInput = {
  rawReferenceContext: FIXED_BETA_REFERENCE_CONTEXT,
  rawPolicyContext: 'FIXED_BETA_400',
  configuredTradingCapitalUsd: 1_000,
  currentRiskEquityUsd: 400,
  dailyPeriodKey: '2026-09-10T00:00:00.000Z',
  weeklyPeriodKey: '2026-09-07T00:00:00.000Z',
  historicalHardStopPresent: false,
} as const;

describe('fixed beta reference restart-safe state', () => {
  it('starts an isolated 400-USDC reference at zero period PnL without Production authority', () => {
    const created = createFixedBetaReferenceSnapshotV1(baseInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.snapshot).toMatchObject({
      referenceContext: 'FIXED_BETA_REFERENCE_V1',
      policyContext: 'FIXED_BETA_400',
      referenceCapitalUsd: 400,
      dailyStartEquityUsd: 400,
      weeklyStartEquityUsd: 400,
      referenceHwmUsd: 400,
      currentRiskEquityUsd: 400,
      historicalHardStopPresent: false,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
    });
    expect(created.metrics).toEqual({
      dailyPnlUsd: 0,
      weeklyPnlUsd: 0,
      drawdownPercent: 0,
    });
  });

  it('tracks a real 10-USDC loss instead of fabricating the legacy 1K-to-400 loss', () => {
    const created = createFixedBetaReferenceSnapshotV1(baseInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const next = advanceFixedBetaReferenceSnapshotV1(created.snapshot, {
      currentRiskEquityUsd: 390,
      dailyPeriodKey: baseInput.dailyPeriodKey,
      weeklyPeriodKey: baseInput.weeklyPeriodKey,
      historicalHardStopPresent: false,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;

    expect(next.metrics.dailyPnlUsd).toBe(-10);
    expect(next.metrics.weeklyPnlUsd).toBe(-10);
    expect(next.metrics.drawdownPercent).toBeCloseTo(2.5, 8);
    expect(next.snapshot.dailyStartEquityUsd).toBe(400);
    expect(next.snapshot.weeklyStartEquityUsd).toBe(400);
    expect(next.snapshot.referenceHwmUsd).toBe(400);
  });

  it('restores the same reference identity and baselines after JSON restart', () => {
    const created = createFixedBetaReferenceSnapshotV1(baseInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const restored = restoreFixedBetaReferenceSnapshotV1(JSON.stringify(created.snapshot));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(restored.snapshot).toEqual(created.snapshot);
    const next = advanceFixedBetaReferenceSnapshotV1(restored.snapshot, {
      currentRiskEquityUsd: 395,
      dailyPeriodKey: baseInput.dailyPeriodKey,
      weeklyPeriodKey: baseInput.weeklyPeriodKey,
      historicalHardStopPresent: false,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.metrics.dailyPnlUsd).toBe(-5);
    expect(next.metrics.weeklyPnlUsd).toBe(-5);
  });

  it('rolls only the changed beta period baseline and preserves the isolated HWM', () => {
    const created = createFixedBetaReferenceSnapshotV1(baseInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const next = advanceFixedBetaReferenceSnapshotV1(created.snapshot, {
      currentRiskEquityUsd: 390,
      dailyPeriodKey: '2026-09-11T00:00:00.000Z',
      weeklyPeriodKey: baseInput.weeklyPeriodKey,
      historicalHardStopPresent: false,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;

    expect(next.snapshot.dailyStartEquityUsd).toBe(390);
    expect(next.snapshot.weeklyStartEquityUsd).toBe(400);
    expect(next.snapshot.referenceHwmUsd).toBe(400);
    expect(next.metrics.dailyPnlUsd).toBe(0);
    expect(next.metrics.weeklyPnlUsd).toBe(-10);
  });

  it('keeps historical HARD_STOP sticky across subsequent state advances', () => {
    const created = createFixedBetaReferenceSnapshotV1(baseInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const stopped = advanceFixedBetaReferenceSnapshotV1(created.snapshot, {
      currentRiskEquityUsd: 370,
      dailyPeriodKey: baseInput.dailyPeriodKey,
      weeklyPeriodKey: baseInput.weeklyPeriodKey,
      historicalHardStopPresent: true,
    });
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;

    const later = advanceFixedBetaReferenceSnapshotV1(stopped.snapshot, {
      currentRiskEquityUsd: 380,
      dailyPeriodKey: baseInput.dailyPeriodKey,
      weeklyPeriodKey: baseInput.weeklyPeriodKey,
      historicalHardStopPresent: false,
    });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.snapshot.historicalHardStopPresent).toBe(true);
  });

  it('fails closed for Standard/malformed context and invalid equity or period keys', () => {
    expect(createFixedBetaReferenceSnapshotV1({
      ...baseInput,
      rawPolicyContext: 'STANDARD_ACTIVE',
    })).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_CONTRACT_INVALID',
      blockNewEntries: true,
    });

    expect(createFixedBetaReferenceSnapshotV1({
      ...baseInput,
      currentRiskEquityUsd: Number.NaN,
    })).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_EQUITY_INVALID',
      blockNewEntries: true,
    });

    expect(createFixedBetaReferenceSnapshotV1({
      ...baseInput,
      dailyPeriodKey: '',
    })).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_PERIOD_KEY_INVALID',
      blockNewEntries: true,
    });
  });

  it('rejects tampered restart snapshots, including attempts to grant execution or persistence authority', () => {
    const created = createFixedBetaReferenceSnapshotV1(baseInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    for (const tampered of [
      { ...created.snapshot, betaExecutionAuthorized: true },
      { ...created.snapshot, productionStateMutationAuthorized: true },
      { ...created.snapshot, referenceCapitalUsd: 1_000 },
      { ...created.snapshot, activeStateKey: 'paper_epoch_active_v1' },
      { ...created.snapshot, referenceHwmUsd: 399 },
    ]) {
      const result = restoreFixedBetaReferenceSnapshotV1(tampered);
      expect(result).toEqual({
        ok: false,
        reason: 'FIXED_BETA_REFERENCE_STATE_VALUES_INVALID',
        blockNewEntries: true,
      });
    }
  });
});
