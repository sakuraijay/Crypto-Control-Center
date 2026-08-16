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

import { useEffect, useState } from 'react';
import { useTradingContext } from '@/lib/context';
import { useStrategyContext } from '@/lib/context/StrategyContext';
import { useAppContext } from '@/lib/context/AppContext';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';
import { CheckCircle2, ShieldAlert, TrendingDown, TrendingUp, Info, Lock, Timer } from 'lucide-react';

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
  REACHED:  { icon: CheckCircle2,   label: 'KPI 달성',              cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
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
  const { todayStats, account, dataStatus } = useTradingContext();
  const { limits } = useStrategyContext();
  const { engineState } = useAppContext();
  const { profitLockStage, cooldownEndsAt, tradesThisHour, weeklyRealizedPnl } = useAiEngine();

  // 1-second ticker for live cooldown countdown
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (cooldownEndsAt === 0) { setNowMs(Date.now()); return; }
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [cooldownEndsAt]);

  const cooldownRemainingMs  = Math.max(0, cooldownEndsAt - nowMs);
  const cooldownRemainingMin = Math.ceil(cooldownRemainingMs / 60_000);
  const inCooldown = cooldownRemainingMs > 0;

  const realized    = todayStats?.realized    ?? 0;
  const unrealized  = account?.unrealizedPnl  ?? 0;
  const totalPnL    = realized + unrealized;

  // PAPER 데이터 미로드/실패 시 $0로 표시하지 않는다 (mock/추정치 금지)
  if (dataStatus !== 'ok') {
    return (
      <div className={cn('rounded-xl border border-border bg-card p-5 flex flex-col gap-2', className)}>
        <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">Daily PnL</span>
        <p className="text-sm text-muted-foreground">
          {dataStatus === 'loading'
            ? '로드 중 — PAPER 거래 데이터 조회 중…'
            : 'Unavailable — PAPER 거래 데이터 조회 실패 (mock 대체값 표시 안 함)'}
        </p>
      </div>
    );
  }

  const dailyTarget    = limits.dailyTargetUSDT  ?? 500;
  const tradingCap     = limits.tradingCapital    ?? 10_000;
  const dailyLossLimit = limits.dailyLossLimitUSDT ?? 500;

  const isHalted   = engineState === 'RISK_LOCKED' || engineState === 'EMERGENCY_STOP';
  const dailyState = deriveDailyState(realized, totalPnL, dailyTarget, isHalted);
  const stateMeta  = STATE_META[dailyState];
  const StateIcon  = stateMeta.icon;

  // Profit-lock: override REACHED label to show lock stage
  const statusLabel = dailyState === 'REACHED' && profitLockStage > 0
    ? `KPI 달성 · LOCK Lv.${profitLockStage}`
    : stateMeta.label;

  // Progress bar math
  const totalPct    = Math.max(-100, Math.min(100, (totalPnL / dailyTarget) * 100));
  const realizedPct = Math.max(-100, Math.min(100, (realized  / dailyTarget) * 100));
  const isPositive  = totalPnL >= 0;

  // Drawdown as % of trading capital
  const drawdownUsdt   = Math.min(0, realized + unrealized);
  const drawdownPct    = tradingCap > 0 ? Math.abs(drawdownUsdt / tradingCap) * 100 : 0;

  const remaining = Math.max(0, dailyTarget - realized);
  const achievedPct = Math.max(0, Math.min(100, (realized / dailyTarget) * 100));
  const realizedPnlPct = tradingCap > 0 ? (realized / tradingCap) * 100 : 0;

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
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
            Daily PnL
          </span>
          <span className="text-[10px] text-muted-foreground leading-relaxed">
            KPI 모니터링 전용 · AI 진입 결정을 강제하지 않습니다
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Profit-lock badge — shown when engine has reduced new-entry exposure */}
          {profitLockStage > 0 && (
            <div className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full border text-[9px] font-bold tracking-wider',
              profitLockStage === 1 ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/25' :
              profitLockStage === 2 ? 'bg-orange-500/10 text-orange-400 border-orange-500/25' :
                                      'bg-red-500/10 text-red-400 border-red-500/25',
            )}>
              <Lock className="w-2.5 h-2.5" />
              PROFIT-LOCK Lv.{profitLockStage}
            </div>
          )}
          <div className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-wider', stateMeta.cls)}>
            <StateIcon className="w-3 h-3" />
            {statusLabel}
          </div>
        </div>
      </div>

      {/* ── Progress bar ── */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-mono font-bold" style={{ color: isPositive ? 'var(--color-long)' : 'var(--color-short)' }}>
            {fmt(totalPnL)} total PnL
          </span>
          <span className="text-muted-foreground font-mono">
            {achievedPct.toFixed(1)}% of KPI · {realizedPnlPct >= 0 ? '+' : ''}{realizedPnlPct.toFixed(2)}% capital
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

      {/* ── Risk Guard meters — cooldown, weekly loss, hourly rate ── */}
      {(inCooldown || limits.weeklyLossLimitUSDT > 0 || limits.maxTradesPerHour > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1.5 border-t border-border/60 text-[9px] font-mono">
          {limits.weeklyLossLimitUSDT > 0 && (
            <span className={cn(
              'flex items-center gap-1',
              weeklyRealizedPnl < 0 && Math.abs(weeklyRealizedPnl) >= limits.weeklyLossLimitUSDT * 0.8
                ? 'text-[var(--color-short)] font-bold'
                : weeklyRealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-muted-foreground',
            )}>
              주간&nbsp;{weeklyRealizedPnl >= 0 ? '+' : ''}{weeklyRealizedPnl.toFixed(0)}
              <span className="text-muted-foreground/50 font-normal">/ −{limits.weeklyLossLimitUSDT.toLocaleString()}</span>
            </span>
          )}
          {limits.maxTradesPerHour > 0 && (
            <span className={cn(
              'flex items-center gap-1',
              tradesThisHour >= limits.maxTradesPerHour
                ? 'text-[var(--color-short)] font-bold'
                : tradesThisHour >= Math.ceil(limits.maxTradesPerHour * 0.8) ? 'text-[var(--color-warning)]' : 'text-muted-foreground',
            )}>
              {tradesThisHour}/{limits.maxTradesPerHour}&thinsp;tr/h
            </span>
          )}
          {inCooldown && (
            <span className="flex items-center gap-1 text-amber-400 font-bold animate-pulse">
              <Timer className="w-2.5 h-2.5" />
              쿨다운&nbsp;{cooldownRemainingMin > 1
                ? `${cooldownRemainingMin}분`
                : `${Math.ceil(cooldownRemainingMs / 1000)}초`}
            </span>
          )}
        </div>
      )}

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
