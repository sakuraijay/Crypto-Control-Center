/**
 * LiveApprovalCard — Operator approval gate for live GMX V2 orders.
 *
 * Shown only when engineState === 'LIVE_TRADING' and there are pending approvals.
 * The AI has proposed an order — real money moves ONLY after the operator clicks
 * APPROVE. Orders auto-expire after 5 minutes (market conditions change).
 *
 * Operator sees: state, symbol, size, leverage, TP/SL, trailing, reasoning, risk level.
 * One approval at a time — oldest pending shown first.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Clock, TrendingUp, TrendingDown, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { useAppContext } from '@/lib/context';
import { APPROVAL_TIMEOUT_MS } from '@/lib/ai/types';
import type { PendingLiveApproval, AiOperatingState } from '@/lib/ai/types';
import { formatDistanceToNowStrict } from 'date-fns';

// ── Colours ───────────────────────────────────────────────────────────────────

const STATE_CFG: Record<AiOperatingState, { icon: string; color: string; bg: string }> = {
  SPOT:  { icon: '◈', color: 'text-sky-400',                  bg: 'bg-sky-500/10 border-sky-500/30'         },
  LONG:  { icon: '▲', color: 'text-[var(--color-long)]',      bg: 'bg-[var(--color-long)]/10 border-[var(--color-long)]/30'  },
  SHORT: { icon: '▼', color: 'text-[var(--color-short)]',     bg: 'bg-[var(--color-short)]/10 border-[var(--color-short)]/30' },
  HEDGE: { icon: '⊕', color: 'text-violet-400',               bg: 'bg-violet-500/10 border-violet-500/30'   },
  CASH:  { icon: '◯', color: 'text-muted-foreground',         bg: 'bg-secondary border-border'              },
};

// ── Countdown hook ────────────────────────────────────────────────────────────

function useCountdown(expiresAt: string) {
  const [msLeft, setMsLeft] = useState(() => new Date(expiresAt).getTime() - Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      setMsLeft(new Date(expiresAt).getTime() - Date.now());
    }, 500);
    return () => clearInterval(t);
  }, [expiresAt]);

  return Math.max(0, msLeft);
}

// ── Single approval row ───────────────────────────────────────────────────────

function ApprovalItem({
  approval,
  onApprove,
  onReject,
}: {
  approval: PendingLiveApproval;
  onApprove: () => void;
  onReject: () => void;
}) {
  const msLeft = useCountdown(approval.expiresAt);
  const pctLeft = (msLeft / APPROVAL_TIMEOUT_MS) * 100;
  const secLeft = Math.ceil(msLeft / 1000);
  const d = approval.decision;
  const cfg = STATE_CFG[d.operatingState];
  const isUrgent = pctLeft < 25;

  const [rejectInput, setRejectInput] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  if (msLeft <= 0) return null; // expired — cleaned up by context

  return (
    <div className={cn(
      'rounded-xl border p-4 flex flex-col gap-3 transition-all',
      'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5',
      isUrgent && 'border-[var(--color-short)]/50 bg-[var(--color-short)]/5',
    )}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* State badge */}
          <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-sm font-black tracking-widest', cfg.bg, cfg.color)}>
            {cfg.icon} {d.operatingState}
          </span>
          <span className="font-mono text-base font-bold text-foreground">
            {d.primarySymbol ? `${d.primarySymbol}/USD` : d.selectedSymbols.map(s => `${s}/USD`).join(', ')}
          </span>
          <span className="text-xs text-muted-foreground">Cycle #{d.cycleNumber}</span>
        </div>
        {/* Countdown */}
        <div className={cn('flex items-center gap-1.5 text-xs font-bold', isUrgent ? 'text-[var(--color-short)]' : 'text-[var(--color-warning)]')}>
          <Clock className="w-3.5 h-3.5" />
          {secLeft}s
        </div>
      </div>

      {/* Countdown bar */}
      <div className="h-1 bg-secondary rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', isUrgent ? 'bg-[var(--color-short)]' : 'bg-[var(--color-warning)]')}
          style={{ width: `${pctLeft}%` }}
        />
      </div>

      {/* ── Trade params grid ────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3 text-xs font-mono">
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Size</div>
          <div className="font-bold text-foreground">{d.sizeUsd ? `$${d.sizeUsd.toLocaleString()}` : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Leverage</div>
          <div className="font-bold text-foreground">{d.leverage ? `${d.leverage}×` : '1×'}</div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">TP</div>
          <div className="font-bold text-[var(--color-long)]">{d.tpPrice ? `$${d.tpPrice.toFixed(0)}` : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">SL</div>
          <div className="font-bold text-[var(--color-short)]">{d.slPrice ? `$${d.slPrice.toFixed(0)}` : '—'}</div>
        </div>
        {d.trailingStopPct && (
          <div className="col-span-2">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Trailing Stop</div>
            <div className="font-bold text-violet-400">{d.trailingStopPct.toFixed(1)}%</div>
          </div>
        )}
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Confidence</div>
          <div className="font-bold" style={{ color: d.confidence >= 75 ? 'var(--color-long)' : d.confidence >= 55 ? 'var(--color-warning)' : 'var(--color-short)' }}>
            {d.confidence}%
          </div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Risk</div>
          <div className={cn('font-bold', d.riskLevel === 'LOW' ? 'text-[var(--color-long)]' : d.riskLevel === 'MEDIUM' ? 'text-[var(--color-warning)]' : 'text-[var(--color-short)]')}>
            {d.riskLevel}
          </div>
        </div>
      </div>

      {/* ── Rationale ────────────────────────────────────────────── */}
      <div className="rounded-lg bg-background/60 border border-border/50 px-3 py-2">
        <p className={cn('text-xs font-semibold mb-1', cfg.color)}>{d.stateRationale}</p>
        <ul className="flex flex-col gap-0.5">
          {d.reasoning.slice(0, 3).map((r, i) => (
            <li key={i} className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <span className="opacity-40 mt-0.5">•</span><span>{r}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Hedge details if present ─────────────────────────────── */}
      {d.hedgeParams && (
        <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-1.5 text-[11px] font-mono text-violet-300">
          Hedge: {d.hedgeParams.direction} ${d.hedgeParams.sizeUsd.toLocaleString()} ×{d.hedgeParams.leverage}× {d.hedgeParams.symbol}/USD
        </div>
      )}

      {/* ── Action buttons ───────────────────────────────────────── */}
      {showRejectInput ? (
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5 text-foreground placeholder:text-muted-foreground"
            placeholder="Rejection reason (optional)…"
            value={rejectInput}
            onChange={e => setRejectInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onReject(); if (e.key === 'Escape') setShowRejectInput(false); }}
            autoFocus
          />
          <Button size="sm" variant="destructive" onClick={onReject} className="gap-1 text-xs">
            <XCircle className="w-3.5 h-3.5" /> Confirm Reject
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowRejectInput(false)} className="text-xs">Cancel</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {/* Approve */}
          <Button
            size="sm"
            onClick={onApprove}
            className="flex-1 bg-[var(--color-long)] hover:bg-[var(--color-long)]/90 text-black font-bold gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4" />
            APPROVE — Execute on GMX
          </Button>
          {/* Reject */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowRejectInput(true)}
            className="border-[var(--color-short)]/50 text-[var(--color-short)] hover:bg-[var(--color-short)]/10 gap-1.5"
          >
            <XCircle className="w-3.5 h-3.5" /> Reject
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

export function LiveApprovalCard() {
  const { pendingApprovals, approveLiveOrder, rejectLiveOrder } = useAiEngine();
  const { engineState } = useAppContext();

  const pending = pendingApprovals.filter(a => a.status === 'PENDING');

  // Only render in LIVE mode or when approvals exist
  if (engineState !== 'LIVE_TRADING' && pending.length === 0) return null;
  if (pending.length === 0) {
    // LIVE mode but no pending — show waiting state
    return (
      <div className="rounded-xl border border-[var(--color-long)]/20 bg-[var(--color-long)]/5 px-5 py-4 flex items-center gap-3">
        <Shield className="w-5 h-5 text-[var(--color-long)] shrink-0" />
        <div>
          <span className="text-[11px] font-bold tracking-wider text-[var(--color-long)]">LIVE TRADING ACTIVE</span>
          <span className="text-[11px] text-muted-foreground ml-2">Awaiting next AI decision — you will be prompted to approve before any order executes</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Banner */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/8">
        <AlertTriangle className="w-5 h-5 text-[var(--color-warning)] animate-pulse shrink-0" />
        <div className="flex-1">
          <span className="text-[11px] font-bold tracking-wider text-[var(--color-warning)]">
            {pending.length} ORDER{pending.length > 1 ? 'S' : ''} AWAITING APPROVAL
          </span>
          <span className="text-[11px] text-muted-foreground ml-2">
            Real money will move only after you approve · Orders auto-expire if not actioned
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground shrink-0">
          {pending.length > 1 && (
            <>{pending.length} pending</>
          )}
        </div>
      </div>

      {/* Approval items — show oldest first (slice to max 2 visible at once) */}
      {pending.slice().reverse().slice(0, 2).map(approval => (
        <ApprovalItem
          key={approval.id}
          approval={approval}
          onApprove={() => approveLiveOrder(approval.id)}
          onReject={() => rejectLiveOrder(approval.id)}
        />
      ))}

      {pending.length > 2 && (
        <div className="text-center text-xs text-muted-foreground py-1">
          + {pending.length - 2} more pending · approve or reject above first
        </div>
      )}
    </div>
  );
}
