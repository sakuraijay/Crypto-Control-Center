import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Activity, FlaskConical, Lock, Wifi, WifiOff } from 'lucide-react';
import { QuickNavigation } from './QuickNavigation';
import { cn } from '@/lib/utils';

type ServerMode = 'PAPER' | 'LIVE_LOCKED' | 'LIVE_TEST' | 'LIVE' | 'UNKNOWN';

interface ServerStatus {
  mode: ServerMode;
  gmxConnected: boolean | null;
  networkChainId: number | null;
}

const UNKNOWN_STATUS: ServerStatus = {
  mode: 'UNKNOWN',
  gmxConnected: null,
  networkChainId: null,
};

function deriveMode(payload: {
  engineMode?: unknown;
  liveExecutionLocked?: unknown;
  liveTestMode?: unknown;
}): ServerMode {
  if (payload.engineMode !== 'PAPER' && payload.engineMode !== 'LIVE') return 'UNKNOWN';
  if (payload.engineMode === 'PAPER') return 'PAPER';
  if (payload.liveExecutionLocked !== false) return 'LIVE_LOCKED';
  if (payload.liveTestMode === true) return 'LIVE_TEST';
  return 'LIVE';
}

function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>(UNKNOWN_STATUS);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/executor/status', { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json() as {
          ok?: boolean;
          engineMode?: unknown;
          liveExecutionLocked?: unknown;
          liveTestMode?: unknown;
          gmxConnected?: unknown;
          networkChainId?: unknown;
        };
        if (cancelled) return;
        if (payload.ok === false) { setStatus(UNKNOWN_STATUS); return; }
        setStatus({
          mode: deriveMode(payload),
          gmxConnected: typeof payload.gmxConnected === 'boolean' ? payload.gmxConnected : null,
          networkChainId: typeof payload.networkChainId === 'number' && Number.isFinite(payload.networkChainId)
            ? payload.networkChainId
            : null,
        });
      } catch {
        if (!cancelled) setStatus(UNKNOWN_STATUS);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}

function ModeBadge({ mode }: { mode: ServerMode }) {
  const common = 'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-[0.08em]';
  switch (mode) {
    case 'PAPER':
      return (
        <div className={cn(common, 'border-[#1b2636] bg-[#0d1d19] text-[#37d99a]')}>
          <Activity className="h-3 w-3" /> PAPER
        </div>
      );
    case 'LIVE_LOCKED':
      return (
        <div className={cn(common, 'border-[#1b2636] bg-[#251218] text-[#ff5c76]')}>
          <Lock className="h-3 w-3" /> LIVE LOCKED
        </div>
      );
    case 'LIVE_TEST':
      return (
        <div className={cn(common, 'border-[#1b2636] bg-[#241c0e] text-[#ffb648]')}>
          <FlaskConical className="h-3 w-3" /> LIVE TEST
        </div>
      );
    case 'LIVE':
      return (
        <div className={cn(common, 'border-[#1b2636] bg-[#251218] text-[#ff5c76]')}>
          LIVE
        </div>
      );
    default:
      return (
        <div className={cn(common, 'border-[#1b2636] bg-[#0d131e] text-[#8e9aaf]')}>
          MODE UNKNOWN
        </div>
      );
  }
}

function RpcBadge({ connected, chainId }: { connected: boolean | null; chainId: number | null }) {
  if (connected === true) {
    return (
      <div className="flex items-center gap-1.5 rounded-full border border-[#1b2636] bg-[#0d1d19] px-2.5 py-1 text-[10px] font-semibold text-[#37d99a]">
        <Wifi className="h-3 w-3" /> GMX RPC Healthy{chainId ? ` · ${chainId}` : ''}
      </div>
    );
  }
  if (connected === false) {
    return (
      <div className="flex items-center gap-1.5 rounded-full border border-[#1b2636] bg-[#251218] px-2.5 py-1 text-[10px] font-semibold text-[#ff5c76]">
        <WifiOff className="h-3 w-3" /> GMX RPC Offline
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-[#1b2636] bg-[#0d131e] px-2.5 py-1 text-[10px] font-semibold text-[#8e9aaf]">
      <WifiOff className="h-3 w-3" /> GMX RPC Unknown
    </div>
  );
}

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  '/': { title: '오버뷰', subtitle: 'Virtual 400' },
  '/activity': { title: '거래 기록', subtitle: 'Virtual 400' },
  '/calendar': { title: '수익 달력', subtitle: 'PAPER · PHT' },
  '/system': { title: '시스템 진단', subtitle: 'Operations' },
  '/standard': { title: 'Standard 계정', subtitle: 'Separate workspace' },
  '/positions': { title: 'Positions', subtitle: 'PAPER positions and authoritative GMX read-only account state' },
  '/watchlist': { title: 'Market Watch', subtitle: 'Opportunity ranking and market condition monitoring' },
  '/strategy': { title: 'Strategy', subtitle: 'Regime-aware strategy controls and bounded risk profiles' },
  '/ai-log': { title: 'AI Decisions', subtitle: 'Decision rationale, shadow strategy evidence and execution gates' },
  '/history': { title: 'History', subtitle: 'Trading events, settlements and system audit trail' },
  '/backtest': { title: 'Backtest', subtitle: 'Offline validation, walk-forward evidence and sensitivity checks' },
  '/settings': { title: 'Settings', subtitle: 'Advanced configuration and protected execution readiness controls' },
};

export function TopBar() {
  const [location] = useLocation();
  const server = useServerStatus();
  const meta = PAGE_META[location] ?? { title: '', subtitle: '' };

  return (
    <header className="ccc-topbar">
      <div className="ccc-breadcrumb"><span>Workspace</span><span>/</span><strong>{meta.title}</strong></div>
      <div className="ccc-topbar-actions"><QuickNavigation /><div className="ccc-topbar-divider" />
        <RpcBadge connected={server.gmxConnected} chainId={server.networkChainId} /><ModeBadge mode={server.mode} />
      </div>
    </header>
  );
}
