/**
 * Dashboard — primary desktop operator surface.
 *
 * Desktop-first layout (1280px+):
 *   Top row:    AI Engine state (7/12) │ Execution Engine + Performance (5/12)
 *   KPI rows:   Account metrics + Quick Controls
 *   Data grid:  Equity curve + Positions table (2/3) │ Signals + Strategy logs (1/3)
 */

import { useState } from 'react';
import { useTradingContext, useWatchlistContext, useAppContext, useStrategyContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import {
  ArrowRight, TrendingUp, TrendingDown, Activity, Clock,
  ShieldAlert, Layers, Plus, Target,
} from 'lucide-react';
import { format } from 'date-fns';
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { NewOrderDrawer } from '@/components/trading/NewOrderDrawer';
import { DailyTargetCard } from '@/components/dashboard/DailyTargetCard';
import { AiStateCard } from '@/components/dashboard/AiStateCard';
import { LiveApprovalCard } from '@/components/dashboard/LiveApprovalCard';
import { LiveApprovalBanner } from '@/components/dashboard/LiveApprovalBanner';
import { SystemHealthBanner } from '@/components/dashboard/SystemHealthBanner';
import { AiMarketRankingCard } from '@/components/dashboard/AiMarketRankingCard';
import { ExecutorStatusWidget } from '@/components/dashboard/ExecutorStatusWidget';
import { GmxOnchainCard } from '@/components/dashboard/GmxOnchainCard';
import { cn } from '@/lib/utils';

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <Card className="p-4 flex flex-col justify-between min-w-0">
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider truncate">
        {label}
      </span>
      <span className={cn('text-2xl font-mono font-bold mt-1 truncate', color ?? 'text-foreground')}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-muted-foreground mt-0.5 truncate">{sub}</span>}
    </Card>
  );
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────

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

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { account, positions, logs, todayStats, equityHistory, dataStatus } = useTradingContext();
  const { watchlist } = useWatchlistContext();
  const { stopNewOrders, toggleStopNewOrders, triggerEmergencyStop } = useAppContext();
  const { indicators, limits } = useStrategyContext();

  const [orderOpen, setOrderOpen] = useState(false);

  // PAPER 계좌 데이터 상태 — 'ok'가 아니면 금융 숫자 대신 Unavailable 표시
  const paperDataOk      = dataStatus === 'ok';
  const paperDataLoading = dataStatus === 'loading';

  const minScore  = (indicators.find(i => i.id === 'combined')?.params.minScore as number) ?? 60;
  const signals   = watchlist.filter(w => Math.abs(w.combinedScore) >= minScore / 2);
  const recentLogs = logs.slice(0, 8);

  const winRate   = todayStats.count > 0 ? ((todayStats.wins / todayStats.count) * 100).toFixed(0) : '—';
  const equityData = equityHistory.slice(-60);  // ~1 h at 60 s intervals
  const isEquityUp = equityData.length >= 2
    ? equityData[equityData.length - 1].equity >= equityData[0].equity
    : true;

  return (
    <div className="flex flex-col gap-5 animate-in fade-in duration-500">

      {/* ── Full-width alerts ─────────────────────────────────────────────── */}
      <SystemHealthBanner />
      {/* LiveApprovalBanner: fallback for denied/unsupported notification environments */}
      <LiveApprovalBanner />
      <LiveApprovalCard />

      {/* ── Primary monitoring: 2-column desktop grid ─────────────────────── */}
      <div className="grid grid-cols-12 gap-5 items-start">

        {/* Left 7/12 — AI engine state (primary operator surface) */}
        <div className="col-span-7 flex flex-col gap-4">
          <AiStateCard />
          <AiMarketRankingCard />
        </div>

        {/* Right 5/12 — Execution health + daily performance */}
        <div className="col-span-5 flex flex-col gap-4">
          <ExecutorStatusWidget />
          <DailyTargetCard />
        </div>
      </div>

      {/* ── Account KPI bar — 실제 PAPER DB 데이터만 표시 (mock 금지) ─────── */}
      <div className="grid grid-cols-4 gap-3">
        <KpiCard
          label="Paper Equity"
          value={paperDataOk
            ? `$${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : paperDataLoading ? '…' : 'Unavailable'}
          sub={paperDataOk ? 'PAPER · tradingCapital + realized + unrealized' : paperDataLoading ? 'Loading…' : '데이터 조회 실패'}
        />
        <KpiCard
          label="Unrealized PnL"
          value={paperDataOk
            ? `${account.unrealizedPnl >= 0 ? '+' : ''}$${account.unrealizedPnl.toFixed(2)}`
            : paperDataLoading ? '…' : 'Unavailable'}
          color={paperDataOk ? (account.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]') : undefined}
          sub={paperDataOk ? `PAPER · ${positions.length} open position${positions.length === 1 ? '' : 's'}` : undefined}
        />
        <KpiCard
          label="Margin Ratio"
          value={!paperDataOk
            ? (paperDataLoading ? '…' : 'Unavailable')
            : positions.length === 0 ? 'N/A' : `${(account.marginRatio * 100).toFixed(1)}%`}
          color={paperDataOk && account.marginRatio > 0.7 ? 'text-[var(--color-short)]' : paperDataOk && account.marginRatio > 0.5 ? 'text-[var(--color-warning)]' : undefined}
          sub={paperDataOk ? `$${account.availableBalance.toFixed(0)} avail · PAPER cash` : undefined}
        />
        {/* Quick Controls — emergency actions always visible */}
        <Card className="p-4 flex flex-col justify-between border-border bg-card/50">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Quick Controls
          </span>
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-foreground">Stop New Orders</span>
              <Switch checked={stopNewOrders} onCheckedChange={toggleStopNewOrders} />
            </div>
            <Button
              onClick={triggerEmergencyStop}
              variant="destructive"
              size="sm"
              className="w-full font-bold tracking-widest text-[10px] h-7"
            >
              <ShieldAlert className="w-3 h-3 mr-1.5" /> EMERGENCY STOP
            </Button>
          </div>
        </Card>
      </div>

      {/* ── Performance KPI bar ───────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3">
        <KpiCard
          label="Today Realized"
          value={paperDataOk
            ? `${todayStats.realized >= 0 ? '+' : ''}$${todayStats.realized.toFixed(2)}`
            : paperDataLoading ? '…' : 'Unavailable'}
          color={paperDataOk ? (todayStats.realized >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]') : undefined}
        />
        <KpiCard
          label="Win Rate"
          value={!paperDataOk ? (paperDataLoading ? '…' : 'Unavailable') : winRate === '—' ? '—' : `${winRate}%`}
          sub={paperDataOk ? (todayStats.count > 0 ? `${todayStats.wins}W / ${todayStats.losses}L` : 'No trades today') : undefined}
          color={paperDataOk && winRate !== '—' ? (Number(winRate) >= 50 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]') : undefined}
        />
        <KpiCard
          label="Positions Open"
          value={paperDataOk ? String(positions.length) : paperDataLoading ? '…' : 'Unavailable'}
          sub={paperDataOk ? `${todayStats.count} trades today` : undefined}
        />
        <KpiCard
          label="Weekly PnL"
          value={paperDataOk
            ? `${account.weeklyPnl >= 0 ? '+' : ''}$${account.weeklyPnl.toFixed(2)}`
            : paperDataLoading ? '…' : 'Unavailable'}
          color={paperDataOk ? (account.weeklyPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]') : undefined}
        />
      </div>

      {/* ── GMX 온체인 계정 (Read-only) ──────────────────────────────────── */}
      <GmxOnchainCard />

      {/* ── Data grid: charts/tables left, signals/logs right ────────────── */}
      <div className="grid grid-cols-3 gap-5">

        {/* Left 2/3 — equity + positions */}
        <div className="col-span-2 flex flex-col gap-5">

          {/* Equity curve */}
          <Card className="p-0 overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Equity Curve
              </h3>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted-foreground">last {equityData.length} cycles</span>
                <span className={cn('text-xs font-mono font-bold', isEquityUp ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]')}>
                  {equityData.length > 0 ? `$${equityData[equityData.length - 1].equity.toFixed(2)}` : '—'}
                </span>
              </div>
            </div>
            <div className="h-60 px-2 pt-3 pb-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityData} margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                  <defs>
                    <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={isEquityUp ? 'var(--color-long)' : 'var(--color-short)'} stopOpacity={0.3} />
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

          {/* Active positions table */}
          <Card className="flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" /> Active Positions ({positions.length})
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-blue-500/10 text-blue-400 border-blue-500/30 font-bold">PAPER</span>
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
            {positions.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm">No open positions</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-secondary/50">
                  <tr>
                    <th className="text-left font-medium text-muted-foreground py-2 px-4 text-xs">Symbol</th>
                    <th className="text-right font-medium text-muted-foreground py-2 px-4 text-xs">Size USD</th>
                    <th className="text-right font-medium text-muted-foreground py-2 px-4 text-xs">Entry</th>
                    <th className="text-right font-medium text-muted-foreground py-2 px-4 text-xs">Mark</th>
                    <th className="text-right font-medium text-muted-foreground py-2 px-4 text-xs">TP / SL</th>
                    <th className="text-right font-medium text-muted-foreground py-2 px-4 text-xs">PnL / ROE</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {positions.slice(0, 8).map(pos => (
                    <tr key={pos.id} className="hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            'text-[10px] font-bold px-1.5 py-0.5 rounded',
                            pos.side === 'LONG'
                              ? 'bg-[var(--color-long)]/20 text-[var(--color-long)]'
                              : 'bg-[var(--color-short)]/20 text-[var(--color-short)]',
                          )}>
                            {pos.side}
                          </span>
                          <span className="font-bold text-xs">{pos.displaySymbol ?? pos.symbol}</span>
                          <span className="text-[10px] text-muted-foreground">{pos.leverage}x</span>
                          {pos.leverage > limits.maxLeverage && (
                            <span title={`레버리지 ${pos.leverage}x — 설정 한도(${limits.maxLeverage}x) 초과`}>
                              <ShieldAlert className="w-3 h-3 text-amber-400" />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-xs">
                        ${pos.sizeInUsd.toFixed(0)}
                        <div className="text-[10px] text-muted-foreground">
                          ${pos.collateralUsd?.toFixed(0) ?? '—'} coll.
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-xs">{pos.entryPrice.toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono text-xs">{pos.markPrice.toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right text-[10px] font-mono">
                        {pos.tpPrice != null
                          ? <span className="text-[var(--color-long)]">TP {pos.tpPrice.toFixed(1)}</span>
                          : <span className="text-muted-foreground">—</span>
                        }
                        <br />
                        {pos.slPrice != null
                          ? <span className="text-[var(--color-short)]">SL {pos.slPrice.toFixed(1)}</span>
                          : <span className="text-muted-foreground">—</span>
                        }
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <div className={cn(
                          'font-mono font-medium text-xs',
                          pos.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]',
                        )}>
                          {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl.toFixed(2)}
                        </div>
                        <div className={cn(
                          'text-[10px] font-mono',
                          pos.roe >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]',
                        )}>
                          {pos.roe >= 0 ? '+' : ''}{pos.roe.toFixed(2)}%
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        {/* Right 1/3 — signals + logs */}
        <div className="col-span-1 flex flex-col gap-5">

          {/* Active market signals */}
          <Card className="flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Target className="w-4 h-4 text-primary" /> Signals
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">min {(minScore / 2).toFixed(0)}</span>
                <Link href="/watchlist" className="text-xs text-primary hover:underline flex items-center gap-1">
                  All <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
            {signals.length === 0 ? (
              <div className="py-6 text-center text-muted-foreground text-xs">No signals above threshold</div>
            ) : (
              <div className="divide-y divide-border">
                {signals.slice(0, 8).map(sig => {
                  const bias     = sig.combinedScore > 0 ? 'LONG' : 'SHORT';
                  const colorVar = bias === 'LONG' ? 'var(--color-long)' : 'var(--color-short)';
                  const Icon     = bias === 'LONG' ? TrendingUp : TrendingDown;
                  return (
                    <div key={sig.symbol} className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/30 transition-colors">
                      <div className="flex items-center gap-2">
                        <Icon className="w-3.5 h-3.5" style={{ color: colorVar }} />
                        <div>
                          <div className="font-bold text-xs">{sig.symbol.replace('USDT', '')}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            ${sig.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                          </div>
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
          </Card>

          {/* Strategy log */}
          <Card className="flex flex-col flex-1 overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" /> Strategy Log
              </h3>
              <Link href="/history" className="text-xs text-primary hover:underline">Full Log</Link>
            </div>
            <div className="overflow-y-auto p-4 flex flex-col gap-3 max-h-96">
              {recentLogs.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-xs">No entries yet</div>
              ) : (
                recentLogs.map(log => (
                  <div key={log.id} className="flex flex-col gap-1 pb-3 border-b border-border last:border-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <span className={cn(
                        'text-[9px] font-bold px-1.5 py-0.5 rounded',
                        log.level === 'INFO'  ? 'bg-blue-500/20 text-blue-400' :
                        log.level === 'WARN'  ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]' :
                                                'bg-[var(--color-long)]/20 text-[var(--color-long)]',
                      )}>
                        {log.level}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {format(log.timestamp, 'HH:mm:ss')}
                      </span>
                    </div>
                    <span className="text-xs leading-tight text-foreground/90">{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>

      <NewOrderDrawer open={orderOpen} onClose={() => setOrderOpen(false)} />
    </div>
  );
}
