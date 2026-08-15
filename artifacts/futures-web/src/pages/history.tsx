import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTradingContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { Download, X, RefreshCw, CheckCircle2, XCircle, Clock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── CSV export ──────────────────────────────────────────────────────────────
function downloadCSV(trades: ReturnType<typeof useTradingContext>['closedTrades']) {
  const header = 'Date,Symbol,Side,SizeUSD,Close Price,Realized PnL,Strategy';
  const rows = trades.map(t =>
    [
      format(new Date(t.timestamp), 'yyyy-MM-dd HH:mm:ss'),
      t.displaySymbol ?? t.symbol,
      t.side,
      t.sizeInUsd?.toFixed(2) ?? '0',
      t.price.toFixed(2),
      t.pnl.toFixed(2),
      `"${t.strategy}"`,
    ].join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trades-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── AI history types ──────────────────────────────────────────────────────────

interface AiDecisionRow {
  id: number;
  ts: string;
  symbol: string;
  direction: string;
  confidence: number;
  rationale: string;
  riskResult: string;
  riskNote?: string | null;
  executionOutcome: string;
}

interface AiApprovalRow {
  id: string;
  status: string;
  createdAt: string;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  executionOutcome?: string | null;
  retryCount?: number;
  lastError?: string | null;
  decisionJson: string;
}

interface AiHistoryEntry {
  kind: 'decision' | 'approval';
  id: string;
  ts: string;
  symbol: string;
  direction: string;       // LONG | SHORT | CASH | HEDGE | SPOT
  confidence: number;      // 0–100
  approvalStatus?: string; // PENDING | APPROVED | REJECTED | EXPIRED
  dryRunResult?: string;   // succeeded | failed | null
  retryCount?: number;
  lastError?: string | null;
  rationale: string;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const cfg: Record<string, string> = {
    PENDING:  'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    APPROVED: 'bg-[var(--color-long)]/20 text-[var(--color-long)] border-[var(--color-long)]/30',
    REJECTED: 'bg-[var(--color-short)]/20 text-[var(--color-short)] border-[var(--color-short)]/30',
    EXPIRED:  'bg-muted/30 text-muted-foreground border-border',
  };
  return (
    <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded border', cfg[status] ?? 'bg-muted/30 text-muted-foreground')}>
      {status}
    </span>
  );
}

function DryRunBadge({ result, retryCount }: { result?: string | null; retryCount?: number }) {
  if (!result) return <span className="text-muted-foreground text-xs">—</span>;
  const ok = result === 'succeeded';
  return (
    <div className="flex items-center gap-1">
      <span className={cn(
        'text-[9px] font-bold px-1.5 py-0.5 rounded border flex items-center gap-1',
        ok
          ? 'bg-[var(--color-long)]/20 text-[var(--color-long)] border-[var(--color-long)]/30'
          : 'bg-amber-500/20 text-amber-400 border-amber-500/30',
      )}>
        {ok ? <CheckCircle2 className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
        {ok ? '성공' : '실패'}
      </span>
      {(retryCount ?? 0) > 0 && (
        <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
          <RotateCcw className="w-2.5 h-2.5" />×{retryCount}
        </span>
      )}
    </div>
  );
}

function DirectionBadge({ dir }: { dir: string }) {
  const cfg: Record<string, string> = {
    LONG:  'bg-[var(--color-long)]/20 text-[var(--color-long)]',
    SHORT: 'bg-[var(--color-short)]/20 text-[var(--color-short)]',
    CASH:  'bg-muted/30 text-muted-foreground',
    SPOT:  'bg-sky-500/20 text-sky-400',
    HEDGE: 'bg-violet-500/20 text-violet-400',
  };
  return (
    <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded', cfg[dir] ?? 'bg-muted/30 text-muted-foreground')}>
      {dir}
    </span>
  );
}

// ── AI History tab ────────────────────────────────────────────────────────────

function AiHistoryTab() {
  const [entries, setEntries] = useState<AiHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterDir, setFilterDir] = useState('ALL');
  const [filterDryRun, setFilterDryRun] = useState('ALL');
  const [filterSymbol, setFilterSymbol] = useState('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [decRes, appRes] = await Promise.all([
        fetch('/api/ai/decisions?limit=200'),
        fetch('/api/ai/approvals?limit=200'),
      ]);

      const decisionRows: AiDecisionRow[] = decRes.ok
        ? ((await decRes.json() as { decisions: AiDecisionRow[] }).decisions ?? [])
        : [];
      const approvalRows: AiApprovalRow[] = appRes.ok
        ? ((await appRes.json() as { approvals: AiApprovalRow[] }).approvals ?? [])
        : [];

      const decisionEntries: AiHistoryEntry[] = decisionRows.map(r => ({
        kind:       'decision',
        id:         String(r.id),
        ts:         r.ts,
        symbol:     r.symbol || 'MULTI',
        direction:  r.direction === 'NO_TRADE' ? 'CASH' : (r.direction || 'CASH'),
        confidence: Math.round((r.confidence ?? 0) * 100),
        dryRunResult: r.executionOutcome === 'SIMULATED' ? 'succeeded' : undefined,
        rationale:  r.rationale ?? '',
      }));

      const approvalEntries: AiHistoryEntry[] = approvalRows.map(r => {
        let symbol = 'MULTI';
        let direction = 'CASH';
        let confidence = 0;
        let rationale = '';
        try {
          const d = JSON.parse(r.decisionJson) as {
            primarySymbol?: string | null;
            operatingState?: string;
            confidence?: number;
            stateRationale?: string;
          };
          symbol     = d.primarySymbol || 'MULTI';
          direction  = d.operatingState || 'CASH';
          confidence = d.confidence ?? 0;
          rationale  = d.stateRationale ?? '';
        } catch { /* use defaults */ }
        return {
          kind:          'approval',
          id:            r.id,
          ts:            r.createdAt,
          symbol,
          direction,
          confidence,
          approvalStatus: r.status,
          dryRunResult:  r.executionOutcome ?? undefined,
          retryCount:    r.retryCount ?? 0,
          lastError:     r.lastError ?? null,
          rationale,
        };
      });

      // Merge and deduplicate, sort newest-first
      const combined = [...decisionEntries, ...approvalEntries].sort(
        (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
      );
      setEntries(combined);
    } catch (e) {
      setLoadError((e as Error).message ?? '불러오기 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const uniqueSymbols = useMemo(
    () => ['ALL', ...Array.from(new Set(entries.map(e => e.symbol))).sort()],
    [entries],
  );

  const filtered = useMemo(() => entries.filter(e => {
    if (filterStatus !== 'ALL') {
      if (filterStatus === 'DECISION' && e.kind !== 'decision') return false;
      if (filterStatus !== 'DECISION' && (e.kind !== 'approval' || e.approvalStatus !== filterStatus)) return false;
    }
    if (filterDir !== 'ALL' && e.direction !== filterDir) return false;
    if (filterDryRun !== 'ALL') {
      if (filterDryRun === 'succeeded' && e.dryRunResult !== 'succeeded') return false;
      if (filterDryRun === 'failed' && e.dryRunResult !== 'failed') return false;
      if (filterDryRun === 'retried' && (e.retryCount ?? 0) === 0) return false;
      if (filterDryRun === 'none' && e.dryRunResult != null) return false;
    }
    if (filterSymbol !== 'ALL' && e.symbol !== filterSymbol) return false;
    return true;
  }), [entries, filterStatus, filterDir, filterDryRun, filterSymbol]);

  const hasFilters = filterStatus !== 'ALL' || filterDir !== 'ALL' || filterDryRun !== 'ALL' || filterSymbol !== 'ALL';

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* ── Filters ── */}
      <Card className="p-3 bg-card/50 border-border">
        <div className="flex flex-wrap gap-3 items-center">
          {/* Status */}
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-36 h-8 text-xs bg-background border-border">
              <SelectValue placeholder="상태" />
            </SelectTrigger>
            <SelectContent>
              {['ALL', 'DECISION', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'].map(s => (
                <SelectItem key={s} value={s} className="text-xs">
                  {s === 'ALL' ? '전체 상태' : s === 'DECISION' ? 'AI 결정만' : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Direction */}
          <div className="flex rounded-md overflow-hidden border border-border">
            {(['ALL', 'LONG', 'SHORT', 'CASH', 'HEDGE'] as const).map(d => (
              <button
                key={d}
                onClick={() => setFilterDir(d)}
                className={cn(
                  'px-2.5 h-8 text-[10px] font-bold tracking-wide transition-colors',
                  filterDir === d
                    ? d === 'LONG'  ? 'bg-[var(--color-long)]/20 text-[var(--color-long)]'
                    : d === 'SHORT' ? 'bg-[var(--color-short)]/20 text-[var(--color-short)]'
                    : d === 'HEDGE' ? 'bg-violet-500/20 text-violet-400'
                    :                 'bg-primary/20 text-primary'
                    : 'bg-background text-muted-foreground hover:bg-muted/30',
                )}
              >{d}</button>
            ))}
          </div>

          {/* Dry-run result */}
          <Select value={filterDryRun} onValueChange={setFilterDryRun}>
            <SelectTrigger className="w-36 h-8 text-xs bg-background border-border">
              <SelectValue placeholder="드라이런 결과" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL" className="text-xs">전체 결과</SelectItem>
              <SelectItem value="succeeded" className="text-xs">성공</SelectItem>
              <SelectItem value="failed" className="text-xs">실패</SelectItem>
              <SelectItem value="retried" className="text-xs">재시도됨</SelectItem>
              <SelectItem value="none" className="text-xs">결과 없음</SelectItem>
            </SelectContent>
          </Select>

          {/* Symbol */}
          <Select value={filterSymbol} onValueChange={setFilterSymbol}>
            <SelectTrigger className="w-32 h-8 text-xs bg-background border-border">
              <SelectValue placeholder="심볼" />
            </SelectTrigger>
            <SelectContent>
              {uniqueSymbols.map(s => (
                <SelectItem key={s} value={s} className="text-xs">
                  {s === 'ALL' ? '전체 심볼' : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2">
            {hasFilters && (
              <span className="text-xs text-muted-foreground">{filtered.length} / {entries.length}</span>
            )}
            {hasFilters && (
              <Button size="sm" variant="ghost" className="h-8 px-2 gap-1 text-xs"
                onClick={() => { setFilterStatus('ALL'); setFilterDir('ALL'); setFilterDryRun('ALL'); setFilterSymbol('ALL'); }}>
                <X className="w-3.5 h-3.5" /> 초기화
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8 px-2 gap-1 text-xs" onClick={load} disabled={loading}>
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              새로고침
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Table ── */}
      <Card className="flex-1 flex flex-col overflow-hidden">
        {loadError ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            오류: {loadError}
          </div>
        ) : (
          <div className="overflow-auto flex-1">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 sticky top-0 z-10 backdrop-blur-md border-b border-border">
                <tr>
                  <th className="text-left font-medium text-muted-foreground py-3 px-4 whitespace-nowrap text-xs">시각</th>
                  <th className="text-left font-medium text-muted-foreground py-3 px-4 whitespace-nowrap text-xs">종류</th>
                  <th className="text-left font-medium text-muted-foreground py-3 px-4 whitespace-nowrap text-xs">심볼</th>
                  <th className="text-left font-medium text-muted-foreground py-3 px-4 whitespace-nowrap text-xs">방향</th>
                  <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap text-xs">신뢰도</th>
                  <th className="text-left font-medium text-muted-foreground py-3 px-4 whitespace-nowrap text-xs">승인 상태</th>
                  <th className="text-left font-medium text-muted-foreground py-3 px-4 whitespace-nowrap text-xs">드라이런</th>
                  <th className="text-left font-medium text-muted-foreground py-3 px-4 text-xs">오류 / 근거</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && entries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-muted-foreground">
                      <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2" />
                      불러오는 중…
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-muted-foreground">
                      {entries.length === 0 ? 'AI 이력이 없습니다' : '필터 조건에 맞는 항목이 없습니다'}
                    </td>
                  </tr>
                ) : (
                  filtered.map(e => (
                    <tr key={`${e.kind}-${e.id}`} className="hover:bg-muted/30 transition-colors">
                      <td className="py-2.5 px-4 text-muted-foreground font-mono text-[10px] whitespace-nowrap">
                        {format(new Date(e.ts), 'MM-dd HH:mm:ss')}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className={cn(
                          'text-[9px] font-bold px-1.5 py-0.5 rounded border',
                          e.kind === 'approval'
                            ? 'bg-violet-500/20 text-violet-400 border-violet-500/30'
                            : 'bg-blue-500/20 text-blue-400 border-blue-500/30',
                        )}>
                          {e.kind === 'approval' ? '승인' : '결정'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs font-bold">
                        {e.symbol}
                      </td>
                      <td className="py-2.5 px-4">
                        <DirectionBadge dir={e.direction} />
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-xs">
                        <span style={{
                          color: e.confidence >= 75 ? 'var(--color-long)'
                               : e.confidence >= 55 ? 'var(--color-warning)'
                               : 'var(--color-short)',
                        }}>
                          {e.confidence}%
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        {e.approvalStatus
                          ? <StatusBadge status={e.approvalStatus} />
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="py-2.5 px-4">
                        <DryRunBadge result={e.dryRunResult} retryCount={e.retryCount} />
                      </td>
                      <td className="py-2.5 px-4 max-w-xs">
                        {e.lastError ? (
                          <span className="text-amber-400 text-[10px] font-mono line-clamp-1" title={e.lastError}>
                            {e.lastError}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-[10px] line-clamp-1" title={e.rationale}>
                            {e.rationale || '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const { closedTrades, logs } = useTradingContext();
  const [activeTab, setActiveTab] = useState('trades');

  // ── Trade filter state ────────────────────────────────────────────────────
  const [filterSymbol, setFilterSymbol] = useState('ALL');
  const [filterSide, setFilterSide] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const uniqueSymbols = useMemo(
    () => ['ALL', ...Array.from(new Set(closedTrades.map(t => t.symbol))).sort()],
    [closedTrades]
  );

  const filtered = useMemo(() => {
    return closedTrades.filter(t => {
      if (filterSymbol !== 'ALL' && t.symbol !== filterSymbol) return false;
      if (filterSide !== 'ALL' && t.side !== filterSide) return false;
      if (filterFrom) {
        const from = new Date(filterFrom + 'T00:00:00');
        if (new Date(t.timestamp) < from) return false;
      }
      if (filterTo) {
        const to = new Date(filterTo + 'T23:59:59');
        if (new Date(t.timestamp) > to) return false;
      }
      return true;
    });
  }, [closedTrades, filterSymbol, filterSide, filterFrom, filterTo]);

  const hasFilters = filterSymbol !== 'ALL' || filterSide !== 'ALL' || filterFrom || filterTo;

  function clearFilters() {
    setFilterSymbol('ALL');
    setFilterSide('ALL');
    setFilterFrom('');
    setFilterTo('');
  }

  return (
    <div className="animate-in fade-in duration-500 h-full flex flex-col">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        {/* ── Header row ── */}
        <div className="flex items-center justify-between mb-4">
          <TabsList className="bg-card border border-border">
            <TabsTrigger value="trades" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary w-36">
              Trade History ({closedTrades.length})
            </TabsTrigger>
            <TabsTrigger value="ai" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary w-36">
              AI 결정 & 승인
            </TabsTrigger>
            <TabsTrigger value="logs" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary w-36">
              Strategy Logs
            </TabsTrigger>
          </TabsList>

          {activeTab === 'trades' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadCSV(filtered)}
              disabled={filtered.length === 0}
              className="gap-1.5 text-xs"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV ({filtered.length})
            </Button>
          )}
        </div>

        {/* ── Filters (trades tab only) ── */}
        {activeTab === 'trades' && (
          <Card className="p-3 mb-4 bg-card/50 border-border">
            <div className="flex flex-wrap gap-3 items-center">
              {/* Symbol */}
              <Select value={filterSymbol} onValueChange={setFilterSymbol}>
                <SelectTrigger className="w-36 h-8 text-xs bg-background border-border">
                  <SelectValue placeholder="Symbol" />
                </SelectTrigger>
                <SelectContent>
                  {uniqueSymbols.map(s => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {s === 'ALL' ? 'All Symbols' : s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Side */}
              <div className="flex rounded-md overflow-hidden border border-border">
                {(['ALL', 'LONG', 'SHORT'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setFilterSide(s)}
                    className={`px-3 h-8 text-xs font-medium transition-colors ${
                      filterSide === s
                        ? s === 'LONG'
                          ? 'bg-[var(--color-long)]/20 text-[var(--color-long)]'
                          : s === 'SHORT'
                          ? 'bg-[var(--color-short)]/20 text-[var(--color-short)]'
                          : 'bg-primary/20 text-primary'
                        : 'bg-background text-muted-foreground hover:bg-muted/30'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>

              {/* Date range */}
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  value={filterFrom}
                  onChange={e => setFilterFrom(e.target.value)}
                  className="h-8 text-xs w-36 bg-background border-border"
                  placeholder="From"
                />
                <span className="text-muted-foreground text-xs">–</span>
                <Input
                  type="date"
                  value={filterTo}
                  onChange={e => setFilterTo(e.target.value)}
                  className="h-8 text-xs w-36 bg-background border-border"
                  placeholder="To"
                />
              </div>

              {/* Count + clear */}
              <div className="ml-auto flex items-center gap-3">
                {hasFilters && (
                  <span className="text-xs text-muted-foreground">
                    Showing {filtered.length} of {closedTrades.length}
                  </span>
                )}
                {hasFilters && (
                  <Button size="sm" variant="ghost" onClick={clearFilters} className="h-8 px-2 gap-1 text-xs">
                    <X className="w-3.5 h-3.5" /> Clear
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* ── Trade History ── */}
        <TabsContent value="trades" className="flex-1 mt-0">
          <Card className="h-full flex flex-col overflow-hidden">
            <div className="overflow-auto flex-1">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 sticky top-0 z-10 backdrop-blur-md border-b border-border">
                  <tr>
                    <th className="text-left font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Time</th>
                    <th className="text-left font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Symbol / Side</th>
                    <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Size</th>
                    <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Close Price</th>
                    <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Realized PnL</th>
                    <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Strategy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-muted-foreground">
                        {closedTrades.length === 0 ? 'No closed trades yet' : 'No trades match the current filters'}
                      </td>
                    </tr>
                  ) : (
                    filtered.map(trade => (
                      <tr key={trade.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-6 text-muted-foreground font-mono text-xs">
                          {format(new Date(trade.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                        </td>
                        <td className="py-3 px-6">
                          <div className="flex items-center gap-3">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                              trade.side === 'LONG'
                                ? 'bg-[var(--color-long)]/20 text-[var(--color-long)]'
                                : 'bg-[var(--color-short)]/20 text-[var(--color-short)]'
                            }`}>
                              {trade.side}
                            </span>
                            <span className="font-bold">{trade.symbol.replace('USDT', '')}</span>
                            <span className="text-xs text-muted-foreground">/USDT</span>
                          </div>
                        </td>
                        <td className="py-3 px-6 text-right font-mono">${(trade.sizeInUsd ?? 0).toFixed(0)}</td>
                        <td className="py-3 px-6 text-right font-mono">{trade.price.toFixed(2)}</td>
                        <td className="py-3 px-6 text-right">
                          <span className={`font-mono font-medium ${
                            trade.pnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'
                          }`}>
                            {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                          </span>
                        </td>
                        <td className="py-3 px-6 text-right text-muted-foreground text-xs uppercase tracking-wider">
                          {trade.strategy}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </TabsContent>

        {/* ── AI 결정 & 승인 이력 ── */}
        <TabsContent value="ai" className="flex-1 mt-0 flex flex-col">
          <AiHistoryTab />
        </TabsContent>

        {/* ── Strategy Logs ── */}
        <TabsContent value="logs" className="flex-1 mt-0">
          <Card className="h-full flex flex-col overflow-hidden">
            <div className="overflow-auto flex-1 p-0">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 sticky top-0 z-10 backdrop-blur-md border-b border-border">
                  <tr>
                    <th className="text-left font-medium text-muted-foreground py-3 px-6 w-48">Time</th>
                    <th className="text-left font-medium text-muted-foreground py-3 px-6 w-28">Level</th>
                    <th className="text-left font-medium text-muted-foreground py-3 px-6">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-12 text-center text-muted-foreground">
                        No log entries yet
                      </td>
                    </tr>
                  ) : logs.map(log => (
                    <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                      <td className="py-2.5 px-6 text-muted-foreground font-mono text-xs">
                        {format(new Date(log.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                      </td>
                      <td className="py-2.5 px-6">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded tracking-widest ${
                          log.level === 'INFO'  ? 'bg-blue-500/20 text-blue-400' :
                          log.level === 'WARN'  ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]' :
                                                  'bg-[var(--color-long)]/20 text-[var(--color-long)]'
                        }`}>
                          {log.level}
                        </span>
                      </td>
                      <td className="py-2.5 px-6 font-mono text-sm">{log.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
