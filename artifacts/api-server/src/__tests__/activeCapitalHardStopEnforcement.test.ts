import { describe, expect, it } from 'vitest';
import {
  EMPTY_LOCKS,
  evaluateRiskState,
  type RiskEvaluationInput,
} from '../lib/riskStateMachine';

function baseInput(overrides: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    dailyRiskCapitalUsd: 1000,
    weeklyRiskCapitalUsd: 1000,
    currentEquityUsd: 1000,
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

describe('Active Capital drift HARD_STOP enforcement', () => {
  it('blocks entry without creating a new sticky HARD_STOP when runtime capital semantics drift', () => {
    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 24.5,
      newHardStopEvaluationAllowed: false,
      activeCapitalConfigurationDriftReason: 'ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE',
    }));

    expect(result.state).toBe('NORMAL');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.locks.hardStopReason).toBeNull();
    expect(result.blockReasons).toEqual([
      expect.stringContaining('ACTIVE_CAPITAL_CONFIGURATION_DRIFT'),
    ]);
    expect(result.blockReasons[0]).toContain('ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE');
  });

  it('still creates the sticky HARD_STOP when Active Capital semantics are aligned', () => {
    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 919.99,
      newHardStopEvaluationAllowed: true,
    }));

    expect(result.state).toBe('HARD_STOPPED');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual(expect.arrayContaining([
      'CLOSE_ALL_POSITIONS',
      'CANCEL_ALL_ORDERS',
    ]));
    expect(result.locks.hardStopReason).toContain('hard stop $920');
  });

  it('preserves an existing historical HARD_STOP even when fresh evaluation is blocked', () => {
    const historical = 'legacy hard stop trigger — operator review required';
    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 24.5,
      newHardStopEvaluationAllowed: false,
      activeCapitalConfigurationDriftReason: 'ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE',
      locks: { ...EMPTY_LOCKS, hardStopReason: historical },
    }));

    expect(result.state).toBe('HARD_STOPPED');
    expect(result.entryAllowed).toBe(false);
    expect(result.locks.hardStopReason).toBe(historical);
    expect(result.blockReasons[0]).toContain(historical);
  });

  it('keeps legacy callers backward compatible until the Worker passes the explicit gate', () => {
    const result = evaluateRiskState(baseInput({ currentEquityUsd: 919.99 }));
    expect(result.state).toBe('HARD_STOPPED');
    expect(result.locks.hardStopReason).not.toBeNull();
  });
});
