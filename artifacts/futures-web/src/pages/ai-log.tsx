/**
 * AI Decision Log — 5-State Engine
 *
 * Shows every decision cycle from the AI engine (SPOT / LONG / SHORT / HEDGE / CASH).
 * Risk controls have absolute veto authority — VETOED decisions are shown but were never executed.
 * Operators: monitoring only. Emergency Stop always overrides.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { useAppContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Brain, ShieldAlert, RefreshCw, Trash2,
  TrendingUp, TrendingDown, CheckCircle2, XCircle,
  AlertTriangle, ChevronRight, Zap, ZapOff, BarChart2,
  ChevronDown, ServerCrash,
} from 'lucide-react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import type { AiEngineDecision, AiOperatingState, RiskLevel } from '@/lib/ai/types';

// ── State display config ───────────────────────────────────────────────────────

const STATE_CFG: Record<AiOperatingState, { icon: string; color: string; bg: string; label: string }> = {
  SPOT:  { icon: '◈', color: 'text-sky-400',                              bg: 'bg-sky-500/10 border-sky-500/30',         label: 'SPOT'  },
  LONG:  { icon: '▲', color: 'text-[var(--color-long)]',                  bg: 'bg-[var(--color-long)]/10 border-[var(--color-long)]/30',  label: 'LONG'  },
  SHORT: { icon: '▼', color: 'text-[var(--color-short)]',                 bg: 'bg-[var(--color-short)]/10 border-[var(--color-short)]/30', label: 'SHORT' },
  HEDGE: { icon: '⊕', color: 'text-violet-400',                          bg: 'bg-violet-500/10 border-violet-500/30',   label: 'HEDGE' },
  CASH:  { icon: '◯', color: 'text-muted-foreground',                    bg: 'bg-secondary border-border',              label: 'CASH'  },
};

const RISK_COLOR: Record<RiskLevel, string> = {
  LOW:      'text-[var(--color-long)]',
  MEDIUM:   'text-[var(--color-warning)]',
  HIGH:     'text-[var(--color-short)]',
  CRITICAL: 'text-[var(--color-short)] animate-pulse',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatePill({ state }: { state: AiOperatingState }) {
  const cfg = STATE_CFG[state];
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border', cfg.bg, cfg.color)}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

function ConfBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  const color = pct >= 75 ? 'var(--color-long)' : pct >= 50 ? 'var(--color-warning)' : 'var(--color-short)';
  return (
    <div className="flex items-center gap-2 min-w-[70px]">
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] font-mono w-7 text-right" style={{ color }}>{pct}%</span>
    </div>
  );
}

function DecisionRow({ d }: { d: AiEngineDecision }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="border-b border-border/40 hover:bg-secondary/30 cursor-pointer transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        {/* Time */}
        <td className="px-3 py-2.5 text-[11px] text-muted-foreground font-mono whitespace-nowrap">
          {format(new Date(d.createdAt), 'HH:mm:ss')}
          <div className="text-[9px] opacity-60">{format(new Date(d.createdAt), 'MMM d')}</div>
        </td>
        {/* Cycle */}
        <td className="px-3 py-2.5 text-[10px] text-muted-foreground font-mono">#{d.cycleNumber}</td>
        {/* State */}
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <StatePill state={d.operatingState} />
            {d.stateChanged && <span className="text-[9px] text-primary">↑ changed</span>}
          </div>
        </td>
        {/* Symbol */}
        <td className="px-3 py-2.5">
          <span className="font-mono text-xs font-semibold text-foreground">
            {d.primarySymbol ? `${d.primarySymbol}/USD` : '—'}
          </span>
          {d.selectedSymbols.length > 1 && (
            <span className="text-[10px] text-muted-foreground ml-1">+{d.selectedSymbols.length - 1}</span>
          )}
        </td>
        {/* Confidence */}
        <td className="px-3 py-2.5"><ConfBar value={d.confidence} /></td>
        {/* Risk */}
        <td className={cn('px-3 py-2.5 text-[10px] font-bold', RISK_COLOR[d.riskLevel])}>{d.riskLevel}</td>
        {/* Size */}
        <td className="px-3 py-2.5 text-[11px] font-mono">
          {d.sizeUsd ? (
            <span className="text-foreground">${d.sizeUsd.toLocaleString()}{d.leverage ? <span className="text-muted-foreground">×{d.leverage}</span> : ''}</span>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
        {/* Risk gate */}
        <td className="px-3 py-2.5">
          {d.riskApproved
            ? <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--color-long)]"><CheckCircle2 className="w-3 h-3" /> OK</span>
            : <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--color-short)]"><XCircle className="w-3 h-3" /> Vetoed</span>
          }
        </td>
        {/* Paper executed */}
        <td className="px-3 py-2.5">
          {d.paperExecuted
            ? <span className="text-[10px] text-blue-400 font-semibold">EXECUTED</span>
            : <span className="text-[10px] text-muted-foreground">—</span>
          }
        </td>
        <td className="px-3 py-2.5">
          <ChevronRight className={cn('w-3 h-3 text-muted-foreground transition-transform', open && 'rotate-90')} />
        </td>
      </tr>

      {/* Expanded detail */}
      {open && (
        <tr className="border-b border-border/40 bg-secondary/15">
          <td colSpan={10} className="px-5 py-4">
            <div className="grid grid-cols-3 gap-5 text-xs">
              {/* Reasoning */}
              <div>
                <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                  <Brain className="w-3 h-3" /> AI Reasoning
                </div>
                <p className={cn('font-medium mb-2', STATE_CFG[d.operatingState].color)}>
                  {d.stateRationale}
                </p>
                <ul className="flex flex-col gap-1">
                  {d.reasoning.map((r, i) => (
                    <li key={i} className="text-[11px] text-muted-foreground flex gap-1.5">
                      <span className="opacity-40">•</span><span>{r}</span>
                    </li>
                  ))}
                </ul>
                {d.riskVetoReason && (
                  <p className="mt-2 text-[var(--color-short)] text-[10px] flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> {d.riskVetoReason}
                  </p>
                )}
              </div>

              {/* Trade params */}
              <div>
                <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Action Parameters</div>
                <div className="space-y-1 font-mono">
                  <div>Type: <span className="text-foreground">{d.executionType.replace(/_/g, ' ')}</span></div>
                  <div>Entry style: <span className="text-foreground">{d.entryStyle}</span></div>
                  {d.sizeUsd && <div>Size: <span className="text-foreground">${d.sizeUsd.toLocaleString()}</span></div>}
                  {d.leverage && <div>Leverage: <span className="text-foreground">{d.leverage}×</span></div>}
                  {d.tpPrice && <div>TP: <span className="text-[var(--color-long)]">${d.tpPrice.toFixed(2)}</span></div>}
                  {d.slPrice && <div>SL: <span className="text-[var(--color-short)]">${d.slPrice.toFixed(2)}</span></div>}
                  {d.trailingStopPct && <div>Trailing: <span className="text-foreground">{d.trailingStopPct.toFixed(1)}%</span></div>}
                </div>

                {d.hedgeParams && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="text-[9px] font-bold text-violet-400 uppercase tracking-wider mb-1">Hedge</div>
                    <div className="space-y-0.5 font-mono text-[10px]">
                      <div>{d.hedgeParams.direction} ${d.hedgeParams.sizeUsd.toLocaleString()} ×{d.hedgeParams.leverage}× on {d.hedgeParams.symbol}/USD</div>
                      <div className="text-violet-300/70">{d.hedgeParams.reason}</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Symbol analysis */}
              <div>
                <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Symbol Analysis</div>
                <div className="flex flex-col gap-2">
                  {d.symbolAnalyses.slice(0, 3).map(sa => (
                    <div key={sa.symbol} className="flex items-center justify-between text-[10px] font-mono">
                      <span className="font-bold text-foreground">{sa.displaySymbol}</span>
                      <span className={sa.directionalBias > 0 ? 'text-[var(--color-long)]' : sa.directionalBias < 0 ? 'text-[var(--color-short)]' : 'text-muted-foreground'}>
                        {sa.directionalBias > 0 ? '▲' : sa.directionalBias < 0 ? '▼' : '◯'} {Math.abs(sa.directionalBias).toFixed(0)}pt
                      </span>
                      <span className="text-muted-foreground">RSI {sa.indicators.rsi14.toFixed(0)}</span>
                      <span className="text-muted-foreground">Q:{sa.opportunityScore}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Market: {d.marketCondition.replace(/_/g, ' ')}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Filter types ──────────────────────────────────────────────────────────────

type StateFilter = AiOperatingState | 'ALL';
type RiskFilter = RiskLevel | 'ALL';

const PAGE_SIZE = 50;

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AiLogPage() {
  const {
    currentDecision, decisionHistory, stats, running, autoExecute,
    setAutoExecute, triggerCycle, clearHistory, loadMoreHistory,
  } = useAiEngine();
  const { engineState, triggerEmergencyStop } = useAppContext();

  const [stateFilter,    setStateFilter]    = useState<StateFilter>('ALL');
  const [riskFilter,     setRiskFilter]     = useState<RiskFilter>('ALL');
  const [showVetoed,     setShowVetoed]     = useState(true);
  const [visibleCount,   setVisibleCount]   = useState(PAGE_SIZE);
  const [hasMoreServer,  setHasMoreServer]  = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const isEmergency = engineState === 'EMERGENCY_STOP';

  const filtered = decisionHistory.filter(d => {
    if (stateFilter !== 'ALL' && d.operatingState !== stateFilter) return false;
    if (riskFilter  !== 'ALL' && d.riskLevel       !== riskFilter)  return false;
    if (!showVetoed && !d.riskApproved)                              return false;
    return true;
  });

  const visible = filtered.slice(0, visibleCount);
  const hasMoreInMemory = filtered.length > visibleCount;

  // Reset visible page when filters change
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [stateFilter, riskFilter, showVetoed]);

  const handleLoadMoreInMemory = () => setVisibleCount(c => c + PAGE_SIZE);

  const handleFetchOlder = useCallback(async () => {
    setIsFetchingMore(true);
    try {
      const gotMore = await loadMoreHistory();
      if (!gotMore) setHasMoreServer(false);
      else setVisibleCount(c => c + PAGE_SIZE);
    } finally {
      setIsFetchingMore(false);
    }
  }, [loadMoreHistory]);

  const states: AiOperatingState[] = ['SPOT', 'LONG', 'SHORT', 'HEDGE', 'CASH'];
  const risks: RiskLevel[]         = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  return (
    <div className="flex flex-col gap-5 animate-in fade-in duration-500">

      {/* ── Emergency banner ──────────────────────────────────────────────────── */}
      {isEmergency && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--color-short)]/40 bg-[var(--color-short)]/10">
          <ShieldAlert className="w-5 h-5 text-[var(--color-short)] animate-pulse shrink-0" />
          <div className="flex-1">
            <span className="text-[11px] font-bold tracking-wider text-[var(--color-short)]">EMERGENCY STOP ACTIVE</span>
            <span className="text-[11px] text-muted-foreground ml-2">AI engine suspended · No new decisions being made</span>
          </div>
        </div>
      )}

      {/* ── Page header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="w-6 h-6 text-primary" />
            AI Decision Log
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            5-State engine · GMX V2 · Arbitrum One
            {stats.lastCycleAt && ` · Last cycle ${formatDistanceToNowStrict(new Date(stats.lastCycleAt), { addSuffix: true })}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={triggerCycle} disabled={running || isEmergency} className="gap-1.5">
            <RefreshCw className={cn('w-3.5 h-3.5', running && 'animate-spin')} />
            {running ? 'Analysing…' : 'Run Now'}
          </Button>
          <Button size="sm" variant="outline" onClick={clearHistory} disabled={decisionHistory.length === 0} className="gap-1.5 text-muted-foreground">
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </Button>
          <Button size="sm" variant="destructive" onClick={triggerEmergencyStop} className="gap-1.5 font-bold tracking-wider text-[10px]">
            <ShieldAlert className="w-3.5 h-3.5" /> EMERGENCY STOP
          </Button>
        </div>
      </div>

      {/* ── Stats row ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-6 gap-3">
        <Card className="p-3 flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Total Cycles</span>
          <span className="text-lg font-bold font-mono text-primary">{stats.totalCycles}</span>
        </Card>
        <Card className="p-3 flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Avg Confidence</span>
          <span className="text-lg font-bold font-mono">{stats.avgConfidence.toFixed(0)}%</span>
        </Card>
        <Card className="p-3 flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Current Streak</span>
          <span className={cn('text-lg font-bold font-mono', STATE_CFG[stats.currentStreak.state].color)}>
            {stats.currentStreak.cycles}× {stats.currentStreak.state}
          </span>
        </Card>
        {states.slice(0, 3).map(s => (
          <Card key={s} className="p-3 flex flex-col gap-0.5">
            <span className={cn('text-[9px] uppercase tracking-wider font-bold', STATE_CFG[s].color)}>{s}</span>
            <span className="text-lg font-bold font-mono">{stats.stateDistribution[s] ?? 0}</span>
          </Card>
        ))}
      </div>

      {/* ── Current decision card ──────────────────────────────────────────────── */}
      {currentDecision && (
        <Card className={cn('p-4 border', STATE_CFG[currentDecision.operatingState].bg)}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className={cn('text-[10px] font-bold uppercase tracking-wider', STATE_CFG[currentDecision.operatingState].color)}>
                Current State
              </span>
              <StatePill state={currentDecision.operatingState} />
              {currentDecision.stateChanged && (
                <span className="text-[9px] text-primary bg-primary/10 px-1.5 py-0.5 rounded font-bold">STATE CHANGED</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {autoExecute ? <Zap className="w-3.5 h-3.5 text-[var(--color-warning)]" /> : <ZapOff className="w-3.5 h-3.5" />}
                <span>Auto-execute</span>
                <button
                  onClick={() => setAutoExecute(!autoExecute)}
                  className={cn(
                    'text-[10px] font-bold px-2 py-0.5 rounded border',
                    autoExecute
                      ? 'bg-[var(--color-warning)]/10 border-[var(--color-warning)]/30 text-[var(--color-warning)]'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}
                  disabled={isEmergency}
                >
                  {autoExecute ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          </div>
          <p className={cn('text-sm font-medium mb-2', STATE_CFG[currentDecision.operatingState].color)}>
            {currentDecision.stateRationale}
          </p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {currentDecision.reasoning.map((r, i) => (
              <span key={i} className="text-[10px] text-muted-foreground bg-background/50 border border-border px-2 py-0.5 rounded">
                {r}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-3 text-xs font-mono border-t border-border/30 pt-3">
            <div><span className="text-muted-foreground">Symbols</span>
              <div className="font-bold">{currentDecision.selectedSymbols.map(s => `${s}/USD`).join(', ') || '—'}</div>
            </div>
            <div><span className="text-muted-foreground">Confidence</span>
              <div className="font-bold">{currentDecision.confidence}%</div>
            </div>
            <div><span className="text-muted-foreground">Risk Level</span>
              <div className={cn('font-bold', RISK_COLOR[currentDecision.riskLevel])}>{currentDecision.riskLevel}</div>
            </div>
            <div><span className="text-muted-foreground">Market</span>
              <div className="font-bold">{currentDecision.marketCondition.replace(/_/g, ' ')}</div>
            </div>
          </div>
        </Card>
      )}

      {/* ── Filters ───────────────────────────────────────────────────────────── */}
      <Card className="p-3 flex flex-wrap gap-3 items-center">
        {/* State filter */}
        <div className="flex items-center gap-1">
          {(['ALL', ...states] as StateFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setStateFilter(s)}
              className={cn(
                'text-[10px] font-bold px-2 py-1 rounded border transition-colors',
                stateFilter === s
                  ? s !== 'ALL' ? `${STATE_CFG[s as AiOperatingState].bg} ${STATE_CFG[s as AiOperatingState].color}` : 'bg-primary/20 border-primary/40 text-primary'
                  : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
              )}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-border" />

        {/* Risk filter */}
        <div className="flex items-center gap-1">
          {(['ALL', ...risks] as RiskFilter[]).map(r => (
            <button
              key={r}
              onClick={() => setRiskFilter(r)}
              className={cn(
                'text-[10px] font-bold px-2 py-1 rounded border transition-colors',
                riskFilter === r
                  ? 'bg-primary/20 border-primary/40 text-primary'
                  : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
              )}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-border" />

        <button
          onClick={() => setShowVetoed(v => !v)}
          className={cn(
            'text-[10px] font-bold px-2 py-1 rounded border transition-colors flex items-center gap-1',
            showVetoed
              ? 'bg-secondary border-border text-muted-foreground'
              : 'bg-[var(--color-short)]/10 border-[var(--color-short)]/30 text-[var(--color-short)]'
          )}
        >
          <XCircle className="w-3 h-3" /> {showVetoed ? 'Hide vetoed' : 'Show vetoed'}
        </button>

        <span className="ml-auto text-[10px] text-muted-foreground flex items-center gap-1">
          <BarChart2 className="w-3 h-3" />
          Showing {visible.length} of {filtered.length}
          {decisionHistory.length !== filtered.length && ` (${decisionHistory.length} total)`}
        </span>
      </Card>

      {/* ── Decision table ────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1">
          {decisionHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
              <Brain className="w-10 h-10 opacity-30" />
              <div className="text-sm">No decisions yet — engine initialising…</div>
              <div className="text-xs opacity-60">First cycle runs ~8 seconds after price data loads</div>
              <Button size="sm" onClick={triggerCycle} disabled={running || isEmergency}>
                <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', running && 'animate-spin')} />
                Run cycle now
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              No decisions match the current filters
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 sticky top-0 z-10 backdrop-blur-md border-b border-border">
                <tr>
                  {['Time', '#', 'State', 'Symbol', 'Confidence', 'Risk', 'Size', 'Gate', 'Paper', ''].map(h => (
                    <th key={h} className="text-left font-medium text-muted-foreground py-2.5 px-3 text-[10px] uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(d => <DecisionRow key={d.id} d={d} />)}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pagination footer ──────────────────────────────────────────────── */}
        {filtered.length > 0 && (hasMoreInMemory || hasMoreServer) && (
          <div className="border-t border-border/40 px-4 py-3 flex items-center justify-between bg-secondary/20">
            <span className="text-[10px] text-muted-foreground">
              {visible.length} / {filtered.length} shown
              {hasMoreServer && filtered.length === visibleCount && ' · More available on server'}
            </span>
            <div className="flex items-center gap-2">
              {hasMoreInMemory && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleLoadMoreInMemory}
                  className="gap-1.5 text-[11px] h-7"
                >
                  <ChevronDown className="w-3 h-3" />
                  Show {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more
                </Button>
              )}
              {!hasMoreInMemory && hasMoreServer && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleFetchOlder}
                  disabled={isFetchingMore}
                  className="gap-1.5 text-[11px] h-7"
                >
                  {isFetchingMore
                    ? <><RefreshCw className="w-3 h-3 animate-spin" /> Loading…</>
                    : <><ServerCrash className="w-3 h-3" /> Fetch older from server</>
                  }
                </Button>
              )}
              {!hasMoreServer && !hasMoreInMemory && (
                <span className="text-[10px] text-muted-foreground italic">All decisions loaded</span>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── Architecture note ──────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2 text-[10px] text-muted-foreground px-1 pb-2">
        <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5 text-amber-400" />
        <span>
          Deterministic risk controls have <strong>absolute veto authority</strong> above the AI.
          Vetoed decisions are logged but never executed. In paper mode, auto-execute simulates
          orders locally. Live trading requires a GMX One-Click subaccount configured on the VPS — never your primary wallet key here.
          Operator role: <strong>monitor and emergency stop only</strong>.
        </span>
      </div>
    </div>
  );
}
