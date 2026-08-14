import { useState } from 'react';
import { useWatchlistContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, X, Search, TrendingUp, TrendingDown } from 'lucide-react';

function ScoreBar({ score, label }: { score: number, label: string }) {
  const isPositive = score >= 0;
  const width = Math.min(50, Math.abs(score) / 2);
  
  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex justify-between text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
        <span>{label}</span>
        <span>{score.toFixed(0)}</span>
      </div>
      <div className="h-1.5 w-full bg-secondary rounded-full relative overflow-hidden">
        <div className="absolute top-0 bottom-0 w-px bg-border left-1/2 -ml-[0.5px] z-10" />
        {isPositive ? (
          <div 
            className="absolute top-0 bottom-0 bg-[var(--color-long)] rounded-r-full transition-all duration-300"
            style={{ left: '50%', width: `\${width}%` }}
          />
        ) : (
          <div 
            className="absolute top-0 bottom-0 bg-[var(--color-short)] rounded-l-full transition-all duration-300"
            style={{ right: '50%', width: `\${width}%` }}
          />
        )}
      </div>
    </div>
  );
}

export default function Watchlist() {
  const { watchlist, addSymbol, removeSymbol } = useWatchlistContext();
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
      <Card className="p-4 bg-card/50 border-border">
        <form onSubmit={handleAdd} className="flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              value={newSymbol}
              onChange={e => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="Add symbol (e.g. BTCUSDT)..." 
              className="pl-9 bg-background border-border"
            />
          </div>
          <Button type="submit" disabled={!newSymbol.trim()} className="w-32">
            <Plus className="w-4 h-4 mr-2" /> Add
          </Button>
        </form>
      </Card>

      <div className="grid gap-4">
        {watchlist.map(sym => {
          const bias = sym.combinedScore > 15 ? 'LONG' : sym.combinedScore < -15 ? 'SHORT' : 'NEUTRAL';
          const Icon = bias === 'LONG' ? TrendingUp : bias === 'SHORT' ? TrendingDown : null;
          
          return (
            <Card key={sym.symbol} className="p-4 flex items-center gap-6 group hover:border-primary/50 transition-colors">
              <div className="w-32 shrink-0">
                <div className="font-bold text-lg">{sym.symbol}</div>
                <div className="text-xs text-muted-foreground flex gap-2 mt-1">
                  <span className="font-mono">${sym.price.toFixed(sym.price < 1 ? 4 : 2)}</span>
                  <span className={sym.change24h >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]'}>
                    {sym.change24h >= 0 ? '+' : ''}{sym.change24h.toFixed(2)}%
                  </span>
                </div>
              </div>

              <div className="flex-1 grid grid-cols-3 gap-8 items-center">
                <ScoreBar score={sym.score1h} label="1H TF" />
                <ScoreBar score={sym.score4h} label="4H TF" />
                <ScoreBar score={sym.score1d} label="1D TF" />
              </div>

              <div className="w-48 shrink-0 border-l border-border pl-6 flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Bias</div>
                  <div className={`flex items-center gap-2 font-bold \${
                    bias === 'LONG' ? 'text-[var(--color-long)]' : 
                    bias === 'SHORT' ? 'text-[var(--color-short)]' : 'text-muted-foreground'
                  }`}>
                    {Icon && <Icon className="w-4 h-4" />}
                    {bias}
                  </div>
                </div>
                
                <Button 
                  variant="ghost" 
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive text-muted-foreground h-8 w-8"
                  onClick={() => removeSymbol(sym.symbol)}
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
