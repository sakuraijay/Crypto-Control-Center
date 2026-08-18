/**
 * MarketIntelligenceCard — 6I-1 §15.
 * universe/shortlist 규모, 시장별 regime, 데이터 품질, NO_TRADE 사유 표시.
 * 조회 실패 = Unavailable (가짜 0/NORMAL 렌더 금지).
 */
import { useCallback, useEffect, useState } from 'react';
import { Radar, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  fetchIntelStatus, IntelStatus, INTEL_NOTICE_MONITORING, INTEL_NOTICE_SHADOW,
} from '@/lib/intelStatus';

const REGIME_COLOR: Record<string, string> = {
  STRONG_BULL: 'text-emerald-500', WEAK_BULL: 'text-emerald-400',
  STRONG_BEAR: 'text-red-500', WEAK_BEAR: 'text-red-400',
  RANGE: 'text-muted-foreground', HIGH_VOLATILITY: 'text-amber-500',
  LOW_VOLATILITY: 'text-muted-foreground', OVERHEATED: 'text-amber-500',
  OVERSOLD: 'text-amber-500', ABNORMAL: 'text-red-600', UNAVAILABLE: 'text-muted-foreground',
};

export function MarketIntelligenceCard() {
  const [status, setStatus] = useState<IntelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await fetchIntelStatus());
      setError(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : '조회 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Card className="p-4 space-y-3" data-testid="card-market-intelligence">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Market Intelligence</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} data-testid="button-intel-refresh">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{INTEL_NOTICE_MONITORING}</p>

      {error !== null && (
        <div className="flex items-center gap-2 text-xs text-red-500" data-testid="text-intel-unavailable">
          <AlertTriangle className="h-3 w-3" /> Unavailable — {error} (가짜 정상 표시 금지)
        </div>
      )}
      {error === null && status !== null && !status.available && (
        <div className="text-xs text-muted-foreground" data-testid="text-intel-waiting">
          {status.reason ?? '첫 사이클 대기 중'}
        </div>
      )}
      {error === null && status?.available && (
        <>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div><span className="text-muted-foreground">Universe</span><div className="font-mono" data-testid="text-universe-count">{status.universeCount}</div></div>
            <div><span className="text-muted-foreground">Shortlist</span><div className="font-mono" data-testid="text-shortlist-count">{status.shortlistCount}</div></div>
            <div>
              <span className="text-muted-foreground">데이터 품질</span>
              <div>
                <Badge variant={status.dataQuality === 'GOOD' ? 'default' : 'destructive'} className="text-[10px]">
                  {status.dataQuality}{status.degraded ? ' (불완전)' : ''}
                </Badge>
              </div>
            </div>
          </div>
          {status.degradedReason && (
            <p className="text-[11px] text-amber-500">데이터 불완전: {status.degradedReason}</p>
          )}
          <div className="space-y-1">
            {(status.regimes ?? []).map(r => (
              <div key={r.market} className="flex items-center justify-between text-xs" data-testid={`row-regime-${r.market}`}>
                <span className="font-mono truncate max-w-[45%]">
                  {status.shortlistSymbols?.[status.regimes?.indexOf(r) ?? 0] ?? r.market.slice(0, 8)}
                </span>
                <span className={REGIME_COLOR[r.regime] ?? ''}>{r.regime}</span>
                {!r.tradeAllowed && <Badge variant="destructive" className="text-[10px]">진입 차단</Badge>}
              </div>
            ))}
          </div>
          <div className="text-xs">
            결정: <span className="font-semibold" data-testid="text-intel-decision">{status.decision}</span>
            {status.decision === 'NO_TRADE' && (
              <span className="text-muted-foreground"> — 정상 결과 ({(status.noTradeReasons ?? []).join('; ') || '기준 미달'})</span>
            )}
            {status.decision === 'BLOCKED' && (
              <span className="text-red-500"> — {status.blockedReason}</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            사이클 {status.cycleCount}회 · NO_TRADE {status.noTradeCycles}회
          </div>
        </>
      )}
      <p className="text-[11px] text-muted-foreground border-t pt-2">{INTEL_NOTICE_SHADOW}</p>
    </Card>
  );
}
