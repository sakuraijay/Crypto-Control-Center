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

  it('evaluates an explicitly gated fixed-beta $368/$400 hard-stop pair without falling back to $920', () => {
    const aboveBetaStop = evaluateRiskState(baseInput({
      dailyRiskCapitalUsd: 400,
      weeklyRiskCapitalUsd: 400,
      currentEquityUsd: 368.01,
      newHardStopEvaluationAllowed: true,
      hardStopPolicyEquityUsd: 368,
      hardStopPolicyReferenceCapitalUsd: 400,
    }));

    expect(aboveBetaStop.state).toBe('NORMAL');
    expect(aboveBetaStop.entryAllowed).toBe(true);
    expect(aboveBetaStop.locks.hardStopReason).toBeNull();

    const atBetaStop = evaluateRiskState(baseInput({
      dailyRiskCapitalUsd: 400,
      weeklyRiskCapitalUsd: 400,
      currentEquityUsd: 368,
      newHardStopEvaluationAllowed: true,
      hardStopPolicyEquityUsd: 368,
      hardStopPolicyReferenceCapitalUsd: 400,
    }));

    expect(atBetaStop.state).toBe('HARD_STOPPED');
    expect(atBetaStop.entryAllowed).toBe(false);
    expect(atBetaStop.actions).toEqual(expect.arrayContaining([
      'CLOSE_ALL_POSITIONS',
      'CANCEL_ALL_ORDERS',
    ]));
    expect(atBetaStop.locks.hardStopReason).toContain('hard stop $368');
    expect(atBetaStop.locks.hardStopReason).toContain('Active $400');
    expect(atBetaStop.locks.hardStopReason).not.toContain('hard stop $920');
  });

  it('fails closed on a partial explicit hard-stop binding without creating a sticky lock', () => {
    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 367,
      newHardStopEvaluationAllowed: true,
      hardStopPolicyEquityUsd: 368,
    }));

    expect(result.state).toBe('NORMAL');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.locks.hardStopReason).toBeNull();
    expect(result.blockReasons).toEqual([
      expect.stringContaining('HARD_STOP_POLICY_BINDING_INVALID'),
    ]);
  });

  it('requires an explicit aligned gate before a custom hard-stop pair can be evaluated', () => {
    const result = evaluateRiskState(baseInput({
      currentEquityUsd: 367,
      hardStopPolicyEquityUsd: 368,
      hardStopPolicyReferenceCapitalUsd: 400,
    }));

    expect(result.state).toBe('NORMAL');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.locks.hardStopReason).toBeNull();
    expect(result.blockReasons).toEqual([
      expect.stringContaining('HARD_STOP_POLICY_BINDING_REQUIRES_EXPLICIT_GATE'),
    ]);
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
