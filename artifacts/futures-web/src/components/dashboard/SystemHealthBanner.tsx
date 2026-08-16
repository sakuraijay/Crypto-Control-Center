/**
 * SystemHealthBanner — 대시보드 상단 상태 배너.
 *
 * 두 가지 정보를 표시합니다:
 *   1. LIVE 실행 잠금 상태 — LIVE_EXECUTION_LOCKED=true인 동안 항상 표시
 *   2. AI 엔진 일시 중지 배너 — systemPaused=true일 때만 표시
 */

import { AlertTriangle, Lock } from 'lucide-react';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';

export function SystemHealthBanner() {
  const { systemPaused, pauseReason } = useAiEngine();

  const showPauseBanner = systemPaused && !!pauseReason;
  // LIVE 잠금 배지: 코드 수준 잠금(LIVE_EXECUTION_LOCKED)이 해제되지 않는 한 항상 표시.
  // (구형 브라우저 subaccountConfig 기반 표시는 6E-2 §4에서 제거 — 서버가 authoritative)
  const showLiveLock = true;

  return (
    <div className="flex flex-col gap-2">

      {/* ── LIVE 실행 잠금 배지 ── */}
      {showLiveLock && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/40 bg-card/50 text-xs text-muted-foreground">
          <Lock className="w-3 h-3 shrink-0 text-muted-foreground/70" />
          <span>
            LIVE 실행:{' '}
            {subaccountConfig.status === 'ready'
              ? <span className="text-amber-400/80">준비 완료 — 서브계정 위임 미실행 (잠김)</span>
              : <span>준비 단계 — 서브계정 미설정 (잠김)</span>
            }
          </span>
          <span className="ml-auto font-mono text-[9px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground/50 shrink-0">
            LOCKED
          </span>
        </div>
      )}

      {/* ── AI 엔진 일시 중지 배너 ── */}
      {showPauseBanner && (
        <div className={cn(
          'flex items-start gap-3 px-4 py-3 rounded-xl border text-sm animate-in fade-in slide-in-from-top-1 duration-300',
          'bg-[var(--color-warning)]/10 border-[var(--color-warning)]/40',
        )}>
          <div className="mt-0.5 shrink-0">
            <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-bold text-xs text-[var(--color-warning)]">AI 엔진 일시 중지 — </span>
            <span className="text-xs text-muted-foreground">{pauseReason}</span>
          </div>
        </div>
      )}

    </div>
  );
}
