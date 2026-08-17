/**
 * /api/risk — RiskEngine 정책·상태 조회 (6H-1 §13).
 * 읽기 전용 — 정책 값은 코드 상수(RISK_POLICY)이며 API로 변경 불가.
 */
import { Router, type IRouter } from 'express';
import {
  RISK_POLICY, CANARY_POLICY, CAPITAL_TIER_LADDER,
  deriveDailyTargets, deriveWeeklyMaxLossUsd, deriveTradeRiskUsd,
  isAutoPromotionAllowed,
} from '../lib/riskPolicy';
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

    res.json({
      policy: RISK_POLICY,
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
