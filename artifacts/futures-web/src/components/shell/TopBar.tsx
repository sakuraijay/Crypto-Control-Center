import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { FlaskConical, Lock } from 'lucide-react';

/**
 * 활성 모드 배지 — **서버 executor 상태**가 유일한 근거.
 * 브라우저 설정값(liveTestMode 등)만으로 LIVE TEST를 표시하지 않는다.
 *  - engineMode=PAPER            → PAPER
 *  - engineMode=LIVE + 잠금       → LIVE LOCKED
 *  - engineMode=LIVE + 잠금해제 + liveTestMode → LIVE TEST
 *  - 상태 조회 실패               → MODE UNKNOWN (추정 금지)
 */
type ServerMode = 'PAPER' | 'LIVE_LOCKED' | 'LIVE_TEST' | 'LIVE' | 'UNKNOWN';

function useServerMode(): ServerMode {
  const [mode, setMode] = useState<ServerMode>('UNKNOWN');

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/executor/status', { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = await res.json() as {
          engineMode?: 'PAPER' | 'LIVE';
          liveExecutionLocked?: boolean;
          liveTestMode?: boolean;
        };
        if (cancelled) return;
        // engineMode가 인식 가능한 값이 아니면 PAPER로 추정하지 않는다
        // (executor 라우트의 예외 fallback은 engineMode 없이 200을 반환할 수 있음)
        if (s.engineMode !== 'PAPER' && s.engineMode !== 'LIVE') setMode('UNKNOWN');
        else if (s.engineMode === 'PAPER') setMode('PAPER');
        else if (s.liveExecutionLocked !== false) setMode('LIVE_LOCKED');
        else if (s.liveTestMode) setMode('LIVE_TEST');
        else setMode('LIVE');
      } catch {
        if (!cancelled) setMode('UNKNOWN');
      }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return mode;
}

function ModeBadge({ mode }: { mode: ServerMode }) {
  switch (mode) {
    case 'PAPER':
      return (
        <div className="px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-bold tracking-widest uppercase">
          PAPER
        </div>
      );
    case 'LIVE_LOCKED':
      return (
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted border border-border text-muted-foreground text-xs font-bold tracking-widest uppercase">
          <Lock className="w-3 h-3" />
          LIVE LOCKED
        </div>
      );
    case 'LIVE_TEST':
      return (
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-bold tracking-widest uppercase">
          <FlaskConical className="w-3 h-3" />
          LIVE TEST
        </div>
      );
    case 'LIVE':
      return (
        <div className="px-3 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-bold tracking-widest uppercase">
          LIVE
        </div>
      );
    default:
      return (
        <div className="px-3 py-1 rounded-full bg-muted border border-border text-muted-foreground text-xs font-bold tracking-widest uppercase">
          MODE UNKNOWN
        </div>
      );
  }
}

export function TopBar() {
  const [location] = useLocation();
  const serverMode = useServerMode();

  const getPageTitle = () => {
    switch (location) {
      case '/': return 'Dashboard';
      case '/positions': return 'Positions';
      case '/watchlist': return 'Watchlist';
      case '/strategy': return 'Strategy Controls';
      case '/history': return 'History & Logs';
      case '/settings': return 'Settings';
      default: return '';
    }
  };

  return (
    <div className="h-16 flex items-center justify-between px-8 border-b border-border bg-background sticky top-0 z-30">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {getPageTitle()}
      </h1>
      <div className="flex items-center gap-4">
        <ModeBadge mode={serverMode} />
      </div>
    </div>
  );
}
