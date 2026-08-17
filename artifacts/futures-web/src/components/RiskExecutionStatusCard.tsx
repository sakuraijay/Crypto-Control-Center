/**
 * RiskExecutionStatusCard — 6H-2 사이징 강제·비용 스냅샷·close-all 진행 상태.
 *
 * 계약:
 *  - 데이터 소스: GET /api/executor/status (서버 스냅샷 — 브라우저 계산 없음).
 *  - 조회 실패를 정상(0/미발생)으로 위장하지 않음 — 실패 배너 표시.
 *  - 사이징 거부·clamp·close-all 잠금은 명시적으로 표시.
 */
import { useCallback, useEffect, useState } from 'react';
import { Scale, Loader2, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/apiUrl';

interface PaperSizingSnapshot {
  at: string; ok: boolean; reason: string | null;
  finalNotionalUsd: number | null; finalLeverage: number | null;
  allowedRiskUsd: number | null; clamped: boolean; clampDetails: string[];
  estimatedRoundTripCostUsd: number | null;
}
interface SizingEnforcementSnapshot {
  at: string; decisionId: string; ok: boolean; reason: string | null;
  requestedSizeUsd: number; finalNotionalUsd: number | null;
  finalCollateralUsd: number | null; finalLeverage: number | null;
  allowedRiskUsd: number | null; clamped: boolean; clampDetails: string[];
  costSource: string | null; costFetchedAt: string | null;
  estimatedRoundTripCostUsd: number | null;
}
interface CloseAllSummary {
  total: number; confirmed: number; terminalFailed: number;
  unresolved: number; pending: number;
  allTerminal: boolean; allConfirmed: boolean;
  lockRequired: boolean; rolloverAllowed: boolean;
}
interface StatusSlice {
  paperSizing: PaperSizingSnapshot | null;
  liveSizingEnforcement: SizingEnforcementSnapshot | null;
  closeAllSummary: CloseAllSummary | null;
}

function fmtUsd(v: number | null | undefined): string {
  return v == null ? '—' : `$${v.toFixed(2)}`;
}
function fmtAge(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  return m < 1 ? '방금' : `${m}분 전`;
}

export function RiskExecutionStatusCard() {
  const [data, setData] = useState<StatusSlice | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/executor/status'));
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json() as StatusSlice;
      setData({
        paperSizing: j.paperSizing ?? null,
        liveSizingEnforcement: j.liveSizingEnforcement ?? null,
        closeAllSummary: j.closeAllSummary ?? null,
      });
      setError(false);
    } catch {
      setError(true); // 기존 스냅샷 유지 — 실패를 0/정상으로 표시하지 않음
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const ps = data?.paperSizing ?? null;
  const ls = data?.liveSizingEnforcement ?? null;
  const ca = data?.closeAllSummary ?? null;

  return (
    <Card className="p-5 flex flex-col gap-3" data-testid="risk-execution-status-card">
      <div className="flex items-center gap-2">
        <Scale className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">실행 사이징 강제 (6H-2)</h3>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" onClick={() => void load()}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>

      {error && (
        <div className="text-[10px] rounded border border-red-500/40 bg-red-500/8 p-2 text-red-400 font-semibold">
          상태 조회 실패 — 아래 값은 마지막 성공 스냅샷입니다 (실패 ≠ 정상)
        </div>
      )}

      {/* PAPER 사이징 */}
      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-muted-foreground">PAPER 사이징 엔진 (LIVE 동일 엔진)</p>
        {!ps ? (
          <p className="text-[11px] text-muted-foreground">기록 없음 — 아직 사이징 대상 결정이 없습니다.</p>
        ) : ps.ok ? (
          <div className="text-[11px] font-mono space-y-0.5">
            <p>최종 {fmtUsd(ps.finalNotionalUsd)} · {ps.finalLeverage ?? '—'}x · 허용위험 {fmtUsd(ps.allowedRiskUsd)} · 왕복비용 {fmtUsd(ps.estimatedRoundTripCostUsd)} <span className="text-muted-foreground">({fmtAge(ps.at)})</span></p>
            {ps.clamped && <p className="text-amber-400">CLAMP: {ps.clampDetails.join(' · ')}</p>}
          </div>
        ) : (
          <p className="text-[11px] text-red-400 font-mono">거부 — {ps.reason} <span className="text-muted-foreground">({fmtAge(ps.at)})</span></p>
        )}
      </div>

      {/* LIVE 실행 경로 사이징 */}
      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-muted-foreground">LIVE 실행 경로 사이징 강제</p>
        {!ls ? (
          <p className="text-[11px] text-muted-foreground">기록 없음 — LIVE 실행 경로에 도달한 주문이 없습니다.</p>
        ) : ls.ok ? (
          <div className="text-[11px] font-mono space-y-0.5">
            <p>요청 {fmtUsd(ls.requestedSizeUsd)} → 최종 {fmtUsd(ls.finalNotionalUsd)} · 담보 {fmtUsd(ls.finalCollateralUsd)} · {ls.finalLeverage ?? '—'}x <span className="text-muted-foreground">({fmtAge(ls.at)})</span></p>
            <p className="text-muted-foreground">비용 출처: {ls.costSource ?? '—'} · 스냅샷 {fmtAge(ls.costFetchedAt)} · 왕복비용 {fmtUsd(ls.estimatedRoundTripCostUsd)}</p>
            {ls.clamped && <p className="text-amber-400">CLAMP: {ls.clampDetails.join(' · ')}</p>}
          </div>
        ) : (
          <p className="text-[11px] text-red-400 font-mono">거부 — {ls.reason} <span className="text-muted-foreground">({fmtAge(ls.at)})</span></p>
        )}
      </div>

      {/* close-all */}
      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-muted-foreground">CLOSE_ALL orchestration</p>
        {!ca ? (
          <p className="text-[11px] text-muted-foreground">발생 없음</p>
        ) : (
          <div className="text-[11px] font-mono space-y-0.5">
            <p>{ca.confirmed}/{ca.total} 확정 · 실패 {ca.terminalFailed} · 불명 {ca.unresolved} · 대기 {ca.pending}</p>
            {ca.lockRequired
              ? <p className="text-red-400 font-semibold">전량 종료 미확정 — 신규 진입 잠금 유지 {ca.rolloverAllowed ? '' : '(자정 rollover 해제 금지)'}</p>
              : <p className="text-[var(--color-long)]">전량 CONFIRMED — 잠금 해제 가능</p>}
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        모든 값은 서버 최종 산정 기준입니다 — 브라우저·엔진 요청값은 참고용이며 서버 상한을 초과할 수 없습니다.
      </p>
    </Card>
  );
}
