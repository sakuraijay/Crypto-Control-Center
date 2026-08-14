import { useStrategyContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Activity, ShieldAlert, RotateCcw, Target, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

function Stepper({ value, onChange, min = 0, max = 1000, step = 1 }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onChange(Math.max(min, value - step))}
        className="h-8 w-8 rounded-md border border-border bg-secondary text-foreground hover:bg-muted flex items-center justify-center font-bold text-sm"
      >−</button>
      <div className="w-20 text-center font-mono text-sm font-bold px-2 py-1 bg-background border border-border rounded">
        {value}
      </div>
      <button
        onClick={() => onChange(Math.min(max, value + step))}
        className="h-8 w-8 rounded-md border border-border bg-secondary text-foreground hover:bg-muted flex items-center justify-center font-bold text-sm"
      >+</button>
    </div>
  );
}

export default function Strategy() {
  const { indicators, limits, updateIndicator, updateLimit, resetToDefaults } = useStrategyContext();

  const combined = indicators.find(i => i.id === 'combined');
  const minScore = (combined?.params.minScore as number) ?? 60;

  return (
    <div className="animate-in fade-in duration-500 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">Configure signal thresholds, indicator logic, and risk guards.</p>
        <Button variant="outline" size="sm" onClick={resetToDefaults} className="h-8 text-xs">
          <RotateCcw className="w-3 h-3 mr-2" /> Reset Defaults
        </Button>
      </div>

      {/* ── Entry Signal Thresholds ── */}
      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b border-border bg-card/50 flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          <h2 className="font-semibold text-sm">Entry Signal Thresholds</h2>
          <span className="text-xs text-muted-foreground ml-auto">Score range: −100 to +100</span>
        </div>
        <div className="p-5 grid grid-cols-2 gap-6">
          <div className="flex flex-col gap-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">LONG Entry (Min Score)</div>
            <div className="flex items-center gap-4">
              <Stepper
                value={minScore}
                min={1} max={100} step={5}
                onChange={v => combined && updateIndicator('combined', { params: { ...combined.params, minScore: v } })}
              />
              <div className="text-sm font-mono text-[var(--color-long)] font-bold">+{minScore}</div>
            </div>
            <div className="h-2 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-[var(--color-long)] rounded-full transition-all" style={{ width: `${minScore}%` }} />
            </div>
            <p className="text-[10px] text-muted-foreground">Engine only opens LONG positions when combined score ≥ +{minScore}</p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">SHORT Entry (Min Score)</div>
            <div className="flex items-center gap-4">
              <Stepper
                value={minScore}
                min={1} max={100} step={5}
                onChange={v => combined && updateIndicator('combined', { params: { ...combined.params, minScore: v } })}
              />
              <div className="text-sm font-mono text-[var(--color-short)] font-bold">−{minScore}</div>
            </div>
            <div className="h-2 bg-secondary rounded-full overflow-hidden flex justify-end">
              <div className="h-full bg-[var(--color-short)] rounded-full transition-all" style={{ width: `${minScore}%` }} />
            </div>
            <p className="text-[10px] text-muted-foreground">Engine only opens SHORT positions when combined score ≤ −{minScore}</p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-8">
        {/* ── Indicators ── */}
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-sm">
            <Activity className="w-4 h-4 text-primary" /> Active Indicators
          </h2>
          <div className="grid gap-3">
            {indicators.map(ind => (
              <Card
                key={ind.id}
                className={cn('p-4 transition-colors', ind.enabled ? 'border-primary/20 bg-primary/5' : 'bg-card/50')}
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-medium text-sm">{ind.name}</div>
                    {ind.id === 'combined' && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">Controls entry threshold above</div>
                    )}
                  </div>
                  <Switch
                    checked={ind.enabled}
                    onCheckedChange={c => updateIndicator(ind.id, { enabled: c })}
                  />
                </div>
                {Object.entries(ind.params).filter(([k]) => k !== 'minScore').length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(ind.params).filter(([k]) => k !== 'minScore').map(([key, val]) => (
                      <div key={key} className="flex items-center bg-background border border-border rounded px-2 py-1 gap-2">
                        <span className="text-[10px] text-muted-foreground uppercase">{key}</span>
                        <input
                          type="text" value={val}
                          onChange={e => {
                            const n = parseFloat(e.target.value);
                            if (!isNaN(n)) updateIndicator(ind.id, { params: { ...ind.params, [key]: n } });
                          }}
                          className="w-10 bg-transparent border-b border-dashed border-muted-foreground/50 text-[11px] font-mono text-center focus:outline-none focus:border-primary text-foreground"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>

        {/* ── Planning Assumptions (monitoring KPIs) ── */}
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-sm">
              <TrendingUp className="w-4 h-4 text-[var(--color-long)]" /> Planning Assumptions
            </h2>
            <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
              Monitoring KPIs only — displayed on the dashboard. The daily target{' '}
              <span className="text-foreground font-medium">never</span> mandates extra trades,
              larger leverage, or risk escalation. The Risk Engine is fully independent.
            </p>
          </div>
          <Card className="p-0 overflow-hidden divide-y divide-border">
            {([
              { key: 'startingCapital',  label: 'Starting Capital',   prefix: '$', step: 1000, max: 1_000_000 },
              { key: 'dailyTargetUSDT',  label: 'Daily Target (KPI)', prefix: '$', step: 50,   max: 100_000  },
            ] as const).map(item => (
              <div key={item.key} className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-foreground">{item.label}</span>
                  {item.key === 'dailyTargetUSDT' && (
                    <span className="text-[10px] text-muted-foreground">
                      {limits.startingCapital > 0
                        ? `${((limits.dailyTargetUSDT / limits.startingCapital) * 100).toFixed(1)}% of starting capital`
                        : '—'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    className="h-7 w-7 rounded border border-border bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center text-sm"
                    onClick={() => updateLimit(item.key, Math.max(0, limits[item.key] - item.step))}
                  >−</button>
                  <div className="w-28 text-center font-mono text-xs font-bold px-2 py-1 bg-background border border-border rounded">
                    {item.prefix}{limits[item.key].toLocaleString()}
                  </div>
                  <button
                    className="h-7 w-7 rounded border border-border bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center text-sm"
                    onClick={() => updateLimit(item.key, Math.min(item.max, limits[item.key] + item.step))}
                  >+</button>
                </div>
              </div>
            ))}
          </Card>
        </div>

        {/* ── Risk Limits ── */}
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2 text-sm">
            <ShieldAlert className="w-4 h-4 text-[var(--color-warning)]" /> Risk Limits
            <span className="text-[10px] font-normal text-muted-foreground ml-1">(enforced by Risk Engine · veto authority over AI)</span>
          </h2>
          <Card className="p-0 overflow-hidden divide-y divide-border">
            {([
              { key: 'maxTotalExposureUSDT',    label: 'Max Total Exposure',          prefix: '$', step: 500 },
              { key: 'maxMarginPerTrade',        label: 'Max Margin Per Trade',         prefix: '$', step: 50 },
              { key: 'maxLeverage',              label: 'Max Leverage',                 suffix: 'x', step: 1 },
              { key: 'maxSimultaneousPositions', label: 'Max Simultaneous Positions',               step: 1 },
              { key: 'dailyLossLimitUSDT',       label: 'Daily Loss Limit',             prefix: '$', step: 50 },
              { key: 'weeklyLossLimitUSDT',      label: 'Weekly Loss Limit',            prefix: '$', step: 100 },
              { key: 'maxDrawdownPercent',        label: 'Max Drawdown',                suffix: '%', step: 1 },
              { key: 'consecutiveLossLimit',      label: 'Consecutive Loss Limit',                  step: 1 },
              { key: 'cooldownMinutes',           label: 'Cooldown After Stop (min)',               step: 5 },
              { key: 'maxTradesPerHour',          label: 'Max Trades Per Hour',                     step: 1 },
            ] as const).map(item => (
              <div key={item.key} className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
                <span className="text-xs font-medium text-foreground">{item.label}</span>
                <div className="flex items-center gap-1">
                  <button
                    className="h-7 w-7 rounded border border-border bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center text-sm"
                    onClick={() => updateLimit(item.key as keyof typeof limits, Math.max(0, (limits[item.key as keyof typeof limits] as number) - (item.step ?? 1)))}
                  >−</button>
                  <div className="w-28 text-center font-mono text-xs font-bold px-2 py-1 bg-background border border-border rounded">
                    {'prefix' in item ? item.prefix : ''}{limits[item.key as keyof typeof limits]}{'suffix' in item ? item.suffix : ''}
                  </div>
                  <button
                    className="h-7 w-7 rounded border border-border bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center text-sm"
                    onClick={() => updateLimit(item.key as keyof typeof limits, (limits[item.key as keyof typeof limits] as number) + (item.step ?? 1))}
                  >+</button>
                </div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
