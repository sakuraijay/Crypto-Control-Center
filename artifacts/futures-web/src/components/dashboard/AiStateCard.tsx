/**
 * AiStateCard — prominent dashboard display of the current AI operating state.
 *
 * Shows:
 *   • Large 5-state badge (SPOT / LONG / SHORT / HEDGE / CASH)
 *   • Confidence bar
 *   • Selected symbol(s)
 *   • Risk level
 *   • AI reasoning bullets
 *   • Time to next cycle / auto-execute toggle
 *   • State distribution mini-chart
 */

import { useState } from 'react';
import { Brain, RefreshCw, Zap, ZapOff, ChevronDown, ChevronUp, BarChart2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { useAppContext } from '@/lib/context';
import type { AiOperatingState, RiskLevel } from '@/lib/ai/types';
import { formatDistanceToNowStrict } from 'date-fns';

// ── Colour palette ────────────────────────────────────────────────────────────

const STATE_CONFIG: Record<AiOperatingState, {
  label: string;
  color: string;           // text / border
  bg: string;              // subtle background
  glow: string;            // shadow / pulse colour
  icon: string;
  desc: string;
}> = {
  SPOT: {
    label: 'SPOT',
    color: 'text-sky-400',
    bg: 'bg-sky-500/10 border-sky-500/30',
    glow: 'shadow-[0_0_20px_rgba(14,165,233,0.25)]',
    icon: '◈',
    desc: 'On-chain swap · No leverage',
  },
  LONG: {
    label: 'LONG',
    color: 'text-[var(--color-long)]',
    bg: 'bg-[var(--color-long)]/10 border-[var(--color-long)]/30',
    glow: 'shadow-[0_0_20px_rgba(0,200,83,0.2)]',
    icon: '▲',
    desc: 'Leveraged long · GMX Perpetual',
  },
  SHORT: {
    label: 'SHORT',
    color: 'text-[var(--color-short)]',
    bg: 'bg-[var(--color-short)]/10 border-[var(--color-short)]/30',
    glow: 'shadow-[0_0_20px_rgba(255,59,48,0.2)]',
    icon: '▼',
    desc: 'Leveraged short · GMX Perpetual',
  },
  HEDGE: {
    label: 'HEDGE',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/30',
    glow: 'shadow-[0_0_20px_rgba(139,92,246,0.2)]',
    icon: '⊕',
    desc: 'Protecting existing position',
  },
  CASH: {
    label: 'CASH',
    color: 'text-muted-foreground',
    bg: 'bg-secondary border-border',
    glow: '',
    icon: '◯',
    desc: 'No clear edge — holding USDC',
  },
};

const RISK_COLOR: Record<RiskLevel, string> = {
  LOW:      'text-[var(--color-long)] bg-[var(--color-long)]/10',
  MEDIUM:   'text-[var(--color-warning)] bg-[var(--color-warning)]/10',
  HIGH:     'text-[var(--color-short)] bg-[var(--color-short)]/10',
  CRITICAL: 'text-[var(--color-short)] bg-[var(--color-short)]/20 animate-pulse',
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  const color =
    pct >= 80 ? 'var(--color-long)' :
    pct >= 60 ? 'var(--color-warning)' :
    'var(--color-short)';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="font-mono text-xs font-bold w-8 text-right" style={{ color }}>{pct}%</span>
    </div>
  );
}

function StateDistribution({ dist }: { dist: Record<AiOperatingState, number> }) {
  const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
  const states: AiOperatingState[] = ['LONG', 'SHORT', 'SPOT', 'HEDGE', 'CASH'];
  return (
    <div className="flex gap-1 items-center">
      {states.map(s => {
        const pct = (dist[s] / total) * 100;
        if (pct < 1) return null;
        const cfg = STATE_CONFIG[s];
        return (
          <div
            key={s}
            className="flex flex-col items-center gap-0.5"
            style={{ width: `${pct}%`, minWidth: pct > 5 ? undefined : 0 }}
            title={`${s}: ${pct.toFixed(0)}%`}
          >
            {pct > 8 && (
              <span className={cn('text-[9px] font-bold', cfg.color)}>{pct.toFixed(0)}%</span>
            )}
            <div className={cn('h-1 rounded-sm w-full', cfg.color.replace('text-', 'bg-').replace('[var(--color-long)]', '[var(--color-long)]'))}
              style={{ backgroundColor: s === 'LONG' ? 'var(--color-long)' : s === 'SHORT' ? 'var(--color-short)' : s === 'SPOT' ? '#0ea5e9' : s === 'HEDGE' ? '#8b5cf6' : '#6b7280' }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AiStateCard() {
  const { currentDecision, stats, running, autoExecute, setAutoExecute, triggerCycle, nextCycleMs, systemPaused, pauseReason } = useAiEngine();
  const { engineState, triggerEmergencyStop } = useAppContext();
  const [expanded, setExpanded] = useState(true);
  const [confirmAuto, setConfirmAuto] = useState(false);

  const isEmergency = engineState === 'EMERGENCY_STOP';
  const state = currentDecision?.operatingState ?? 'CASH';
  const cfg = STATE_CONFIG[state];

  const nextCycleSec = Math.ceil(nextCycleMs / 1000);
  const hasDecision = currentDecision != null;

  const handleAutoToggle = (v: boolean) => {
    if (v && !confirmAuto) {
      setConfirmAuto(true);
      return;
    }
    setAutoExecute(v);
    setConfirmAuto(false);
  };

  return (
    <div className={cn(
      'rounded-xl border p-5 transition-all duration-500',
      cfg.bg,
      cfg.glow,
      isEmergency && 'border-[var(--color-short)]/60 bg-[var(--color-short)]/10',
    )}>
      {/* ── Header row ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {/* State badge */}
          <div className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border font-bold',
            cfg.bg,
          )}>
            <span className={cn('text-xl', cfg.color)}>{cfg.icon}</span>
            <span className={cn('text-xl font-black tracking-widest', cfg.color)}>{cfg.label}</span>
            {running && (
              <span className="w-2 h-2 rounded-full bg-current animate-pulse opacity-70" />
            )}
          </div>

          <div>
            <div className="text-xs text-muted-foreground">{cfg.desc}</div>
            {hasDecision && (
              <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                Cycle #{currentDecision.cycleNumber} ·{' '}
                {formatDistanceToNowStrict(new Date(currentDecision.createdAt), { addSuffix: true })}
                {currentDecision.stateChanged && (
                  <span className={cn('ml-2 font-semibold', cfg.color)}>↳ state changed</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setExpanded(e => !e)}
            className="p-1.5 rounded-md hover:bg-white/5 transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
          <Button
            size="sm"
            variant="outline"
            onClick={triggerCycle}
            disabled={running || isEmergency}
            className="h-7 px-2 gap-1.5 text-[10px] border-border"
          >
            <RefreshCw className={cn('w-3 h-3', running && 'animate-spin')} />
            {running ? 'Analysing…' : `Next in ${nextCycleSec}s`}
          </Button>
        </div>
      </div>

      {/* ── Emergency overlay ───────────────────────────────────────────────── */}
      {isEmergency && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--color-short)]/10 border border-[var(--color-short)]/30">
          <AlertTriangle className="w-4 h-4 text-[var(--color-short)] animate-pulse" />
          <span className="text-xs text-[var(--color-short)] font-bold">EMERGENCY STOP ACTIVE — AI engine suspended</span>
        </div>
      )}

      {/* ── System paused overlay (AI paused / approval gate) ───────────────── */}
      {systemPaused && !isEmergency && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/30">
          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] animate-pulse shrink-0" />
          <span className="text-xs text-[var(--color-warning)] font-semibold">
            AI PAUSED{pauseReason ? ` — ${pauseReason}` : ' — waiting for system health to restore'}
          </span>
        </div>
      )}

      {expanded && (
        <div className="mt-4 flex flex-col gap-4">

          {/* ── Main info grid ────────────────────────────────────────────────── */}
          {hasDecision && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {/* Confidence */}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Confidence</div>
                <ConfidenceBar value={currentDecision.confidence} />
              </div>

              {/* Symbol(s) */}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Target Symbol</div>
                <div className="flex flex-wrap gap-1">
                  {currentDecision.selectedSymbols.length > 0
                    ? currentDecision.selectedSymbols.slice(0, 3).map(s => (
                        <span key={s} className={cn('text-xs font-bold font-mono px-2 py-0.5 rounded-md border', cfg.bg, cfg.color)}>
                          {s}/USD
                        </span>
                      ))
                    : <span className="text-xs text-muted-foreground">—</span>
                  }
                </div>
              </div>

              {/* Risk level */}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Risk Level</div>
                <span className={cn('text-xs font-bold px-2 py-1 rounded-md', RISK_COLOR[currentDecision.riskLevel])}>
                  {currentDecision.riskLevel}
                </span>
              </div>

              {/* Position params */}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Action</div>
                <div className="text-xs font-mono">
                  {currentDecision.sizeUsd
                    ? <span className="font-bold text-foreground">${currentDecision.sizeUsd.toLocaleString()}</span>
                    : <span className="text-muted-foreground">—</span>
                  }
                  {currentDecision.leverage && (
                    <span className="text-muted-foreground ml-1">× {currentDecision.leverage}x</span>
                  )}
                </div>
                {(currentDecision.tpPrice || currentDecision.slPrice) && (
                  <div className="text-[10px] font-mono mt-0.5 text-muted-foreground">
                    {currentDecision.tpPrice && <span className="text-[var(--color-long)]">TP {currentDecision.tpPrice.toFixed(0)}</span>}
                    {currentDecision.tpPrice && currentDecision.slPrice && <span> / </span>}
                    {currentDecision.slPrice && <span className="text-[var(--color-short)]">SL {currentDecision.slPrice.toFixed(0)}</span>}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Rationale ─────────────────────────────────────────────────────── */}
          {hasDecision && (
            <div className="rounded-lg bg-background/40 border border-border p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Brain className="w-3.5 h-3.5 text-primary" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">AI Reasoning</span>
                {!currentDecision.riskApproved && (
                  <span className="ml-auto text-[9px] font-bold text-[var(--color-short)] bg-[var(--color-short)]/10 px-1.5 py-0.5 rounded">VETOED</span>
                )}
              </div>
              <p className={cn('text-xs font-medium mb-2', cfg.color)}>
                {currentDecision.stateRationale}
              </p>
              <ul className="flex flex-col gap-1">
                {currentDecision.reasoning.map((r, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                    <span className="text-muted-foreground/50 mt-0.5">•</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Hedge details ──────────────────────────────────────────────────── */}
          {hasDecision && currentDecision.hedgeParams && (
            <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 p-3">
              <div className="text-[10px] font-bold text-violet-400 uppercase tracking-wider mb-1">Hedge Parameters</div>
              <div className="text-xs font-mono text-muted-foreground">
                {currentDecision.hedgeParams.direction} ${currentDecision.hedgeParams.sizeUsd.toLocaleString()} × {currentDecision.hedgeParams.leverage}x on {currentDecision.hedgeParams.symbol}/USD
              </div>
              <div className="text-[11px] text-violet-300/80 mt-1">{currentDecision.hedgeParams.reason}</div>
            </div>
          )}

          {/* ── Stats row ─────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-4 pt-1 border-t border-border/50">
            <div className="flex items-center gap-1.5">
              <BarChart2 className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">
                {stats.totalCycles} cycles · {stats.avgConfidence.toFixed(0)}% avg confidence
              </span>
            </div>
            {stats.totalCycles > 0 && (
              <div className="flex-1">
                <StateDistribution dist={stats.stateDistribution} />
              </div>
            )}

            {/* Auto-execute toggle */}
            <div className="flex items-center gap-2 ml-auto">
              {confirmAuto && (
                <div className="flex items-center gap-2 text-[10px] text-[var(--color-warning)]">
                  <AlertTriangle className="w-3 h-3" />
                  <span>Auto-execute paper trades?</span>
                  <button onClick={() => { setAutoExecute(true); setConfirmAuto(false); }} className="text-[var(--color-short)] font-bold underline">Yes</button>
                  <button onClick={() => setConfirmAuto(false)} className="text-muted-foreground underline">No</button>
                </div>
              )}
              {!confirmAuto && (
                <>
                  {autoExecute
                    ? <Zap className="w-3.5 h-3.5 text-[var(--color-warning)]" />
                    : <ZapOff className="w-3.5 h-3.5 text-muted-foreground" />
                  }
                  <span className="text-[10px] text-muted-foreground">
                    {autoExecute ? 'Auto-executing' : 'Auto-execute'}
                  </span>
                  <Switch
                    checked={autoExecute}
                    onCheckedChange={handleAutoToggle}
                    disabled={isEmergency}
                    className="scale-75"
                  />
                </>
              )}
            </div>
          </div>

          {!hasDecision && !running && (
            <div className="text-center py-4 text-xs text-muted-foreground">
              Initialising — waiting for price data…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
