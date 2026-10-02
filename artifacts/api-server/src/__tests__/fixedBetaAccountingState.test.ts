import { describe, expect, it } from 'vitest';
import { EMPTY_LOCKS } from '../lib/riskStateMachine';
import {
  FIXED_BETA_ACCOUNTING_SCHEMA_VERSION,
  FIXED_BETA_TRADE_STRATEGY,
  fixedBetaLedgerBinding,
  isFixedBetaAccountingStateFresh,
  parseFixedBetaAccountingStateV1,
} from '../workers/fixedBetaAccountingState';
import { parseWorkerPolicyContextV1 } from '../workers/workerPolicyContext';

function provisioned(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: FIXED_BETA_ACCOUNTING_SCHEMA_VERSION,
    policyContext: 'FIXED_BETA_400',
    referenceContext: 'FIXED_BETA_REFERENCE_V1',
    referenceCapitalUsd: 400,
    authoritativeHistoricalHardStopPresent: true,
    provenance: {
      tradeStrategy: FIXED_BETA_TRADE_STRATEGY,
      checkpointId: 'close-claim:alpha-1',
      checkpointedAt: '2026-09-18T00:00:00.000Z',
      ledgerBinding: fixedBetaLedgerBinding([]),
    },
    state: {
      dayPeriodStart: '2026-09-18T00:00:00.000Z',
      weekPeriodStart: '2026-09-14T16:00:00.000Z',
      startOfDayEquityUsd: 400,
      startOfWeekEquityUsd: 400,
      dailyRealizedNetPnlUsd: -31.5,
      dailyLossAwareNetPnlUsd: -31.5,
      weeklyRealizedNetPnlUsd: -31.5,
      dailyEntryCount: 2,
      consecutiveLossCount: 2,
      riskOperatingState: 'HARD_STOPPED',
      locks: { ...EMPTY_LOCKS, hardStopReason: 'hard stop $368 Active $400' },
      lastUpdatedAt: '2026-09-18T00:01:00.000Z',
    },
    ...overrides,
  };
}

describe('fixed-beta durable accounting envelope', () => {
  it('round-trips nonzero losses, counts, and sticky HARD_STOP across a simulated restart', () => {
    const persisted = JSON.stringify(provisioned());
    const first = parseFixedBetaAccountingStateV1(persisted);
    const restarted = parseFixedBetaAccountingStateV1(persisted);
    expect(first?.state.dailyRealizedNetPnlUsd).toBe(-31.5);
    expect(restarted?.state.dailyEntryCount).toBe(2);
    expect(restarted?.state.locks.hardStopReason).toContain('hard stop $368');
  });

  it.each([
    undefined,
    '{bad json',
    JSON.stringify(provisioned({ referenceCapitalUsd: 0 })),
    JSON.stringify(provisioned({ state: { ...provisioned().state, dailyRealizedNetPnlUsd: undefined } })),
    JSON.stringify(provisioned({ state: { ...provisioned().state, locks: { ...EMPTY_LOCKS } } })),
  ])('rejects missing or corrupt alpha evidence without inventing zero state', raw => {
    expect(parseFixedBetaAccountingStateV1(raw)).toBeNull();
  });

  it('treats only missing selector as legacy Standard and rejects unknown selector', () => {
    expect(parseWorkerPolicyContextV1(null)).toEqual({ ok: true, context: null });
    expect(parseWorkerPolicyContextV1(JSON.stringify({
      schemaVersion: 1, policyContext: '400', approvedBy: 'OPERATOR_AUTH_V1',
      approvedAt: '2026-09-18T00:00:00.000Z',
    }))).toEqual({ ok: false, reason: 'WORKER_POLICY_CONTEXT_INVALID' });
  });

  it('marks stale alpha checkpoints unusable instead of rebuilding a zero baseline', () => {
    const state = parseFixedBetaAccountingStateV1(JSON.stringify(provisioned()));
    expect(state && isFixedBetaAccountingStateFresh(
      state,
      Date.parse('2026-09-27T00:00:01.000Z'),
    )).toBe(false);
  });

  it.each([
    { dailyEntryCount: -1 },
    { consecutiveLossCount: 1.5 },
    { dailyEntryCount: Number.MAX_SAFE_INTEGER + 1 },
    { startOfDayEquityUsd: 0 },
    { locks: { ...EMPTY_LOCKS, hardStopReason: ' ', defensiveEntriesUsed: 0 } },
    { locks: { ...EMPTY_LOCKS, hardStopReason: 'retained', defensiveEntriesUsed: -1 } },
    { locks: { ...EMPTY_LOCKS, hardStopReason: 'retained', defensiveEntriesUsed: 0.5 } },
    { locks: { ...EMPTY_LOCKS, hardStopReason: 'retained', dailyLockState: 'invented' } },
    { locks: { ...EMPTY_LOCKS, hardStopReason: 'retained', dailyLockState: 'DAILY_LOSS_LOCKED' } },
    { locks: { ...EMPTY_LOCKS, hardStopReason: 'retained', protectedProfitFloorUsd: -1 } },
    { riskOperatingState: 'WEEKLY_LOSS_LOCKED' },
    { riskOperatingState: 'PROFIT_PROTECTED' },
  ])('rejects invalid counters, locks, or lock/state relationships %j', stateOverride => {
    const row = provisioned();
    expect(parseFixedBetaAccountingStateV1(JSON.stringify({
      ...row, state: { ...row.state, ...stateOverride },
    }))).toBeNull();
  });

  it('does not infer a historical hard-stop boolean from a missing reason', () => {
    const row = provisioned({ authoritativeHistoricalHardStopPresent: false });
    expect(parseFixedBetaAccountingStateV1(JSON.stringify({
      ...row, state: { ...row.state, locks: { ...EMPTY_LOCKS } },
    }))).toBeNull();
  });

  it('rejects old envelopes without immutable complete-ledger metadata', () => {
    const row = provisioned();
    expect(parseFixedBetaAccountingStateV1(JSON.stringify({
      ...row, provenance: { ...row.provenance, ledgerBinding: undefined },
    }))).toBeNull();
  });

  it('canonical proof binds row IDs, historical risk fields and open inventory independent of row/key order', () => {
    const rows = [
      { id: 'open', action: 'OPEN', closeTime: 0, sizeInUsd: '100', side: 'SHORT' },
      { id: 'old-loss', action: 'CLOSE', closeTime: 1234, netPnlUsd: '-20' },
    ];
    const proof = fixedBetaLedgerBinding(rows);
    expect(proof.openTradeIds).toEqual(['open']);
    expect(fixedBetaLedgerBinding([...rows].reverse().map(row =>
      Object.fromEntries(Object.entries(row).reverse()),
    ))).toEqual(proof);
    expect(fixedBetaLedgerBinding(rows.slice(0, 1)).sha256).not.toBe(proof.sha256);
    expect(fixedBetaLedgerBinding([{ ...rows[0], sizeInUsd: '10' }, rows[1]]).sha256).not.toBe(proof.sha256);
    expect(fixedBetaLedgerBinding([rows[0], { ...rows[1], netPnlUsd: '-2' }]).sha256).not.toBe(proof.sha256);
    expect(fixedBetaLedgerBinding([{ ...rows[0], closeTime: 1234 }, rows[1]]).openTradeIds).toEqual([]);
  });
});