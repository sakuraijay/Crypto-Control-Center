/**
 * DailyTargetCard — web
 *
 * Displays progress toward the daily profit KPI.
 *
 * ⚠️  IMPORTANT: dailyTargetUSDT is a MONITORING KPI only.
 *     It is never used to mandate extra trades, increase leverage,
 *     or escalate risk. The Risk Engine is fully independent and
 *     retains absolute veto authority regardless of target state.
 */

import { useTradingContext } from '@/lib/context';
import { useStrategyContext } from '@/lib/context/StrategyContext';
import { useAppContext } from '@/lib/context/AppContext';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, ShieldAlert, TrendingDown, TrendingUp, Info } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type DailyState = 'REACHED' | 'ON_TRACK' | 'DRAWDOWN' | 'HALTED';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number, alwaysSign = true): string {
  const sign = alwaysSign ? (v >= 0 ? '+' : '') : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function deriveDailyState(
  realized: number,
  totalPnL: number,
  dailyTarget: number,
  isHalted: boolean,
): DailyState {
  if (isHalted) return 'HALTED';
  if (realized >= dailyTarget) return 'REACHED';
  if (totalPnL < 0) return 'DRAWDOWN';
  return 'ON_TRACK';
}

const STATE_META: Record<DailyState, {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  cls: string;
}> = {
  REACHED:  { icon: CheckCircle2,   label: 'TARGET REACHED',        cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
  ON_TRACK: { icon: TrendingUp,     label: 'ON TRACK',              cls: 'bg-[var(--color-long)]/15 text-[var(--color-long)] border-[var(--color-long)]/30' },
  DRAWDOWN: { icon: TrendingDown,   label: 'DAILY DRAWDOWN',        cls: 'bg-[var(--color-short)]/15 text-[var(--color-short)] border-[var(--color-short)]/30' },
  HALTED:   { icon: ShieldAlert,    label: 'TRADING HALTED',        cls: 'bg-[var(--color-short)]/15 text-[var(--color-short)] border-[var(--color-short)]/30 animate-pulse' },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatItem({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={cn('font-mono font-bold text-sm', cls)}>{value}</span>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DailyTargetCard({ className }: { className?: string }) {
  const { todayStats, account } = useTradingContext();
  const { limits } = useStrategyContext();
  const { engineState } = useAppContext();

  const realized    = todayStats?.realized    ?? 0;
  const unrealized  = account?.unrealizedPnl  ?? 0;
  const totalPnL    = realized + unrealized;

  const dailyTarget    = limits.dailyTargetUSDT  ?? 500;
  const startingCap    = limits.startingCapital   ?? 10_000;
  const dailyLossLimit = limits.dailyLossLimitUSDT ?? 500;

  const isHalted   = engineState === 'RISK_LOCKED' || engineState === 'EMERGENCY_STOP';
  const dailyState = deriveDailyState(realized, totalPnL, dailyTarget, isHalted);
  const stateMeta  = STATE_META[dailyState];
  const StateIcon  = stateMeta.icon;

  // Progress bar math
  const totalPct    = Math.max(-100, Math.min(100, (totalPnL / dailyTarget) * 100));
  const realizedPct = Math.max(-100, Math.min(100, (realized  / dailyTarget) * 100));
  const isPositive  = totalPnL >= 0;

  // Drawdown as % of starting capital
  const drawdownUsdt   = Math.min(0, realized + unrealized);
  const drawdownPct    = startingCap > 0 ? Math.abs(drawdownUsdt / startingCap) * 100 : 0;

  const remaining = Math.max(0, dailyTarget - realized);
  const achievedPct = Math.max(0, Math.min(100, (realized / dailyTarget) * 100));

  const progressColor = dailyState === 'REACHED'  ? '#f59e0b'
    : dailyState === 'DRAWDOWN' || dailyState === 'HALTED' ? 'var(--color-short)'
    : 'var(--color-long)';

  const unrealizedBarWidth = isPositive
    ? Math.max(0, Math.min(100, (Math.abs(totalPct) - Math.abs(realizedPct))))
    : 0;

  void dailyLossLimit; // used in risk engine, not display

  return (
    <div className={cn(
      'rounded-xl border bg-card p-4 flex flex-col gap-3',
      dailyState === 'REACHED' && 'border-yellow-500/30',
      dailyState === 'HALTED'  && 'border-[var(--color-short)]/40',
      dailyState === 'DRAWDOWN' && 'border-[var(--color-short)]/25',
      dailyState === 'ON_TRACK' && 'border-border',
      className,
    )}>

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
            Daily Performance KPI
          </span>
          <span className="text-[10px] text-muted-foreground">
            ${startingCap.toLocaleString()} starting capital · ${dailyTarget.toLocaleString()} daily target
          </span>
        </div>
        <div className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-wider', stateMeta.cls)}>
          <StateIcon className="w-3 h-3" />
          {stateMeta.label}
        </div>
      </div>

      {/* ── Progress bar ── */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-mono font-bold" style={{ color: isPositive ? 'var(--color-long)' : 'var(--color-short)' }}>
            {fmt(totalPnL)} total PnL
          </span>
          <span className="text-muted-foreground font-mono">
            {achievedPct.toFixed(1)}% of ${dailyTarget.toLocaleString()} target
          </span>
        </div>

        {/* Progress track */}
        <div className="relative h-5 rounded-full bg-secondary overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(100, Math.abs(realizedPct))}%`,
              backgroundColor: progressColor,
              opacity: isPositive ? 1 : 0.9,
            }}
          />
          {unrealizedBarWidth > 0 && (
            <div
              className="absolute inset-y-0 transition-all duration-700"
              style={{
                left:            `${Math.min(100, Math.abs(realizedPct))}%`,
                width:           `${unrealizedBarWidth}%`,
                backgroundColor: progressColor,
                opacity:         0.35,
              }}
            />
          )}
          <div className="absolute inset-y-0 right-0 w-px bg-muted-foreground/30" />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-bold text-white/80 mix-blend-plus-lighter">
              {fmt(realized)} realized
              {unrealized !== 0 && ` · ${fmt(unrealized, true)} unreal.`}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between text-[9px] text-muted-foreground font-mono">
          <span>$0</span>
          <span className="text-muted-foreground/60">─── target ───▶</span>
          <span>${dailyTarget.toLocaleString()}</span>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-5 gap-2 pt-1 border-t border-border">
        <StatItem
          label="Realized PnL"
          value={fmt(realized)}
          cls={realized >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}
        />
        <StatItem
          label="Unrealized"
          value={fmt(unrealized)}
          cls={unrealized >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}
        />
        <StatItem
          label="Remaining"
          value={remaining > 0 ? `$${remaining.toFixed(2)}` : '—'}
          cls={remaining > 0 ? 'text-muted-foreground' : 'text-[var(--color-long)]'}
        />
        <StatItem
          label="Daily Drawdown"
          value={drawdownUsdt < 0 ? fmt(drawdownUsdt) : '$0.00'}
          cls={drawdownUsdt < 0 ? 'text-[var(--color-short)]' : 'text-muted-foreground'}
        />
        <StatItem
          label="DD vs Capital"
          value={drawdownPct > 0 ? `${drawdownPct.toFixed(2)}%` : '0.00%'}
          cls={drawdownPct > limits.maxDrawdownPercent ? 'text-[var(--color-short)]' : 'text-muted-foreground'}
        />
      </div>

      {/* ── Risk Engine independence disclaimer ── */}
      <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground border-t border-border pt-2">
        <Info className="w-3 h-3 shrink-0 mt-0.5 text-muted-foreground/50" />
        <span>
          <span className="font-semibold text-muted-foreground/80">Monitoring KPI only.</span>
          {' '}This target never mandates extra trades, larger leverage, or risk escalation.
          The Risk Engine operates independently and retains absolute veto authority even
          when the daily target has not been reached.
        </span>
      </div>
    </div>
  );
}
