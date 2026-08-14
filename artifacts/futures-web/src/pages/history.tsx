import { useState, useMemo } from 'react';
import { useTradingContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { format } from 'date-fns';
import { Download, X } from 'lucide-react';

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

export default function HistoryPage() {
  const { closedTrades, logs } = useTradingContext();
  const [activeTab, setActiveTab] = useState('trades');

  // ── Filter state ─────────────────────────────────────────────────────────
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
