/**
 * AiMarketRankingCard — shows all analysed GMX V2 markets ranked by the AI's
 * opportunity score from the latest engine cycle.
 *
 * Ranked #1 is the market the engine currently finds most tradeable.
 * Direction indicator (▲ LONG / ▼ SHORT / — NEUTRAL), score bar, volatility (ATR),
 * and 24h price change give a quick read of the current opportunity landscape.
 *
 * Updated on every AI decision cycle (every ~60 s by default).
 * No side-effects — this is a read-only monitoring surface.
 */

import { TrendingUp, TrendingDown, Minus, BarChart3 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';
import type { MarketRanking } from '@/lib/ai/types';
import { formatDistanceToNowStrict } from 'date-fns';

// ── Direction badge ───────────────────────────────────────────────────────────

function DirectionBadge({ direction }: { direction: MarketRanking['direction'] }) {
  if (direction === 'LONG') return (
    <span className="flex items-center gap-1 text-[10px] font-bold text-[var(--color-long)] bg-[var(--color-long)]/10 px-1.5 py-0.5 rounded">
      <TrendingUp className="w-3 h-3" /> LONG
    </span>
  );
  if (direction === 'SHORT') return (
    <span className="flex items-center gap-1 text-[10px] font-bold text-[var(--color-short)] bg-[var(--color-short)]/10 px-1.5 py-0.5 rounded">
      <TrendingDown className="w-3 h-3" /> SHORT
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-[10px] font-bold text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
      <Minus className="w-3 h-3" /> —
    </span>
  );
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score, direction }: { score: number; direction: MarketRanking['direction'] }) {
  const color = direction === 'LONG' ? 'var(--color-long)'
    : direction === 'SHORT' ? 'var(--color-short)'
    : '#6b7280';
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(100, score)}%`, backgroundColor: color }}
        />
      </div>
      <span className="font-mono text-[10px] w-6 text-right text-muted-foreground">{score}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AiMarketRankingCard() {
  const { marketRankings, currentDecision } = useAiEngine();

  if (marketRankings.length === 0) return null;

  const lastUpdated = currentDecision?.createdAt
    ? formatDistanceToNowStrict(new Date(currentDecision.createdAt), { addSuffix: true })
    : null;

  return (
    <Card className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
            AI Market Rankings
          </span>
          <span className="text-[9px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
            GMX V2 · Arbitrum
          </span>
        </div>
        {lastUpdated && (
          <span className="text-[10px] text-muted-foreground">Updated {lastUpdated}</span>
        )}
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[20px_1fr_80px_80px_60px_52px] gap-x-3 px-1 mb-1.5">
        <span className="text-[9px] text-muted-foreground font-semibold">#</span>
        <span className="text-[9px] text-muted-foreground font-semibold">MARKET</span>
        <span className="text-[9px] text-muted-foreground font-semibold">DIRECTION</span>
        <span className="text-[9px] text-muted-foreground font-semibold">SCORE</span>
        <span className="text-[9px] text-muted-foreground font-semibold text-right">ATR%</span>
        <span className="text-[9px] text-muted-foreground font-semibold text-right">24h%</span>
      </div>

      {/* Rows */}
      <div className="flex flex-col divide-y divide-border/40">
        {marketRankings.map((m) => {
          const isTop = m.rank === 1;
          const change = m.priceChange24h;
          return (
            <div
              key={m.symbol}
              className={cn(
                'grid grid-cols-[20px_1fr_80px_80px_60px_52px] gap-x-3 items-center py-2 px-1 rounded-sm transition-colors',
                isTop && 'bg-primary/5',
              )}
            >
              {/* Rank */}
              <span className={cn(
                'text-xs font-bold font-mono',
                isTop ? 'text-primary' : 'text-muted-foreground/60',
              )}>
                {m.rank}
              </span>

              {/* Symbol */}
              <div>
                <span className={cn(
                  'text-xs font-bold font-mono',
                  isTop ? 'text-foreground' : 'text-muted-foreground',
                )}>
                  {m.displaySymbol}
                </span>
                <div className="text-[9px] text-muted-foreground/60 font-mono">
                  ${m.price >= 1000
                    ? m.price.toLocaleString('en', { maximumFractionDigits: 0 })
                    : m.price.toFixed(3)}
                </div>
              </div>

              {/* Direction */}
              <DirectionBadge direction={m.direction} />

              {/* Score bar */}
              <ScoreBar score={m.opportunityScore} direction={m.direction} />

              {/* ATR% */}
              <span className={cn(
                'text-[10px] font-mono text-right',
                m.atrPct > 5 ? 'text-[var(--color-short)]' :
                m.atrPct > 3 ? 'text-[var(--color-warning)]' :
                'text-muted-foreground',
              )}>
                {m.atrPct.toFixed(2)}%
              </span>

              {/* 24h% */}
              <span className={cn(
                'text-[10px] font-mono font-semibold text-right',
                change >= 0 ? 'text-[var(--color-long)]' : 'text-[var(--color-short)]',
              )}>
                {change >= 0 ? '+' : ''}{change.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 pt-2 border-t border-border/50 flex flex-wrap gap-3 text-[9px] text-muted-foreground/60">
        <span>Score 0–100 · higher = stronger signal</span>
        <span>ATR% = daily volatility</span>
        <span>Rank #1 = AI primary target</span>
      </div>
    </Card>
  );
}
