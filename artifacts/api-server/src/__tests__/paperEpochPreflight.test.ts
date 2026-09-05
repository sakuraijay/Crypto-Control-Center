import { describe, expect, it } from 'vitest';
import {
  buildPaperEpochPreflight,
  type PaperEpochPreflightInput,
} from '../lib/paperEpochPreflight';
import type { OperationalDiagnostics } from '../lib/operationalDiagnostics';

function diagnostics(overrides: Partial<Record<
  keyof OperationalDiagnostics['flags'],
  boolean | 'PAPER' | 'LIVE' | 'DISABLED' | 'DRY_RUN'
>> = {}): OperationalDiagnostics {
  const value = <T extends boolean | string>(effective: T, approvedTarget: T) => ({
    configured: effective,
    buildObserved: effective,
    approvedTarget,
    effective,
    status: effective === approvedTarget ? 'MATCH' as const : 'DRIFT' as const,
    driftReason: effective === approvedTarget ? null : 'drift',
    buildObservationStatus: 'MATCH' as const,
    buildObservationReason: null,
  });
  return {
    schemaVersion: 2,
    flags: {
      engineMode: value((overrides.engineMode ?? 'PAPER') as 'PAPER' | 'LIVE', 'PAPER'),
      autoWorkerLiveEnabled: value((overrides.autoWorkerLiveEnabled ?? false) as boolean, false),
      liveTestExecutionLocked: value((overrides.liveTestExecutionLocked ?? false) as boolean, false),
      delegatedSignerEnabled: value((overrides.delegatedSignerEnabled ?? true) as boolean, true),
      gmxOrderSubmissionEnabled: value((overrides.gmxOrderSubmissionEnabled ?? true) as boolean, true),
      relaySubmissionEnabled: value((overrides.relaySubmissionEnabled ?? false) as boolean, false),
      relaySubmitNetworkEnabled: value((overrides.relaySubmitNetworkEnabled ?? false) as boolean, false),
      relayMode: value((overrides.relayMode ?? 'DISABLED') as 'DISABLED' | 'DRY_RUN' | 'LIVE', 'DISABLED'),
    },
    provenance: {
      status: 'MATCH',
      driftReason: null,
      workspaceSourceAvailable: true,
      releaseSourceAvailable: true,
      sameCommit: true,
      sameProductTree: true,
    },
  };
}

function input(): PaperEpochPreflightInput {
  return {
    observedAtMs: 1_777_000_000_000,
    counts: {
      openPositionCount: 0,
      pendingApprovalCount: 0,
      pendingCloseCount: 0,
      blockingIntentCount: 0,
      blockingProtectionCount: 0,
      paperExecutorUnresolvedCount: 0,
      unresolvedRelayTaskCount: 0,
      unsettledTradeCount: 0,
      openRelayTaskCount: 0,
    },
    current: {
      activeTradingCapitalUsd: 24.5,
      equityHwmUsd: 1_000,
      dailyRiskBaselineUsd: 24.5,
      weeklyRiskBaselineUsd: 24.5,
      currentEquityUsd: 24.5,
      reserveCashPct: 20,
      riskOperatingState: 'HARD_STOPPED',
      riskEntryAllowed: false,
    },
    operationalDiagnostics: diagnostics(),
    gates: {
      readyForControlledCanary: false,
      stopExecutionAvailable: false,
      hardStopReason: 'historical PAPER hard stop',
    },
  };
}

describe('buildPaperEpochPreflight', () => {
  it('현재 상태를 바꾸지 않고 계획·제안 자본을 별도 계산한다', () => {
    const source = input();
    const before = structuredClone(source);
    const view = buildPaperEpochPreflight(source);

    expect(source).toEqual(before);
    expect(view).toMatchObject({
      boundary: 'READ_ONLY_CALCULATION_NOT_STATE_CHANGE',
      executionAuthorized: false,
      stateChangePerformed: false,
      readyForPaperEpochProposal: true,
      planned: {
        seedCapitalUsd: 10_000,
        activeCapitalStagesUsd: [1_000, 2_500, 5_000, 10_000],
      },
      paperTestAllocationPlan: {
        scope: 'PAPER_TEST_ALLOCATION',
        authority: 'SERVER_CODE_USER_APPROVED_PLAN',
        approvalStatus: 'USER_APPROVED_PLAN',
        applicationStatus: 'PROPOSED_NOT_APPLIED',
        totalAllocationUsd: 400,
        reservePercent: 20,
        reserveUsd: 80,
        deployableUsd: 320,
        walletEligibilityMinimumUsdc: 400,
        futureActiveCapitalPolicyCandidate: {
          baseRiskPerTradePercent: 0.25,
          baseRiskPerTradeUsd: 1,
          maxRiskPerTradePercent: 0.5,
          maxRiskPerTradeUsd: 2,
          hardStopDrawdownPercent: 8,
          hardStopEquityUsd: 368,
          maxLeverage: 3,
          recommendedMaxMarginPerTradeUsd: 100,
          targetRoundTripCostCapUsd: 0.4,
        },
        applied: false,
        executionAuthorized: false,
        autoActivationAllowed: false,
        stateChangePerformed: false,
        runtimeDbHwmUnchanged: true,
      },
      proposedNewEpoch: {
        activeTradingCapitalUsd: 1_000,
        equityHwmUsd: 1_000,
        dailyRiskBaselineUsd: 1_000,
        weeklyRiskBaselineUsd: 1_000,
        applied: false,
        persistenceId: null,
      },
      preservedExecutionGates: {
        readyForControlledCanary: false,
        stopExecutionAvailable: false,
        riskOperatingState: 'HARD_STOPPED',
        riskEntryAllowed: false,
        unchanged: true,
      },
    });
    expect(view.current.activeTradingCapitalUsd).toBe(24.5);
    expect(view.paperTestAllocationPlan).not.toHaveProperty('persistenceId');
  });

  it.each([1_000, 2_500, 5_000, 10_000])(
    '계획 단계 %i USDC는 반복 조회만으로 current capital이나 reserve를 승격하지 않는다',
    (plannedStage) => {
      const source = input();
      const walletBalanceUsd = 10_000;
      const before = structuredClone(source);

      const first = buildPaperEpochPreflight(source);
      const second = buildPaperEpochPreflight(source);

      expect(first.planned.seedCapitalUsd).toBe(walletBalanceUsd);
      expect(first.planned.activeCapitalStagesUsd).toContain(plannedStage);
      expect(first.planned.separation).toBe('PLANNED_SEED_IS_NOT_ACTIVE_OR_RESERVE_CAPITAL');
      expect(first.current.activeTradingCapitalUsd).toBe(24.5);
      expect(first.current.reserveCashPct).toBe(20);
      expect(first.proposedNewEpoch.applied).toBe(false);
      expect(first.proposedNewEpoch.persistenceId).toBeNull();
      expect(first.paperTestAllocationPlan.applied).toBe(false);
      expect(first.paperTestAllocationPlan.executionAuthorized).toBe(false);
      expect(first.paperTestAllocationPlan.autoActivationAllowed).toBe(false);
      expect(first.paperTestAllocationPlan.stateChangePerformed).toBe(false);
      expect(first.paperTestAllocationPlan.runtimeDbHwmUnchanged).toBe(true);
      expect(first.paperTestAllocationPlan).not.toHaveProperty('persistenceId');
      expect(second).toEqual(first);
      expect(source).toEqual(before);
      expect(source.current).not.toHaveProperty('walletBalanceUsd');
    },
  );

  it('non-zero/null 선행조건과 PAPER/Relay 경계 drift를 fail-closed 처리한다', () => {
    const source = input();
    source.counts.pendingCloseCount = 1;
    source.counts.unsettledTradeCount = null;
    source.operationalDiagnostics = diagnostics({
      autoWorkerLiveEnabled: true,
      relaySubmitNetworkEnabled: true,
    });

    const view = buildPaperEpochPreflight(source);
    expect(view.readyForPaperEpochProposal).toBe(false);
    expect(view.blockerIds).toEqual(expect.arrayContaining([
      'PENDINGCLOSECOUNT_NON_ZERO',
      'UNSETTLEDTRADECOUNT_UNAVAILABLE',
      'AUTO_WORKER_LIVE_NOT_DISABLED',
      'RELAY_SUBMIT_NETWORK_NOT_DISABLED',
    ]));
    expect(view.executionAuthorized).toBe(false);
    expect(view.proposedNewEpoch.applied).toBe(false);
  });
});