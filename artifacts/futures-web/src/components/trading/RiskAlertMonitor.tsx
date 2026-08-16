import { useEffect, useRef } from 'react';
import { useTradingContext, useStrategyContext, useAppContext } from '@/lib/context';
import { useGmxAccount } from '@/lib/context/GmxAccountContext';
import { useToast } from '@/hooks/use-toast';

/**
 * Invisible component — runs in background, fires toasts when risk limits are
 * being approached or breached. Debounced per alert type (5 min cooldown each).
 *
 * Sources:
 *  - Paper/mock positions: useTradingContext (account, positions)
 *  - Real GMX on-chain positions: useGmxAccount (nearLiquidation, liquidationPrice)
 *
 * Rule: nearLiquidation is only true when BOTH liquidationPrice AND markPriceUsd
 * are non-null server-verified values. Never estimated. (GmxAccountContext:307-311)
 */
export function RiskAlertMonitor() {
  const { account, positions } = useTradingContext();
  const { limits } = useStrategyContext();
  const { engineState } = useAppContext();
  const gmx = useGmxAccount();
  const { toast } = useToast();

  // Track when each alert type last fired (unix ms)
  const lastFired = useRef<Record<string, number>>({});
  const COOLDOWN = 5 * 60 * 1000; // 5 min

  function maybeToast(
    key: string,
    title: string,
    description: string,
    variant: 'default' | 'destructive' = 'destructive',
  ) {
    const now = Date.now();
    if ((lastFired.current[key] ?? 0) + COOLDOWN > now) return;
    lastFired.current[key] = now;
    toast({ title, description, variant });
  }

  useEffect(() => {
    if (engineState === 'OFFLINE' || engineState === 'EMERGENCY_STOP') return;

    const check = () => {
      // ── Paper account risk checks ────────────────────────────────────────────

      // Daily loss limit ≥ 80%
      const lossToday = Math.min(0, account.realizedPnlToday);
      if (limits.dailyLossLimitUSDT > 0 && Math.abs(lossToday) >= limits.dailyLossLimitUSDT * 0.8) {
        maybeToast(
          'daily-loss',
          '⚠ Daily Loss Warning',
          `Loss today: $${Math.abs(lossToday).toFixed(2)} — limit is $${limits.dailyLossLimitUSDT}`,
        );
      }

      // Max positions ≥ 80%
      if (limits.maxSimultaneousPositions > 0 && positions.length >= Math.ceil(limits.maxSimultaneousPositions * 0.8)) {
        maybeToast(
          'max-positions',
          '⚠ Position Count Warning',
          `${positions.length}/${limits.maxSimultaneousPositions} positions open`,
          'default',
        );
      }

      // Margin ratio ≥ 70%
      if (account.marginRatio >= 0.70) {
        maybeToast(
          'margin-ratio',
          '🔴 High Margin Usage',
          `Margin ratio at ${(account.marginRatio * 100).toFixed(1)}% — consider reducing exposure`,
        );
      }

      // Total exposure ≥ 90%
      const totalExposure = positions.reduce((s, p) => s + p.sizeInUsd, 0);
      if (limits.maxTotalExposureUSDT > 0 && totalExposure >= limits.maxTotalExposureUSDT * 0.9) {
        maybeToast(
          'total-exposure',
          '⚠ Exposure Limit Warning',
          `Total exposure $${totalExposure.toFixed(0)} approaching limit $${limits.maxTotalExposureUSDT.toLocaleString()}`,
        );
      }

      // ── Real GMX on-chain liquidation check ──────────────────────────────────
      // nearLiquidation = liquidationPrice != null && markPriceUsd != null &&
      //   |markPrice - liqPrice| / markPrice ≤ 0.05 (GmxAccountContext)
      // Never fires if either price is missing — strictly fail-closed.
      const nearLiqPositions = gmx.positions.filter(p => p.nearLiquidation);
      for (const pos of nearLiqPositions) {
        // Per-position cooldown key so each open position alerts independently
        const alertKey = `near-liq-${pos.id}`;
        const gapPct = (pos.liquidationPrice != null && pos.markPriceUsd != null && pos.markPriceUsd > 0)
          ? ((Math.abs(pos.markPriceUsd - pos.liquidationPrice) / pos.markPriceUsd) * 100).toFixed(1)
          : '?';
        maybeToast(
          alertKey,
          '🔴 청산가 위험 근접',
          `${pos.symbol} ${pos.direction}: 청산 $${pos.liquidationPrice?.toFixed(2) ?? 'N/A'} / 현재 $${pos.markPriceUsd?.toFixed(2) ?? 'N/A'} — ${gapPct}% 이내`,
          'destructive',
        );
      }
    };

    check(); // immediate
    const id = setInterval(check, 15_000); // then every 15 s
    return () => clearInterval(id);
  }, [account, positions, limits, engineState, gmx.positions]);

  return null; // renders nothing
}
