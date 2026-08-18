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
import {
  fetchShadowMetrics, fetchEnrichmentStatus,
  ShadowMetricsResponse, EnrichmentStatus, INTEL_NOTICE_SHADOW,
} from '@/lib/intelStatus';

const fmt = (v: unknown, digits = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';

export function ShadowReviewCard() {
  const [data, setData] = useState<ShadowMetricsResponse | null>(null);
  const [enrich, setEnrich] = useState<EnrichmentStatus | null>(null);
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
    // enrichment 상태는 독립 조회 — 실패해도 metrics 표시는 유지
    try { setEnrich(await fetchEnrichmentStatus()); } catch { setEnrich(null); }
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
      {/* 6I-2 §11 — Outcome Enrichment 상태 (저장 상태만) */}
      {enrich !== null && (
        <div className="text-[11px] space-y-0.5 border-t pt-2" data-testid="text-enrichment-status">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Outcome Enrichment</span>
            <span className="font-mono">
              대기 {enrich.backlog.dueCount} · 4h 완료 {enrich.backlog.complete4hCount} · 모호 {enrich.backlog.ambiguousCount}
            </span>
          </div>
          {enrich.lastRun !== null && (
            <p className="text-muted-foreground">
              최근 실행: scanned {enrich.lastRun.scanned} / 4h {enrich.lastRun.enriched} / 1h {enrich.lastRun.enriched1h}
              {enrich.lastRun.exhausted > 0 && ` / 상한종결 ${enrich.lastRun.exhausted}`}
            </p>
          )}
        </div>
      )}

      {/* 6I-2 §10 — 표본 성숙도 (승격 플래그는 항상 false) */}
      {error === null && data?.maturity !== undefined && (
        <div className="text-[11px] space-y-1 border-t pt-2" data-testid="text-shadow-maturity">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant={data.maturity.researchPreviewEligible ? 'default' : 'secondary'} className="text-[10px]">
              연구 미리보기 {data.maturity.sampleCount4h}/30
            </Badge>
            <Badge variant={data.maturity.manualReviewSampleEligible ? 'default' : 'secondary'} className="text-[10px]">
              수동 검토 {data.maturity.sampleCount4h}/100
            </Badge>
            <Badge variant="destructive" className="text-[10px]">자동 승격 차단</Badge>
          </div>
          {data.maturity.blockedReasons.length > 0 && (
            <p className="text-muted-foreground">{data.maturity.blockedReasons[0]}</p>
          )}
          {data.counterfactual !== undefined && data.counterfactual.evaluated > 0 && (
            <p className="text-muted-foreground" data-testid="text-counterfactual">
              NO_TRADE 검증 {data.counterfactual.evaluated}건 — 올바른 거부 {data.counterfactual.byLabel.CORRECT_REJECTION ?? 0}
              · 기회 상실 {data.counterfactual.byLabel.MISSED_OPPORTUNITY ?? 0}
              · 위험 회피 {data.counterfactual.byLabel.RISK_AVOIDED ?? 0}
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground border-t pt-2" data-testid="text-shadow-notice">{INTEL_NOTICE_SHADOW}</p>
    </Card>
  );
}
