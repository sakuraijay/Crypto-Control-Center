import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/apiUrl';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { AlertCircle, CheckCircle2, ShieldAlert } from 'lucide-react';

export interface OfflineCostTotals {
  feesUsd: number;
  slippageUsd: number;
  fundingUsd: number;
  borrowingUsd: number;
  impactUsd: number;
  totalUsd: number;
}

export interface OfflineMetrics {
  tradeCount: number;
  grossReturnPct: number | null;
  netReturnPct: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
  profitFactor: number | null;
  expectancyUsd: number | null;
  averageR: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  costs: OfflineCostTotals;
  equityCurve: Array<{ time: number; equityUsd: number }>;
}

export interface OfflineBreakdownRow {
  trades: number;
  netPnlUsd: number;
}

export interface OfflineSampleResult {
  metrics: OfflineMetrics;
  trades: any[];
  blocked: Record<string, number>;
  breakdown: {
    month: Record<string, OfflineBreakdownRow>;
    direction: Record<string, OfflineBreakdownRow>;
    strategy: Record<string, OfflineBreakdownRow>;
    regime: Record<string, OfflineBreakdownRow>;
    profile: Record<string, OfflineBreakdownRow>;
  };
}

export interface OfflineFoldResult {
  fold: number;
  trainStartTime: number;
  trainEndTime: number;
  oosStartTime: number;
  oosEndTime: number;
  is: OfflineSampleResult;
  oos: OfflineSampleResult;
}

export interface OfflineThresholdResult {
  threshold: number;
  folds: OfflineFoldResult[];
  aggregateOos: OfflineSampleResult;
}

export interface OfflineBtcReport {
  status: 'OK' | 'UNAVAILABLE';
  generatedAtMs: number;
  provenance: {
    datasetId: string;
    source: string;
    license: string | null;
    immutable: boolean;
    checksumAlgorithm: string;
    checksums: Record<string, string | null>;
    period: { fromMs: number | null; toMs: number | null };
  };
  evidence: {
    candleCounts: Record<string, number>;
    costCount: number;
    riskCount: number;
  };
  issues: string[];
  walkForward: {
    config: any;
    input: any;
    thresholds: OfflineThresholdResult[];
  } | null;
  autoPromotionAllowed: boolean;
  liveExecutionAuthorized: boolean;
}

function fmt(n: number | null | undefined, dec = 2) {
  if (n == null) return 'Unavailable';
  return n.toFixed(dec);
}

function fmtPct(n: number | null | undefined) {
  if (n == null) return 'Unavailable';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtUSD(n: number | null | undefined) {
  if (n == null) return 'Unavailable';
  const val = Math.abs(n);
  return `${n < 0 ? '-' : ''}$${val.toLocaleString('en', { maximumFractionDigits: 2 })}`;
}

function fmtDate(ms: number | null | undefined) {
  if (ms == null) return 'Unavailable';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function ReportMetricCard({ label, value, positive }: { label: string, value: string | number | null, positive?: boolean | null }) {
  const color =
    positive === true ? 'text-emerald-400' :
    positive === false ? 'text-red-400' :
    'text-foreground';
  return (
    <div className="bg-card border border-border rounded-lg p-3 flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className={`font-bold font-mono ${value === 'Unavailable' ? 'text-xs text-muted-foreground/60' : 'text-lg ' + color}`}>{value ?? 'Unavailable'}</span>
    </div>
  );
}

const CostCard = ({ label, value }: { label: string, value: string }) => (
  <div className="flex justify-between items-center py-1.5 border-b border-border/50 last:border-0">
    <span className="text-xs text-muted-foreground tracking-wider">{label}</span>
    <span className="font-mono text-xs font-semibold">{value}</span>
  </div>
);

const BreakdownSection = ({ title, data }: { title: string, data: Record<string, OfflineBreakdownRow> }) => {
  const entries = Object.entries(data).sort((a, b) => b[1].trades - a[1].trades);
  if (entries.length === 0) return null;
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{title}</h4>
      <div className="space-y-1.5">
        {entries.map(([key, val]) => (
          <div key={key} className="flex justify-between items-center text-xs">
            <span className="text-muted-foreground font-mono truncate mr-2" title={key}>{key}</span>
            <div className="flex items-center gap-3 shrink-0">
              <span className="font-mono text-muted-foreground w-6 text-right">{val.trades}</span>
              <span className={`font-mono w-16 text-right ${val.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {fmtUSD(val.netPnlUsd)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const BlockedSection = ({ blocked, ambiguousCount }: { blocked: Record<string, number>, ambiguousCount: number }) => {
  const entries = Object.entries(blocked).filter(([_, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0 && ambiguousCount === 0) return <span className="text-xs text-muted-foreground">No blocked trades.</span>;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
      {entries.map(([reason, count]) => (
        <div key={reason} className="flex justify-between items-center text-xs py-1 border-b border-border/30 last:border-0">
          <span className="text-muted-foreground uppercase tracking-wider text-[10px]">{reason.replace(/_/g, ' ')}</span>
          <span className="font-mono font-semibold">{count}</span>
        </div>
      ))}
      {ambiguousCount > 0 && (
        <div className="flex justify-between items-center text-xs py-1 border-b border-border/30 last:border-0 col-span-2">
          <span className="text-muted-foreground uppercase tracking-wider text-[10px]">AMBIGUOUS STOP FIRST</span>
          <span className="font-mono font-semibold text-amber-500">{ambiguousCount}</span>
        </div>
      )}
    </div>
  );
};

export function OfflineBtcReportView() {
  const [data, setData] = useState<OfflineBtcReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeThreshold, setActiveThreshold] = useState<number>(60);

  useEffect(() => {
    let active = true;
    fetch(apiUrl('backtest/offline-btc-report'))
      .then(res => {
         if (!res.ok) throw new Error(`API fetch failed: ${res.status}`);
         return res.json();
      })
      .then(json => {
         if (active) {
            setData(json);
            if (json.walkForward?.thresholds?.length > 0) {
              setActiveThreshold(json.walkForward.thresholds[0].threshold);
            }
            setLoading(false);
         }
      })
      .catch(err => {
         if (active) {
            setError(err.message);
            setLoading(false);
         }
      });
    return () => { active = false; };
  }, []);

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 bg-card border border-border w-1/4 rounded-lg"></div>
        <div className="grid grid-cols-3 gap-4">
          <div className="h-48 bg-card border border-border rounded-lg"></div>
          <div className="h-48 bg-card border border-border rounded-lg"></div>
          <div className="h-48 bg-card border border-border rounded-lg"></div>
        </div>
        <div className="h-64 bg-card border border-border rounded-lg"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-4 py-3 text-sm text-destructive">
        Failed to load Offline BTC Report: {error}
      </div>
    );
  }

  if (!data) return null;

  const thresholdData = data.walkForward?.thresholds.find(t => t.threshold === activeThreshold);
  const activeOos = thresholdData?.aggregateOos;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-foreground flex items-center gap-3">
            Task 150 Report
            {data.status === 'OK' ? (
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3"/> OK</span>
            ) : (
              <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1.5"><ShieldAlert className="w-3 h-3"/> UNAVAILABLE</span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground mt-1">Generated: <span className="font-mono">{fmtDate(data.generatedAtMs)}</span></p>
        </div>
        
        {/* Safety Locks */}
        <div className="flex items-center gap-4 bg-card border border-border rounded-lg px-4 py-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className={`w-4 h-4 ${data.autoPromotionAllowed ? 'text-emerald-500' : 'text-amber-500'}`} />
            <span className="text-xs text-muted-foreground">Auto Promotion: <strong className={data.autoPromotionAllowed ? 'text-emerald-500' : 'text-amber-500'}>{data.autoPromotionAllowed ? 'ALLOWED' : 'LOCKED'}</strong></span>
          </div>
          <div className="w-px h-6 bg-border" />
          <div className="flex items-center gap-2">
            <ShieldAlert className={`w-4 h-4 ${data.liveExecutionAuthorized ? 'text-emerald-500' : 'text-amber-500'}`} />
            <span className="text-xs text-muted-foreground">Live Execution: <strong className={data.liveExecutionAuthorized ? 'text-emerald-500' : 'text-amber-500'}>{data.liveExecutionAuthorized ? 'AUTHORIZED' : 'LOCKED'}</strong></span>
          </div>
        </div>
      </div>

      {/* Issues */}
      {data.issues && data.issues.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
          <h3 className="text-xs font-bold text-amber-500 mb-2 flex items-center gap-1.5 uppercase tracking-wider"><AlertCircle className="w-4 h-4"/> Integrity Issues</h3>
          <ul className="list-disc list-inside text-xs text-amber-400/80 space-y-1 ml-1 font-mono">
            {data.issues.map((iss, i) => <li key={i}>{iss}</li>)}
          </ul>
        </div>
      )}

      {/* Provenance & Evidence Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Provenance */}
        <div className="bg-card border border-border rounded-lg p-4 space-y-4 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-2">Provenance</h3>
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Dataset ID</span>
              <span className="font-mono truncate ml-4" title={data.provenance.datasetId || ''}>{data.provenance.datasetId || '-'}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Source</span>
              <span className="font-mono truncate ml-4" title={data.provenance.source || ''}>{data.provenance.source || '-'}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">License</span>
              <span className="font-mono">{data.provenance.license || '-'}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Immutable</span>
              <span className={`font-mono font-bold ${data.provenance.immutable ? 'text-emerald-400' : 'text-amber-400'}`}>{data.provenance.immutable ? 'TRUE' : 'FALSE'}</span>
            </div>
            <div className="flex justify-between items-center text-xs pt-2 border-t border-border/30">
              <span className="text-muted-foreground">From</span>
              <span className="font-mono">{fmtDate(data.provenance.period.fromMs)}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">To</span>
              <span className="font-mono">{fmtDate(data.provenance.period.toMs)}</span>
            </div>
          </div>
        </div>

        {/* Evidence */}
        <div className="bg-card border border-border rounded-lg p-4 space-y-4 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-2">Evidence Coverage</h3>
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Candles 15m</span>
              <span className="font-mono">{data.evidence.candleCounts['15m'].toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Candles 1h</span>
              <span className="font-mono">{data.evidence.candleCounts['1h'].toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Candles 4h</span>
              <span className="font-mono">{data.evidence.candleCounts['4h'].toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center text-xs pt-2 border-t border-border/30">
              <span className="text-muted-foreground">Historical Costs</span>
              <span className="font-mono">{data.evidence.costCount.toLocaleString()} points</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Risk Policies</span>
              <span className="font-mono">{data.evidence.riskCount.toLocaleString()} points</span>
            </div>
          </div>
        </div>

        {/* Checksums */}
        <div className="bg-card border border-border rounded-lg p-4 space-y-4 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-2 flex items-center justify-between">
            <span>Integrity</span>
            <span className="text-[9px] bg-muted px-1.5 py-0.5 rounded">{data.provenance.checksumAlgorithm || '-'}</span>
          </h3>
          <div className="space-y-2">
            {['15m', '1h', '4h', 'costs', 'risk'].map(key => (
              <div key={key} className="flex justify-between items-center text-xs">
                <span className="text-muted-foreground uppercase text-[10px] tracking-wider">{key}</span>
                <span className="font-mono text-[9px] bg-background border border-border px-1.5 py-0.5 rounded text-muted-foreground truncate w-40 text-right" title={data.provenance.checksums[key as any] || 'MISSING'}>
                  {data.provenance.checksums[key as any] || 'MISSING'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Walk Forward Content */}
      {data.status === 'UNAVAILABLE' || !data.walkForward ? (
        <div className="bg-card border border-border rounded-lg p-16 text-center space-y-4 shadow-sm">
          <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-2">
            <ShieldAlert className="w-6 h-6 text-amber-500" />
          </div>
          <p className="text-foreground font-semibold">Walk-Forward Data Unavailable</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            Offline report generation is currently restricted or data inputs failed integrity checks. See issues panel for detailed reasons.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Threshold Tabs */}
          <div className="flex flex-wrap gap-2">
            {data.walkForward.thresholds.map(t => (
              <button
                key={t.threshold}
                onClick={() => setActiveThreshold(t.threshold)}
                className={`px-5 py-2 rounded-md text-xs font-bold transition-all border ${
                  activeThreshold === t.threshold 
                    ? 'bg-primary text-primary-foreground border-primary shadow-sm' 
                    : 'bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-foreground hover:bg-primary/5'
                }`}
              >
                Sensitivity: {t.threshold}
              </button>
            ))}
          </div>

          {activeOos && (
            <div className="space-y-6">
              {/* OOS Metrics Grid */}
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 ml-1">Aggregate OOS Core Metrics</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  <ReportMetricCard label="Trade Count" value={activeOos.metrics.tradeCount} />
                  <ReportMetricCard label="Net Return" value={fmtPct(activeOos.metrics.netReturnPct)} positive={activeOos.metrics.netReturnPct != null ? activeOos.metrics.netReturnPct >= 0 : null} />
                  <ReportMetricCard label="Gross Return" value={fmtPct(activeOos.metrics.grossReturnPct)} positive={activeOos.metrics.grossReturnPct != null ? activeOos.metrics.grossReturnPct >= 0 : null} />
                  <ReportMetricCard label="Win Rate" value={fmtPct(activeOos.metrics.winRatePct)} positive={activeOos.metrics.winRatePct != null ? activeOos.metrics.winRatePct >= 50 : null} />
                  <ReportMetricCard label="Max Drawdown" value={activeOos.metrics.maxDrawdownPct != null ? `-${fmt(activeOos.metrics.maxDrawdownPct)}%` : 'Unavailable'} positive={activeOos.metrics.maxDrawdownPct != null ? activeOos.metrics.maxDrawdownPct < 15 : null} />
                  <ReportMetricCard label="Profit Factor" value={fmt(activeOos.metrics.profitFactor)} positive={activeOos.metrics.profitFactor != null ? activeOos.metrics.profitFactor > 1 : null} />
                  <ReportMetricCard label="Expectancy" value={fmtUSD(activeOos.metrics.expectancyUsd)} positive={activeOos.metrics.expectancyUsd != null ? activeOos.metrics.expectancyUsd >= 0 : null} />
                  <ReportMetricCard label="Average R" value={fmt(activeOos.metrics.averageR)} positive={activeOos.metrics.averageR != null ? activeOos.metrics.averageR > 0 : null} />
                  <ReportMetricCard label="Sharpe" value={fmt(activeOos.metrics.sharpe)} positive={activeOos.metrics.sharpe != null ? activeOos.metrics.sharpe > 1 : null} />
                  <ReportMetricCard label="Sortino" value={fmt(activeOos.metrics.sortino)} positive={activeOos.metrics.sortino != null ? activeOos.metrics.sortino > 1.5 : null} />
                  <ReportMetricCard label="Max Cons Wins" value={activeOos.metrics.maxConsecutiveWins ?? 'Unavailable'} />
                  <ReportMetricCard label="Max Cons Losses" value={activeOos.metrics.maxConsecutiveLosses ?? 'Unavailable'} />
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                {/* Equity Curve */}
                <div className="lg:col-span-3 bg-card border border-border rounded-lg p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">OOS Equity Curve</h2>
                    <span className="text-[10px] text-muted-foreground bg-muted/30 px-2 py-0.5 rounded">{activeOos.metrics.equityCurve.length} observations</span>
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={activeOos.metrics.equityCurve} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="oosEquity" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#10b981" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="time" tickFormatter={(v) => new Date(v).toISOString().slice(5,10)} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} minTickGap={30} />
                      <YAxis domain={['auto', 'auto']} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={48} />
                      <Tooltip
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 6, fontSize: 11, boxShadow: 'var(--shadow-md)' }}
                        labelFormatter={v => fmtDate(Number(v))}
                        formatter={(v: number) => [<span className="font-mono font-medium">{fmtUSD(v)}</span>, 'Equity']}
                      />
                      <Area type="monotone" dataKey="equityUsd" stroke="#10b981" strokeWidth={1.5} fill="url(#oosEquity)" dot={false} activeDot={{ r: 4, fill: '#10b981', stroke: 'hsl(var(--card))', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Costs */}
                <div className="bg-card border border-border rounded-lg p-5 shadow-sm flex flex-col">
                  <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4">Cost Structure</h3>
                  <div className="space-y-1 flex-1">
                    <CostCard label="Fees" value={fmtUSD(activeOos.metrics.costs.feesUsd)} />
                    <CostCard label="Slippage" value={fmtUSD(activeOos.metrics.costs.slippageUsd)} />
                    <CostCard label="Funding" value={fmtUSD(activeOos.metrics.costs.fundingUsd)} />
                    <CostCard label="Borrowing" value={fmtUSD(activeOos.metrics.costs.borrowingUsd)} />
                    <CostCard label="Market Impact" value={fmtUSD(activeOos.metrics.costs.impactUsd)} />
                  </div>
                  <div className="pt-3 mt-3 border-t border-border flex justify-between items-center bg-muted/10 -mx-5 -mb-5 p-5 rounded-b-lg">
                    <span className="text-xs font-bold text-foreground uppercase tracking-wider">Total Load</span>
                    <span className="font-mono text-sm font-bold text-red-400">-{fmtUSD(activeOos.metrics.costs.totalUsd)}</span>
                  </div>
                </div>
              </div>

              {/* Folds Table */}
              <div className="bg-card border border-border rounded-lg overflow-hidden shadow-sm">
                <div className="px-5 py-4 border-b border-border bg-muted/5">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Walk-Forward Boundaries</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
                        <th className="text-left px-5 py-3 font-medium">Fold</th>
                        <th className="text-left px-5 py-3 font-medium">Train Bound</th>
                        <th className="text-left px-5 py-3 font-medium border-r border-border/50">OOS Bound</th>
                        <th className="text-right px-5 py-3 font-medium text-emerald-500/80">IS TRD</th>
                        <th className="text-right px-5 py-3 font-medium text-emerald-500/80 border-r border-border/50">IS RET</th>
                        <th className="text-right px-5 py-3 font-medium text-primary/80">OOS TRD</th>
                        <th className="text-right px-5 py-3 font-medium text-primary/80">OOS RET</th>
                        <th className="text-right px-5 py-3 font-medium text-primary/80">OOS WIN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {thresholdData?.folds.map(fold => (
                        <tr key={fold.fold} className="border-b border-border/30 hover:bg-muted/10 transition-colors">
                          <td className="px-5 py-2.5 font-mono text-xs">{fold.fold}</td>
                          <td className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                            {fmtDate(fold.trainStartTime).slice(0, 10)} <span className="opacity-50 mx-1">→</span> {fmtDate(fold.trainEndTime).slice(0, 10)}
                          </td>
                          <td className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground whitespace-nowrap border-r border-border/50">
                            {fmtDate(fold.oosStartTime).slice(0, 10)} <span className="opacity-50 mx-1">→</span> {fmtDate(fold.oosEndTime).slice(0, 10)}
                          </td>
                          <td className="px-5 py-2.5 font-mono text-xs text-right text-muted-foreground">{fold.is.metrics.tradeCount}</td>
                          <td className={`px-5 py-2.5 font-mono text-xs text-right border-r border-border/50 ${fold.is.metrics.netReturnPct != null && fold.is.metrics.netReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {fmtPct(fold.is.metrics.netReturnPct)}
                          </td>
                          <td className="px-5 py-2.5 font-mono text-xs text-right text-muted-foreground">{fold.oos.metrics.tradeCount}</td>
                          <td className={`px-5 py-2.5 font-mono text-xs text-right font-semibold ${fold.oos.metrics.netReturnPct != null && fold.oos.metrics.netReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {fmtPct(fold.oos.metrics.netReturnPct)}
                          </td>
                          <td className="px-5 py-2.5 font-mono text-xs text-right text-muted-foreground">
                            {fmtPct(fold.oos.metrics.winRatePct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Blocked & Breakdowns */}
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                <div className="bg-card border border-border rounded-lg p-5 shadow-sm">
                  <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4 border-b border-border/50 pb-2">Blocked / Ambiguous</h3>
                  <BlockedSection blocked={activeOos.blocked} ambiguousCount={activeOos.trades?.filter((t: any) => t.exitReason === 'AMBIGUOUS_STOP_FIRST').length || 0} />
                </div>
                <div className="lg:col-span-3 bg-card border border-border rounded-lg p-5 shadow-sm">
                  <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4 border-b border-border/50 pb-2">OOS Breakdown</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-x-8 gap-y-6">
                    <BreakdownSection title="Month" data={activeOos.breakdown.month} />
                    <BreakdownSection title="Direction" data={activeOos.breakdown.direction} />
                    <BreakdownSection title="Strategy" data={activeOos.breakdown.strategy} />
                    <BreakdownSection title="Regime" data={activeOos.breakdown.regime} />
                    <BreakdownSection title="Profile" data={activeOos.breakdown.profile} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
