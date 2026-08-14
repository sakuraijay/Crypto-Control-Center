import { useState } from 'react';
import { useWatchlistContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, X, Search, TrendingUp, TrendingDown, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function ScoreBar({ score, label }: { score: number; label: string }) {
  const isPositive = score >= 0;
  const width = Math.min(50, Math.abs(score) / 2);

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex justify-between text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
        <span>{label}</span>
        <span className={score >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}>
          {score >= 0 ? '+' : ''}{score.toFixed(0)}
        </span>
      </div>
      <div className="h-1.5 w-full bg-secondary rounded-full relative overflow-hidden">
        <div className="absolute top-0 bottom-0 w-px bg-border left-1/2 -ml-[0.5px] z-10" />
        {isPositive ? (
          <div
            className="absolute top-0 bottom-0 bg-[var(--color-long)] rounded-r-full transition-all duration-300"
            style={{ left: '50%', width: `${width}%` }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 bg-[var(--color-short)] rounded-l-full transition-all duration-300"
            style={{ right: '50%', width: `${width}%` }}
          />
        )}
      </div>
    </div>
  );
}

function StreamBadge({ status }: { status: string }) {
  const cfg = {
    connected:    { icon: <Wifi className="w-3 h-3" />,    label: 'LIVE',          cls: 'text-[var(--color-long)] border-[var(--color-long)]/40 bg-[var(--color-long)]/10' },
    connecting:   { icon: <Loader2 className="w-3 h-3 animate-spin" />, label: 'CONNECTING', cls: 'text-[var(--color-warning)] border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10' },
    reconnecting: { icon: <Loader2 className="w-3 h-3 animate-spin" />, label: 'RECONNECTING', cls: 'text-[var(--color-warning)] border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10' },
    offline:      { icon: <WifiOff className="w-3 h-3" />, label: 'SIMULATED',    cls: 'text-muted-foreground border-border bg-secondary' },
  }[status] ?? { icon: <WifiOff className="w-3 h-3" />, label: 'OFFLINE', cls: 'text-muted-foreground border-border bg-secondary' };

  return (
    <div className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-widest', cfg.cls)}>
      {cfg.icon} {cfg.label}
    </div>
  );
}

export default function Watchlist() {
  const { watchlist, streamStatus, addSymbol, removeSymbol } = useWatchlistContext();
  const [newSymbol, setNewSymbol] = useState('');

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (newSymbol.trim()) {
      addSymbol(newSymbol.trim());
      setNewSymbol('');
    }
  };

  return (
    <div className="animate-in fade-in duration-500 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Multi-timeframe signals · Binance USD-M Futures</p>
        <StreamBadge status={streamStatus} />
      </div>
      <Card className="p-4 bg-card/50 border-border">
        <form onSubmit={handleAdd} className="flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={newSymbol}
              onChange={e => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="Add symbol (e.g. BTCUSDT or BTC)..."
              className="pl-9 bg-background border-border"
              data-testid="input-add-symbol"
            />
          </div>
          <Button type="submit" disabled={!newSymbol.trim()} className="w-32" data-testid="button-add-symbol">
            <Plus className="w-4 h-4 mr-2" /> Add
          </Button>
        </form>
      </Card>

      <div className="grid gap-4">
        {watchlist.map(sym => {
          const bias = sym.combinedScore > 15 ? 'LONG' : sym.combinedScore < -15 ? 'SHORT' : 'NEUTRAL';
          const Icon = bias === 'LONG' ? TrendingUp : bias === 'SHORT' ? TrendingDown : null;

          return (
            <Card
              key={sym.symbol}
              className="p-4 flex items-center gap-6 group hover:border-primary/50 transition-colors"
              data-testid={`card-watchlist-${sym.symbol}`}
            >
              {/* Symbol + price */}
              <div className="w-36 shrink-0">
                <div className="font-bold text-lg">{sym.symbol.replace('USDT', '')}</div>
                <div className="text-xs text-muted-foreground font-mono mt-0.5">
                  ${sym.price.toFixed(sym.price < 1 ? 4 : 2)}
                </div>
                <div className={`text-xs font-mono mt-0.5 ${
                  sym.change24h >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'
                }`}>
                  {sym.change24h >= 0 ? '+' : ''}{sym.change24h.toFixed(2)}%
                </div>
              </div>

              {/* Score bars */}
              <div className="flex-1 grid grid-cols-3 gap-8 items-center">
                <ScoreBar score={sym.score1h} label="1H" />
                <ScoreBar score={sym.score4h} label="4H" />
                <ScoreBar score={sym.score1d} label="1D" />
              </div>

              {/* Bias + remove */}
              <div className="w-44 shrink-0 border-l border-border pl-6 flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Bias</div>
                  <div className={`flex items-center gap-2 font-bold ${
                    bias === 'LONG'    ? 'text-[var(--color-long)]' :
                    bias === 'SHORT'   ? 'text-[var(--color-short)]' :
                                        'text-muted-foreground'
                  }`}>
                    {Icon && <Icon className="w-4 h-4" />}
                    {bias}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono mt-1">
                    Score: {sym.combinedScore >= 0 ? '+' : ''}{sym.combinedScore.toFixed(0)}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive text-muted-foreground h-8 w-8"
                  onClick={() => removeSymbol(sym.symbol)}
                  data-testid={`button-remove-${sym.symbol}`}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          );
        })}

        {watchlist.length === 0 && (
          <div className="py-12 text-center text-muted-foreground border border-dashed border-border rounded-xl">
            Watchlist is empty. Add a symbol above to start monitoring.
          </div>
        )}
      </div>
    </div>
  );
}
