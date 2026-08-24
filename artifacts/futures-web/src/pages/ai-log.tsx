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
  ChevronDown, ServerCrash, Download, RotateCcw, BellOff,
  FlaskConical, FileText,
} from 'lucide-react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import type { AiEngineDecision, AiOperatingState, RiskLevel, PendingLiveApproval } from '@/lib/ai/types';
import { parseStrategyShadowView, type StrategyShadowView } from '@/lib/ai/strategyShadowView';
import {
  parseStrategyRiskAdvisoryView,
  type StrategyRiskAdvisoryView,
} from '@/lib/ai/strategyRiskAdvisoryView';

// ── CSV export helpers ────────────────────────────────────────────────────────

function downloadDecisionsCSV(decisions: AiEngineDecision[]) {
  const header = ['Time', 'Cycle', 'State', 'Symbol', 'Confidence%', 'RiskLevel', 'SizeUSD', 'RiskApproved', 'PaperExecuted', 'Rationale'].join(',');
  const rows = decisions.map(d => [
    format(new Date(d.createdAt), 'yyyy-MM-dd HH:mm:ss'),
    d.cycleNumber ?? '',
    d.operatingState,
    d.primarySymbol ?? '',
    d.confidence,
    d.riskLevel,
    d.sizeUsd ?? '',
    d.riskApproved ? 'true' : 'false',
    d.paperExecuted ? 'true' : 'false',
    `"${(d.stateRationale ?? '').replace(/"/g, '""')}"`,
  ].join(','));
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `ai-decisions-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadApprovalsCSV(approvals: PendingLiveApproval[]) {
  const header = ['Time', 'Cycle', 'Symbol', 'ExecutionType', 'Status', 'RetryCount', 'ExecutionFeedback', 'RejectionReason'].join(',');
  const rows = approvals.map(a => [
    format(new Date(a.createdAt), 'yyyy-MM-dd HH:mm:ss'),
    a.decision.cycleNumber ?? '',
    a.decision.primarySymbol ? `${a.decision.primarySymbol}/USD` : '',
    a.decision.executionType?.replace(/_/g, ' ') ?? '',
    a.status,
    a.retryCount ?? 0,
    a.executionFeedback ?? '',
    `"${(a.rejectionReason ?? '').replace(/"/g, '""')}"`,
  ].join(','));
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `ai-approvals-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadSessionReportCSV(decisions: AiEngineDecision[]) {
  const testDecisions = [...decisions]
    .filter(d => d.testMode)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (testDecisions.length === 0) return;

  const sessionStart  = testDecisions[0].createdAt;
  const sessionEnd    = testDecisions[testDecisions.length - 1].createdAt;
  const vetoCount     = testDecisions.filter(d => !d.riskApproved).length;
  const approvedCount = testDecisions.filter(d => d.riskApproved).length;
  const maxLeverage   = Math.max(...testDecisions.map(d => d.leverage ?? 1));
  const maxSizeUsd    = Math.max(...testDecisions.map(d => d.sizeUsd ?? 0));
  const avgConf       = testDecisions.reduce((s, d) => s + d.confidence, 0) / testDecisions.length;
  const latestVeto    = [...testDecisions].reverse().find(d => d.riskVetoReason)?.riskVetoReason ?? '—';
  const stateDist     = testDecisions.reduce((acc, d) => {
    acc[d.operatingState] = (acc[d.operatingState] ?? 0) + 1; return acc;
  }, {} as Record<string, number>);

  const rows: (string | number)[][] = [
    ['LIVE TEST 세션 종료 리포트'],
    ['세션 시작', format(new Date(sessionStart), 'yyyy-MM-dd HH:mm:ss')],
    ['세션 종료', format(new Date(sessionEnd),   'yyyy-MM-dd HH:mm:ss')],
    ['총 결정 사이클', testDecisions.length],
    ['리스크 통과', approvedCount],
    ['리스크 VETO 횟수', vetoCount],
    ['최대 레버리지', `${maxLeverage.toFixed(1)}x`],
    ['최대 포지션 규모 (USD)', maxSizeUsd.toFixed(0)],
    ['평균 신뢰도 (%)', avgConf.toFixed(1)],
    ['마지막 VETO 사유', latestVeto],
    ['실현손익', 'LIVE_EXECUTION_LOCKED=true — 드라이런 시뮬레이션 (실제 자금 없음)'],
    [],
    ['상태 분포'],
    ...Object.entries(stateDist).map(([s, n]) => [s, n]),
    [],
    ['결정 상세'],
    ['시각', '사이클#', '상태', '심볼', '신뢰도%', '리스크', '규모USD', '레버리지', 'VETO사유'],
    ...testDecisions.map(d => [
      format(new Date(d.createdAt), 'yyyy-MM-dd HH:mm:ss'),
      d.cycleNumber ?? '', d.operatingState, d.primarySymbol ?? '',
      d.confidence, d.riskLevel, d.sizeUsd ?? '', d.leverage ?? '',
      `"${(d.riskVetoReason ?? '').replace(/"/g, '""')}"`,
    ]),
  ];
  const csv  = rows.map(r => r.map(c => String(c)).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `live-test-session-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

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

function ShadowStatusPill({ shadow }: { shadow: StrategyShadowView }) {
  const statusColor = shadow.status === 'EVALUATED'
    ? 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10'
    : shadow.status === 'PARTIAL'
      ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
      : 'text-muted-foreground border-border bg-secondary';
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold border', statusColor)}>
      SHADOW {shadow.status} {shadow.evaluatedSymbols.length}/{shadow.expectedSymbols.length}
    </span>
  );
}

function StrategyShadowDetail({ shadow }: { shadow: StrategyShadowView }) {
  return (
    <div className="mt-4 pt-4 border-t border-border" data-testid="strategy-shadow-detail">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">Strategy Ensemble Explainability</div>
        <ShadowStatusPill shadow={shadow} />
        <span className="text-[9px] text-muted-foreground font-mono">cycle #{shadow.cycleNumber} · SHADOW_ONLY</span>
        <span className="ml-auto text-[9px] text-cyan-300">읽기 전용 · 실행 권한 없음</span>
      </div>

      {shadow.records.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {shadow.records.map(record => (
            <div key={`${record.symbol}:${record.signalId ?? record.action}`} className="rounded border border-border bg-background/60 p-2.5 text-[10px]">
              <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                <span className="font-bold font-mono text-foreground">{record.symbol}</span>
                <span className="text-muted-foreground">{record.regime}</span>
                <span className={cn(
                  'ml-auto font-bold',
                  record.action === 'LONG' ? 'text-[var(--color-long)]'
                    : record.action === 'SHORT' ? 'text-[var(--color-short)]' : 'text-muted-foreground',
                )}>{record.action}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
                <span>Strategy</span><span className="text-right text-foreground">{record.strategyId ?? '—'}</span>
                <span>Comparison</span><span className="text-right text-foreground">{record.comparison}</span>
                <span>Confidence</span><span className="text-right text-foreground">{record.confidence ?? '—'}</span>
                <span>Lifecycle</span><span className="text-right text-foreground">{record.lifecycleEligible === null ? '—' : record.lifecycleEligible ? 'ELIGIBLE' : 'BLOCKED'}</span>
                <span>Net edge / R:R</span><span className="text-right text-foreground">{record.expectedNetEdgeBps ?? '—'} / {record.expectedNetRR ?? '—'}</span>
              </div>
              {record.reasons.slice(0, 2).map((reason, index) => (
                <div key={index} className="mt-1 text-muted-foreground break-words">• {reason}</div>
              ))}
              {record.warnings.length > 0 && (
                <div className="mt-1 text-amber-300 break-words">⚠ {record.warnings.slice(0, 2).join(' · ')}</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded border border-border bg-background/60 p-2.5 text-[10px] text-muted-foreground">
          {shadow.reasons.join(' · ') || '평가 record 없음 — 실행 근거로 사용하지 않음'}
          {shadow.missingSymbols.length > 0 && ` · 누락: ${shadow.missingSymbols.join(', ')}`}
        </div>
      )}

      <div className="mt-2 text-[9px] text-muted-foreground font-mono">
        execution=false · approval=false · PAPER mutation=false · LIVE mutation=false · riskAuthority=NOT_EVALUATED
      </div>
    </div>
  );
}

function StrategyRiskStatusPill({ advisory }: { advisory: StrategyRiskAdvisoryView }) {
  const { allow, reduce, reject } = advisory.summary;
  const statusColor = reject > 0 || advisory.status === 'BLOCKED'
    ? 'text-red-300 border-red-500/30 bg-red-500/10'
    : reduce > 0 || advisory.status === 'PARTIAL'
      ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
      : 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10';
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold border', statusColor)}>
      RISK {advisory.status} · A{allow}/D{reduce}/R{reject}
    </span>
  );
}

function StrategyRiskAdvisoryDetail({ advisory }: { advisory: StrategyRiskAdvisoryView }) {
  return (
    <div className="mt-3 pt-3 border-t border-border" data-testid="strategy-risk-advisory-detail">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">Risk Advisory Explainability</div>
        <StrategyRiskStatusPill advisory={advisory} />
        <span className="text-[9px] text-muted-foreground font-mono">
          cycle #{advisory.cycleNumber} · {advisory.riskState ?? 'NOT_EVALUATED'}
        </span>
        <span className="ml-auto text-[9px] text-cyan-300">ADVISORY_ONLY · 실행 권한 없음</span>
      </div>

      {advisory.decisions.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {advisory.decisions.map(decision => (
            <div key={decision.decisionId} className="rounded border border-border bg-background/60 p-2.5 text-[10px]">
              <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                <span className="font-bold font-mono text-foreground">{decision.symbol}</span>
                <span className="text-muted-foreground">{decision.direction}</span>
                <span className={cn(
                  'ml-auto font-bold',
                  decision.action === 'ALLOW' ? 'text-emerald-300'
                    : decision.action === 'REDUCE' ? 'text-amber-300' : 'text-red-300',
                )}>{decision.action}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-muted-foreground">
                <span>Risk state</span><span className="text-right text-foreground">{decision.riskState ?? '—'}</span>
                <span>Size factor</span><span className="text-right text-foreground">{decision.sizeFactor.toFixed(2)}</span>
                <span>Max leverage</span><span className="text-right text-foreground">{decision.maxLeverage.toFixed(2)}×</span>
              </div>
              {decision.reasons.slice(0, 2).map((reason, index) => (
                <div key={index} className="mt-1 text-muted-foreground break-words">• {reason}</div>
              ))}
              {decision.warnings.length > 0 && (
                <div className="mt-1 text-amber-300 break-words">⚠ {decision.warnings.slice(0, 2).join(' · ')}</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded border border-border bg-background/60 p-2.5 text-[10px] text-muted-foreground">
          {advisory.reasons.join(' · ') || 'Risk advisory 없음 — 실행 근거로 사용하지 않음'}
        </div>
      )}

      <div className="mt-2 text-[9px] text-muted-foreground font-mono">
        authority=ADVISORY_ONLY · execution=false · approval=false · PAPER mutation=false · LIVE mutation=false
      </div>
    </div>
  );
}

function DecisionRow({ d }: { d: AiEngineDecision }) {
  const [open, setOpen] = useState(false);
  const shadow = parseStrategyShadowView(d.strategyEnsembleShadow);
  const riskAdvisory = parseStrategyRiskAdvisoryView(d.strategyRiskAdvisory);
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
          <div className="flex items-center gap-1.5 flex-wrap">
            <StatePill state={d.operatingState} />
            {d.stateChanged && <span className="text-[9px] text-primary">↑ changed</span>}
            {d.testMode && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold border border-amber-500/30 bg-amber-500/10 text-amber-400">
                🧪 TEST
              </span>
            )}
            {shadow && <ShadowStatusPill shadow={shadow} />}
            {riskAdvisory && <StrategyRiskStatusPill advisory={riskAdvisory} />}
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
            {shadow && <StrategyShadowDetail shadow={shadow} />}
            {riskAdvisory && <StrategyRiskAdvisoryDetail advisory={riskAdvisory} />}
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

// ── LIVE TEST Session Report component ────────────────────────────────────────
function LiveTestSessionReport({
  decisions,
  onDownload,
}: {
  decisions: AiEngineDecision[];
  onDownload: () => void;
}) {
  const testDecisions = [...decisions]
    .filter(d => d.testMode)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (testDecisions.length === 0) {
    return (
      <Card className="p-6 flex flex-col items-center gap-3 text-center border-amber-500/20 bg-amber-500/5">
        <FlaskConical className="w-8 h-8 text-amber-500/30" />
        <p className="text-sm text-muted-foreground font-medium">LIVE TEST 결정 이력이 없습니다</p>
        <p className="text-xs text-muted-foreground/60 max-w-sm">
          Settings에서 LIVE TEST MODE를 활성화하고 AI Worker가 LIVE 모드(WORKER_ENGINE_MODE=LIVE)로
          실행될 때 testMode=true 결정이 누적됩니다.
        </p>
      </Card>
    );
  }

  const sessionStart  = testDecisions[0].createdAt;
  const sessionEnd    = testDecisions[testDecisions.length - 1].createdAt;
  const totalCycles   = testDecisions.length;
  const vetoCount     = testDecisions.filter(d => !d.riskApproved).length;
  const approvedCount = testDecisions.filter(d => d.riskApproved).length;
  const maxLeverage   = Math.max(...testDecisions.map(d => d.leverage ?? 1));
  const maxSizeUsd    = Math.max(...testDecisions.map(d => d.sizeUsd ?? 0));
  const avgConf       = testDecisions.reduce((s, d) => s + d.confidence, 0) / totalCycles;
  const latestVeto    = [...testDecisions].reverse().find(d => d.riskVetoReason)?.riskVetoReason;
  const stateDist     = testDecisions.reduce((acc, d) => {
    acc[d.operatingState] = (acc[d.operatingState] ?? 0) + 1; return acc;
  }, {} as Record<string, number>);

  return (
    <Card className="overflow-hidden border-amber-500/20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-amber-500/20 bg-amber-500/5">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold text-amber-400">LIVE TEST 세션 리포트</span>
          <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
            {totalCycles}개 결정
          </span>
        </div>
        <button
          onClick={onDownload}
          className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors border border-border rounded px-2.5 py-1"
        >
          <Download className="w-3 h-3" /> CSV 내보내기
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Timeline */}
        <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground">
          <span className="text-foreground font-medium">시작</span>
          {format(new Date(sessionStart), 'yyyy-MM-dd HH:mm:ss')}
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">마지막</span>
          {format(new Date(sessionEnd), 'yyyy-MM-dd HH:mm:ss')}
          <span className="ml-auto text-[10px]">
            {formatDistanceToNowStrict(new Date(sessionStart))} 경과
          </span>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {[
            { label: '총 사이클', value: totalCycles,                     color: 'text-primary' },
            { label: '통과',      value: approvedCount,                   color: 'text-[var(--color-long)]' },
            { label: 'VETO',      value: vetoCount,                       color: 'text-[var(--color-short)]' },
            { label: '평균신뢰도', value: `${avgConf.toFixed(1)}%`,        color: '' },
            { label: '최대레버리지', value: `${maxLeverage.toFixed(1)}×`, color: '' },
            { label: '최대규모',  value: maxSizeUsd > 0 ? `$${maxSizeUsd.toLocaleString()}` : '—', color: '' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-secondary rounded-lg p-2.5 text-center">
              <div className="text-[8px] text-muted-foreground uppercase tracking-wider mb-0.5">{label}</div>
              <div className={cn('text-base font-bold font-mono', color)}>{value}</div>
            </div>
          ))}
        </div>

        {/* State distribution */}
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1.5">상태 분포</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(stateDist).map(([state, count]) => {
              const cfg = STATE_CFG[state as AiOperatingState] ?? {
                color: 'text-foreground', bg: 'bg-secondary border-border', icon: '○', label: state,
              };
              return (
                <span key={state} className={cn(
                  'inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold border',
                  cfg.bg, cfg.color,
                )}>
                  {cfg.icon} {state} <span className="font-mono opacity-70">×{count}</span>
                </span>
              );
            })}
          </div>
        </div>

        {/* PnL note */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-secondary/50 border border-border text-[11px]">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-muted-foreground">
            <span className="font-semibold text-foreground">실현손익 미표시 — </span>
            LIVE_EXECUTION_LOCKED=true 동안 모든 실행은 드라이런 시뮬레이션입니다 (실제 자금이동 없음).
            실제 PnL은 LIVE_EXECUTION_LOCKED 해제 후 체결된 test_mode=true 거래에서 자동 집계됩니다.
          </div>
        </div>

        {/* Latest veto reason */}
        {latestVeto && (
          <div className="text-[11px] font-mono text-[var(--color-short)] bg-[var(--color-short)]/5 border border-[var(--color-short)]/20 rounded p-2.5 break-all">
            <span className="text-muted-foreground font-sans mr-1">마지막 VETO:</span>{latestVeto}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AiLogPage() {
  const {
    currentDecision, decisionHistory, stats, running, autoExecute,
    setAutoExecute, triggerCycle, clearHistory, loadMoreHistory,
    pendingApprovals, notificationPermission,
  } = useAiEngine();
  const { engineState, triggerEmergencyStop } = useAppContext();

  const [stateFilter,    setStateFilter]    = useState<StateFilter>('ALL');
  const [riskFilter,     setRiskFilter]     = useState<RiskFilter>('ALL');
  const [showVetoed,      setShowVetoed]      = useState(true);
  const [showTestOnly,    setShowTestOnly]    = useState(false);
  const [showSessionReport, setShowSessionReport] = useState(false);
  const [visibleCount,   setVisibleCount]   = useState(PAGE_SIZE);
  const [hasMoreServer,  setHasMoreServer]  = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const isEmergency = engineState === 'EMERGENCY_STOP';

  // testDecisions for session report (independent of other filters)
  const testDecisions = decisionHistory.filter(d => d.testMode);

  const filtered = decisionHistory.filter(d => {
    if (showTestOnly && !d.testMode)                                 return false;
    if (stateFilter !== 'ALL' && d.operatingState !== stateFilter) return false;
    if (riskFilter  !== 'ALL' && d.riskLevel       !== riskFilter)  return false;
    if (!showVetoed && !d.riskApproved)                              return false;
    return true;
  });

  const visible = filtered.slice(0, visibleCount);
  const hasMoreInMemory = filtered.length > visibleCount;

  // Reset visible page when filters change
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [stateFilter, riskFilter, showVetoed, showTestOnly]);

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
          <Button size="sm" variant="outline" onClick={() => downloadDecisionsCSV(filtered)} disabled={filtered.length === 0} className="gap-1.5 text-muted-foreground" title="현재 필터 적용된 결정 이력 CSV 다운로드">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => setShowSessionReport(v => !v)}
            className={cn(
              'gap-1.5 text-[11px]',
              showSessionReport
                ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
                : 'text-muted-foreground',
            )}
            title="LIVE TEST 세션 리포트"
          >
            <FileText className="w-3.5 h-3.5" />
            세션 리포트
            {testDecisions.length > 0 && (
              <span className="font-mono text-[9px] opacity-70">({testDecisions.length})</span>
            )}
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

        <div className="w-px h-4 bg-border" />

        {/* LIVE TEST only filter — amber, distinct from PAPER/LIVE mode label */}
        <button
          onClick={() => setShowTestOnly(v => !v)}
          className={cn(
            'text-[10px] font-bold px-2 py-1 rounded border transition-colors flex items-center gap-1',
            showTestOnly
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
          )}
          title="testMode=true 결정만 표시 (LIVE TEST MODE 결정)"
        >
          <FlaskConical className="w-3 h-3" />
          {showTestOnly ? '🧪 TEST ONLY (해제)' : '🧪 TEST ONLY'}
        </button>

        <span className="ml-auto text-[10px] text-muted-foreground flex items-center gap-1">
          <BarChart2 className="w-3 h-3" />
          Showing {visible.length} of {filtered.length}
          {decisionHistory.length !== filtered.length && ` (${decisionHistory.length} total)`}
        </span>
      </Card>

      {/* ── LIVE TEST Session Report ──────────────────────────────────────────── */}
      {showSessionReport && (
        <LiveTestSessionReport
          decisions={decisionHistory}
          onDownload={() => downloadSessionReportCSV(decisionHistory)}
        />
      )}

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

      {/* ── LIVE 승인 이력 ────────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-border bg-card/50 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-primary" /> LIVE 승인 이력
              <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-blue-500/10 text-blue-400 border-blue-500/30 font-bold">
                PAPER — 실제 주문 없음
              </span>
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted-foreground">
                {pendingApprovals.filter(a => a.status === 'APPROVED').length}건 승인 ·{' '}
                {pendingApprovals.filter(a => a.status === 'REJECTED').length}건 거절 ·{' '}
                {pendingApprovals.filter(a => a.status === 'PENDING').length}건 대기
              </span>
              <Button
                size="sm" variant="outline"
                onClick={() => downloadApprovalsCSV(pendingApprovals)}
                disabled={pendingApprovals.length === 0}
                className="gap-1 h-6 text-[10px] text-muted-foreground px-2"
                title="승인 이력 CSV 다운로드"
              >
                <Download className="w-3 h-3" /> CSV
              </Button>
            </div>
          </div>
          {/* Notification permission hint — only shown when there are PENDING approvals */}
          {notificationPermission !== 'granted' && notificationPermission !== 'unsupported'
            && pendingApprovals.some(a => a.status === 'PENDING') && (
            <div className="flex items-center gap-2 text-[10px] text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded px-2.5 py-1.5">
              <BellOff className="w-3 h-3 shrink-0" />
              <span>데스크탑 알림 권한이 없습니다 — 탭 내 토스트로만 알립니다. Settings에서 알림 허용 버튼을 누르세요.</span>
            </div>
          )}
        </div>
        {pendingApprovals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
            <CheckCircle2 className="w-8 h-8 opacity-20" />
            <div className="text-xs">아직 LIVE 승인 요청이 없습니다</div>
            <div className="text-[10px] opacity-60">LIVE 모드가 활성화되면 AI가 승인을 요청합니다</div>
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 border-b border-border">
                <tr>
                  {['시간', '결정 #', '심볼', '실행 유형', '상태', '재시도'].map(h => (
                    <th key={h} className="text-left font-medium text-muted-foreground py-2 px-3 text-[10px] uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {[...pendingApprovals].reverse().map(a => {
                  const statusCfg = {
                    PENDING:  { cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30',   label: '⏳ 대기' },
                    APPROVED: { cls: 'bg-[var(--color-long)]/15 text-[var(--color-long)] border-[var(--color-long)]/30', label: '✅ 승인' },
                    REJECTED: { cls: 'bg-[var(--color-short)]/15 text-[var(--color-short)] border-[var(--color-short)]/30', label: '❌ 거절' },
                    EXPIRED:  { cls: 'bg-secondary text-muted-foreground border-border',     label: '⏰ 만료' },
                  }[a.status] ?? { cls: 'bg-secondary text-muted-foreground border-border', label: a.status };

                  return (
                    <tr key={a.id} className="hover:bg-secondary/20 transition-colors">
                      <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                        {format(new Date(a.createdAt), 'HH:mm:ss')}
                        <div className="text-[9px] opacity-50">{format(new Date(a.createdAt), 'MM/dd')}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">
                        #{a.decision.cycleNumber}
                      </td>
                      <td className="px-3 py-2 font-bold">
                        {a.decision.primarySymbol ? `${a.decision.primarySymbol}/USD` : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                        {a.decision.executionType?.replace(/_/g, ' ') ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold', statusCfg.cls)}>
                          {statusCfg.label}
                        </span>
                        {a.status === 'REJECTED' && a.rejectionReason && (
                          <div className="text-[9px] text-muted-foreground mt-0.5 max-w-[120px] truncate">{a.rejectionReason}</div>
                        )}
                        {a.executionFeedback === 'failed' && a.executionError && (
                          <div className="text-[9px] text-[var(--color-short)]/80 mt-0.5 max-w-[120px] truncate" title={a.executionError}>
                            ✗ {a.executionError}
                          </div>
                        )}
                      </td>
                      {/* ── 재시도 횟수 — 0=neutral, 1=amber, ≥2=orange, ≥3=red+상한 ── */}
                      <td className="px-3 py-2">
                        {(() => {
                          const count = a.retryCount ?? 0;
                          if (count === 0) return (
                            <span className="text-[10px] text-muted-foreground font-mono">—</span>
                          );
                          if (count >= 3) return (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[var(--color-short)]/10 border-[var(--color-short)]/30 text-[var(--color-short)]">
                              <RotateCcw className="w-2.5 h-2.5" />{count} 상한
                            </span>
                          );
                          if (count >= 2) return (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold bg-orange-500/10 border-orange-500/30 text-orange-400">
                              <RotateCcw className="w-2.5 h-2.5" />{count}
                            </span>
                          );
                          return (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold bg-amber-500/10 border-amber-500/30 text-amber-400">
                              <RotateCcw className="w-2.5 h-2.5" />{count}
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── 아키텍처 원칙 안내 ────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2 text-[10px] text-muted-foreground px-1 pb-2">
        <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5 text-amber-400" />
        <span>
          결정론적 리스크 컨트롤이 AI보다 <strong>절대 우선권</strong>을 가집니다.
          거부(Veto)된 결정은 로그에 기록되지만 절대 실행되지 않습니다.
          페이퍼 모드에서 자동 실행은 로컬 시뮬레이션입니다.
          LIVE 주문은 오퍼레이터 승인 후 GMX One-Click 서브계정으로만 실행됩니다.
          오퍼레이터 역할: <strong>모니터링 · 승인 게이트 · 비상정지</strong>.
        </span>
      </div>
    </div>
  );
}
