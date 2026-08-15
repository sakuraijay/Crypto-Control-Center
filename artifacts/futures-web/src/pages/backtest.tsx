import { useState, useCallback } from 'react';
import { useStrategyContext } from '@/lib/context/StrategyContext';
import { runBacktest, parseGmxCandles, webIndicatorsToBacktestConfig, type BacktestResult, type BacktestTrade } from '@/lib/backtest/engine';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, Activity, Target, BarChart2, Zap } from 'lucide-react';

const SYMBOLS = ['BTC','ETH','SOL','ARB','LINK','AVAX','DOGE','BNB','XRP','DOT'];
const INTERVALS = [
  { label: '1 Hour',  value: '1h',  countBack: 500 },
  { label: '4 Hours', value: '4h',  countBack: 500 },
  { label: '1 Day',   value: '1d',  countBack: 365 },
];
const PERIODS = [
  { label: '30 Days',  days: 30  },
  { label: '90 Days',  days: 90  },
  { label: '180 Days', days: 180 },
  { label: '1 Year',   days: 365 },
];

function fmt(n: number, dec = 2) { return n.toFixed(dec); }
function fmtPct(n: number) { return `${n >= 0 ? '+' : ''}${fmt(n)}%`; }
function fmtUSD(n: number) { return `$${Math.abs(n).toLocaleString('en', { maximumFractionDigits: 2 })}`; }
function fmtTime(ms: number) {
  return new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean | null;
  icon: React.ReactNode;
}

function MetricCard({ label, value, sub, positive, icon }: MetricCardProps) {
  const color =
    positive === true  ? 'text-emerald-400' :
    positive === false ? 'text-red-400' :
    'text-foreground';
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <span className={`text-xl font-bold font-mono ${color}`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

export default function BacktestPage() {
  const { indicators } = useStrategyContext();

  const [symbol,   setSymbol]   = useState('BTC');
  const [interval, setInterval] = useState('1h');
  const [period,   setPeriod]   = useState(90);
  const [capital,  setCapital]  = useState(10000);
  const [tpPct,    setTpPct]    = useState(2);
  const [slPct,    setSlPct]    = useState(1);

  const [result,  setResult]  = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [dataSource, setDataSource] = useState<string>('');

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    setResult(null);
    setDataSource('');
    try {
      const iv = INTERVALS.find(i => i.value === interval)!;
      const countBack = Math.min(iv.countBack, Math.ceil(period * 24 / (interval === '1d' ? 24 : interval === '4h' ? 4 : 1)));

      const res = await fetch(
        `/api/gmx/candles?symbol=${symbol}&period=${interval}&countBack=${countBack}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) throw new Error(`GMX candle fetch failed: ${res.status}`);
      const data = await res.json() as { prices: number[][]; source: string };
      if (!data.prices?.length) throw new Error('No candle data returned');

      setDataSource(data.source);
      const candles = parseGmxCandles(data.prices);
      const btResult = runBacktest(candles, {
        indicators: webIndicatorsToBacktestConfig(indicators),
        initialCapital: capital,
        tpPct, slPct,
        feePct: 0.06,       // GMX taker fee ~0.05-0.07%
        positionSizePct: 0.10,
      });
      setResult(btResult);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Backtest failed');
    } finally {
      setLoading(false);
    }
  }, [symbol, interval, period, capital, tpPct, slPct, indicators]);

  const pos = result ? result.totalReturnPct >= 0 : null;

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Backtest</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Simulate your current strategy against GMX V2 historical price data · Arbitrum One
        </p>
      </div>

      {/* Config + Run */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 items-end">
          {/* Symbol */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Symbol</label>
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              className="bg-background border border-border rounded px-3 py-2 text-sm text-foreground"
            >
              {SYMBOLS.map(s => <option key={s} value={s}>{s}/USD</option>)}
            </select>
          </div>

          {/* Interval */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Interval</label>
            <select
              value={interval}
              onChange={e => setInterval(e.target.value)}
              className="bg-background border border-border rounded px-3 py-2 text-sm text-foreground"
            >
              {INTERVALS.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </div>

          {/* Period */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Period</label>
            <select
              value={period}
              onChange={e => setPeriod(Number(e.target.value))}
              className="bg-background border border-border rounded px-3 py-2 text-sm text-foreground"
            >
              {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
            </select>
          </div>

          {/* Capital */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Capital (USDC)</label>
            <input
              type="number" min={100} step={1000} value={capital}
              onChange={e => setCapital(Number(e.target.value))}
              className="bg-background border border-border rounded px-3 py-2 text-sm text-foreground w-full"
            />
          </div>

          {/* TP / SL */}
          <div className="flex gap-2">
            <div className="flex flex-col gap-1.5 flex-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">TP %</label>
              <input type="number" min={0.1} step={0.5} value={tpPct}
                onChange={e => setTpPct(Number(e.target.value))}
                className="bg-background border border-border rounded px-3 py-2 text-sm text-foreground w-full"
              />
            </div>
            <div className="flex flex-col gap-1.5 flex-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">SL %</label>
              <input type="number" min={0.1} step={0.5} value={slPct}
                onChange={e => setSlPct(Number(e.target.value))}
                className="bg-background border border-border rounded px-3 py-2 text-sm text-foreground w-full"
              />
            </div>
          </div>

          {/* Run */}
          <button
            onClick={run}
            disabled={loading}
            className="h-[38px] px-6 rounded bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? 'Running…' : 'Run Backtest'}
          </button>
        </div>

        {/* Active indicator pills */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {indicators.filter(i => i.enabled).map(i => (
            <span key={i.id} className="px-2 py-0.5 rounded bg-primary/10 text-primary text-xs font-medium">
              {i.name}
            </span>
          ))}
          {dataSource && (
            <span className={`px-2 py-0.5 rounded text-xs font-medium ml-auto ${dataSource === 'synthetic' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
              {dataSource === 'synthetic' ? '⚠ Synthetic data (GMX unavailable)' : '✓ GMX live data'}
            </span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-4 animate-pulse">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-24 bg-card border border-border rounded-lg" />
            ))}
          </div>
          <div className="h-64 bg-card border border-border rounded-lg" />
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4">
          {/* Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <MetricCard
              label="Total Return"
              value={fmtPct(result.totalReturnPct)}
              sub={`${fmtUSD(result.finalEquity)} final`}
              positive={result.totalReturnPct >= 0}
              icon={<TrendingUp className="w-4 h-4" />}
            />
            <MetricCard
              label="Win Rate"
              value={`${fmt(result.winRate)}%`}
              sub={`${result.trades.filter(t => t.pnl > 0).length} / ${result.tradeCount} trades`}
              positive={result.winRate >= 50}
              icon={<Target className="w-4 h-4" />}
            />
            <MetricCard
              label="Max Drawdown"
              value={`-${fmt(result.maxDrawdownPct)}%`}
              positive={result.maxDrawdownPct < 10 ? true : result.maxDrawdownPct > 20 ? false : null}
              icon={<TrendingDown className="w-4 h-4" />}
            />
            <MetricCard
              label="Trade Count"
              value={String(result.tradeCount)}
              sub={`${symbol}/USD ${interval} — ${period}d`}
              icon={<Activity className="w-4 h-4" />}
            />
            <MetricCard
              label="Profit Factor"
              value={result.profitFactor === Infinity ? '∞' : fmt(result.profitFactor)}
              sub="gross profit / gross loss"
              positive={result.profitFactor >= 1.5 ? true : result.profitFactor < 1 ? false : null}
              icon={<BarChart2 className="w-4 h-4" />}
            />
            <MetricCard
              label="Avg Win / Loss"
              value={`${fmtPct(result.avgWinPct)} / ${fmtPct(result.avgLossPct)}`}
              positive={Math.abs(result.avgWinPct) > Math.abs(result.avgLossPct)}
              icon={<Zap className="w-4 h-4" />}
            />
          </div>

          {/* Equity Curve */}
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">Equity Curve</h2>
              <span className="text-xs text-muted-foreground">{result.equityCurve.length} data points</span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={result.equityCurve} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="btEquity" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={pos ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={pos ? '#10b981' : '#ef4444'} stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" tickFormatter={fmtTime} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={v => `$${(v/1000).toFixed(1)}k`} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={56} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 12 }}
                  labelFormatter={v => fmtTime(Number(v))}
                  formatter={(v: number) => [`$${v.toLocaleString('en', { maximumFractionDigits: 2 })}`, 'Equity']}
                />
                <ReferenceLine y={capital} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeWidth={1} />
                <Area type="monotone" dataKey="equity" stroke={pos ? '#10b981' : '#ef4444'} strokeWidth={1.5} fill="url(#btEquity)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Trades Table */}
          {result.trades.length > 0 && (
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <h2 className="text-sm font-semibold uppercase tracking-wider">Trades ({result.tradeCount})</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground uppercase">
                      <th className="text-left px-4 py-2">Entry</th>
                      <th className="text-left px-4 py-2">Exit</th>
                      <th className="text-left px-4 py-2">Side</th>
                      <th className="text-right px-4 py-2">Entry $</th>
                      <th className="text-right px-4 py-2">Exit $</th>
                      <th className="text-right px-4 py-2">PnL</th>
                      <th className="text-left px-4 py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.slice(0, 100).map((t: BacktestTrade, i: number) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{fmtTime(t.entryTime)}</td>
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{fmtTime(t.exitTime)}</td>
                        <td className="px-4 py-2">
                          <span className={`text-xs font-bold ${t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
                            {t.side}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono">{t.entryPrice.toLocaleString('en', { maximumFractionDigits: 2 })}</td>
                        <td className="px-4 py-2 text-right font-mono">{t.exitPrice.toLocaleString('en', { maximumFractionDigits: 2 })}</td>
                        <td className={`px-4 py-2 text-right font-mono font-semibold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {fmtPct(t.pnlPct)}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.trades.length > 100 && (
                  <p className="text-center text-xs text-muted-foreground py-2">
                    Showing 100 of {result.trades.length} trades
                  </p>
                )}
              </div>
            </div>
          )}

          {result.tradeCount === 0 && (
            <div className="bg-card border border-border rounded-lg p-8 text-center">
              <p className="text-muted-foreground text-sm">No trades generated. Try enabling more indicators or a longer period.</p>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!result && !loading && !error && (
        <div className="bg-card border border-border rounded-lg p-12 text-center space-y-3">
          <BarChart2 className="w-10 h-10 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Configure the parameters above and click <strong>Run Backtest</strong></p>
          <p className="text-xs text-muted-foreground">Uses your current Strategy indicator settings — enable/disable indicators on the Strategy page</p>
          <p className="text-xs text-muted-foreground/60">Data source: GMX V2 · Arbitrum One · stats.gmx.io</p>
        </div>
      )}
    </div>
  );
}
