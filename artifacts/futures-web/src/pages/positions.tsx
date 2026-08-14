import { useState } from 'react';
import { useTradingContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { AlertTriangle, X } from 'lucide-react';

export default function Positions() {
  const { positions, closePosition } = useTradingContext();
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);

  const posToClose = positions.find(p => p.id === confirmCloseId);

  return (
    <div className="animate-in fade-in duration-500 flex flex-col gap-6 h-full">
      <Card className="flex-1 flex flex-col overflow-hidden">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 sticky top-0 z-10 backdrop-blur-md">
              <tr>
                <th className="text-left font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Symbol / Side</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Size</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Entry Price</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Mark Price</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Liq. Price</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Margin / Lev</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">PNL (ROE)</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Opened</th>
                <th className="text-center font-medium text-muted-foreground py-3 px-6 whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-muted-foreground">
                    No open positions
                  </td>
                </tr>
              ) : (
                positions.map(pos => (
                  <tr key={pos.id} className="hover:bg-muted/30 transition-colors">
                    <td className="py-4 px-6 flex items-center gap-3">
                      <div className={`w-1.5 h-8 rounded-full \${pos.side === 'LONG' ? 'bg-[var(--color-long)]' : 'bg-[var(--color-short)]'}`} />
                      <div>
                        <div className="font-bold text-base">{pos.symbol}</div>
                        <div className={`text-[10px] font-bold tracking-widest \${pos.side === 'LONG' ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                          {pos.side}
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-6 text-right font-mono">{pos.size}</td>
                    <td className="py-4 px-6 text-right font-mono">{pos.entryPrice.toFixed(2)}</td>
                    <td className="py-4 px-6 text-right font-mono">{pos.markPrice.toFixed(2)}</td>
                    <td className="py-4 px-6 text-right font-mono text-[var(--color-warning)]">{pos.liquidationPrice.toFixed(2)}</td>
                    <td className="py-4 px-6 text-right">
                      <div className="font-mono">${pos.marginUsed.toFixed(2)}</div>
                      <div className="text-xs text-muted-foreground">{pos.leverage}x</div>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <div className={`font-mono font-medium \${pos.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                        {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl.toFixed(2)}
                      </div>
                      <div className={`text-xs font-mono \${pos.roe >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                        {pos.roe >= 0 ? '+' : ''}{pos.roe.toFixed(2)}%
                      </div>
                    </td>
                    <td className="py-4 px-6 text-right text-muted-foreground text-xs">
                      {format(pos.openTime, 'MMM d, HH:mm')}
                    </td>
                    <td className="py-4 px-6 text-center">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="hover:bg-destructive hover:text-destructive-foreground hover:border-destructive transition-colors h-8 text-xs px-3"
                        onClick={() => setConfirmCloseId(pos.id)}
                      >
                        <X className="w-3 h-3 mr-1" /> Close
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog open={!!confirmCloseId} onOpenChange={(open) => !open && setConfirmCloseId(null)}>
        <DialogContent className="border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" /> Confirm Close Position
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to close this position at market price?
            </DialogDescription>
          </DialogHeader>
          
          {posToClose && (
            <div className="py-4 bg-muted/50 rounded-lg px-4 my-2 border border-border">
              <div className="flex justify-between items-center mb-2">
                <span className="font-bold">{posToClose.symbol}</span>
                <span className={`font-bold \${posToClose.side === 'LONG' ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                  {posToClose.side}
                </span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Unrealized PNL</span>
                <span className={`font-mono \${posToClose.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}`}>
                  {posToClose.unrealizedPnl >= 0 ? '+' : ''}${posToClose.unrealizedPnl.toFixed(2)}
                </span>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCloseId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => {
              if (confirmCloseId) closePosition(confirmCloseId);
              setConfirmCloseId(null);
            }}>
              Close Position
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
