/**
 * VpsContext — web
 *
 * The private VPS is the 24/7 trading authority. This client is a monitoring
 * and control interface only. The VPS continues strategy evaluation, position
 * monitoring, TP/SL/trailing-stop management, and (when armed) autonomous
 * entries even when every client app is closed.
 *
 * States
 *   OFF          VPS not configured or unreachable
 *   ARMED        VPS connected + unattended trading authorised; awaiting cycle
 *   RECONCILING  VPS reconnected; reconciling live positions with GMX V2
 *   RUNNING      VPS actively executing strategy cycles
 *   RISK_LOCKED  VPS paused by risk engine (drawdown / daily loss / etc.)
 */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode,
} from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type VpsEngineState = 'OFF' | 'ARMED' | 'RECONCILING' | 'RUNNING' | 'RISK_LOCKED';
export type VpsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Operating mode — the user-facing representation of what the system is doing.
 *   AUTONOMOUS_AI   — VPS AI is selecting symbols, deciding direction, sizing
 *                     positions and managing TP/SL/trailing-stops 24/7.
 *                     No per-trade confirmation required.
 *   MANUAL_OVERRIDE — AI is paused; user places trades manually.
 *   RISK_LOCKED     — Deterministic risk controls vetoed all activity.
 */
export type OperatingMode = 'AUTONOMOUS_AI' | 'MANUAL_OVERRIDE' | 'RISK_LOCKED';

/** Single AI decision record from the VPS */
export interface AiDecision {
  id: number;
  ts: string;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE' | 'CLOSE' | 'REVERSE';
  confidence: number;  // 0.0–1.0
  rationale: string;
  strategy: string;
  entryPrice: number | null;
  exitPrice: number | null;
  size: number | null;
  riskResult: 'APPROVED' | 'VETOED' | 'MODIFIED';
  riskNote: string | null;
  executionOutcome: 'FILLED' | 'REJECTED' | 'PENDING' | 'CANCELLED' | 'SIMULATED';
  pnl: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AiDecisionStats {
  today: number;
  todayApproved: number;
  todayVetoed: number;
  todayFilled: number;
  avgConfidence: number;
}

/** Derive operating mode from VPS engine state + armed flag */
export function deriveOperatingMode(state: VpsEngineState, armed: boolean): OperatingMode {
  if (state === 'RISK_LOCKED') return 'RISK_LOCKED';
  if ((state === 'RUNNING' || state === 'ARMED') && armed) return 'AUTONOMOUS_AI';
  return 'MANUAL_OVERRIDE';
}

export interface VpsConfig {
  host: string;
  port: string;
  useSSL: boolean;
  /** Optional human label for the active GMX subaccount (informational only) */
  subaccountLabel?: string;
}

export interface ReconciliationInfo {
  status: 'idle' | 'in_progress' | 'complete' | 'failed';
  matchedPositions: number;
  totalPositions: number;
  lastAt: string | null;
}

export interface SystemHealth {
  lastHeartbeat: string | null;
  heartbeatLatencyMs: number | null;
  lastMarketUpdate: string | null;
  lastUserStream: string | null;
  lastStrategyCycle: string | null;
  lastRestart: string | null;
  uptimeSeconds: number | null;
  reconciliation: ReconciliationInfo;
  // GMX connection status (replaces binanceConnected)
  gmxConnected: boolean;
  walletAddress: string | null;
  subaccountAddress: string | null;
  subaccountExpiresAt: string | null;
  subaccountActionsRemaining: number | null;
  networkChainId: number;
  strategyVersion: string | null;
  riskLock: { reason: string; since: string } | null;
  vpsReachable: boolean;
}

/** In-app connection health event (web doesn't have push — shown as a dismissible banner) */
export interface ConnectionHealthEvent {
  type: 'down' | 'degraded' | 'recovered';
  message: string;
  at: Date;
}

interface VpsContextType {
  /** Persisted connection config */
  config: VpsConfig;
  /** Current VPS engine state */
  vpsState: VpsEngineState;
  /** High-level operating mode (derived from vpsState + unattendedArmed) */
  operatingMode: OperatingMode;
  /** Client ↔ API-server connection */
  connectionStatus: VpsConnectionStatus;
  connectionError: string;
  /** Unattended trading authorised flag (local — also reflected in vpsState) */
  unattendedArmed: boolean;
  /** System health telemetry from VPS */
  health: SystemHealth;
  /** AI decision log (most recent first) */
  aiDecisions: AiDecision[];
  /** Today's AI decision stats */
  aiStats: AiDecisionStats;
  /**
   * Most recent connection health event — shown as a dismissible banner.
   * null when no event has fired or the last one was dismissed.
   */
  connectionHealthEvent: ConnectionHealthEvent | null;
  dismissHealthEvent: () => void;
  /** Save config and immediately re-poll */
  saveConfig: (c: VpsConfig) => void;
  /** Test connectivity to VPS (one-shot) */
  testConnection: () => Promise<void>;
  disconnect: () => void;
  /** Arm / disarm unattended autonomous trading on VPS */
  armUnattended: () => Promise<{ ok: boolean; error?: string }>;
  disarmUnattended: () => Promise<{ ok: boolean; error?: string }>;
  /** Refresh AI decision log from API server */
  fetchAiDecisions: () => Promise<void>;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: VpsConfig = { host: '', port: '8080', useSSL: true };

const EMPTY_HEALTH: SystemHealth = {
  lastHeartbeat: null,
  heartbeatLatencyMs: null,
  lastMarketUpdate: null,
  lastUserStream: null,
  lastStrategyCycle: null,
  lastRestart: null,
  uptimeSeconds: null,
  reconciliation: { status: 'idle', matchedPositions: 0, totalPositions: 0, lastAt: null },
  // GMX
  gmxConnected: false,
  walletAddress: null,
  subaccountAddress: null,
  subaccountExpiresAt: null,
  subaccountActionsRemaining: null,
  networkChainId: 42161,
  strategyVersion: null,
  riskLock: null,
  vpsReachable: false,
};

const POLL_INTERVAL_MS = 30_000; // poll VPS status every 30 s
const LOCAL_STORAGE_KEY = 'futures_vps_config';

function loadConfig(): VpsConfig {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as VpsConfig) : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

const VpsContext = createContext<VpsContextType | undefined>(undefined);

const EMPTY_AI_STATS: AiDecisionStats = {
  today: 0, todayApproved: 0, todayVetoed: 0, todayFilled: 0, avgConfidence: 0,
};

export function VpsProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<VpsConfig>(loadConfig);
  const [vpsState, setVpsState] = useState<VpsEngineState>('OFF');
  const [connectionStatus, setConnectionStatus] = useState<VpsConnectionStatus>('disconnected');
  const [connectionError, setConnectionError] = useState('');
  const [unattendedArmed, setUnattendedArmed] = useState(false);
  const [health, setHealth] = useState<SystemHealth>(EMPTY_HEALTH);
  const [aiDecisions, setAiDecisions] = useState<AiDecision[]>([]);
  const [aiStats, setAiStats] = useState<AiDecisionStats>(EMPTY_AI_STATS);
  const [connectionHealthEvent, setConnectionHealthEvent] = useState<ConnectionHealthEvent | null>(null);

  const pollingRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const configRef      = useRef(config);
  configRef.current    = config;

  // ── Health-transition tracking ──────────────────────────────────────────────
  const prevStatusRef      = useRef<VpsConnectionStatus>('disconnected');
  const prevReachableRef   = useRef<boolean>(false);
  const prevLastRestartRef = useRef<string | null>(null);
  const errorStreakRef     = useRef(0);

  const dismissHealthEvent = useCallback(() => setConnectionHealthEvent(null), []);

  const operatingMode = deriveOperatingMode(vpsState, unattendedArmed);

  // ── Health-event emitter (web in-app banner, no push) ──────────────────────
  const emitHealthEvent = useCallback((
    newStatus: VpsConnectionStatus,
    newReachable: boolean,
    newLastRestart: string | null,
  ) => {
    const prev        = prevStatusRef.current;
    const prevReach   = prevReachableRef.current;
    const prevRestart = prevLastRestartRef.current;

    // VPS restarted
    if (newLastRestart && newLastRestart !== prevRestart && prevRestart !== null) {
      setConnectionHealthEvent({
        type: 'recovered',
        message: `VPS restarted at ${new Date(newLastRestart).toLocaleTimeString()}. Verify arm/disarm state.`,
        at: new Date(),
      });
    }

    // Went down (debounce: require 2 consecutive errors)
    if (newStatus === 'error' && prev !== 'error') {
      errorStreakRef.current += 1;
      if (errorStreakRef.current >= 2) {
        setConnectionHealthEvent({
          type: 'down',
          message: !newReachable
            ? 'VPS is unreachable. Check VPS power, network, and firewall settings.'
            : 'API server cannot reach VPS. Verify VPS host/port in Settings.',
          at: new Date(),
        });
      }
    } else if (newStatus === 'error') {
      errorStreakRef.current += 1;
    } else {
      errorStreakRef.current = 0;
    }

    // Recovered
    if (newStatus === 'connected' && prev === 'error') {
      setConnectionHealthEvent({ type: 'recovered', message: 'VPS connection restored.', at: new Date() });
    }

    // Degraded: API up but VPS unreachable
    if (newStatus === 'connected' && !newReachable && prevReach) {
      setConnectionHealthEvent({
        type: 'degraded',
        message: 'API server is up but VPS is unreachable. Live trading is paused.',
        at: new Date(),
      });
    }

    prevStatusRef.current      = newStatus;
    prevReachableRef.current   = newReachable;
    prevLastRestartRef.current = newLastRestart;
  }, []);

  // ── Poll VPS status via API server proxy ──────────────────────────────────
  const pollStatus = useCallback(async () => {
    const cfg = configRef.current;
    if (!cfg.host.trim()) {
      setVpsState('OFF');
      setConnectionStatus('disconnected');
      setHealth(EMPTY_HEALTH);
      prevStatusRef.current    = 'disconnected';
      errorStreakRef.current   = 0;
      return;
    }

    try {
      const params = new URLSearchParams({
        host: cfg.host,
        port: cfg.port,
        ssl: String(cfg.useSSL),
      });
      const res = await fetch(`/api-server/api/vps/status?${params}`, {
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) throw new Error(`API ${res.status}`);

      const data = await res.json() as {
        state?: string;
        unattendedArmed?: boolean;
        vpsReachable?: boolean;
        lastHeartbeat?: string | null;
        heartbeatLatencyMs?: number | null;
        lastMarketUpdate?: string | null;
        lastUserStream?: string | null;
        lastStrategyCycle?: string | null;
        lastRestart?: string | null;
        uptimeSeconds?: number | null;
        reconciliation?: ReconciliationInfo;
        gmxConnected?: boolean;
        walletAddress?: string | null;
        subaccountAddress?: string | null;
        subaccountExpiresAt?: string | null;
        subaccountActionsRemaining?: number | null;
        networkChainId?: number;
        strategyVersion?: string | null;
        riskLock?: { reason: string; since: string } | null;
      };

      const newStatus: VpsConnectionStatus = data.vpsReachable ? 'connected' : 'error';
      const newReachable  = data.vpsReachable ?? false;
      const newLastRestart = data.lastRestart ?? null;

      setVpsState((data.state as VpsEngineState) ?? 'OFF');
      setUnattendedArmed(data.unattendedArmed ?? false);
      setConnectionStatus(newStatus);
      setConnectionError(newReachable ? '' : 'VPS unreachable');

      setHealth({
        lastHeartbeat:      data.lastHeartbeat ?? null,
        heartbeatLatencyMs: data.heartbeatLatencyMs ?? null,
        lastMarketUpdate:   data.lastMarketUpdate ?? null,
        lastUserStream:     data.lastUserStream ?? null,
        lastStrategyCycle:  data.lastStrategyCycle ?? null,
        lastRestart:        newLastRestart,
        uptimeSeconds:      data.uptimeSeconds ?? null,
        reconciliation:              data.reconciliation ?? EMPTY_HEALTH.reconciliation,
        gmxConnected:                data.gmxConnected ?? false,
        walletAddress:               data.walletAddress ?? null,
        subaccountAddress:           data.subaccountAddress ?? null,
        subaccountExpiresAt:         data.subaccountExpiresAt ?? null,
        subaccountActionsRemaining:  data.subaccountActionsRemaining ?? null,
        networkChainId:              data.networkChainId ?? 42161,
        strategyVersion:             data.strategyVersion ?? null,
        riskLock:                    data.riskLock ?? null,
        vpsReachable:                newReachable,
      });

      emitHealthEvent(newStatus, newReachable, newLastRestart);
    } catch {
      if (cfg.host.trim()) {
        const newStatus: VpsConnectionStatus = 'error';
        setConnectionStatus(newStatus);
        setConnectionError('Cannot reach API server');
        emitHealthEvent(newStatus, false, prevLastRestartRef.current);
      }
    }
  }, [emitHealthEvent]);

  // ── Start / restart polling whenever config.host changes ─────────────────
  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    if (!config.host.trim()) {
      setVpsState('OFF');
      setConnectionStatus('disconnected');
      setConnectionError('');
      setHealth(EMPTY_HEALTH);
      prevStatusRef.current    = 'disconnected';
      prevReachableRef.current = false;
      errorStreakRef.current   = 0;
      return;
    }

    // Reset tracking when host changes to avoid false alerts on reconfigure
    prevStatusRef.current    = 'disconnected';
    prevReachableRef.current = false;
    errorStreakRef.current   = 0;

    pollStatus(); // immediate first call
    pollingRef.current = setInterval(pollStatus, POLL_INTERVAL_MS);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [config.host, pollStatus]);

  // ── saveConfig ────────────────────────────────────────────────────────────
  const saveConfig = useCallback((c: VpsConfig) => {
    setConfig(c);
    configRef.current = c;
    try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(c)); } catch { /* noop */ }
    setConnectionStatus('disconnected');
    setConnectionError('');
    setVpsState('OFF');
    setHealth(EMPTY_HEALTH);
  }, []);

  // ── testConnection (one-shot) ─────────────────────────────────────────────
  const testConnection = useCallback(async () => {
    setConnectionStatus('connecting');
    setConnectionError('');
    // Reset tracking so first result fires fresh alerts
    prevStatusRef.current    = 'disconnected';
    prevReachableRef.current = false;
    errorStreakRef.current   = 0;
    await pollStatus();
  }, [pollStatus]);

  // ── disconnect ────────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    setConnectionStatus('disconnected');
    setConnectionError('');
    setVpsState('OFF');
    setHealth(EMPTY_HEALTH);
    prevStatusRef.current    = 'disconnected';
    prevReachableRef.current = false;
    errorStreakRef.current   = 0;
  }, []);

  // ── fetchAiDecisions ─────────────────────────────────────────────────────
  const fetchAiDecisions = useCallback(async () => {
    try {
      const res = await fetch('/api-server/api/ai/decisions?limit=200', {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return;
      const data = await res.json() as { decisions: AiDecision[]; stats: AiDecisionStats };
      setAiDecisions(data.decisions ?? []);
      setAiStats(data.stats ?? EMPTY_AI_STATS);
    } catch { /* noop */ }
  }, []);

  // ── armUnattended ─────────────────────────────────────────────────────────
  const armUnattended = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const cfg = configRef.current;
    if (!cfg.host.trim()) return { ok: false, error: 'VPS host not configured' };

    try {
      const res = await fetch('/api-server/api/vps/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: cfg.host, port: cfg.port, ssl: cfg.useSSL }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: e.error ?? `HTTP ${res.status}` };
      }

      // Refresh status after arming
      await pollStatus();
      setUnattendedArmed(true);
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: (e as Error).message };
    }
  }, [pollStatus]);

  // ── disarmUnattended ──────────────────────────────────────────────────────
  const disarmUnattended = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const cfg = configRef.current;
    if (!cfg.host.trim()) return { ok: false, error: 'VPS host not configured' };

    try {
      const res = await fetch('/api-server/api/vps/disarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: cfg.host, port: cfg.port, ssl: cfg.useSSL }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: e.error ?? `HTTP ${res.status}` };
      }

      await pollStatus();
      setUnattendedArmed(false);
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: (e as Error).message };
    }
  }, [pollStatus]);

  return (
    <VpsContext.Provider value={{
      config, vpsState, operatingMode, connectionStatus, connectionError,
      unattendedArmed, health,
      aiDecisions, aiStats,
      connectionHealthEvent, dismissHealthEvent,
      saveConfig, testConnection, disconnect,
      armUnattended, disarmUnattended,
      fetchAiDecisions,
    }}>
      {children}
    </VpsContext.Provider>
  );
}

export function useVpsContext() {
  const ctx = useContext(VpsContext);
  if (!ctx) throw new Error('useVpsContext must be used within VpsProvider');
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}

export const VPS_STATE_LABELS: Record<VpsEngineState, string> = {
  OFF:          'OFF',
  ARMED:        'ARMED',
  RECONCILING:  'RECONCILING',
  RUNNING:      'RUNNING',
  RISK_LOCKED:  'RISK LOCKED',
};
