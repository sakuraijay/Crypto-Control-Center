/**
 * /api/risk — RiskEngine 정책·상태 조회 (6H-1 §13).
 * 읽기 전용 — 정책 값은 코드 상수(RISK_POLICY)이며 API로 변경 불가.
 */
import { Router, type IRouter } from 'express';
import {
  RISK_POLICY, CANARY_POLICY, CAPITAL_PLAN, CAPITAL_TIER_LADDER,
  deriveDailyTargets, deriveWeeklyMaxLossUsd, deriveTradeRiskUsd,
  isAutoPromotionAllowed,
} from '../lib/riskPolicy';
import { assessActiveCapitalSemantics } from '../lib/activeCapitalSemantics';
import { msUntilNextManilaDay, manilaDayStartIso, manilaWeekStartIso } from '../lib/manilaTime';
import { getWorkerStatus } from '../workers/aiWorker';

const router: IRouter = Router();

router.get('/risk/policy', (_req, res) => {
  try {
    const status = getWorkerStatus();
    const now = new Date();

    // 파생값은 start-of-day risk capital 기준 (worker 상태 있으면 그 값, 없으면 정책 기준 $1,000)
    const derived = status.riskDerivedTargets
      ?? deriveDailyTargets(RISK_POLICY.maxRiskCapitalUsd);
    const trade = deriveTradeRiskUsd(RISK_POLICY.maxRiskCapitalUsd);
    const riskSizingCapitalUsd = status.lastLimitsUsed?.tradingCapital
      ?? CAPITAL_PLAN.activeTradingCapitalUsd;
    const riskSizingReservePercent = status.lastLimitsUsed?.reserveCashPct
      ?? CAPITAL_PLAN.reserveCapitalPercent;
    const riskSizingReserveUsd = riskSizingCapitalUsd * riskSizingReservePercent / 100;
    const capitalSemantics = assessActiveCapitalSemantics({
      runtimeConfiguredCapitalUsd: status.lastLimitsUsed?.tradingCapital,
      // 지갑 잔액은 이 endpoint의 Risk 상태와 결합하지 않는다. 별도 RPC read-only 원본이 필요하다.
      observedWalletBalanceUsd: null,
      currentRiskEquityUsd: status.currentEquityUsd,
      historicalHardStopTriggerReason: status.riskHistoricalHardStopTriggerReason,
    });

    res.json({
      policy: RISK_POLICY,
      capital: {
        ...CAPITAL_PLAN,
        riskSizingCapitalUsd,
        riskSizingReserveUsd,
        riskSizingReservePercent,
        onchainBalanceUsd: null,
        onchainBalanceAuthoritative: false,
        semantics: capitalSemantics,
      },
      canary: CANARY_POLICY,
      tierLadder: CAPITAL_TIER_LADDER,
      autoPromotionAllowed: isAutoPromotionAllowed(),
      derived: {
        ...derived,
        weeklyMaxLossUsd: deriveWeeklyMaxLossUsd(RISK_POLICY.maxRiskCapitalUsd),
        baseRiskPerTradeUsd: trade.baseRiskUsd,
        absoluteMaxRiskPerTradeUsd: trade.absoluteMaxRiskUsd,
      },
      state: {
        riskOperatingState:       status.riskOperatingState,
        riskEntryAllowed:         status.riskEntryAllowed,
        riskBlockReasons:         status.riskBlockReasons,
        currentHardStopPolicyEquityUsd: RISK_POLICY.hardStopEquityUsd,
        historicalHardStopTriggerReason: status.riskHistoricalHardStopTriggerReason,
        riskDbOk:                 status.riskDbOk,
        dailyEntryCount:          status.riskDailyEntryCount,
        consecutiveLossCount:     status.riskConsecutiveLossCount,
        dayPeriodStart:           status.riskDayPeriodStart,
        weekPeriodStart:          status.riskWeekPeriodStart,
      },
      manila: {
        currentDayStart:  manilaDayStartIso(now),
        currentWeekStart: manilaWeekStartIso(now),
        msUntilNextDay:   msUntilNextManilaDay(now),
      },
      serverTime: now.toISOString(),
    });
  } catch (err) {
    // 정책 조회 실패 시에도 fail-closed 신호를 명확히 — UI는 "Unavailable" 표시
    res.status(500).json({ error: 'risk policy unavailable' });
  }
});

export default router;
