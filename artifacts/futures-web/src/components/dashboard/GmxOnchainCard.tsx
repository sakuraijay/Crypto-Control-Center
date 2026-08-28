/**
 * GmxOnchainCard — 실제 GMX 온체인 포지션 + 지갑 잔고 (Read-only)
 *
 * 서버에 설정된 공개 owner 계정을 GMX V2 PositionReader로 조회해 표시합니다.
 * 브라우저 지갑, signer, Subaccount 연결은 필요하지 않습니다.
 *
 * 보안 원칙:
 *   - 조회 전용. 서명·주문·자금 이동 없음.
 *   - 개인키·시드문구를 수신하거나 저장하지 않음.
 *
 * 데이터 출처:
 *   - Arbitrum RPC (GMX V2 PositionReader) — 포지션 목록 (30초 캐시)
 *   - Arbitrum RPC — 공개 계정 ETH/USDC 잔고
 *   - GMX API v2 — 포지션 개수 교차검증(실행 증거로 사용하지 않음)
 *   PAPER/Mock 대시보드 데이터와 완전히 별개의 실제 온체인 데이터입니다.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Wallet, RefreshCw, TrendingUp, TrendingDown,
  Loader2, AlertCircle, CheckCircle2, Clock, XCircle,
  Database, Activity, ChevronDown, ChevronUp, Zap, ShieldAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useGmxAccount, type GmxOnchainPosition } from '@/lib/context/GmxAccountContext';
import { summarizeGmxRisk } from '@/lib/gmxPositionMetrics';
import { cn } from '@/lib/utils';
import { formatDistanceToNow, format } from 'date-fns';
import { ko } from 'date-fns/locale';

// ── 1-second ticker ───────────────────────────────────────────────────────────

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ── Elapsed formatter ────────────────────────────────────────────────────────

function formatElapsedKo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 전`;
}

/** amber at 60 s, red at 120 s */
function elapsedColor(ms: number): string {
  if (ms >= 120_000) return 'text-[var(--color-short)]';
  if (ms >= 60_000)  return 'text-amber-400';
  return 'text-muted-foreground';
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({ pos }: { pos: GmxOnchainPosition }) {
  const isLong   = pos.direction === 'LONG';
  const pnlColor = pos.realisedPnlUsd >= 0
    ? 'text-[var(--color-long)]'
    : 'text-[var(--color-short)]';

  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/60 last:border-0 text-xs">
      {/* Left: symbol + direction */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={cn(
          'flex items-center justify-center w-6 h-6 rounded-md shrink-0',
          isLong
            ? 'bg-[var(--color-long)]/10 text-[var(--color-long)]'
            : 'bg-[var(--color-short)]/10 text-[var(--color-short)]',
        )}>
          {isLong ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
        </div>
        <div className="min-w-0">
          <div className="font-bold font-mono">
            {pos.symbol}/USD
            <span className={cn(
              'ml-1.5 text-[10px] font-bold px-1 py-0.5 rounded',
              isLong
                ? 'bg-[var(--color-long)]/10 text-[var(--color-long)]'
                : 'bg-[var(--color-short)]/10 text-[var(--color-short)]',
            )}>
              {pos.direction}
            </span>
          </div>
          {pos.openedAt && (
            <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {formatDistanceToNow(new Date(pos.openedAt * 1000), { locale: ko, addSuffix: true })}
            </div>
          )}
        </div>
      </div>

      {/* Right: size + collateral + leverage + liq price + unrealized PnL + realised PnL */}
      <div className="flex items-center gap-4 shrink-0 text-right">
        <div>
          <div className="font-mono font-semibold text-foreground">
            ${pos.sizeUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[10px] text-muted-foreground">SIZE</div>
        </div>
        <div>
          <div className="font-mono text-foreground">
            ${pos.collateralUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-muted-foreground">COLLATERAL</div>
        </div>
        {/* Leverage — calculated from size/collateral, shown only when trust-safe */}
        <div>
          <div className={cn(
            'font-mono font-semibold',
            pos.leverage != null ? 'text-foreground' : 'text-muted-foreground/50',
          )}>
            {pos.leverage != null ? `${pos.leverage.toFixed(1)}x` : 'N/A'}
          </div>
          <div className="text-[10px] text-muted-foreground">LEV</div>
        </div>
        {/* Liquidation price — authoritative source only, never estimated */}
        <div>
          <div className={cn(
            'font-mono',
            pos.nearLiquidation
              ? 'text-[var(--color-short)] font-bold animate-pulse'
              : pos.liquidationPrice != null
                ? 'text-[var(--color-short)] font-semibold'
                : 'text-muted-foreground/50',
          )}>
            {pos.liquidationPrice != null
              ? `$${pos.liquidationPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
              : 'N/A'}
          </div>
          <div className="text-[10px] text-muted-foreground">LIQ.PRICE</div>
        </div>
        {/* Unrealized PnL — mark-to-market. null when data unavailable */}
        <div>
          <div className={cn(
            'font-mono font-semibold',
            pos.unrealizedPnlUsd == null
              ? 'text-muted-foreground/40'
              : pos.unrealizedPnlUsd >= 0
                ? 'text-[var(--color-long)]'
                : 'text-[var(--color-short)]',
          )}>
            {pos.unrealizedPnlUsd != null
              ? `${pos.unrealizedPnlUsd >= 0 ? '+' : ''}${pos.unrealizedPnlUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
              : '—'}
          </div>
          <div className="text-[10px] text-muted-foreground">UNREALISED</div>
        </div>
        <div>
          <div className={cn('font-mono font-semibold', pnlColor)}>
            {pos.realisedPnlUsd >= 0 ? '+' : ''}{pos.realisedPnlUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-muted-foreground">REALISED</div>
        </div>
      </div>
    </div>
  );
}

// ── Diagnostic badge ──────────────────────────────────────────────────────────

function DiagBadge({
  icon: Icon, label, value, ok,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  /** true = green, false = red, undefined = neutral */
  ok?: boolean;
}) {
  const colorClass =
    ok === true  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]' :
    ok === false ? 'border-[var(--color-short)]/30 bg-[var(--color-short)]/5 text-[var(--color-short)]' :
                   'border-border bg-card/50 text-muted-foreground';

  return (
    <div className={cn(
      'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-medium min-w-0',
      colorClass,
    )}>
      <Icon className="w-3 h-3 shrink-0" />
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono truncate" title={value}>{value}</span>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

export function GmxOnchainCard() {
  const gmx    = useGmxAccount();
  const now    = useNow();

  const [diagOpen, setDiagOpen] = useState(false);

  // Show error UI when canonical RPC failed — regardless of stale positions.
  const hasError = gmx.error !== null && (gmx.status === 'unavailable' || gmx.status === 'error');
  const hasConsistencyWarning = gmx.apiConsistency === 'mismatch';
  const hasStaleError = gmx.error !== null && gmx.status === 'ok' && !hasConsistencyWarning;

  /** Total notional exposure across all open positions */
  const riskSummary = summarizeGmxRisk(gmx.positions);
  const totalExposureUsd = riskSummary.totalExposureUsd;

  /** Elapsed since last success — drives real-time coloring */
  const elapsedMs = gmx.lastSuccessUpdated ? now - gmx.lastSuccessUpdated.getTime() : null;

  const handleRefresh = useCallback(() => {
    gmx.refresh();
  }, [gmx]);

  return (
    <Card className="overflow-hidden border border-border">

      {/* ── Header ── */}
      <div className="flex items-start justify-between px-4 py-2.5 bg-card/50 border-b border-border">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-primary shrink-0" />
            <span className="font-semibold text-sm">온체인 계정 (Read-only · 실제 GMX)</span>

            <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30 font-bold shrink-0">
              SERVER READ-ONLY
            </span>
          </div>
          {/* Data source clarification — always visible */}
          <span className="text-[10px] text-muted-foreground/70 ml-6">
            PAPER/Mock 데이터와 별개 · canonical Arbitrum RPC · 지갑 연결/서명 없음
          </span>
        </div>

        {/* Refresh + live elapsed time */}
        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          {elapsedMs !== null && (
            <span className={cn('text-[10px] font-mono transition-colors', elapsedColor(elapsedMs))}>
              {formatElapsedKo(elapsedMs)}
              {elapsedMs >= 60_000 && (
                <span className="ml-1 font-bold">⚠</span>
              )}
            </span>
          )}
          <Button
            size="sm" variant="ghost"
            className="h-7 w-7 p-0"
            onClick={handleRefresh}
            disabled={gmx.status === 'loading'}
            title="새로고침"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', gmx.status === 'loading' && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="p-4 flex flex-col gap-4">

        {/* ── Server-configured canonical account ── */}
          <>
            {/* ── Diagnostic badge row ── */}
            <div className="flex flex-wrap gap-2">
              <DiagBadge
                icon={Wallet}
                label="계정"
                value="서버 구성 owner"
                ok
              />
              <DiagBadge
                icon={Activity}
                label="체인"
                value="Arbitrum One (42161)"
                ok
              />
              <DiagBadge
                icon={Database}
                label="PositionReader"
                value={
                  gmx.status === 'loading'      ? '조회 중…' :
                  gmx.status === 'ok' ? `정상${gmx.lastFetchMs != null ? ` (${gmx.lastFetchMs}ms)` : ''}` :
                  gmx.status === 'unavailable' ? '실패' :
                  '대기'
                }
                ok={
                  gmx.status === 'unavailable' ? false :
                  gmx.status === 'ok' ? true :
                  undefined
                }
              />
              <DiagBadge
                icon={Database}
                label="GMX API 교차검증"
                value={gmx.apiConsistency ?? '대기'}
                ok={
                  gmx.apiConsistency === 'matched' ? true :
                  gmx.apiConsistency === 'mismatch' || gmx.apiConsistency === 'rpc-unavailable' ? false :
                  undefined
                }
              />
              <DiagBadge
                icon={Clock}
                label="마지막 성공"
                value={gmx.lastSuccessUpdated
                  ? format(gmx.lastSuccessUpdated, 'HH:mm:ss')
                  : '—'}
              />
              {gmx.positions.length > 0 && (
                <DiagBadge
                  icon={Zap}
                  label="총 노출"
                  value={`$${totalExposureUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
                />
              )}
            </div>

            {/* Canonical account balance summary */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-card border border-border">
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">조회 계정</span>
                <span className="font-mono text-xs text-foreground truncate">
                  GMX_WALLET_ADDRESS
                </span>
                <span className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                  <CheckCircle2 className="w-2.5 h-2.5 text-[var(--color-long)]" /> Read-only
                </span>
              </div>
              <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-card border border-border">
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">USDC 잔고</span>
                <span className="font-mono text-sm font-bold text-foreground">
                  {gmx.usdcBalance != null ? `$${gmx.usdcBalance}` : '—'}
                </span>
                <span className="text-[10px] text-muted-foreground">Arbitrum Native USDC</span>
              </div>
              <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-card border border-border">
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">ETH 잔고</span>
                <span className="font-mono text-sm font-bold text-foreground">
                  {gmx.ethBalance != null ? `${gmx.ethBalance} ETH` : '—'}
                </span>
                <span className="text-[10px] text-muted-foreground">가스비용 예비</span>
              </div>
            </div>

            {/* GMX Positions section */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  GMX 오픈 포지션
                  {gmx.status === 'loading' && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                  {gmx.status === 'ok' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30 font-bold">
                      {gmx.positions.length}
                    </span>
                  )}
                </span>
                <span className="text-[10px] text-muted-foreground">PositionReader RPC · 조회 전용</span>
              </div>

              {/* Loading */}
              {gmx.status === 'loading' && gmx.positions.length === 0 && (
                <div className="flex items-center justify-center py-6 text-muted-foreground text-xs gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> 포지션 조회 중…
                </div>
              )}

              {/* Stale data warning (fetch failed but has old data) */}
              {hasStaleError && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-[10px] text-amber-400 mb-2">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                      <span className="font-semibold">마지막 조회 실패</span>
                      {' '}— 아래는 이전 캐시 데이터입니다.{' '}
                      {gmx.error}
                    </span>
                  </div>
                  <Button
                    size="sm" variant="outline"
                    className="h-6 text-[10px] shrink-0 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                    onClick={handleRefresh}
                    disabled={gmx.status === 'loading'}
                  >
                    <RefreshCw className="w-2.5 h-2.5 mr-1" /> 재시도
                  </Button>
                </div>
              )}

              {hasConsistencyWarning && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-[10px] text-amber-400 mb-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    <span className="font-semibold">RPC/API 정합성 불일치</span>
                    {' '}— 온체인 PositionReader 값을 표시하지만 신규 실행 증거로는 사용하지 않습니다. {gmx.error}
                  </span>
                </div>
              )}

              {/* ── 리스크 요약 행 (totalExposure · avgLeverage · nearestLiq) ── */}
              {/* 데이터가 없는 필드는 N/A 표시 — 절대 추정값 사용 안 함 */}
              {gmx.positions.length > 0 && (() => {
                const {
                  averageLeverage,
                  validLeverageCount,
                  nearestLiquidationGapFraction,
                  nearestLiquidationLabel,
                  totalExposureUsd: totalExp,
                } = riskSummary;
                return (
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {/* 총 익스포저 */}
                    <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60">
                      <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">총 익스포저</span>
                      <span className="font-mono text-xs font-bold text-foreground">
                        ${totalExp.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    {/* 평균 레버리지 */}
                    <div className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border border-border bg-card/60">
                      <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">평균 레버리지</span>
                      {averageLeverage != null ? (
                        <>
                          <span className="font-mono text-xs font-bold text-foreground">{averageLeverage.toFixed(1)}×</span>
                          {validLeverageCount < gmx.positions.length && (
                            <span className="text-[9px] text-muted-foreground">{validLeverageCount}/{gmx.positions.length}개 유효</span>
                          )}
                        </>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">N/A</span>
                      )}
                    </div>
                    {/* 최근접 청산거리 */}
                    <div className={`flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border bg-card/60 ${
                      nearestLiquidationGapFraction !== null && nearestLiquidationGapFraction <= 0.05
                        ? 'border-[var(--color-short)]/40 bg-[var(--color-short)]/5'
                        : 'border-border'
                    }`}>
                      <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">최근접 청산거리</span>
                      {nearestLiquidationGapFraction != null ? (
                        <>
                          <span className={`font-mono text-xs font-bold ${
                            nearestLiquidationGapFraction <= 0.05 ? 'text-[var(--color-short)]' : 'text-foreground'
                          }`}>
                            {(nearestLiquidationGapFraction * 100).toFixed(1)}%
                          </span>
                          <span className="text-[9px] text-muted-foreground truncate">{nearestLiquidationLabel}</span>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">N/A</span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* ── 청산가 위험 근접 경고 배너 ── */}
              {gmx.positions.some(p => p.nearLiquidation) && (
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-[var(--color-short)]/40 bg-[var(--color-short)]/8 text-[11px] text-[var(--color-short)] mb-2">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 animate-pulse" />
                  <div>
                    <span className="font-bold">청산가 위험 근접 경고</span>
                    {' '}— 아래 포지션의 청산가가 현재 시장가 대비 5% 이내입니다:{' '}
                    <span className="font-mono font-bold">
                      {gmx.positions
                        .filter(p => p.nearLiquidation)
                        .map(p => `${p.symbol} ${p.direction} (청산: $${p.liquidationPrice?.toLocaleString('en-US', { maximumFractionDigits: 2 })} / 현재: $${p.markPriceUsd?.toLocaleString('en-US', { maximumFractionDigits: 2 })})`)
                        .join(', ')}
                    </span>
                  </div>
                </div>
              )}

              {/* Positions list */}
              {gmx.positions.length > 0 && (
                <div className="divide-y divide-border/60">
                  {gmx.positions.map(p => (
                    <PositionRow key={p.id} pos={p} />
                  ))}
                </div>
              )}

              {/* No positions (after successful load) */}
              {gmx.status === 'ok' && gmx.positions.length === 0 && (
                <div className="flex items-center justify-center py-5 text-muted-foreground text-xs gap-2">
                  <CheckCircle2 className="w-4 h-4 text-muted-foreground/50" />
                  GMX에 열린 포지션 없음
                </div>
              )}

              {/* Canonical RPC unavailable — first-load failure */}
              {hasError && (
                <div className="flex flex-col gap-3 py-3 px-3 rounded-lg bg-card/50 border border-[var(--color-short)]/20">
                  <div className="flex items-start gap-2 text-xs">
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-short)]" />
                    <div className="flex-1 min-w-0">
                      <span className="text-[var(--color-short)] font-semibold">Canonical RPC 조회 실패</span>
                      <p className="text-muted-foreground mt-0.5 break-words">
                        {gmx.error ?? 'GMX V2 PositionReader에 연결할 수 없습니다.'}
                      </p>
                      {gmx.lastSuccessUpdated ? (
                        <p className="text-muted-foreground/70 text-[10px] mt-1 flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          마지막 성공: {format(gmx.lastSuccessUpdated, 'yyyy-MM-dd HH:mm:ss')}
                        </p>
                      ) : (
                        <p className="text-muted-foreground/70 text-[10px] mt-1">
                          이번 세션에서 아직 성공적으로 조회된 데이터 없음
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm" variant="outline"
                    className="h-7 text-xs w-fit gap-1.5"
                    onClick={handleRefresh}
                    disabled={gmx.status === 'loading'}
                  >
                    <RefreshCw className={cn('w-3.5 h-3.5', gmx.status === 'loading' && 'animate-spin')} />
                    다시 조회
                  </Button>
                </div>
              )}

              {/* Data source timestamp — only shown when data was actually fetched successfully */}
              {gmx.lastSuccessUpdated && gmx.positions.length > 0 && (
                <p className="text-[9px] text-muted-foreground/60 mt-3 flex items-center gap-1">
                  <Database className="w-2.5 h-2.5" />
                  Arbitrum PositionReader 기준 · {format(gmx.lastSuccessUpdated, 'yyyy-MM-dd HH:mm:ss')} 조회
                  (30초 캐시)
                </p>
              )}
            </div>

            {/* ── Collapsible diagnostic section ── */}
            <div className="border-t border-border/50 pt-2">
              <button
                onClick={() => setDiagOpen(v => !v)}
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors w-full text-left"
              >
                {diagOpen
                  ? <ChevronUp className="w-3 h-3 shrink-0" />
                  : <ChevronDown className="w-3 h-3 shrink-0" />}
                진단 정보 {diagOpen ? '접기' : '펼치기'}
              </button>

              {diagOpen && (
                <div className="mt-2 flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-secondary/50 border border-border/40 text-[10px] font-mono">
                  <div className="flex justify-between text-muted-foreground">
                    <span>데이터 소스</span>
                    <span className="text-foreground/80 truncate max-w-[60%] text-right" title="Arbitrum RPC → /api/gmx/positions 프록시">
                      Arbitrum RPC · GMX V2 PositionReader
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>마지막 성공</span>
                    <span className={cn('font-semibold', elapsedMs !== null ? elapsedColor(elapsedMs) : 'text-muted-foreground')}>
                      {gmx.lastSuccessUpdated
                        ? `${format(gmx.lastSuccessUpdated, 'yyyy-MM-dd HH:mm:ss')} (${elapsedMs !== null ? formatElapsedKo(elapsedMs) : '—'})`
                        : '이번 세션에 없음'}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>응답 속도</span>
                    <span className="text-foreground/80">
                      {gmx.lastFetchMs != null ? `${gmx.lastFetchMs} ms` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>포지션 수</span>
                    <span className="text-foreground/80">{gmx.positions.length}개</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>총 노출 합계</span>
                    <span className="text-foreground/80">
                      ${totalExposureUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>조회 상태</span>
                    <span className={cn(
                      'font-semibold',
                      gmx.status === 'ok' && !gmx.error ? 'text-[var(--color-long)]' :
                      gmx.status === 'unavailable' || gmx.error ? 'text-[var(--color-short)]' :
                      'text-muted-foreground',
                    )}>
                      {gmx.status}{gmx.error ? ` — ${gmx.error}` : ''}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>폴링 주기</span>
                    <span className="text-foreground/80">30초</span>
                  </div>
                  {(hasError || hasStaleError || hasConsistencyWarning) && (
                    <Button
                      size="sm" variant="outline"
                      className="h-6 text-[10px] w-fit mt-1 gap-1 border-[var(--color-short)]/30 text-[var(--color-short)] hover:bg-[var(--color-short)]/10"
                      onClick={handleRefresh}
                      disabled={gmx.status === 'loading'}
                    >
                      <RefreshCw className={cn('w-2.5 h-2.5', gmx.status === 'loading' && 'animate-spin')} />
                      재조회
                    </Button>
                  )}
                </div>
              )}

              <p className="text-[10px] text-muted-foreground/50 mt-2">
                조회 전용 — 서명·주문·자금 이동 없음. PAPER 대시보드 데이터와 별개의 실제 온체인 데이터.
              </p>
            </div>
          </>
      </div>
    </Card>
  );
}
