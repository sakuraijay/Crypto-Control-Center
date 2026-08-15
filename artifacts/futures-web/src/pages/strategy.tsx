import { useStrategyContext } from '@/lib/context';
import { useWallet } from '@/lib/context/WalletContext';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Activity, ShieldAlert, RotateCcw, Target, TrendingUp, Cpu, Info, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCallback, useEffect } from 'react';

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
  const { address, usdcBalance } = useWallet();

  const combined = indicators.find(i => i.id === 'combined');
  const minScore = (combined?.params.minScore as number) ?? 60;

  // Wallet USDC balance validation for tradingCapital.
  // Strip locale grouping separators (e.g. "10,000.00" → 10000) before parsing.
  // Use Number.isFinite so that "0.00" → 0 (not null) and truly bad strings → null.
  const walletUsdcNum: number | null = (() => {
    if (usdcBalance === null) return null;
    const n = parseFloat(usdcBalance.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  })();

  // Warn/enforce cap when wallet is connected and capital exceeds balance.
  // A zero-USDC balance still exceeds any positive capital setting.
  const capitalExceedsWallet = walletUsdcNum !== null && limits.tradingCapital > walletUsdcNum;

  // Cap-aware updateLimit wrapper for the Planning section.
  // Enforces tradingCapital ≤ walletUsdcNum whenever wallet is connected
  // (including zero balance — caller must not be able to set capital > available funds).
  // Disconnected wallet (address = null): no server-side cap, operator's responsibility.
  const handleUpdateLimit = useCallback(
    (key: 'tradingCapital' | 'dailyTargetUSDT', value: number) => {
      let clamped = value;
      if (key === 'tradingCapital' && address !== null && walletUsdcNum !== null) {
        clamped = Math.min(clamped, walletUsdcNum);
      }
      updateLimit(key, clamped);
    },
    [address, walletUsdcNum, updateLimit],
  );

  // Auto-correct tradingCapital on wallet connection / balance update (including 0).
  // Only fires on wallet data changes (not on every capital edit) to avoid loops.
  useEffect(() => {
    if (address === null || walletUsdcNum === null) return;
    if (limits.tradingCapital > walletUsdcNum) {
      updateLimit('tradingCapital', walletUsdcNum);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, walletUsdcNum]); // intentionally omit limits.tradingCapital to prevent loops

  return (
    <div className="animate-in fade-in duration-500 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">Configure signal thresholds, indicator logic, and risk guards.</p>
        <Button variant="outline" size="sm" onClick={resetToDefaults} className="h-8 text-xs">
          <RotateCcw className="w-3 h-3 mr-2" /> Reset Defaults
        </Button>
      </div>

      {/* ── AI Objective Function ── */}
      <div className="flex items-start gap-3 p-4 rounded-xl border border-primary/20 bg-primary/5">
        <Cpu className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-semibold text-foreground">AI 목적함수 — 위험조정수익(Sharpe-like) 최대화</div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            엔진은 <span className="text-foreground font-medium">고정 일일 수익률을 채우기 위해 추가 매매하거나 레버리지를 높이지 않습니다.</span>{' '}
            아래 하드 리스크 한도 내에서 기대수익을 최대화하는 것이 유일한 목적입니다.
            수익이 많이 난 날에는 Profit-lock이 신규 노출을 단계적으로 줄이고 trailing을 강화해
            좋은 추세를 계속 탈 수 있게 합니다 — 완전 중단하지 않습니다.
          </p>
        </div>
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
              <TrendingUp className="w-4 h-4 text-[var(--color-long)]" /> Trading Capital &amp; KPI
            </h2>
            <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
              <span className="text-foreground font-medium">Trading Capital</span>은 실제 지갑 USDC 잔고를 초과할 수 없습니다.
              일일 PnL KPI는 모니터링 전용 — AI 진입 결정과 무관합니다.
            </p>
          </div>
          <Card className="p-0 overflow-hidden divide-y divide-border">
            {([
              { key: 'tradingCapital',   label: 'Trading Capital (시드머니)', prefix: '$', step: 1000, max: 1_000_000 },
              { key: 'dailyTargetUSDT',  label: '일일 PnL KPI (소프트 목표)', prefix: '$', step: 50,   max: 100_000  },
            ] as const).map(item => (
              <div key={item.key} className="flex flex-col px-4 py-3 hover:bg-muted/30 transition-colors gap-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-foreground">{item.label}</span>
                    {item.key === 'dailyTargetUSDT' && (
                      <span className="text-[10px] text-muted-foreground">
                        {limits.tradingCapital > 0
                          ? `${((limits.dailyTargetUSDT / limits.tradingCapital) * 100).toFixed(1)}% of trading capital · AI 진입과 무관`
                          : '—'}
                      </span>
                    )}
                    {item.key === 'tradingCapital' && !address && (
                      <span className="text-[10px] text-muted-foreground">지갑 연결 후 잔고 검증 가능</span>
                    )}
                    {item.key === 'tradingCapital' && address && !capitalExceedsWallet && walletUsdcNum !== null && (
                      <span className="text-[10px] text-emerald-500/80">
                        ✓ 지갑 USDC ${walletUsdcNum.toLocaleString('en-US', { maximumFractionDigits: 0 })} 이내
                      </span>
                    )}
                    {item.key === 'tradingCapital' && capitalExceedsWallet && walletUsdcNum !== null && (
                      <span className="text-[10px] text-amber-400">
                        ⚠ 지갑 USDC (${walletUsdcNum.toLocaleString('en-US', { maximumFractionDigits: 0 })}) 초과 — 줄여주세요
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="h-7 w-7 rounded border border-border bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center text-sm"
                      onClick={() => handleUpdateLimit(item.key, Math.max(0, limits[item.key] - item.step))}
                    >−</button>
                    <div className={cn(
                      'w-28 text-center font-mono text-xs font-bold px-2 py-1 bg-background border rounded',
                      item.key === 'tradingCapital' && capitalExceedsWallet
                        ? 'border-amber-500/50 text-amber-400'
                        : 'border-border',
                    )}>
                      {item.prefix}{limits[item.key].toLocaleString()}
                    </div>
                    <button
                      disabled={
                        item.key === 'tradingCapital' &&
                        address !== null &&
                        walletUsdcNum !== null &&
                        limits.tradingCapital >= walletUsdcNum
                      }
                      className={cn(
                        'h-7 w-7 rounded border border-border flex items-center justify-center text-sm',
                        item.key === 'tradingCapital' &&
                        address !== null &&
                        walletUsdcNum !== null &&
                        limits.tradingCapital >= walletUsdcNum
                          ? 'bg-muted/20 text-muted-foreground/30 cursor-not-allowed'
                          : 'bg-secondary text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => handleUpdateLimit(item.key, Math.min(item.max, limits[item.key] + item.step))}
                    >+</button>
                  </div>
                </div>
                {/* KPI independence notice — shown only for dailyTargetUSDT */}
                {item.key === 'dailyTargetUSDT' && (
                  <div className="flex items-start gap-1 text-[9px] text-muted-foreground/70">
                    <Info className="w-2.5 h-2.5 shrink-0 mt-0.5" />
                    이 값에 미달해도 AI는 추가 매매·레버리지 확대 없음
                  </div>
                )}
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
              { key: 'reserveCashPct',           label: 'Reserve Cash (미배포 비율)',    suffix: '%', step: 5,   hint: '거래에 투입하지 않는 Trading Capital 비율' },
              { key: 'maxTotalExposureUSDT',      label: 'Max Total Exposure',            prefix: '$', step: 500 },
              { key: 'maxMarginPerTrade',          label: 'Max Margin Per Trade',           prefix: '$', step: 50 },
              { key: 'maxLeverage',                label: 'Max Leverage',                   suffix: 'x', step: 1 },
              { key: 'maxSimultaneousPositions',   label: 'Max Simultaneous Positions',                 step: 1 },
              { key: 'maxRiskPerSymbolPct',        label: 'Max Risk Per Symbol',            suffix: '%', step: 0.5, hint: 'Trading Capital 대비 심볼당 최대 위험' },
              { key: 'dailyLossLimitUSDT',         label: 'Daily Loss Limit',               prefix: '$', step: 50 },
              { key: 'weeklyLossLimitUSDT',        label: 'Weekly Loss Limit',              prefix: '$', step: 100 },
              { key: 'maxDrawdownPercent',          label: 'Max Drawdown',                  suffix: '%', step: 1 },
              { key: 'consecutiveLossLimit',        label: 'Consecutive Loss Limit',                     step: 1 },
              { key: 'cooldownMinutes',             label: 'Cooldown After Stop (min)',                  step: 5 },
              { key: 'maxTradesPerHour',            label: 'Max Trades Per Hour',                        step: 1 },
              { key: 'profitLockThresholdPct',     label: 'Profit-lock 발동 임계값',       suffix: '%', step: 0.5, hint: '일일 PnL이 Trading Capital 대비 이 비율에 도달하면 Lv.1 가동' },
            ] as const).map(item => (
              <div key={item.key} className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-foreground">{item.label}</span>
                  {'hint' in item && item.hint && (
                    <span className="text-[9px] text-muted-foreground/70">{item.hint}</span>
                  )}
                </div>
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

          {/* Profit-lock stage visual legend */}
          <div className="flex flex-col gap-1.5 p-3 rounded-lg border border-border bg-muted/20">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              <Lock className="w-3 h-3" /> Profit-lock 단계 (현재 임계값: {limits.profitLockThresholdPct}% of capital)
            </div>
            <div className="grid grid-cols-4 gap-1.5 text-[9px]">
              {([
                { stage: 0, label: 'Lv.0 정상',   desc: '제한 없음',                    cls: 'border-border text-muted-foreground' },
                { stage: 1, label: 'Lv.1',         desc: '노출 ×0.75 · trailing +20%',  cls: 'border-yellow-500/30 text-yellow-400 bg-yellow-500/5' },
                { stage: 2, label: 'Lv.2',         desc: '노출 ×0.50 · trailing +40%',  cls: 'border-orange-500/30 text-orange-400 bg-orange-500/5' },
                { stage: 3, label: 'Lv.3',         desc: '노출 ×0.25 · scale_in 차단',  cls: 'border-red-500/30 text-red-400 bg-red-500/5' },
              ]).map(s => (
                <div key={s.stage} className={cn('rounded p-2 border flex flex-col gap-0.5', s.cls)}>
                  <span className="font-bold">{s.label}</span>
                  <span className="opacity-80">{s.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
