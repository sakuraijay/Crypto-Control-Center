/**
 * GlobalOfflineBanner — app-wide Executor offline indicator
 *
 * Renders in the Shell layout between TopBar and main content.
 * Visible on every page (Dashboard, Strategy, Positions, History, AI Log, etc.).
 *
 * Thresholds (matching Settings page):
 *   1 failure  → amber 'stale' hint (subtle)
 *   ≥2 failures → amber 'offline' alert (prominent)
 *
 * Does NOT conflict with EmergencyBanner (fixed z-[60] in App.tsx).
 */
import { WifiOff, AlertTriangle } from 'lucide-react';
import { useExecutorOnlineStatus } from '@/hooks/useExecutorHealth';
import { format } from 'date-fns';

export function GlobalOfflineBanner() {
  const { isOffline, isStale, consecutiveFailures, lastSuccessAt } =
    useExecutorOnlineStatus();

  if (!isOffline && !isStale) return null;

  if (isStale) {
    return (
      <div className="flex items-center gap-2 px-6 py-1.5 bg-amber-950/30 border-b border-amber-500/15 text-[11px] text-amber-400/70">
        <AlertTriangle className="w-3 h-3 shrink-0" />
        <span>Executor 응답 지연 — 재시도 중…</span>
      </div>
    );
  }

  // isOffline — ≥2 consecutive failures
  return (
    <div className="flex items-center gap-3 px-6 py-2 bg-amber-950/80 border-b border-amber-500/50 text-xs">
      <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0 animate-pulse" />
      <span className="flex-1">
        <strong className="text-amber-400">Executor 오프라인</strong>
        <span className="text-amber-300/80 ml-2">
          {consecutiveFailures}회 연속 응답 없음 — API 서버 상태를 확인하세요
          {lastSuccessAt && (
            <span className="opacity-70 ml-2">
              · 마지막 성공: {format(lastSuccessAt, 'HH:mm:ss')}
            </span>
          )}
        </span>
      </span>
    </div>
  );
}
