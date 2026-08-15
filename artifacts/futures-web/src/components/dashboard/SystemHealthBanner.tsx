/**
 * SystemHealthBanner — dismissible warning when execution connectivity is degraded.
 *
 * In LIVE_TRADING mode: fail-closed — no new live orders will be queued.
 * In other modes:       informational — paper trades continue locally.
 *
 * Works for both Internal Replit Executor and External VPS modes.
 */

import { WifiOff, AlertTriangle, X } from 'lucide-react';
import { useVpsContext } from '@/lib/context/VpsContext';
import { useAppContext } from '@/lib/context/AppContext';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';

export function SystemHealthBanner() {
  const { connectionStatus, connectionHealthEvent, dismissHealthEvent, config, executorMode } = useVpsContext();
  const { engineState } = useAppContext();
  const { systemPaused, pauseReason } = useAiEngine();

  const isLive       = engineState === 'LIVE_TRADING';
  const isDown       = connectionStatus === 'disconnected' || connectionStatus === 'error';
  const isError      = connectionStatus === 'error';
  // Internal executor is always "configured" — no host needed
  const isUnconfigured = executorMode === 'external' && !config.host.trim();

  // Nothing to show when executor is healthy, no active event, and engine not paused
  if (!isDown && !connectionHealthEvent && !systemPaused) return null;
  // Skip if external VPS isn't configured and engine is not paused
  if (isUnconfigured && !systemPaused) return null;

  const executorLabel = executorMode === 'internal' ? 'Internal Executor' : 'External VPS';

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 rounded-xl border text-sm animate-in fade-in slide-in-from-top-1 duration-300',
        isLive
          ? 'bg-[var(--color-short)]/10 border-[var(--color-short)]/40'
          : 'bg-[var(--color-warning)]/10 border-[var(--color-warning)]/40',
      )}
    >
      {/* Icon */}
      <div className="mt-0.5 shrink-0">
        {isDown
          ? <WifiOff className={cn('w-4 h-4 animate-pulse', isLive ? 'text-[var(--color-short)]' : 'text-[var(--color-warning)]')} />
          : <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] animate-pulse" />
        }
      </div>

      {/* Message */}
      <div className="flex-1 min-w-0">
        <span className={cn(
          'font-bold text-xs',
          isLive ? 'text-[var(--color-short)]' : 'text-[var(--color-warning)]',
        )}>
          {isLive
            ? (isDown ? 'FAIL-CLOSED — LIVE MODE' : 'AI PAUSED — LIVE MODE')
            : (isError ? `${executorLabel.toUpperCase()} ERROR` : `${executorLabel.toUpperCase()} OFFLINE`)
          }
          {' — '}
        </span>
        <span className="text-xs text-muted-foreground">
          {systemPaused && pauseReason
            ? pauseReason
            : isLive
              ? `No new live orders will be queued until ${executorLabel} reconnects. Open positions continue to be tracked locally.`
              : `Paper trading continues locally. AI decisions are recorded. Reconnect ${executorLabel} to enable live order forwarding.`
          }
        </span>
        {isUnconfigured && (
          <span className="block text-[10px] text-muted-foreground/70 mt-0.5">
            → Configure External VPS host in Settings → Advanced to enable connectivity monitoring.
          </span>
        )}
      </div>

      {/* Dismiss button (only for transient events, not persistent down state) */}
      {connectionHealthEvent && !isDown && (
        <button
          onClick={dismissHealthEvent}
          className="shrink-0 p-1 rounded-md hover:bg-white/10 transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
