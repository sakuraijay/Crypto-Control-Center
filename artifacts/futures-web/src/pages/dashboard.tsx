import { useTradingContext, useWatchlistContext, useAppContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { ArrowRight, TrendingUp, TrendingDown, Activity, Clock, ShieldAlert, Layers } from 'lucide-react';
import { format } from 'date-fns';

export default function Dashboard() {
  const { account, positions, logs } = useTradingContext();
  const { watchlist } = useWatchlistContext();
  const { stopNewOrders, toggleStopNewOrders, triggerEmergencyStop } = useAppContext();

  const signals = watchlist.filter(w => Math.abs(w.combinedScore) > 15);
  const recentLogs = logs.slice(0, 5);

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="grid grid-cols-4 gap-4">
        <Card className="p-5 flex flex-col justify-between">
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Balance</span>
          <span className="text-3xl font-mono mt-2">${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
        </Card>
        <Card className="p-5 flex flex-col justify-between">
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Unrealized PNL</span>
          <span className={`text-3xl font-mono mt-2 \${account.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
            {account.unrealizedPnl >= 0 ? '+' : ''}${account.unrealizedPnl.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
        </Card>
        <Card className="p-5 flex flex-col justify-between">
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Margin Ratio</span>
          <div className="mt-2 flex items-center gap-3">
            <span className="text-3xl font-mono">{(account.marginRatio * 100).toFixed(1)}%</span>
            <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `\${Math.min(100, account.marginRatio * 100)}%` }} />
            </div>
          </div>
        </Card>
        <Card className="p-5 flex flex-col justify-between border-border bg-card/50">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Quick Controls</span>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">Stop New Orders</span>
              <Switch checked={stopNewOrders} onCheckedChange={toggleStopNewOrders} />
            </div>
            <Button onClick={triggerEmergencyStop} variant="destructive" size="sm" className="w-full font-bold tracking-widest text-xs h-8">
              <ShieldAlert className="w-4 h-4 mr-2" /> EMERGENCY STOP
            </Button>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 flex flex-col gap-6">
          <Card className="flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" /> Active Positions ({positions.length})
              </h3>
              <Link href="/positions" className="text-sm text-primary hover:underline flex items-center gap-1">
                View All <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="p-0">
              {positions.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">No open positions</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-secondary/50">
                    <tr>
                      <th className="text-left font-medium text-muted-foreground py-2 px-4">Symbol</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">Size</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">Entry</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">Mark</th>
                      <th className="text-right font-medium text-muted-foreground py-2 px-4">PNL / ROE</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {positions.slice(0, 5).map(pos => (
                      <tr key={pos.id} className="hover:bg-muted/50 transition-colors">
                        <td className="py-3 px-4 flex items-center gap-2">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded \${pos.side === 'LONG' ? 'bg-[var(--color-long)]/20 text-[var(--color-long)]' : 'bg-[var(--color-short)]/20 text-[var(--color-short)]'}`}>
                            {pos.side}
                          </span>
                          <span className="font-bold">{pos.symbol}</span>
                          <span className="text-xs text-muted-foreground">{pos.leverage}x</span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono">{pos.size}</td>
                        <td className="py-3 px-4 text-right font-mono">{pos.entryPrice.toFixed(2)}</td>
                        <td className="py-3 px-4 text-right font-mono">{pos.markPrice.toFixed(2)}</td>
                        <td className="py-3 px-4 text-right">
                          <div className={`font-mono font-medium \${pos.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                            {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl.toFixed(2)}
                          </div>
                          <div className={`text-xs font-mono \${pos.roe >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
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

          <Card className="flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Active Signals
              </h3>
              <Link href="/watchlist" className="text-sm text-primary hover:underline flex items-center gap-1">
                Watchlist <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="p-0">
              {signals.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">No strong signals</div>
              ) : (
                <div className="grid grid-cols-2 gap-px bg-border">
                  {signals.map(sig => {
                    const bias = sig.combinedScore > 15 ? 'LONG' : 'SHORT';
                    const colorVar = bias === 'LONG' ? 'var(--color-long)' : 'var(--color-short)';
                    const Icon = bias === 'LONG' ? TrendingUp : TrendingDown;
                    return (
                      <div key={sig.symbol} className="bg-card p-4 flex items-center justify-between hover:bg-muted/50 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded bg-secondary flex items-center justify-center" style={{ color: colorVar }}>
                            <Icon className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="font-bold">{sig.symbol}</div>
                            <div className="text-xs text-muted-foreground font-mono">{sig.price.toFixed(4)}</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs font-bold tracking-wider" style={{ color: colorVar }}>{bias}</div>
                          <div className="text-sm font-mono mt-0.5">{sig.combinedScore > 0 ? '+' : ''}{sig.combinedScore.toFixed(0)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="col-span-1 flex flex-col h-full">
          <Card className="flex flex-col h-full overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-card/50">
              <h3 className="font-semibold flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" /> Strategy Logs
              </h3>
              <Link href="/history" className="text-sm text-primary hover:underline">Full Log</Link>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {recentLogs.map(log => (
                <div key={log.id} className="flex flex-col gap-1 pb-3 border-b border-border last:border-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded \${
                      log.level === 'INFO' ? 'bg-blue-500/20 text-blue-400' :
                      log.level === 'WARN' ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]' :
                      'bg-[var(--color-long)]/20 text-[var(--color-long)]'
                    }`}>
                      {log.level}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">{format(log.timestamp, 'HH:mm:ss')}</span>
                  </div>
                  <span className="text-sm leading-tight text-foreground/90">{log.message}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
