// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { RiskPolicyCard } from '../RiskPolicyCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RiskPolicyCard Hard Stop labels', () => {
  it('separates the current $920 policy from a historical $850 trigger snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        capital: {
          plannedSeedCapitalUsd: 10_000,
          activeTradingCapitalUsd: 1_000,
          reserveCapitalPercent: 20,
          reserveCapitalUsd: 200,
          deployableActiveCapitalUsd: 800,
          riskSizingCapitalUsd: 1_000,
          riskSizingReserveUsd: 200,
          riskSizingReservePercent: 20,
          currentRiskEquityUsd: 840,
          equityHwmUsd: 1_000,
          onchainBalanceUsd: null,
          onchainBalanceAuthoritative: false,
          monthlyNetReturnReferenceRangePercent: [1, 3],
        },
        paperTestAllocationPlan: {
          totalAllocationUsd: 400,
          reservePercent: 20,
          reserveUsd: 80,
          deployableUsd: 320,
          futureActiveCapitalPolicyCandidate: {
            baseRiskPerTradeUsd: 1,
            maxRiskPerTradeUsd: 2,
            hardStopEquityUsd: 368,
            maxLeverage: 3,
            recommendedMaxMarginPerTradeUsd: 100,
          },
          applied: false,
          executionAuthorized: false,
          runtimeDbHwmUnchanged: true,
        },
        policy: {
          initialCapitalUsd: 1_000,
          maxRiskCapitalUsd: 1_000,
          primaryProfitTargetPercent: 5,
          absoluteProfitCapPercent: 10,
          protectedProfitFloorPercent: 3.5,
          baseRiskPerTradePercent: 0.25,
          maxRiskPerTradePercent: 0.5,
          defensiveModeLossPercent: 0.5,
          dailyMaxLossPercent: 1,
          weeklyMaxLossPercent: 8,
          hardStopEquityUsd: 920,
          baseMaxLeverage: 3,
          conditionalMaxLeverage: 5,
          conditional5xEnabled: false,
          maxConcurrentPositions: 1,
          maxDailyEntries: 3,
          maxConsecutiveLosses: 3,
          tradingTimezone: 'Asia/Manila',
        },
        canary: {
          canaryMaxCapitalAtRiskUsd: 100,
          canaryMaxCumulativeLossUsd: 10,
          canaryMaxLeverage: 2,
        },
        autoPromotionAllowed: false,
        derived: {
          primaryProfitTargetUsd: 50,
          absoluteProfitCapUsd: 100,
          dailyMaxLossUsd: 10,
          protectedProfitFloorUsd: 35,
          defensiveModeLossUsd: 5,
          weeklyMaxLossUsd: 80,
          baseRiskPerTradeUsd: 2.5,
          absoluteMaxRiskPerTradeUsd: 5,
        },
        state: {
          riskOperatingState: 'HARD_STOPPED',
          riskEntryAllowed: false,
          riskBlockReasons: ['HARD_STOPPED'],
          currentHardStopPolicyEquityUsd: 920,
          historicalHardStopTriggerReason: 'equity $840.00 ≤ hard stop $850',
          riskDbOk: true,
          dailyEntryCount: 0,
          consecutiveLossCount: 0,
        },
        manila: { msUntilNextDay: 60_000 },
      }),
    })));

    render(<RiskPolicyCard />);

    expect(await screen.findByText('현재 Hard Stop 정책 기준')).toBeTruthy();
    expect(screen.getByText(/equity ≤ \$920 — 현재 authoritative 기준/)).toBeTruthy();
    expect(screen.getByText('과거 HARD_STOP 발동 스냅샷:')).toBeTruthy();
    expect(screen.getByText('equity $840.00 ≤ hard stop $850')).toBeTruthy();
    expect(screen.getByText(/상태 발생 당시 기록이며 현재 정책 기준은 아래 별도 행/)).toBeTruthy();
    expect(screen.getByText('Current Risk Sizing / Reserve')).toBeTruthy();
    expect(screen.getByText('Current Equity / HWM')).toBeTruthy();
    expect(screen.getByText('$840 / $1,000 · RiskEngine 관측 상태')).toBeTruthy();
    expect(screen.getByText('On-chain balance')).toBeTruthy();
    expect(screen.getByText('별도 GMX RPC 카드에서 확인')).toBeTruthy();
    expect(screen.getByText('PAPER Test Allocation')).toBeTruthy();
    expect(screen.getByText(/\$400 total = \$320 deployable \+ \$80 reserve/)).toBeTruthy();
    expect(screen.getByText('400 적용 상태')).toBeTruthy();
    expect(screen.getByText(/runtime\/DB\/HWM unchanged · 실행 권한 없음/)).toBeTruthy();
  });
});