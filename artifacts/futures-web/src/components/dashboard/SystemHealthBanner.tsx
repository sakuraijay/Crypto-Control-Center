/**
 * SystemHealthBanner — dismissible warning when the AI engine is paused.
 * Shows only when systemPaused is true or there's an active pause reason.
 */

import { AlertTriangle } from 'lucide-react';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';

export function SystemHealthBanner() {
  const { systemPaused, pauseReason } = useAiEngine();

  if (!systemPaused || !pauseReason) return null;

  return (
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
  );
}
