/**
 * LiveApprovalCard — Operator approval gate for LIVE mode.
 *
 * PAPER / DRY-RUN ONLY — 이 컴포넌트는 실제 GMX 주문을 실행하지 않습니다.
 * 승인 후 내부 executor가 파라미터를 검증하는 paper dry-run을 수행합니다.
 * 실제 온체인 주문은 GMX One-Click 서브계정 구성 완료 후 활성화됩니다.
 *
 * Operator sees: state, symbol, size, leverage, TP/SL, trailing, reasoning, risk level.
 * After approve: dry-run validation badge (pending → success / failure).
 * After failure: retry button re-invokes the dry-run; reject button marks REJECTED.
 */

import { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, AlertTriangle, Clock,
  Shield, Loader2, FlaskConical, RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { useAppContext } from '@/lib/context';
import { APPROVAL_TIMEOUT_MS } from '@/lib/ai/types';
import type { PendingLiveApproval, AiOperatingState } from '@/lib/ai/types';

// ── Colours ───────────────────────────────────────────────────────────────────

const STATE_CFG: Record<AiOperatingState, { icon: string; color: string; bg: string }> = {
  SPOT:  { icon: '◈', color: 'text-sky-400',              bg: 'bg-sky-500/10 border-sky-500/30'                          },
  LONG:  { icon: '▲', color: 'text-[var(--color-long)]',  bg: 'bg-[var(--color-long)]/10 border-[var(--color-long)]/30'  },
  SHORT: { icon: '▼', color: 'text-[var(--color-short)]', bg: 'bg-[var(--color-short)]/10 border-[var(--color-short)]/30' },
  HEDGE: { icon: '⊕', color: 'text-violet-400',           bg: 'bg-violet-500/10 border-violet-500/30'                    },
  CASH:  { icon: '◯', color: 'text-muted-foreground',     bg: 'bg-secondary border-border'                               },
};

// ── Countdown hook ────────────────────────────────────────────────────────────

function useCountdown(expiresAt: string) {
  const [msLeft, setMsLeft] = useState(() => new Date(expiresAt).getTime() - Date.now());
  useEffect(() => {
    const t = setInterval(() => setMsLeft(new Date(expiresAt).getTime() - Date.now()), 500);
    return () => clearInterval(t);
  }, [expiresAt]);
  return Math.max(0, msLeft);
}

// ── DryRunBadge ───────────────────────────────────────────────────────────────

function DryRunBadge({
  feedback,
  error,
  retryCount,
}: {
  feedback: 'pending' | 'ok' | 'failed';
  error?: string;
  retryCount?: number;
}) {
  if (feedback === 'pending') {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-primary/30 bg-primary/5 text-primary text-[10px] font-medium">
        <Loader2 className="w-3 h-3 animate-spin" />
        드라이런 검증 중…
      </div>
    );
  }
  if (feedback === 'ok') {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)] text-[10px] font-bold">
        <CheckCircle2 className="w-3 h-3" />
        드라이런 성공 — PAPER ONLY, 실제 주문 없음
        {retryCount != null && retryCount > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-[var(--color-long)]/20 font-mono">
            {retryCount}회 재시도
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-400 text-[10px] font-medium">
        <XCircle className="w-3 h-3 shrink-0" />
        <span>드라이런 실패 — {error ?? '검증 오류'}</span>
        {retryCount != null && retryCount > 0 && (
          <span className="ml-auto px-1.5 py-0.5 rounded bg-amber-500/20 font-mono text-[9px]">
            {retryCount}회 재시도됨
          </span>
        )}
      </div>
    </div>
  );
}

// ── Single pending approval item ──────────────────────────────────────────────

function PendingApprovalItem({
  approval,
  onApprove,
  onReject,
}: {
  approval: PendingLiveApproval;
  onApprove: () => void;
  onReject: (reason?: string) => void;
}) {
  const msLeft  = useCountdown(approval.expiresAt);
  const pctLeft = (msLeft / APPROVAL_TIMEOUT_MS) * 100;
  const secLeft = Math.ceil(msLeft / 1000);
  const d       = approval.decision;
  const cfg     = STATE_CFG[d.operatingState];
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
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-sm font-black tracking-widest', cfg.bg, cfg.color)}>
            {cfg.icon} {d.operatingState}
          </span>
          <span className="font-mono text-base font-bold text-foreground">
            {d.primarySymbol ? `${d.primarySymbol}/USD` : d.selectedSymbols.map(s => `${s}/USD`).join(', ')}
          </span>
          <span className="text-xs text-muted-foreground">Cycle #{d.cycleNumber}</span>
        </div>
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

      {/* ── Trade params ── */}
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

      {/* ── Rationale ── */}
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

      {/* ── Hedge details ── */}
      {d.hedgeParams && (
        <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-1.5 text-[11px] font-mono text-violet-300">
          Hedge: {d.hedgeParams.direction} ${d.hedgeParams.sizeUsd.toLocaleString()} ×{d.hedgeParams.leverage}× {d.hedgeParams.symbol}/USD
        </div>
      )}

      {/* ── Action buttons ── */}
      {showRejectInput ? (
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5 text-foreground placeholder:text-muted-foreground"
            placeholder="거부 사유 (선택)…"
            value={rejectInput}
            onChange={e => setRejectInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { onReject(rejectInput || undefined); }
              if (e.key === 'Escape') setShowRejectInput(false);
            }}
            autoFocus
          />
          <Button size="sm" variant="destructive" onClick={() => onReject(rejectInput || undefined)} className="gap-1 text-xs">
            <XCircle className="w-3.5 h-3.5" /> 거부 확인
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowRejectInput(false)} className="text-xs">취소</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            {/* Approve — triggers paper dry-run */}
            <Button
              size="sm"
              onClick={onApprove}
              className="flex-1 bg-[var(--color-long)] hover:bg-[var(--color-long)]/90 text-black font-bold gap-1.5"
            >
              <FlaskConical className="w-4 h-4" />
              승인 및 드라이런
            </Button>
            {/* Reject */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowRejectInput(true)}
              className="border-[var(--color-short)]/50 text-[var(--color-short)] hover:bg-[var(--color-short)]/10 gap-1.5"
            >
              <XCircle className="w-3.5 h-3.5" /> 거부
            </Button>
          </div>
          {/* PAPER ONLY notice */}
          <p className="text-[10px] text-muted-foreground/70 text-center">
            PAPER ONLY — 실제 GMX 주문 없음 · 파라미터 드라이런 검증만 수행
          </p>
        </div>
      )}
    </div>
  );
}

// ── Approved item (shows dry-run feedback + retry/reject for failed) ───────────

function ApprovedFeedbackItem({
  approval,
  onRetry,
  onReject,
}: {
  approval: PendingLiveApproval;
  onRetry: () => void;
  onReject: (reason?: string) => void;
}) {
  const d   = approval.decision;
  const cfg = STATE_CFG[d.operatingState];
  const isFailed  = approval.executionFeedback === 'failed';
  const isRetrying = approval.retrying;

  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectInput, setRejectInput] = useState('');

  return (
    <div className={cn(
      'rounded-xl border p-4 flex flex-col gap-2 transition-all',
      isFailed
        ? 'border-amber-500/30 bg-amber-500/5'
        : 'border-[var(--color-long)]/25 bg-[var(--color-long)]/5',
    )}>
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border text-xs font-black tracking-widest', cfg.bg, cfg.color)}>
          {cfg.icon} {d.operatingState}
        </span>
        <span className="font-mono text-sm font-bold text-foreground">
          {d.primarySymbol ? `${d.primarySymbol}/USD` : '—'}
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {isFailed ? '드라이런 실패' : approval.executionFeedback === 'pending' ? '검증 중' : '승인됨'}
        </span>
      </div>

      {/* Dry-run badge */}
      {approval.executionFeedback && (
        <DryRunBadge
          feedback={approval.executionFeedback}
          error={approval.executionError}
          retryCount={approval.retryCount}
        />
      )}

      {/* ── Retry / Reject actions (only when dry-run failed) ── */}
      {isFailed && !isRetrying && (
        showRejectInput ? (
          <div className="flex items-center gap-2 mt-1">
            <input
              className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5 text-foreground placeholder:text-muted-foreground"
              placeholder="거부 사유 (선택)…"
              value={rejectInput}
              onChange={e => setRejectInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { onReject(rejectInput || undefined); }
                if (e.key === 'Escape') setShowRejectInput(false);
              }}
              autoFocus
            />
            <Button size="sm" variant="destructive" onClick={() => onReject(rejectInput || undefined)} className="gap-1 text-xs">
              <XCircle className="w-3.5 h-3.5" /> 거부 확인
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowRejectInput(false)} className="text-xs">취소</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              className="gap-1.5 text-xs border-primary/40 text-primary hover:bg-primary/10"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              재시도
              {(approval.retryCount ?? 0) > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded bg-primary/20 text-[9px] font-mono">
                  ×{approval.retryCount}
                </span>
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowRejectInput(true)}
              className="gap-1 text-xs text-[var(--color-short)] hover:bg-[var(--color-short)]/10"
            >
              <XCircle className="w-3.5 h-3.5" /> 거부
            </Button>
            <span className="text-[9px] text-muted-foreground/60 ml-auto">
              재시도는 동일 파라미터로 드라이런을 재실행합니다
            </span>
          </div>
        )
      )}
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

const FEEDBACK_DISPLAY_MS = 90_000; // show approved feedback for 90 s

export function LiveApprovalCard() {
  const { pendingApprovals, approveLiveOrder, rejectLiveOrder, retryLiveApproval } = useAiEngine();
  const { engineState } = useAppContext();

  // Tick every 5 s so recentlyApproved filter stays accurate within 5 s
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const pending = pendingApprovals.filter(a => a.status === 'PENDING');

  // Show recently approved items with dry-run feedback for FEEDBACK_DISPLAY_MS,
  // PLUS any failed-feedback items that haven't been rejected yet
  // (they stay visible so the operator can retry or reject them).
  const recentlyApproved = pendingApprovals.filter(a =>
    a.status === 'APPROVED' && (
      // Recently approved: show feedback for FEEDBACK_DISPLAY_MS
      (a.approvedAt && now - new Date(a.approvedAt).getTime() < FEEDBACK_DISPLAY_MS) ||
      // Failed dry-run: always show until operator retries (success) or rejects
      a.executionFeedback === 'failed' ||
      a.executionFeedback === 'pending'
    )
  );

  const hasAnything = pending.length > 0 || recentlyApproved.length > 0;

  if (engineState !== 'LIVE_TRADING' && !hasAnything) return null;

  if (!hasAnything) {
    // LIVE mode but nothing to show — waiting state
    return (
      <div className="rounded-xl border border-[var(--color-long)]/20 bg-[var(--color-long)]/5 px-5 py-4 flex items-center gap-3">
        <Shield className="w-5 h-5 text-[var(--color-long)] shrink-0" />
        <div>
          <span className="text-[11px] font-bold tracking-wider text-[var(--color-long)]">LIVE TRADING ACTIVE</span>
          <span className="text-[11px] text-muted-foreground ml-2">다음 AI 결정을 대기 중 — 승인 전까지 실제 주문 없음</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Banner */}
      {pending.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/8">
          <AlertTriangle className="w-5 h-5 text-[var(--color-warning)] animate-pulse shrink-0" />
          <div className="flex-1">
            <span className="text-[11px] font-bold tracking-wider text-[var(--color-warning)]">
              {pending.length}건 승인 대기
            </span>
            <span className="text-[11px] text-muted-foreground ml-2">
              PAPER ONLY — 드라이런 모드 · 실제 주문 없음 · 미처리 시 자동 만료
            </span>
          </div>
        </div>
      )}

      {/* Pending items — oldest first, max 2 visible */}
      {pending.slice().reverse().slice(0, 2).map(approval => (
        <PendingApprovalItem
          key={approval.id}
          approval={approval}
          onApprove={() => approveLiveOrder(approval.id)}
          onReject={(reason) => rejectLiveOrder(approval.id, reason)}
        />
      ))}

      {pending.length > 2 && (
        <div className="text-center text-xs text-muted-foreground py-1">
          + {pending.length - 2}건 더 대기 중 · 위 항목을 먼저 처리하세요
        </div>
      )}

      {/* Recently approved — show dry-run feedback + retry/reject for failed */}
      {recentlyApproved.map(approval => (
        <ApprovedFeedbackItem
          key={approval.id}
          approval={approval}
          onRetry={() => retryLiveApproval(approval.id)}
          onReject={(reason) => rejectLiveOrder(approval.id, reason)}
        />
      ))}
    </div>
  );
}
