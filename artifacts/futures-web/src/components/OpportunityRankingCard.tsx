/**
 * OpportunityRankingCard — 6I-1 §15.
 * 후보별 신호/보정 확률(미보정=문구)/순기대값(null=산출 불가)/탈락 사유 표시.
 * 미보정 확률을 %로 위장하지 않는다. NO_TRADE는 정상 결과로 표시.
 */
import { useCallback, useEffect, useState } from 'react';
import { ListOrdered, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  fetchOpportunitiesLatest, OpportunitiesLatest,
  formatWinProbability, formatExpectedNetValue, INTEL_NOTICE_NO_GUARANTEE,
  formatBucketSamples, formatTotalCost, costComponentLines,
} from '@/lib/intelStatus';

export function OpportunityRankingCard() {
  const [data, setData] = useState<OpportunitiesLatest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchOpportunitiesLatest());
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
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Card className="p-4 space-y-3" data-testid="card-opportunity-ranking">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListOrdered className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Opportunity Ranking</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} data-testid="button-opportunities-refresh">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {error !== null && (
        <div className="flex items-center gap-2 text-xs text-red-500" data-testid="text-opportunities-unavailable">
          <AlertTriangle className="h-3 w-3" /> Unavailable — {error}
        </div>
      )}
      {error === null && data !== null && !data.available && (
        <div className="text-xs text-muted-foreground">{data.reason ?? '저장된 사이클 없음'}</div>
      )}
      {error === null && data?.available && (
        <>
          <div className="text-xs">
            최근 결정: <span className="font-semibold" data-testid="text-latest-decision">{data.decision}</span>
            {data.decision === 'NO_TRADE' && <span className="text-muted-foreground"> — NO_TRADE는 정상 결과입니다</span>}
          </div>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {data.candidates.slice(0, 10).map((c, i) => (
              <div key={`${c.symbol}-${c.direction}-${i}`} className="border rounded p-2 text-xs space-y-1" data-testid={`row-candidate-${c.symbol}-${c.direction}`}>
                <div className="flex items-center justify-between">
                  <span className="font-mono font-semibold">
                    {c.rank !== null ? `#${c.rank} ` : ''}{c.symbol} {c.direction}
                  </span>
                  <Badge
                    variant={c.decision === 'ELIGIBLE' ? 'default' : c.decision === 'SHADOW_ONLY' ? 'secondary' : 'destructive'}
                    className="text-[10px]"
                  >
                    {c.selected ? 'SELECTED' : c.decision}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-x-3 text-muted-foreground">
                  <span>신호 점수: <span className="text-foreground font-mono">{c.rawSignalScore.toFixed(1)}</span></span>
                  <span>승률: <span className="text-foreground" data-testid={`text-prob-${c.symbol}-${c.direction}`}>{formatWinProbability(c.winProbability, c.calibrationStatus)}</span></span>
                  <span>순기대값: <span className="text-foreground font-mono">{formatExpectedNetValue(c.expectedNetValueUsd)}</span></span>
                  <span>연구 점수: <span className="text-foreground font-mono">{c.uncalibratedRankingScore === null ? '—' : c.uncalibratedRankingScore.toFixed(1)}</span></span>
                  <span
                    title={costComponentLines(c.costBreakdown).map(l => `${l.label}: ${l.value}`).join('\n') || undefined}
                  >
                    총비용: <span className="text-foreground font-mono" data-testid={`text-cost-${c.symbol}-${c.direction}`}>{formatTotalCost(c.totalExpectedCostUsd)}</span>
                  </span>
                  {formatBucketSamples(c.calibrationBucket) !== null && (
                    <span title={c.calibrationBucket?.reason ?? undefined}>
                      Bucket: <span className="text-foreground font-mono" data-testid={`text-bucket-${c.symbol}-${c.direction}`}>{formatBucketSamples(c.calibrationBucket)}</span>
                    </span>
                  )}
                </div>
                {c.costBreakdown?.costBasis && c.totalExpectedCostUsd === null && (
                  <div className="text-[10px] text-muted-foreground truncate" title={c.costBreakdown.costBasis}>
                    비용: {c.costBreakdown.costBasis}
                  </div>
                )}
                {c.rejectionReasons.length > 0 && (
                  <div className="text-[10px] text-muted-foreground truncate" title={c.rejectionReasons.join('; ')}>
                    사유: {c.rejectionReasons[0]}{c.rejectionReasons.length > 1 ? ` 외 ${c.rejectionReasons.length - 1}건` : ''}
                  </div>
                )}
              </div>
            ))}
            {data.candidates.length === 0 && (
              <div className="text-xs text-muted-foreground">후보 없음</div>
            )}
          </div>
        </>
      )}
      <p className="text-[11px] text-muted-foreground border-t pt-2">{INTEL_NOTICE_NO_GUARANTEE}</p>
    </Card>
  );
}
