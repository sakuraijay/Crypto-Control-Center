/**
 * VpsContext — web
 *
 * Manages the execution engine connection: either the built-in Replit Internal
 * Executor (default) or an optional user-hosted External VPS.
 *
 * Executor modes
 *   internal  — Replit Reserved VM hosts the GMX execution worker; no external host needed.
 *               This is the default and the recommended mode for 24/7 autonomous operation.
 *   external  — User-hosted VPS holds the GMX One-Click subaccount key.
 *               Legacy mode; kept for advanced operators.
 *
 * Connection states
 *   disconnected  — not yet connected / not configured
 *   connecting    — test/initial connect in progress
 *   connected     — executor is reachable
 *   error         — executor unreachable or returned an error
 *
 * Engine states
 *   OFF           — executor not configured or unreachable
 *   ARMED         — executor connected; unattended trading authorised
 *   RECONCILING   — reconnected; reconciling live positions with GMX V2
 *   RUNNING       — actively executing strategy cycles
 *   RISK_LOCKED   — paused by risk engine
 *
 * SECURITY: No private keys are ever returned to clients. Subaccount data is
 * read-only metadata (address, expiry, quota) only.
 */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode,
} from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type VpsEngineState   = 'OFF' | 'ARMED' | 'RECONCILING' | 'RUNNING' | 'RISK_LOCKED';
export type VpsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ExecutorMode     = 'internal' | 'external';

/**
 * High-level operating mode.
 *   AUTONOMOUS_AI   — AI independently selects symbols, sizes positions, manages TP/SL 24/7
 *   MANUAL_OVERRIDE — AI paused; user places trades manually
 *   RISK_LOCKED     — deterministic risk controls vetoed all activity
 */
export type OperatingMode = 'AUTONOMOUS_AI' | 'MANUAL_OVERRIDE' | 'RISK_LOCKED';

/** Single AI decision record */
export interface AiDecision {
  id: number;
  ts: string;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE' | 'CLOSE' | 'REVERSE';
  confidence: number;
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

export function deriveOperatingMode(state: VpsEngineState, armed: boolean): OperatingMode {
  if (state === 'RISK_LOCKED') return 'RISK_LOCKED';
  if ((state === 'RUNNING' || state === 'ARMED') && armed) return 'AUTONOMOUS_AI';
  return 'MANUAL_OVERRIDE';
}

export interface VpsConfig {
  host: string;
  port: string;
  useSSL: boolean;
  /** Optional human label for the active GMX subaccount (display only, no key data) */
  subaccountLabel?: string;
  /**
   * Execution target:
   *   'internal' — Replit-hosted executor (default; no host/port config needed)
   *   'external' — user-hosted VPS (requires host + port + ssl)
   */
  executorMode: ExecutorMode;
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

export interface ConnectionHealthEvent {
  type: 'down' | 'degraded' | 'recovered';
  message: string;
  at: Date;
}

interface VpsContextType {
  config: VpsConfig;
  vpsState: VpsEngineState;
  operatingMode: OperatingMode;
  connectionStatus: VpsConnectionStatus;
  connectionError: string;
  unattendedArmed: boolean;
  health: SystemHealth;
  aiDecisions: AiDecision[];
  aiStats: AiDecisionStats;
  connectionHealthEvent: ConnectionHealthEvent | null;
  dismissHealthEvent: () => void;
  saveConfig: (c: VpsConfig) => void;
  testConnection: () => Promise<void>;
  disconnect: () => void;
  armUnattended: () => Promise<{ ok: boolean; error?: string }>;
  disarmUnattended: () => Promise<{ ok: boolean; error?: string }>;
  fetchAiDecisions: () => Promise<void>;
  /** Active executor mode — 'internal' = Replit executor, 'external' = user VPS */
  executorMode: ExecutorMode;
  /** Switch executor mode (persisted to localStorage) */
  setExecutorMode: (mode: ExecutorMode) => void;
  /** True when internal executor is ready (always true — simulates when signer unconfigured) */
  internalReady: boolean;
  /** True when GMX_SIGNER_KEY env var is set on the server (real orders will be placed) */
  internalSignerConfigured: boolean;
  /** 'reserved_vm' = always-on; 'development' = may sleep */
  internalDeploymentMode: 'reserved_vm' | 'development' | null;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: VpsConfig = {
  host:         '',
  port:         '8080',
  useSSL:       true,
  executorMode: 'internal',
};

const EMPTY_HEALTH: SystemHealth = {
  lastHeartbeat: null, heartbeatLatencyMs: null, lastMarketUpdate: null,
  lastUserStream: null, lastStrategyCycle: null, lastRestart: null,
  uptimeSeconds: null,
  reconciliation: { status: 'idle', matchedPositions: 0, totalPositions: 0, lastAt: null },
  gmxConnected: false, walletAddress: null, subaccountAddress: null,
  subaccountExpiresAt: null, subaccountActionsRemaining: null, networkChainId: 42161,
  strategyVersion: null, riskLock: null, vpsReachable: false,
};

const EMPTY_AI_STATS: AiDecisionStats = {
  today: 0, todayApproved: 0, todayVetoed: 0, todayFilled: 0, avgConfidence: 0,
};

const POLL_INTERVAL_MS   = 30_000;
const TIMEOUT_MS         = 8_000;
const LOCAL_STORAGE_KEY  = 'futures_vps_config';

function loadConfig(): VpsConfig {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<VpsConfig>;
    return {
      host:            parsed.host            ?? '',
      port:            parsed.port            ?? '8080',
      useSSL:          parsed.useSSL          ?? true,
      subaccountLabel: parsed.subaccountLabel,
      // Migration: existing configs without executorMode default to 'internal'
      executorMode:    parsed.executorMode    ?? 'internal',
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

const VpsContext = createContext<VpsContextType | undefined>(undefined);

export function VpsProvider({ children }: { children: ReactNode }) {
  const [config, setConfig]               = useState<VpsConfig>(loadConfig);
  const [vpsState, setVpsState]           = useState<VpsEngineState>('OFF');
  const [connectionStatus, setConnectionStatus] = useState<VpsConnectionStatus>('disconnected');
  const [connectionError, setConnectionError]   = useState('');
  const [unattendedArmed, setUnattendedArmed]   = useState(false);
  const [health, setHealth]               = useState<SystemHealth>(EMPTY_HEALTH);
  const [aiDecisions, setAiDecisions]     = useState<AiDecision[]>([]);
  const [aiStats, setAiStats]             = useState<AiDecisionStats>(EMPTY_AI_STATS);
  const [connectionHealthEvent, setConnectionHealthEvent] = useState<ConnectionHealthEvent | null>(null);

  // Internal executor state
  const [internalReady, setInternalReady]                       = useState(false);
  const [internalSignerConfigured, setInternalSignerConfigured] = useState(false);
  const [internalDeploymentMode, setInternalDeploymentMode]     = useState<'reserved_vm' | 'development' | null>(null);

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

  // ── Health-event emitter ───────────────────────────────────────────────────
  const emitHealthEvent = useCallback((
    newStatus: VpsConnectionStatus,
    newReachable: boolean,
    newLastRestart: string | null,
  ) => {
    const prev        = prevStatusRef.current;
    const prevReach   = prevReachableRef.current;
    const prevRestart = prevLastRestartRef.current;

    if (newLastRestart && newLastRestart !== prevRestart && prevRestart !== null) {
      const mode = configRef.current.executorMode;
      setConnectionHealthEvent({
        type: 'recovered',
        message: `${mode === 'internal' ? 'Executor' : 'VPS'} restarted at ${new Date(newLastRestart).toLocaleTimeString()}. Verify arm/disarm state.`,
        at: new Date(),
      });
    }

    if (newStatus === 'error' && prev !== 'error') {
      errorStreakRef.current += 1;
      if (errorStreakRef.current >= 2) {
        const mode = configRef.current.executorMode;
        setConnectionHealthEvent({
          type: 'down',
          message: mode === 'internal'
            ? 'Internal Executor is unreachable. Check API server status.'
            : (!newReachable
              ? 'VPS is unreachable. Check VPS power, network, and firewall settings.'
              : 'API server cannot reach VPS. Verify VPS host/port in Settings.'),
          at: new Date(),
        });
      }
    } else if (newStatus === 'error') {
      errorStreakRef.current += 1;
    } else {
      errorStreakRef.current = 0;
    }

    if (newStatus === 'connected' && prev === 'error') {
      const mode = configRef.current.executorMode;
      setConnectionHealthEvent({
        type: 'recovered',
        message: `${mode === 'internal' ? 'Internal Executor' : 'VPS'} connection restored.`,
        at: new Date(),
      });
    }

    if (newStatus === 'connected' && !newReachable && prevReach) {
      setConnectionHealthEvent({
        type: 'degraded',
        message: 'API server is up but executor is unreachable. Live trading is paused.',
        at: new Date(),
      });
    }

    prevStatusRef.current      = newStatus;
    prevReachableRef.current   = newReachable;
    prevLastRestartRef.current = newLastRestart;
  }, []);

  // ── Poll status (branches on executorMode) ────────────────────────────────
  const pollStatus = useCallback(async () => {
    const cfg = configRef.current;

    // ── Internal Replit Executor ─────────────────────────────────────────────
    if (cfg.executorMode === 'internal') {
      try {
        const res = await fetch('/api-server/api/executor/status', {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const data = await res.json() as {
          ready: boolean;
          signerConfigured: boolean;
          gmxRpcHealthy: boolean;
          deploymentMode: 'reserved_vm' | 'development';
          walletAddress: string | null;
          subaccountAddress: string | null;
          uptimeMs: number;
          startedAt: string;
          lastRpcCheckAt: string | null;
        };

        setInternalReady(data.ready ?? true);
        setInternalSignerConfigured(data.signerConfigured ?? false);
        setInternalDeploymentMode(data.deploymentMode ?? 'development');

        setConnectionStatus('connected');
        setConnectionError('');
        setVpsState(data.ready ? 'ARMED' : 'OFF');
        setUnattendedArmed(data.ready ?? false);

        setHealth({
          lastHeartbeat:              data.lastRpcCheckAt,
          heartbeatLatencyMs:         null,
          lastMarketUpdate:            null,
          lastUserStream:              null,
          lastStrategyCycle:           null,
          lastRestart:                 data.startedAt,
          uptimeSeconds:               Math.round((data.uptimeMs ?? 0) / 1000),
          reconciliation:              { status: 'idle', matchedPositions: 0, totalPositions: 0, lastAt: null },
          gmxConnected:                data.gmxRpcHealthy ?? false,
          walletAddress:               data.walletAddress ?? null,
          subaccountAddress:           data.subaccountAddress ?? null,
          subaccountExpiresAt:         null,
          subaccountActionsRemaining:  null,
          networkChainId:              42161,
          strategyVersion:             null,
          riskLock:                    null,
          vpsReachable:                true,
        });

        emitHealthEvent('connected', true, data.startedAt);
      } catch {
        setConnectionStatus('error');
        setConnectionError('Cannot reach internal executor');
        setInternalReady(false);
        emitHealthEvent('error', false, prevLastRestartRef.current);
      }
      return;
    }

    // ── External VPS mode ─────────────────────────────────────────────────────
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
        host: cfg.host, port: cfg.port, ssl: String(cfg.useSSL),
      });
      const res = await fetch(`/api-server/api/vps/status?${params}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);

      const data = await res.json() as {
        state?: string; unattendedArmed?: boolean; vpsReachable?: boolean;
        lastHeartbeat?: string | null; heartbeatLatencyMs?: number | null;
        lastMarketUpdate?: string | null; lastUserStream?: string | null;
        lastStrategyCycle?: string | null; lastRestart?: string | null;
        uptimeSeconds?: number | null; reconciliation?: ReconciliationInfo;
        gmxConnected?: boolean; walletAddress?: string | null;
        subaccountAddress?: string | null; subaccountExpiresAt?: string | null;
        subaccountActionsRemaining?: number | null; networkChainId?: number;
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
        lastHeartbeat:              data.lastHeartbeat ?? null,
        heartbeatLatencyMs:         data.heartbeatLatencyMs ?? null,
        lastMarketUpdate:            data.lastMarketUpdate ?? null,
        lastUserStream:              data.lastUserStream ?? null,
        lastStrategyCycle:           data.lastStrategyCycle ?? null,
        lastRestart:                 newLastRestart,
        uptimeSeconds:               data.uptimeSeconds ?? null,
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
        setConnectionStatus('error');
        setConnectionError('Cannot reach API server');
        emitHealthEvent('error', false, prevLastRestartRef.current);
      }
    }
  }, [emitHealthEvent]);

  // ── Start/restart polling on mode or host change ──────────────────────────
  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    // Internal mode: always poll (no host needed)
    if (config.executorMode === 'internal') {
      prevStatusRef.current    = 'disconnected';
      prevReachableRef.current = false;
      errorStreakRef.current   = 0;
      pollStatus();
      pollingRef.current = setInterval(pollStatus, POLL_INTERVAL_MS);
      return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
    }

    // External mode: gate on host
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

    prevStatusRef.current    = 'disconnected';
    prevReachableRef.current = false;
    errorStreakRef.current   = 0;
    pollStatus();
    pollingRef.current = setInterval(pollStatus, POLL_INTERVAL_MS);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [config.host, config.executorMode, pollStatus]);

  // ── saveConfig ────────────────────────────────────────────────────────────
  const saveConfig = useCallback((c: VpsConfig) => {
    // Preserve executorMode if caller omitted it (backwards-compat with settings form)
    const merged: VpsConfig = {
      ...configRef.current,
      ...c,
      executorMode: c.executorMode ?? configRef.current.executorMode ?? 'internal',
    };
    setConfig(merged);
    configRef.current = merged;
    try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(merged)); } catch { /* noop */ }
    setConnectionStatus('disconnected');
    setConnectionError('');
    setVpsState('OFF');
    setHealth(EMPTY_HEALTH);
  }, []);

  // ── setExecutorMode ───────────────────────────────────────────────────────
  const setExecutorMode = useCallback((mode: ExecutorMode) => {
    const newConfig: VpsConfig = { ...configRef.current, executorMode: mode };
    setConfig(newConfig);
    configRef.current = newConfig;
    try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newConfig)); } catch { /* noop */ }
    // Reset connection state so new mode's polling starts fresh
    setConnectionStatus('disconnected');
    setConnectionError('');
    setVpsState('OFF');
    setHealth(EMPTY_HEALTH);
    setInternalReady(false);
    prevStatusRef.current    = 'disconnected';
    prevReachableRef.current = false;
    errorStreakRef.current   = 0;
  }, []);

  // ── testConnection ────────────────────────────────────────────────────────
  const testConnection = useCallback(async () => {
    setConnectionStatus('connecting');
    setConnectionError('');
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

  // ── fetchAiDecisions ──────────────────────────────────────────────────────
  const fetchAiDecisions = useCallback(async () => {
    try {
      const res = await fetch('/api-server/api/ai/decisions?limit=200', {
        signal: AbortSignal.timeout(TIMEOUT_MS),
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

    // Internal mode: arm locally (executor always running)
    if (cfg.executorMode === 'internal') {
      setUnattendedArmed(true);
      setVpsState('ARMED');
      return { ok: true };
    }

    // External VPS mode
    if (!cfg.host.trim()) return { ok: false, error: 'VPS host not configured' };
    try {
      const res = await fetch('/api-server/api/vps/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: cfg.host, port: cfg.port, ssl: cfg.useSSL }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: e.error ?? `HTTP ${res.status}` };
      }
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

    // Internal mode: disarm locally
    if (cfg.executorMode === 'internal') {
      setUnattendedArmed(false);
      setVpsState('OFF');
      return { ok: true };
    }

    // External VPS mode
    if (!cfg.host.trim()) return { ok: false, error: 'VPS host not configured' };
    try {
      const res = await fetch('/api-server/api/vps/disarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: cfg.host, port: cfg.port, ssl: cfg.useSSL }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
      executorMode:            config.executorMode ?? 'internal',
      setExecutorMode,
      internalReady,
      internalSignerConfigured,
      internalDeploymentMode,
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
  if (diff < 5_000)    return 'just now';
  if (diff < 60_000)   return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return '—';
  if (seconds < 60)     return `${seconds}s`;
  if (seconds < 3_600)  return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}

export const VPS_STATE_LABELS: Record<VpsEngineState, string> = {
  OFF:         'OFF',
  ARMED:       'ARMED',
  RECONCILING: 'RECONCILING',
  RUNNING:     'RUNNING',
  RISK_LOCKED: 'RISK LOCKED',
};
