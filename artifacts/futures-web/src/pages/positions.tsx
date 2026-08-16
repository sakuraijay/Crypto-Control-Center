import { useState } from 'react';
import { useTradingContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { AlertTriangle, X, Plus, Check, Pencil, FlaskConical } from 'lucide-react';
import { NewOrderDrawer } from '@/components/trading/NewOrderDrawer';
import { cn } from '@/lib/utils';

/** Inline TP/SL editor for a single position row */
function RiskEditor({
  posId, tpPrice, slPrice, onSave, onCancel,
}: {
  posId: string; tpPrice?: number; slPrice?: number;
  onSave: (tp: number | null, sl: number | null) => void;
  onCancel: () => void;
}) {
  const [tp, setTp] = useState(tpPrice?.toString() ?? '');
  const [sl, setSl] = useState(slPrice?.toString() ?? '');
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number" min="0" step="0.01" placeholder="TP"
        value={tp} onChange={e => setTp(e.target.value)}
        className="h-7 w-24 font-mono text-xs text-[var(--color-long)] placeholder:text-muted-foreground"
      />
      <Input
        type="number" min="0" step="0.01" placeholder="SL"
        value={sl} onChange={e => setSl(e.target.value)}
        className="h-7 w-24 font-mono text-xs text-[var(--color-short)] placeholder:text-muted-foreground"
      />
      <Button size="icon" variant="ghost" className="h-7 w-7 text-[var(--color-long)]"
        onClick={() => onSave(tp ? parseFloat(tp) : null, sl ? parseFloat(sl) : null)}>
        <Check className="w-3.5 h-3.5" />
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={onCancel}>
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

export default function Positions() {
  const { positions, closePosition, updatePositionRisk } = useTradingContext();
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const [editingRiskId, setEditingRiskId] = useState<string | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);

  const posToClose = positions.find(p => p.id === confirmCloseId);

  return (
    <div className="animate-in fade-in duration-500 flex flex-col gap-4 h-full">
      {/* PAPER TRADING notice */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-500/25 bg-blue-500/5 text-[11px] text-blue-300/80">
        <FlaskConical className="w-3.5 h-3.5 shrink-0 text-blue-400" />
        <span>
          <strong className="text-blue-400 font-bold">PAPER TRADING</strong>
          {' '}— 이 페이지의 모든 포지션·잔고·PnL은 <strong>모의 데이터</strong>입니다. 실제 GMX 계정 데이터와 무관합니다.
          실제 계정 조회는 브라우저 지갑 연결 후 활성화됩니다.
        </span>
      </div>

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-lg flex items-center gap-2">
            {positions.length} Open Position{positions.length !== 1 ? 's' : ''}
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-500/30 bg-blue-500/10 text-blue-400 font-bold">PAPER</span>
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">모의거래 — 실제 주문 없음</p>
        </div>
        <Button size="sm" onClick={() => setOrderOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> New Order
        </Button>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 sticky top-0 z-10 backdrop-blur-md">
              <tr>
                <th className="text-left font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Symbol / Side</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Size (USD)</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Entry</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Mark</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Liq.</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Collateral</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">PnL (ROE)</th>
                <th className="text-center font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">TP / SL</th>
                <th className="text-right font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Opened</th>
                <th className="text-center font-medium text-muted-foreground py-3 px-4 whitespace-nowrap">Close</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-16 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <span>No open positions</span>
                      <Button size="sm" variant="outline" onClick={() => setOrderOpen(true)}>
                        <Plus className="w-3 h-3 mr-1.5" /> Place First Order
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                positions.map(pos => (
                  <tr key={pos.id} className="hover:bg-muted/30 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <div className={`w-1 h-8 rounded-full ${pos.side === 'LONG' ? 'bg-[var(--color-long)]' : 'bg-[var(--color-short)]'}`} />
                        <div>
                          <div className="font-bold">{pos.displaySymbol ?? pos.symbol}</div>
                          <div className={cn('text-[10px] font-bold tracking-widest', pos.side === 'LONG' ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]')}>
                            {pos.side} {pos.leverage}x
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-mono">${pos.sizeInUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                    <td className="py-3 px-4 text-right font-mono">{pos.entryPrice.toFixed(2)}</td>
                    <td className="py-3 px-4 text-right font-mono">{pos.markPrice.toFixed(2)}</td>
                    <td className="py-3 px-4 text-right font-mono text-[var(--color-warning)] text-xs">{pos.liquidationPrice.toFixed(2)}</td>
                    <td className="py-3 px-4 text-right font-mono text-xs">${pos.collateralUsd.toFixed(2)}</td>
                    <td className="py-3 px-4 text-right">
                      <div className={cn('font-mono font-bold text-sm', pos.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]')}>
                        {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl.toFixed(2)}
                      </div>
                      <div className={cn('text-xs font-mono', pos.roe >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]')}>
                        {pos.roe >= 0 ? '+' : ''}{pos.roe.toFixed(2)}%
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {editingRiskId === pos.id ? (
                        <RiskEditor
                          posId={pos.id}
                          tpPrice={pos.tpPrice}
                          slPrice={pos.slPrice}
                          onSave={(tp, sl) => {
                            updatePositionRisk(pos.id, tp, sl);
                            setEditingRiskId(null);
                          }}
                          onCancel={() => setEditingRiskId(null)}
                        />
                      ) : (
                        <button
                          onClick={() => setEditingRiskId(pos.id)}
                          className="flex items-center gap-1.5 group text-xs"
                        >
                          <div className="flex flex-col items-end gap-0.5 min-w-[60px]">
                            <span className={pos.tpPrice ? 'text-[var(--color-long)] font-mono' : 'text-muted-foreground/50'}>
                              TP {pos.tpPrice ? pos.tpPrice.toFixed(2) : '—'}
                            </span>
                            <span className={pos.slPrice ? 'text-[var(--color-short)] font-mono' : 'text-muted-foreground/50'}>
                              SL {pos.slPrice ? pos.slPrice.toFixed(2) : '—'}
                            </span>
                          </div>
                          <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right text-muted-foreground text-xs">
                      {format(pos.openTime, 'MMM d HH:mm')}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <Button
                        variant="ghost" size="sm"
                        className="h-7 w-7 p-0 hover:bg-destructive/20 hover:text-destructive transition-colors"
                        onClick={() => setConfirmCloseId(pos.id)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Close confirm */}
      <Dialog open={!!confirmCloseId} onOpenChange={open => !open && setConfirmCloseId(null)}>
        <DialogContent className="border-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" /> Close Position
            </DialogTitle>
            <DialogDescription>Market close at current price?</DialogDescription>
          </DialogHeader>
          {posToClose && (
            <div className="py-3 bg-muted/50 rounded-lg px-4 border border-border text-sm flex flex-col gap-1.5">
              <div className="flex justify-between">
                <span className="font-bold">{posToClose.symbol}</span>
                <span className={posToClose.side === 'LONG' ? 'text-[var(--color-long)] font-bold' : 'text-[var(--color-short)] font-bold'}>
                  {posToClose.side}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Unrealized PnL</span>
                <span className={cn('font-mono', posToClose.unrealizedPnl >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]')}>
                  {posToClose.unrealizedPnl >= 0 ? '+' : ''}${posToClose.unrealizedPnl.toFixed(2)}
                </span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCloseId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (confirmCloseId) closePosition(confirmCloseId); setConfirmCloseId(null); }}>
              Close Position
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewOrderDrawer open={orderOpen} onClose={() => setOrderOpen(false)} />
    </div>
  );
}
