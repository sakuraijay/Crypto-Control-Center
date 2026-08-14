import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, TrendingUp, TrendingDown, Info } from 'lucide-react';
import { useTradingContext, useWatchlistContext, useStrategyContext, useAppContext, NewOrderParams } from '@/lib/context';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  defaultSymbol?: string;
}

const POPULAR = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'XRPUSDT'];

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</label>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function NewOrderDrawer({ open, onClose, defaultSymbol }: Props) {
  const { placeOrder, account, positions } = useTradingContext();
  const { watchlist } = useWatchlistContext();
  const { limits } = useStrategyContext();
  const { engineState, stopNewOrders } = useAppContext();
  const { toast } = useToast();

  const [symbol, setSymbol] = useState(defaultSymbol ?? 'BTCUSDT');
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [size, setSize] = useState('0.01');
  const [leverage, setLeverage] = useState('10');
  const [limitPrice, setLimitPrice] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const wlEntry = watchlist.find(w => w.symbol === symbol.toUpperCase());
  const refPrice = wlEntry?.price ?? (orderType === 'LIMIT' ? parseFloat(limitPrice) || 0 : 0);
  const sizeNum = parseFloat(size) || 0;
  const levNum = Math.min(parseInt(leverage) || 10, limits.maxLeverage);
  const effectivePrice = orderType === 'MARKET' ? refPrice : (parseFloat(limitPrice) || 0);
  const estimatedMargin = effectivePrice > 0 && sizeNum > 0 ? (effectivePrice * sizeNum) / levNum : 0;
  const estimatedExposure = effectivePrice * sizeNum;

  const validationErrors = useMemo(() => {
    const errs: string[] = [];
    if (engineState === 'EMERGENCY_STOP') errs.push('Emergency stop is active');
    if (stopNewOrders) errs.push('New orders are disabled');
    if (!symbol.trim()) errs.push('Symbol is required');
    if (sizeNum <= 0) errs.push('Size must be > 0');
    if (levNum < 1 || levNum > limits.maxLeverage) errs.push(`Leverage must be 1–${limits.maxLeverage}x`);
    if (orderType === 'LIMIT' && !(parseFloat(limitPrice) > 0)) errs.push('Limit price required');
    if (estimatedMargin > limits.maxMarginPerTrade) errs.push(`Margin ${estimatedMargin.toFixed(0)} exceeds limit ${limits.maxMarginPerTrade}`);
    if (estimatedMargin > account.availableBalance) errs.push('Insufficient available balance');
    if (positions.length >= limits.maxSimultaneousPositions) errs.push(`Max positions (${limits.maxSimultaneousPositions}) reached`);
    if (estimatedExposure > 0 && estimatedExposure + positions.reduce((s, p) => s + p.markPrice * p.size, 0) > limits.maxTotalExposureUSDT) {
      errs.push(`Total exposure would exceed ${limits.maxTotalExposureUSDT.toLocaleString()} USDT`);
    }
    return errs;
  }, [engineState, stopNewOrders, symbol, sizeNum, levNum, orderType, limitPrice, estimatedMargin, estimatedExposure, limits, account, positions]);

  const handleSubmit = async () => {
    if (validationErrors.length > 0) return;
    setSubmitting(true);
    const params: NewOrderParams = {
      symbol: symbol.toUpperCase(),
      side,
      orderType,
      size: sizeNum,
      leverage: levNum,
      limitPrice: orderType === 'LIMIT' ? parseFloat(limitPrice) : undefined,
      tpPrice: tpPrice ? parseFloat(tpPrice) : undefined,
      slPrice: slPrice ? parseFloat(slPrice) : undefined,
    };
    await new Promise(r => setTimeout(r, 200)); // simulate network feel
    const result = placeOrder(params);
    setSubmitting(false);
    if (result.success) {
      toast({
        title: '[PAPER] Order Placed',
        description: `${side} ${sizeNum} ${symbol.toUpperCase()} @ ${orderType === 'MARKET' ? 'Market' : limitPrice} × ${levNum}x`,
      });
      onClose();
    } else {
      toast({ title: 'Order Rejected', description: result.error, variant: 'destructive' });
    }
  };

  const isLong = side === 'LONG';

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-[480px] p-0 gap-0 border-border overflow-hidden">
        {/* Header bar */}
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border bg-card/80">
          <DialogTitle className="text-base font-bold tracking-widest uppercase flex items-center gap-2">
            <span className="text-[var(--color-primary)]">⬡</span> New Paper Order
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">Orders are simulated — no real funds involved</p>
        </DialogHeader>

        <div className="px-6 py-5 flex flex-col gap-4 overflow-y-auto max-h-[75vh]">
          {/* Symbol */}
          <Field label="Symbol">
            <Input
              value={symbol}
              onChange={e => setSymbol(e.target.value.toUpperCase())}
              placeholder="BTCUSDT"
              className="font-mono font-bold text-sm"
            />
            <div className="flex flex-wrap gap-1.5 mt-1">
              {POPULAR.map(s => (
                <button
                  key={s}
                  onClick={() => setSymbol(s)}
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded border transition-colors',
                    symbol === s
                      ? 'bg-primary/20 border-primary/40 text-primary'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {s.replace('USDT', '')}
                </button>
              ))}
            </div>
          </Field>

          {/* Side */}
          <Field label="Direction">
            <div className="flex gap-2">
              <button
                onClick={() => setSide('LONG')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md border font-bold text-sm transition-all',
                  isLong
                    ? 'bg-[var(--color-long)]/20 border-[var(--color-long)]/60 text-[var(--color-long)]'
                    : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                )}
              >
                <TrendingUp className="w-4 h-4" /> LONG / BUY
              </button>
              <button
                onClick={() => setSide('SHORT')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md border font-bold text-sm transition-all',
                  !isLong
                    ? 'bg-[var(--color-short)]/20 border-[var(--color-short)]/60 text-[var(--color-short)]'
                    : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                )}
              >
                <TrendingDown className="w-4 h-4" /> SHORT / SELL
              </button>
            </div>
          </Field>

          {/* Order type */}
          <Field label="Order Type">
            <div className="flex gap-2">
              {(['MARKET', 'LIMIT'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setOrderType(t)}
                  className={cn(
                    'flex-1 py-2 rounded-md border text-sm font-semibold transition-colors',
                    orderType === t
                      ? 'bg-primary/20 border-primary/40 text-primary'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>

          {/* Size + Leverage */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Size" hint={wlEntry ? `≈ $${(sizeNum * wlEntry.price).toFixed(0)}` : undefined}>
              <Input
                type="number" min="0" step="0.001"
                value={size}
                onChange={e => setSize(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Leverage" hint={`Max ${limits.maxLeverage}x`}>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setLeverage(String(Math.max(1, levNum - 1)))}
                  className="h-9 w-9 shrink-0 rounded-md border border-border bg-secondary text-foreground hover:bg-muted flex items-center justify-center font-bold"
                >−</button>
                <Input
                  type="number" min="1" max={limits.maxLeverage}
                  value={leverage}
                  onChange={e => setLeverage(e.target.value)}
                  className="font-mono text-center"
                />
                <button
                  onClick={() => setLeverage(String(Math.min(limits.maxLeverage, levNum + 1)))}
                  className="h-9 w-9 shrink-0 rounded-md border border-border bg-secondary text-foreground hover:bg-muted flex items-center justify-center font-bold"
                >+</button>
              </div>
            </Field>
          </div>

          {/* Limit price (conditional) */}
          {orderType === 'LIMIT' && (
            <Field label="Limit Price">
              <Input
                type="number" min="0" step="0.01"
                value={limitPrice}
                onChange={e => setLimitPrice(e.target.value)}
                placeholder="Enter limit price"
                className="font-mono"
              />
            </Field>
          )}

          {/* Margin estimate */}
          {estimatedMargin > 0 && (
            <div className="flex items-center justify-between text-xs p-3 bg-secondary rounded-md border border-border">
              <span className="text-muted-foreground flex items-center gap-1.5"><Info className="w-3 h-3" /> Estimated Margin</span>
              <span className={cn('font-mono font-bold', estimatedMargin > limits.maxMarginPerTrade ? 'text-[var(--color-short)]' : 'text-foreground')}>
                ${estimatedMargin.toFixed(2)}
              </span>
            </div>
          )}

          {/* TP/SL toggle */}
          <button
            onClick={() => setShowAdvanced(a => !a)}
            className="text-xs text-primary underline-offset-2 hover:underline text-left font-medium"
          >
            {showAdvanced ? '▾ Hide' : '▸ Set'} Take Profit / Stop Loss
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Take Profit" hint="Optional">
                <Input
                  type="number" min="0" step="0.01"
                  value={tpPrice}
                  onChange={e => setTpPrice(e.target.value)}
                  placeholder="TP price"
                  className="font-mono text-[var(--color-long)] placeholder:text-muted-foreground"
                />
              </Field>
              <Field label="Stop Loss" hint="Optional">
                <Input
                  type="number" min="0" step="0.01"
                  value={slPrice}
                  onChange={e => setSlPrice(e.target.value)}
                  placeholder="SL price"
                  className="font-mono text-[var(--color-short)] placeholder:text-muted-foreground"
                />
              </Field>
            </div>
          )}

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div className="flex flex-col gap-1 p-3 bg-destructive/10 border border-destructive/30 rounded-md">
              {validationErrors.map(e => (
                <div key={e} className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="w-3 h-3 shrink-0" /> {e}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border bg-card/50 flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button
            className={cn(
              'flex-1 font-bold tracking-wider',
              isLong
                ? 'bg-[var(--color-long)] hover:bg-[var(--color-long)]/90 text-black'
                : 'bg-[var(--color-short)] hover:bg-[var(--color-short)]/90 text-white'
            )}
            onClick={handleSubmit}
            disabled={validationErrors.length > 0 || submitting}
          >
            {submitting ? 'Placing…' : `${isLong ? 'BUY / LONG' : 'SELL / SHORT'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
