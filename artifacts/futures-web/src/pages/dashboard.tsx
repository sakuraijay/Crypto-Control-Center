import { useState } from 'react';
import { useTradingContext, useWatchlistContext, useAppContext, useStrategyContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { ArrowRight, TrendingUp, TrendingDown, Activity, Clock, ShieldAlert, Layers, Plus } from 'lucide-react';
import { format } from 'date-fns';
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { NewOrderDrawer } from '@/components/trading/NewOrderDrawer';
import { VpsStatusPanel } from '@/components/vps/VpsStatusPanel';
import { DailyTargetCard } from '@/components/dashboard/DailyTargetCard';
import { AiStateCard } from '@/components/dashboard/AiStateCard';
import { LiveApprovalCard } from '@/components/dashboard/LiveApprovalCard';
import { cn } from '@/lib/utils';

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <Card className="p-4 flex flex-col justify-between min-w-0">
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider truncate">{label}</span>
      <span className={cn('text-2xl font-mono font-bold mt-1 truncate', color ?? 'text-foreground')}>{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground mt-0.5 truncate">{sub}</span>}
    </Card>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded px-3 py-2 text-xs shadow-xl">
      <div className="text-muted-foreground">{format(new Date(payload[0].payload.time), 'HH:mm')}</div>
      <div className="font-mono font-bold text-foreground">${payload[0].value.toFixed(2)}</div>
    </div>
  );
}

export default function Dashboard() {
  const { account, positions, logs, todayStats, equityHistory } = useTradingContext();
  const { watchlist } = useWatchlistContext();
  const { stopNewOrders, toggleStopNewOrders, triggerEmergencyStop } = useAppContext();
  const { indicators } = useStrategyContext();

  const [orderOpen, setOrderOpen] = useState(false);

  const minScore = (indicators.find(i => i.id === 'combined')?.params.minScore as number) ?? 60;
  const signals = watchlist.filter(w => Math.abs(w.combinedScore) >= minScore / 2);
  const recentLogs = logs.slice(0, 6);

  const winRate = todayStats.count > 0 ? ((todayStats.wins / todayStats.count) * 100).toFixed(0) : '—';
  const equityData = equityHistory.slice(-48);
  const isEquityUp = equityData.length >= 2
    ? equityData[equityData.length - 1].equity >= equityData[0].equity
    : true;

  return (
    <div className="flex flex-col gap-5 animate-in fade-in duration-500">

      {/* ── Live operator approval gate (shown in LIVE_TRADING mode) ────────── */}
      <LiveApprovalCard />

      {/* ── AI 5-State Engine Card (primary monitoring surface) ──────────────── */}
      <AiStateCard />

      {/* ── VPS Engine Status ──────────────────────────────────────────────────── */}
      <VpsStatusPanel />

      {/* ── Daily Performance KPI ─────────────────────────────────────────────── */}
      <DailyTargetCard />

      {/* ── Row 1: Account KPIs ── */}
      <div className="grid grid-cols-4 gap-3">
        <KpiCard
          label="Total Balance"
          value={`$${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
        />
        <KpiCard
          label="Unrealized PnL"
          value={`${account.unrealizedPnl >= 0 ? '+' : ''}$${account.unrealizedPnl.toFixed(2)}`}
          color={account.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}
        />
        <KpiCard
          label="Margin Ratio"
          value={`${(account.marginRatio * 100).toFixed(1)}%`}
          color={account.marginRatio > 0.7 ? 'text-[var(--color-short)]' : account.marginRatio > 0.5 ? 'text-[var(--color-warning)]' : undefined}
          sub={`$${account.availableBalance.toFixed(0)} available`}
        />
        <Card className="p-4 flex flex-col justify-between border-border bg-card/50">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Quick Controls</span>
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-foreground">Stop New Orders</span>
              <Switch checked={stopNewOrders} onCheckedChange={toggleStopNewOrders} />
            </div>
            <Button onClick={triggerEmergencyStop} variant="destructive" size="sm" className="w-full font-bold tracking-widest text-[10px] h-7">
              <ShieldAlert className="w-3 h-3 mr-1.5" /> EMERGENCY STOP
            </Button>
          </div>
        </Card>
      </div>

      {/* ── Row 2: Today KPIs ── */}
      <div className="grid grid-cols-4 gap-3">
        <KpiCard
          label="Today Realized"
          value={`${todayStats.realized >= 0 ? '+' : ''}$${todayStats.realized.toFixed(2)}`}
          color={todayStats.realized >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}
        />
        <KpiCard
          label="Win Rate"
          value={winRate === '—' ? '—' : `${winRate}%`}
          sub={todayStats.count > 0 ? `${todayStats.wins}W / ${todayStats.losses}L` : 'No trades today'}
          color={parseInt(winRate) >= 50 ? 'text-[var(--color-long)]' : winRate === '—' ? undefined : 'text-[var(--color-short)]'}
        />
        <KpiCard
          label="Trades Today"
          value={String(todayStats.count)}
          sub={`${positions.length} positions open`}
        />
        <KpiCard
          label="Weekly PnL"
          value={`${account.weeklyPnl >= 0 ? '+' : ''}$${account.weeklyPnl.toFixed(2)}`}
          color={account.weeklyPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}
        />
      </div>

      {/* ── Main content ── */}
      <div className="grid grid-cols-3 gap-5">
        <div className="col-span-2 flex flex-col gap-5">

          {/* Equity chart */}
          <Card className="p-0 overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Equity Curve
              </h3>
              <span className={cn('text-xs font-mono', isEquityUp ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]')}>
                {equityData.length > 0 && `$${equityData[equityData.length - 1].equity.toFixed(2)}`}
              </span>
            </div>
            <div className="h-44 px-2 pt-3 pb-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityData} margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                  <defs>
                    <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={isEquityUp ? 'var(--color-long)' : 'var(--color-short)'} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={isEquityUp ? 'var(--color-long)' : 'var(--color-short)'} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="time"
                    tickFormatter={v => format(new Date(v), 'HH:mm')}
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                    axisLine={false} tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Area
                    type="monotone" dataKey="equity"
                    stroke={isEquityUp ? 'var(--color-long)' : 'var(--color-short)'}
                    strokeWidth={2}
                    fill="url(#equityGrad)"
                    dot={false} activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Positions mini-table */}
          <Card className="flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" /> Active Positions ({positions.length})
              </h3>
              <div className="flex items-center gap-3">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setOrderOpen(true)}>
                  <Plus className="w-3 h-3 mr-1" /> New Order
                </Button>
                <Link href="/positions" className="text-xs text-primary hover:underline flex items-center gap-1">
                  All <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
            <div className="p-0">
              {positions.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-sm">No open positions</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-secondary/50">
                    <tr>
                      <th className="text-left font-medium text-muted-foreground py-2 px-4">Symbol</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">Size</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">Entry</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">Mark</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">PnL / ROE</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {positions.slice(0, 5).map(pos => (
                      <tr key={pos.id} className="hover:bg-muted/50 transition-colors">
                        <td className="py-3 px-4 flex items-center gap-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${pos.side === 'LONG' ? 'bg-[var(--color-long)]/20 text-[var(--color-long)]' : 'bg-[var(--color-short)]/20 text-[var(--color-short)]'}`}>
                            {pos.side}
                          </span>
                          <span className="font-bold">{pos.displaySymbol ?? pos.symbol}</span>
                          <span className="text-xs text-muted-foreground">{pos.leverage}x</span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono">${pos.sizeInUsd.toFixed(0)}</td>
                        <td className="py-3 px-4 text-right font-mono">{pos.entryPrice.toFixed(2)}</td>
                        <td className="py-3 px-4 text-right font-mono">{pos.markPrice.toFixed(2)}</td>
                        <td className="py-3 px-4 text-right">
                          <div className={`font-mono font-medium ${pos.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                            {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl.toFixed(2)}
                          </div>
                          <div className={`text-xs font-mono ${pos.roe >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                            {pos.roe >= 0 ? '+' : ''}{pos.roe.toFixed(2)}%
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        </div>

        {/* ── Right column ── */}
        <div className="col-span-1 flex flex-col gap-5">

          {/* Active signals */}
          <Card className="flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Signals
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">min {(minScore / 2).toFixed(0)}</span>
                <Link href="/watchlist" className="text-xs text-primary hover:underline flex items-center gap-1">
                  All <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
            <div className="p-0">
              {signals.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-xs">No signals above threshold</div>
              ) : (
                <div className="divide-y divide-border">
                  {signals.slice(0, 6).map(sig => {
                    const bias = sig.combinedScore > 0 ? 'LONG' : 'SHORT';
                    const colorVar = bias === 'LONG' ? 'var(--color-long)' : 'var(--color-short)';
                    const Icon = bias === 'LONG' ? TrendingUp : TrendingDown;
                    return (
                      <div key={sig.symbol} className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/30 transition-colors">
                        <div className="flex items-center gap-2">
                          <Icon className="w-3.5 h-3.5" style={{ color: colorVar }} />
                          <div>
                            <div className="font-bold text-xs">{sig.symbol.replace('USDT', '')}</div>
                            <div className="text-[10px] text-muted-foreground font-mono">{sig.price.toFixed(4)}</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] font-bold" style={{ color: colorVar }}>{bias}</div>
                          <div className="text-xs font-mono">{sig.combinedScore >= 0 ? '+' : ''}{sig.combinedScore.toFixed(0)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          {/* Strategy logs */}
          <Card className="flex flex-col flex-1 overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" /> Strategy Logs
              </h3>
              <Link href="/history" className="text-xs text-primary hover:underline">Full Log</Link>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {recentLogs.map(log => (
                <div key={log.id} className="flex flex-col gap-1 pb-3 border-b border-border last:border-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                      log.level === 'INFO' ? 'bg-blue-500/20 text-blue-400' :
                      log.level === 'WARN' ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]' :
                      'bg-[var(--color-long)]/20 text-[var(--color-long)]'
                    }`}>{log.level}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{format(log.timestamp, 'HH:mm:ss')}</span>
                  </div>
                  <span className="text-xs leading-tight text-foreground/90">{log.message}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <NewOrderDrawer open={orderOpen} onClose={() => setOrderOpen(false)} />
    </div>
  );
}
