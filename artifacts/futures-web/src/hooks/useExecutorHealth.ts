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
  /** True while a subaccount revoke session is active — all new orders blocked (4단계) */
  activeRevoke: boolean;
  /** Latest authoritative server snapshot. Null until the first successful GET. */
  snapshot: ExecutorSafetySnapshot | null;
}

export interface ExecutorSafetySnapshot {
  ready?: boolean;
  engineMode?: 'PAPER' | 'LIVE';
  gmxConnected?: boolean;
  rpcConfigured?: boolean;
  networkChainId?: number | null;
  operationalDiagnostics?: {
    flags?: {
      engineMode?: { effective?: string; status?: string };
      autoWorkerLiveEnabled?: { effective?: boolean; status?: string };
      liveTestExecutionLocked?: { effective?: boolean; status?: string };
      relaySubmissionEnabled?: { effective?: boolean; status?: string };
      relaySubmitNetworkEnabled?: { effective?: boolean; status?: string };
      relayMode?: { effective?: string; status?: string };
    };
  };
}

export function isExecutorSafetySnapshot(value: unknown): value is ExecutorSafetySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.ready === 'boolean'
    && (snapshot.engineMode === 'PAPER' || snapshot.engineMode === 'LIVE')
    && typeof snapshot.gmxConnected === 'boolean'
    && typeof snapshot.rpcConfigured === 'boolean'
    && (typeof snapshot.networkChainId === 'number' || snapshot.networkChainId === null);
}

export function useExecutorOnlineStatus(): ExecutorOnlineStatus {
  const [consecutiveFailures, setConsecFails] = useState(0);
  const [lastSuccessAt, setLastSuccessAt]     = useState<Date | null>(null);
  const [activeRevoke, setActiveRevoke]       = useState(false);
  const [snapshot, setSnapshot]               = useState<ExecutorSafetySnapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/executor/status', {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`Executor status HTTP ${res.status}`);
      const json: unknown = await res.json();
      if (!isExecutorSafetySnapshot(json)) {
        throw new Error('Executor status payload failed validation');
      }
      setLastSuccessAt(new Date());
      setConsecFails(0);
      setActiveRevoke((json as ExecutorSafetySnapshot & { activeRevoke?: boolean }).activeRevoke === true);
      setSnapshot(json);
    } catch {
      // A malformed/failed poll invalidates the authoritative evidence
      // immediately; a previous safe response cannot manufacture readiness.
      setSnapshot(null);
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
    activeRevoke,
    snapshot,
  };
}
