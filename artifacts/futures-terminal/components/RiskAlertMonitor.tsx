/**
 * RiskAlertMonitor — invisible background component.
 * Runs 4 checks every 60 s. Uses expo-notifications for local push alerts
 * that fire even when the app is backgrounded or terminated.
 * Falls back gracefully to Alert.alert() when notifications are not permitted.
 *
 * Alert types:
 *   daily_loss    — today's realized loss ≥ 80% of dailyLossLimitUSDT
 *   margin_ratio  — margin ratio ≥ 70%
 *   pos_count     — open positions ≥ 80% of maxSimultaneousPositions
 *   exposure      — total position value ≥ 90% of maxTotalExposureUSDT
 */

import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useTrading } from '@/contexts/TradingContext';
import { useStrategy } from '@/contexts/StrategyContext';
import {
  scheduleRiskAlert,
  getNotificationPermission,
} from '@/services/notifications';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type AlertType = 'daily_loss' | 'margin_ratio' | 'pos_count' | 'exposure';

export function RiskAlertMonitor() {
  const { account, positions } = useTrading();
  const { config } = useStrategy();
  const { riskLimits } = config;

  const lastAlertAt = useRef<Record<AlertType, number>>({
    daily_loss:   0,
    margin_ratio: 0,
    pos_count:    0,
    exposure:     0,
  });

  // Cache permission status (re-checked every 5 min cycle to avoid async on every tick)
  const notifPermission = useRef<'granted' | 'denied' | 'undetermined'>('undetermined');
  useEffect(() => {
    getNotificationPermission().then(p => { notifPermission.current = p; });
  }, []);

  useEffect(() => {
    const fire = async (type: AlertType, title: string, message: string) => {
      lastAlertAt.current[type] = Date.now();

      if (notifPermission.current === 'granted') {
        // Push notification — works even when backgrounded
        await scheduleRiskAlert(`⚠️ ${title}`, message, `risk_alert_${type}`);
      } else {
        // Fallback: blocking Alert (only works when foregrounded)
        Alert.alert(`⚠️ ${title}`, message, [{ text: 'Dismiss', style: 'cancel' }]);
      }
    };

    const check = async () => {
      const now = Date.now();
      const canAlert = (type: AlertType) => now - lastAlertAt.current[type] > COOLDOWN_MS;

      // Refresh permission each cycle
      notifPermission.current = await getNotificationPermission();

      // 1. Daily loss limit
      if (canAlert('daily_loss') && riskLimits.dailyLossLimitUSDT > 0) {
        const lossRatio = Math.abs(Math.min(0, account.realizedPnlToday)) / riskLimits.dailyLossLimitUSDT;
        if (lossRatio >= 0.80) {
          await fire(
            'daily_loss',
            'Daily Loss Warning',
            `Today's loss has reached ${(lossRatio * 100).toFixed(0)}% of your daily limit ($${riskLimits.dailyLossLimitUSDT.toFixed(0)}).`
          );
        }
      }

      // 2. Margin ratio
      if (canAlert('margin_ratio') && account.marginRatio >= 0.70) {
        await fire(
          'margin_ratio',
          'Margin Ratio High',
          `Margin ratio is ${(account.marginRatio * 100).toFixed(0)}%. Reduce exposure to avoid liquidation.`
        );
      }

      // 3. Position count
      if (canAlert('pos_count') && riskLimits.maxSimultaneousPositions > 0) {
        const posRatio = positions.length / riskLimits.maxSimultaneousPositions;
        if (posRatio >= 0.80) {
          await fire(
            'pos_count',
            'Positions Near Limit',
            `${positions.length} of ${riskLimits.maxSimultaneousPositions} maximum positions are open.`
          );
        }
      }

      // 4. Total exposure
      if (canAlert('exposure') && riskLimits.maxTotalExposureUSDT > 0) {
        const expRatio = account.totalPositionValue / riskLimits.maxTotalExposureUSDT;
        if (expRatio >= 0.90) {
          await fire(
            'exposure',
            'Exposure Near Limit',
            `Total exposure is $${account.totalPositionValue.toFixed(0)} — ${(expRatio * 100).toFixed(0)}% of your $${riskLimits.maxTotalExposureUSDT.toFixed(0)} limit.`
          );
        }
      }
    };

    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [account, positions, riskLimits]);

  return null;
}
