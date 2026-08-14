import { useState } from 'react';
import { useTradingContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { format } from 'date-fns';

export default function HistoryPage() {
  const { closedTrades, logs } = useTradingContext();
  const [activeTab, setActiveTab] = useState('trades');

  return (
    <div className="animate-in fade-in duration-500 h-full flex flex-col">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <div className="flex items-center justify-between mb-6">
          <TabsList className="bg-card border border-border">
            <TabsTrigger value="trades" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary w-36">
              Trade History ({closedTrades.length})
            </TabsTrigger>
            <TabsTrigger value="logs" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary w-36">
              Strategy Logs
            </TabsTrigger>
          </TabsList>
        </div>

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
                    <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Realized PNL</th>
                    <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Strategy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {closedTrades.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-muted-foreground">
                        No closed trades yet
                      </td>
                    </tr>
                  ) : (
                    closedTrades.map(trade => (
                      <tr key={trade.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3 px-6 text-muted-foreground font-mono text-xs">
                          {format(trade.timestamp, 'yyyy-MM-dd HH:mm:ss')}
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
                            <span className="font-bold">{trade.symbol}</span>
                          </div>
                        </td>
                        <td className="py-3 px-6 text-right font-mono">{trade.size}</td>
                        <td className="py-3 px-6 text-right font-mono">{trade.price.toFixed(2)}</td>
                        <td className="py-3 px-6 text-right">
                          <div className={`font-mono font-medium ${
                            trade.pnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'
                          }`}>
                            {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                          </div>
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
                  {logs.map(log => (
                    <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                      <td className="py-2.5 px-6 text-muted-foreground font-mono text-xs">
                        {format(log.timestamp, 'yyyy-MM-dd HH:mm:ss')}
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
