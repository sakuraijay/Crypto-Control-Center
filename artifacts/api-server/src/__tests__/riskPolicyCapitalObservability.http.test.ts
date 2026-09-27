import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../workers/aiWorker', () => ({
  getWorkerStatus: () => ({
    riskDerivedTargets: null,
    lastLimitsUsed: {
      tradingCapital: 24.5,
      reserveCashPct: 20,
    },
    currentEquityUsd: 24.5,
    equityHwm: 1_000,
    riskHistoricalHardStopTriggerReason: 'historical hard stop',
    riskOperatingState: 'HARD_STOPPED',
    riskEntryAllowed: false,
    riskBlockReasons: ['HARD_STOPPED'],
    riskDbOk: true,
    riskDailyEntryCount: 0,
    riskConsecutiveLossCount: 0,
    riskDayPeriodStart: '2026-09-04T16:00:00.000Z',
    riskWeekPeriodStart: '2026-08-30T16:00:00.000Z',
  }),
}));

import riskRouter from '../routes/risk';

describe('GET /api/risk/policy capital observability contract', () => {
  it('keeps plan, runtime, reserve, wallet, equity, HWM, and RiskEngine state distinct', async () => {
    const app = express();
    app.use('/api', riskRouter);

    const res = await request(app).get('/api/risk/policy');

    expect(res.status).toBe(200);
    expect(res.body.capital).toMatchObject({
      plannedSeedCapitalUsd: 10_000,
      activeTradingCapitalUsd: 1_000,
      reserveCapitalUsd: 200,
      deployableActiveCapitalUsd: 800,
      riskSizingCapitalUsd: 24.5,
      riskSizingReserveUsd: 4.9,
      currentRiskEquityUsd: 24.5,
      equityHwmUsd: 1_000,
      onchainBalanceUsd: null,
      onchainBalanceAuthoritative: false,
      semantics: {
        diagnosticOnly: true,
        plannedSeedCapitalUsd: 10_000,
        approvedActiveTradingCapitalUsd: 1_000,
        runtimeConfiguredCapitalUsd: 24.5,
        observedWalletBalanceUsd: null,
        currentRiskEquityUsd: 24.5,
        walletBalanceTreatedAsActiveCapital: false,
        automaticHardStopClearAllowed: false,
      },
    });
    expect(res.body.tierLadder.map(
      (entry: { capitalUsd: number }) => entry.capitalUsd,
    )).toEqual([15, 1_000, 2_500, 5_000, 10_000]);
    expect(res.body.autoPromotionAllowed).toBe(false);
    expect(res.body.paperTestAllocationPlan).toEqual({
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
    });
    expect(res.body.paperTestAllocationPlan).not.toHaveProperty('persistenceId');
    expect(res.body.state).toMatchObject({
      riskOperatingState: 'HARD_STOPPED',
      riskEntryAllowed: false,
      historicalHardStopTriggerReason: 'historical hard stop',
    });
    expect(res.body.capital.onchainBalanceUsd)
      .not.toBe(res.body.capital.riskSizingCapitalUsd);
    expect(res.body.capital.equityHwmUsd)
      .not.toBe(res.body.capital.currentRiskEquityUsd);
  });
});