/**
 * ShadowReviewCard — 6I-1 §15.
 * shadow 성과 지표. 표본 부족 = INSUFFICIENT_SAMPLE 명시 (0/정상 위장 금지).
 * 자동 LIVE 승격 없음 문구 고정.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchShadowMetrics, ShadowMetricsResponse, INTEL_NOTICE_SHADOW } from '@/lib/intelStatus';

const fmt = (v: unknown, digits = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';

export function ShadowReviewCard() {
  const [data, setData] = useState<ShadowMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchShadowMetrics());
      setError(null);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : '조회 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 120_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Card className="p-4 space-y-3" data-testid="card-shadow-review">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Shadow Review</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} data-testid="button-shadow-refresh">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {error !== null && (
        <div className="flex items-center gap-2 text-xs text-red-500" data-testid="text-shadow-unavailable">
          <AlertTriangle className="h-3 w-3" /> Unavailable — {error}
        </div>
      )}
      {error === null && data !== null && data.status === 'INSUFFICIENT_SAMPLE' && (
        <div className="text-xs space-y-1" data-testid="text-insufficient-sample">
          <Badge variant="secondary" className="text-[10px]">표본 부족 (INSUFFICIENT_SAMPLE)</Badge>
          <p className="text-muted-foreground">
            완료 shadow 표본 {data.sampleCount}/{data.required}건 — 지표는 표본 확보 후 표시됩니다. (0/정상으로 위장하지 않음)
          </p>
        </div>
      )}
      {error === null && data !== null && data.status === 'OK' && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">표본 수</span><span className="font-mono">{data.sampleCount}</span>
          <span className="text-muted-foreground">순기대값(1h)</span><span className="font-mono">${fmt((data as Record<string, unknown>).netExpectancy1hUsd)}</span>
          <span className="text-muted-foreground">순기대값(4h)</span><span className="font-mono">${fmt((data as Record<string, unknown>).netExpectancy4hUsd)}</span>
          <span className="text-muted-foreground">Profit Factor(4h)</span><span className="font-mono">{fmt((data as Record<string, unknown>).profitFactor4h)}</span>
          <span className="text-muted-foreground">평균 MFE</span><span className="font-mono">{fmt((data as Record<string, unknown>).avgMaxFavorableExcursionPct)}%</span>
          <span className="text-muted-foreground">평균 MAE</span><span className="font-mono">{fmt((data as Record<string, unknown>).avgMaxAdverseExcursionPct)}%</span>
          <span className="text-muted-foreground">비용 잠식비</span><span className="font-mono">{fmt((data as Record<string, unknown>).costErosionRatio)}</span>
          <span className="text-muted-foreground">Brier</span><span className="font-mono">{fmt((data as Record<string, unknown>).brierScore, 4)}</span>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground border-t pt-2" data-testid="text-shadow-notice">{INTEL_NOTICE_SHADOW}</p>
    </Card>
  );
}
