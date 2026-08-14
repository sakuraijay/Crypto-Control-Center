import { useStrategyContext } from '@/lib/context';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Activity, ShieldAlert, RotateCcw } from 'lucide-react';

export default function Strategy() {
  const { indicators, limits, updateIndicator, updateLimit, resetToDefaults } = useStrategyContext();

  return (
    <div className="animate-in fade-in duration-500">
      <div className="flex items-center justify-between mb-6">
        <p className="text-muted-foreground">Configure global strategy logic and risk limits.</p>
        <Button variant="outline" size="sm" onClick={resetToDefaults} className="h-8 text-xs">
          <RotateCcw className="w-3 h-3 mr-2" /> Reset to Defaults
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-8">
        {/* Indicators Column */}
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2">
            <Activity className="w-5 h-5 text-primary" /> Active Indicators
          </h2>
          
          <div className="grid gap-3">
            {indicators.map(ind => (
              <Card key={ind.id} className={`p-4 transition-colors \${ind.enabled ? 'border-primary/20 bg-primary/5' : 'bg-card/50'}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="font-medium text-sm">{ind.name}</div>
                  <Switch 
                    checked={ind.enabled} 
                    onCheckedChange={(c) => updateIndicator(ind.id, { enabled: c })} 
                  />
                </div>
                {Object.keys(ind.params).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(ind.params).map(([key, val]) => (
                      <div key={key} className="flex items-center bg-background border border-border rounded px-2 py-1 gap-2">
                        <span className="text-xs text-muted-foreground uppercase">{key}</span>
                        <input 
                          type="text" 
                          value={val}
                          onChange={(e) => {
                            const num = parseFloat(e.target.value);
                            if (!isNaN(num)) {
                              updateIndicator(ind.id, { params: { ...ind.params, [key]: num } });
                            }
                          }}
                          className="w-12 bg-transparent border-b border-dashed border-muted-foreground/50 text-xs font-mono text-center focus:outline-none focus:border-primary text-foreground" 
                        />
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>

        {/* Risk Limits Column */}
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold flex items-center gap-2 border-b border-border pb-2">
            <ShieldAlert className="w-5 h-5 text-[var(--color-warning)]" /> Risk Limits
          </h2>

          <Card className="p-0 overflow-hidden divide-y divide-border">
            {[
              { key: 'maxTotalExposureUSDT', label: 'Max Total Exposure (USDT)', prefix: '$' },
              { key: 'maxMarginPerTrade', label: 'Max Margin Per Trade', prefix: '$' },
              { key: 'maxLeverage', label: 'Max Leverage', suffix: 'x' },
              { key: 'maxSimultaneousPositions', label: 'Max Simultaneous Positions' },
              { key: 'dailyLossLimitUSDT', label: 'Daily Loss Limit', prefix: '$' },
              { key: 'weeklyLossLimitUSDT', label: 'Weekly Loss Limit', prefix: '$' },
              { key: 'maxDrawdownPercent', label: 'Max Drawdown', suffix: '%' },
              { key: 'consecutiveLossLimit', label: 'Consecutive Loss Limit' },
              { key: 'cooldownMinutes', label: 'Cooldown After Stop (mins)' },
              { key: 'maxTradesPerHour', label: 'Max Trades Per Hour' },
            ].map(item => (
              <div key={item.key} className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors">
                <span className="text-sm font-medium">{item.label}</span>
                <div className="flex items-center gap-1 w-32">
                  <Input 
                    type="number" 
                    value={limits[item.key as keyof typeof limits]}
                    onChange={(e) => updateLimit(item.key as keyof typeof limits, parseFloat(e.target.value) || 0)}
                    className="h-8 font-mono text-right"
                  />
                  {(item.prefix || item.suffix) && (
                    <span className="text-xs text-muted-foreground w-4">
                      {item.prefix || item.suffix}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
