/**
 * GmxOnchainCard — 실제 GMX 온체인 포지션 + 지갑 잔고 (Read-only)
 *
 * 오퍼레이터가 브라우저 지갑을 연결하면 GMX Synthetics 서브그래프에서
 * 실제 온체인 포지션을 조회해 표시합니다.
 *
 * 보안 원칙:
 *   - 조회 전용. 서명·주문·자금 이동 없음.
 *   - 개인키·시드문구를 수신하거나 저장하지 않음.
 */

import { useCallback } from 'react';
import { Link } from 'wouter';
import {
  Wallet, RefreshCw, ExternalLink, TrendingUp, TrendingDown,
  Loader2, AlertCircle, CheckCircle2, Unplug, Clock,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useWallet } from '@/lib/context/WalletContext';
import { useGmxAccount, type GmxOnchainPosition } from '@/lib/context/GmxAccountContext';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { ko } from 'date-fns/locale';

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({ pos }: { pos: GmxOnchainPosition }) {
  const isLong = pos.direction === 'LONG';
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

      {/* Right: size + collateral + realised PnL */}
      <div className="flex items-center gap-5 shrink-0 text-right">
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

// ── Main card ─────────────────────────────────────────────────────────────────

export function GmxOnchainCard() {
  const wallet   = useWallet();
  const gmx      = useGmxAccount();

  const isConnected = wallet.status === 'connected' && wallet.isArbitrum;
  const isWrongNet  = wallet.status === 'wrong_network';

  const handleRefresh = useCallback(() => {
    gmx.refresh();
  }, [gmx]);

  return (
    <Card className="overflow-hidden border border-border">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-card/50 border-b border-border">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">온체인 계정 (Read-only)</span>

          {/* Connection status badge */}
          {isConnected ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30 font-bold">
              Arbitrum One
            </span>
          ) : isWrongNet ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-amber-500/10 text-amber-400 border-amber-500/30 font-bold">
              WRONG NETWORK
            </span>
          ) : (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border font-bold">
              WALLET NOT CONNECTED
            </span>
          )}
        </div>

        {/* Refresh + last updated */}
        <div className="flex items-center gap-2">
          {gmx.lastUpdated && (
            <span className="text-[10px] text-muted-foreground">
              {formatDistanceToNow(gmx.lastUpdated, { locale: ko, addSuffix: true })} 업데이트
            </span>
          )}
          {isConnected && (
            <Button
              size="sm" variant="ghost"
              className="h-7 w-7 p-0"
              onClick={handleRefresh}
              disabled={gmx.status === 'loading'}
              title="새로고침"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', gmx.status === 'loading' && 'animate-spin')} />
            </Button>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="p-4">

        {/* ── NOT CONNECTED ── */}
        {!isConnected && !isWrongNet && (
          <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
            <Unplug className="w-8 h-8 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">지갑 미연결</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                실제 GMX 계정 잔고·포지션을 조회하려면 Settings에서 브라우저 지갑을 연결하세요.
              </p>
            </div>
            <Link href="/settings">
              <Button size="sm" variant="outline" className="h-7 text-xs">
                Settings → Step 2 <ExternalLink className="w-3 h-3 ml-1.5" />
              </Button>
            </Link>
          </div>
        )}

        {/* ── WRONG NETWORK ── */}
        {isWrongNet && (
          <div className="flex items-center gap-2 py-4 px-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-amber-400">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>MetaMask를 Arbitrum One(Chain 42161)으로 전환하면 데이터를 조회할 수 있습니다.</span>
          </div>
        )}

        {/* ── CONNECTED ── */}
        {isConnected && (
          <div className="flex flex-col gap-4">

            {/* Wallet summary row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-card border border-border">
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">지갑 주소</span>
                <span className="font-mono text-xs text-foreground truncate">
                  {wallet.address
                    ? `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`
                    : '—'}
                </span>
                <span className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                  <CheckCircle2 className="w-2.5 h-2.5 text-[var(--color-long)]" /> Read-only
                </span>
              </div>
              <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-card border border-border">
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">USDC 잔고</span>
                <span className="font-mono text-sm font-bold text-foreground">
                  {wallet.usdcBalance != null ? `$${wallet.usdcBalance}` : '—'}
                </span>
                <span className="text-[10px] text-muted-foreground">Arbitrum Native USDC</span>
              </div>
              <div className="flex flex-col gap-0.5 px-3 py-2.5 rounded-lg bg-card border border-border">
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">ETH 잔고</span>
                <span className="font-mono text-sm font-bold text-foreground">
                  {wallet.ethBalance != null ? `${wallet.ethBalance} ETH` : '—'}
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
                <span className="text-[10px] text-muted-foreground">서브그래프 · 조회 전용</span>
              </div>

              {/* Loading */}
              {gmx.status === 'loading' && gmx.positions.length === 0 && (
                <div className="flex items-center justify-center py-6 text-muted-foreground text-xs gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> 포지션 조회 중…
                </div>
              )}

              {/* Positions list */}
              {gmx.status === 'ok' && gmx.positions.length > 0 && (
                <div className="divide-y divide-border/60">
                  {gmx.positions.map(p => (
                    <PositionRow key={p.id} pos={p} />
                  ))}
                </div>
              )}

              {/* No positions */}
              {gmx.status === 'ok' && gmx.positions.length === 0 && (
                <div className="flex items-center justify-center py-5 text-muted-foreground text-xs gap-2">
                  <CheckCircle2 className="w-4 h-4 text-muted-foreground/50" />
                  GMX에 열린 포지션 없음
                </div>
              )}

              {/* Subgraph unavailable */}
              {gmx.status === 'unavailable' && (
                <div className="flex items-start gap-2 py-3 px-3 rounded-lg bg-card/50 border border-border text-xs text-muted-foreground">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                  <div>
                    <span className="text-amber-400 font-medium">서브그래프 조회 실패</span>
                    <span className="block mt-0.5 text-muted-foreground/70">
                      {gmx.error ?? 'GMX Synthetics 서브그래프에 연결할 수 없습니다.'}
                      {' '}잠시 후 새로고침하거나 지갑 잔고만 확인하세요.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Disclaimer */}
            <p className="text-[10px] text-muted-foreground/60 border-t border-border/50 pt-2">
              서브그래프 데이터는 최대 30~60초 지연될 수 있습니다.
              실제 주문 실행을 위해서는 Settings Step 4(서브계정 승인)를 완료하세요.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
