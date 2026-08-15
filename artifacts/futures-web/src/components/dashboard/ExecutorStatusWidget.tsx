/**
 * ExecutorStatusWidget — 대시보드 우측 열용 실행 엔진 상태 위젯
 *
 * 역할:
 *   - Replit 모니터링 상태 (RPC 헬스, 배포 모드, 가동 시간)
 *   - AI 엔진 현재 상태 및 다음 사이클 카운트다운
 *
 * 보안 원칙:
 *   - Replit에는 GMX 개인키·시드문구·signer key가 저장되지 않습니다.
 *   - LIVE 실행은 GMX One-Click 서브계정 구성 후 수행됩니다.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'wouter';
import {
  Server, CheckCircle2, XCircle, Loader2,
  ExternalLink, Cpu, Eye, Clock, Wallet, Key, FlaskConical, WifiOff,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { useWallet } from '@/lib/context/WalletContext';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

// ── Executor health type ──────────────────────────────────────────────────────

interface ExecutorHealth {
  /** Present when the server returned an error payload (HTTP 200 with ok:false) */
  ok?: boolean;
  error?: string;
  gmxConnected: boolean;
  rpcUrl?: string;
  networkChainId?: number;
  deploymentMode?: 'reserved_vm' | 'development';
  uptimeSeconds?: number;
  reconciliation?: { lastAt?: string; mismatchedCount?: number };
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function fmtMs(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatRow({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-medium font-mono', cls)}>{value}</span>
    </div>
  );
}

// ── Main widget ───────────────────────────────────────────────────────────────

// Polling intervals
const POLL_NORMAL_MS  = 30_000;
const POLL_OFFLINE_MS = 60_000;
const OFFLINE_THRESHOLD = 2; // consecutive failures before showing offline

export function ExecutorStatusWidget() {
  const [health, setHealth]       = useState<ExecutorHealth | null>(null);
  const [loading, setLoading]     = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const consecutiveFailures = useRef(0);
  const pollTimer           = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a stable ref to fetchStatus so the self-scheduling closure doesn't go stale
  const fetchRef = useRef<(() => Promise<void>) | null>(null);

  const { currentDecision, stats, nextCycleMs, running, operatingMode } = useAiEngine();
  const wallet = useWallet();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/executor/status');
      // The server always returns HTTP 200 (including error cases).
      // We must inspect the payload: `ok: false` in the body means the executor
      // status could not be read — treat that as a poll failure, not success.
      const data = await res.json() as ExecutorHealth;
      const isPayloadOk = res.ok && data.ok !== false;

      if (isPayloadOk) {
        setHealth(data);
        setLastFetch(new Date());
        consecutiveFailures.current = 0;
        setIsOffline(false);
      } else {
        // HTTP error or {ok:false} payload — stale health data preserved
        consecutiveFailures.current += 1;
        if (consecutiveFailures.current >= OFFLINE_THRESHOLD) setIsOffline(true);
      }
    } catch {
      // Network / JSON parse error — do not rethrow; stale data preserved
      consecutiveFailures.current += 1;
      if (consecutiveFailures.current >= OFFLINE_THRESHOLD) setIsOffline(true);
    }
    setLoading(false);
  }, []);

  // Keep fetchRef up to date
  fetchRef.current = fetchStatus;

  // Self-scheduling poll — backoff to POLL_OFFLINE_MS after ≥ OFFLINE_THRESHOLD failures
  useEffect(() => {
    let mounted = true;

    const run = async () => {
      if (!mounted) return;
      await fetchRef.current?.();
      if (!mounted) return;
      const delay = consecutiveFailures.current >= OFFLINE_THRESHOLD
        ? POLL_OFFLINE_MS
        : POLL_NORMAL_MS;
      pollTimer.current = setTimeout(run, delay);
    };

    void run();

    return () => {
      mounted = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const MODE_BADGE: Record<string, string> = {
    AUTONOMOUS_AI:   'bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/30',
    MANUAL_OVERRIDE: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    RISK_LOCKED:     'bg-[var(--color-short)]/10 text-[var(--color-short)] border-[var(--color-short)]/30',
  };
  const MODE_LABEL: Record<string, string> = {
    AUTONOMOUS_AI: 'AUTONOMOUS AI', MANUAL_OVERRIDE: 'MANUAL', RISK_LOCKED: 'RISK LOCKED',
  };

  return (
    <Card className="overflow-hidden border border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-card/50 border-b border-border">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">실행 엔진</span>
          <span className={cn(
            'text-[9px] px-1.5 py-0.5 rounded-full border font-bold tracking-wider',
            'bg-primary/10 text-primary border-primary/30',
          )}>
            REPLIT
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Offline badge — shown after ≥2 consecutive fetch failures */}
          {isOffline && (
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-[var(--color-short)]/40 bg-[var(--color-short)]/5 text-[var(--color-short)] text-[9px] font-bold">
              <WifiOff className="w-2.5 h-2.5" />
              오프라인
            </div>
          )}
          {health?.uptimeSeconds != null && !isOffline && (
            <span className="text-[10px] text-muted-foreground font-mono">
              ↑ {formatUptime(health.uptimeSeconds)}
            </span>
          )}
          <div className={cn(
            'flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold tracking-wider',
            MODE_BADGE[operatingMode] ?? MODE_BADGE.MANUAL_OVERRIDE,
          )}>
            <div className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              operatingMode === 'AUTONOMOUS_AI'
                ? 'bg-[var(--color-long)] shadow-[0_0_6px_rgba(0,200,83,0.5)]'
                : operatingMode === 'RISK_LOCKED'
                  ? 'bg-[var(--color-short)] animate-pulse'
                  : 'bg-amber-400',
            )} />
            {MODE_LABEL[operatingMode] ?? operatingMode}
          </div>
        </div>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3">
        {/* RPC health */}
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> 상태 로딩 중…
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {/* Row 1: RPC + monitoring */}
            <div className="grid grid-cols-2 gap-2">
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-medium',
                health?.gmxConnected
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : 'border-border bg-card/50 text-muted-foreground',
              )}>
                {health?.gmxConnected ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                Arbitrum RPC
              </div>
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-medium',
                'border-primary/30 bg-primary/5 text-primary',
              )}>
                <Eye className="w-3 h-3" />
                시장 데이터 전용
              </div>
            </div>
            {/* Row 2: Wallet + Subaccount */}
            <div className="grid grid-cols-2 gap-2">
              <div className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-medium',
                wallet.status === 'connected'
                  ? 'border-[var(--color-long)]/30 bg-[var(--color-long)]/5 text-[var(--color-long)]'
                  : wallet.status === 'wrong_network'
                    ? 'border-amber-500/30 bg-amber-500/5 text-amber-400'
                    : wallet.status === 'connecting'
                      ? 'border-primary/30 bg-primary/5 text-primary'
                      : 'border-border bg-card/50 text-muted-foreground',
              )}>
                {wallet.status === 'connected'
                  ? <CheckCircle2 className="w-3 h-3" />
                  : wallet.status === 'connecting'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Wallet className="w-3 h-3" />
                }
                {wallet.status === 'connected'
                  ? `${wallet.address!.slice(0, 6)}…${wallet.address!.slice(-4)}`
                  : wallet.status === 'wrong_network'
                    ? '잘못된 네트워크'
                    : wallet.status === 'connecting'
                      ? '연결 중…'
                      : '지갑 미연결'}
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card/50 text-muted-foreground text-[10px] font-medium">
                <Key className="w-3 h-3" />
                서브계정 미인증
              </div>
            </div>
            {/* Row 3: Execution mode */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/30 bg-blue-500/5 text-blue-400 text-[10px] font-medium">
              <FlaskConical className="w-3 h-3" />
              주문 실행: PAPER ONLY (모의거래)
            </div>
          </div>
        )}

        {/* Deployment mode */}
        {health?.deploymentMode && (
          <div className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-medium',
            health.deploymentMode === 'reserved_vm'
              ? 'border-primary/30 bg-primary/5 text-primary'
              : 'border-border bg-card/50 text-muted-foreground',
          )}>
            <Cpu className="w-3 h-3" />
            {health.deploymentMode === 'reserved_vm' ? 'Reserved VM (always-on)' : 'Development (may sleep)'}
          </div>
        )}

        {/* AI Engine stats */}
        <div className="border-t border-border pt-2 flex flex-col gap-1.5">
          <StatRow
            label="다음 사이클"
            value={
              <span className="flex items-center gap-1">
                {running && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                <Clock className="w-2.5 h-2.5 text-muted-foreground" />
                {running ? '실행 중…' : fmtMs(nextCycleMs)}
              </span>
            }
          />
          <StatRow label="총 사이클" value={stats.totalCycles} />
          {stats.lastCycleAt && (
            <StatRow label="마지막 사이클" value={format(new Date(stats.lastCycleAt), 'HH:mm:ss')} />
          )}
          {currentDecision && (
            <StatRow
              label="현재 상태"
              value={currentDecision.operatingState}
              cls={
                currentDecision.operatingState === 'LONG' || currentDecision.operatingState === 'SPOT'
                  ? 'text-[var(--color-long)]'
                  : currentDecision.operatingState === 'SHORT'
                    ? 'text-[var(--color-short)]'
                    : 'text-muted-foreground'
              }
            />
          )}
        </div>

        {/* Reconciliation info */}
        {health?.reconciliation?.lastAt && (
          <div className="border-t border-border pt-2 flex flex-col gap-1.5">
            <StatRow
              label="마지막 조정"
              value={format(new Date(health.reconciliation.lastAt), 'HH:mm:ss')}
            />
            {health.reconciliation.mismatchedCount != null && health.reconciliation.mismatchedCount > 0 && (
              <StatRow
                label="불일치"
                value={`${health.reconciliation.mismatchedCount}개`}
                cls="text-[var(--color-warning)]"
              />
            )}
          </div>
        )}

        {/* Last fetch / offline state */}
        <div className="text-[9px] text-right">
          {isOffline ? (
            <span className="text-[var(--color-short)]/70">
              상태 조회 실패
              {lastFetch ? ` · 마지막 성공 ${format(lastFetch, 'HH:mm:ss')}` : ''}
               · 60s 재시도 중
            </span>
          ) : lastFetch ? (
            <span className="text-muted-foreground">
              {format(lastFetch, 'HH:mm:ss')} 기준 · 30s 자동 갱신
            </span>
          ) : null}
        </div>

        {/* Settings link */}
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground w-full justify-start">
          <Link href="/settings">
            <ExternalLink className="w-3 h-3 mr-1.5" />
            Engine Settings
          </Link>
        </Button>
      </div>
    </Card>
  );
}
