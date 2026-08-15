/**
 * useExecutorOnlineStatus — shared Executor health polling hook
 *
 * Polls /api/executor/status every 30s and exposes online/offline state.
 * Used by GlobalOfflineBanner (all pages) and Settings (detailed view).
 * OFFLINE_THRESHOLD=2: 1 transient failure → 'stale'; ≥2 → 'offline'.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export const EXECUTOR_OFFLINE_THRESHOLD = 2;
const POLL_MS = 30_000;

export interface ExecutorOnlineStatus {
  /** True after ≥2 consecutive /api/executor/status failures */
  isOffline: boolean;
  /** True after exactly 1 failure (warning, not yet offline) */
  isStale: boolean;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
}

export function useExecutorOnlineStatus(): ExecutorOnlineStatus {
  const [consecutiveFailures, setConsecFails] = useState(0);
  const [lastSuccessAt, setLastSuccessAt]     = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/executor/status', {
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        setLastSuccessAt(new Date());
        setConsecFails(0);
      } else {
        setConsecFails(c => c + 1);
      }
    } catch {
      setConsecFails(c => c + 1);
    }
  }, []);

  useEffect(() => {
    void poll();
    timerRef.current = setInterval(() => void poll(), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll]);

  return {
    isOffline:           consecutiveFailures >= EXECUTOR_OFFLINE_THRESHOLD,
    isStale:             consecutiveFailures === 1,
    consecutiveFailures,
    lastSuccessAt,
  };
}
