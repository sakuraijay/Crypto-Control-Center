/**
 * RiskAlertMonitor — invisible background component.
 * Runs 4 checks every 60 s and shows Alert.alert() when thresholds are breached.
 * 5-minute cooldown per alert type prevents spam.
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

  useEffect(() => {
    const check = () => {
      const now = Date.now();
      const canAlert = (type: AlertType) => now - lastAlertAt.current[type] > COOLDOWN_MS;
      const fire = (type: AlertType, title: string, message: string) => {
        lastAlertAt.current[type] = now;
        Alert.alert(`⚠️ ${title}`, message, [{ text: 'Dismiss', style: 'cancel' }]);
      };

      // 1. Daily loss limit
      if (canAlert('daily_loss') && riskLimits.dailyLossLimitUSDT > 0) {
        const lossRatio = Math.abs(Math.min(0, account.realizedPnlToday)) / riskLimits.dailyLossLimitUSDT;
        if (lossRatio >= 0.80) {
          fire(
            'daily_loss',
            'Daily Loss Warning',
            `Today's loss has reached ${(lossRatio * 100).toFixed(0)}% of your daily limit ($${riskLimits.dailyLossLimitUSDT.toFixed(0)}). Consider closing positions.`
          );
        }
      }

      // 2. Margin ratio
      if (canAlert('margin_ratio') && account.marginRatio >= 0.70) {
        fire(
          'margin_ratio',
          'Margin Ratio High',
          `Margin ratio is at ${(account.marginRatio * 100).toFixed(0)}%. Reduce exposure or add margin to avoid liquidation.`
        );
      }

      // 3. Position count
      if (canAlert('pos_count') && riskLimits.maxSimultaneousPositions > 0) {
        const posRatio = positions.length / riskLimits.maxSimultaneousPositions;
        if (posRatio >= 0.80) {
          fire(
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
          fire(
            'exposure',
            'Exposure Near Limit',
            `Total exposure is $${account.totalPositionValue.toFixed(0)} — ${(expRatio * 100).toFixed(0)}% of your $${riskLimits.maxTotalExposureUSDT.toFixed(0)} limit.`
          );
        }
      }
    };

    // Run immediately then every 60 s
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [account, positions, riskLimits]);

  // Renders nothing — side-effect only
  return null;
}
