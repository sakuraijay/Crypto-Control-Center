/**
 * VpsContext — mobile (React Native / Expo)
 *
 * The VPS is the 24/7 trading authority. This app is a monitoring and control
 * interface only. The VPS continues trading regardless of whether this app is open.
 *
 * Polls VPS status via the API server every 30 seconds.
 * Fires push notifications on connection-state transitions.
 * Persists config to AsyncStorage under '@futures_vps_config'.
 *
 * SECURITY: No private keys, seed phrases, or raw delegated-signer keys are
 * ever accepted, stored, or transmitted by this context. The only subaccount
 * data surfaced is read-only metadata (address, expiry, quota) from the VPS.
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  scheduleConnectionHealthAlert,
  scheduleRestartAlert,
} from '@/services/notifications';

// ── Types ─────────────────────────────────────────────────────────────────────

export type VpsEngineState = 'OFF' | 'ARMED' | 'RECONCILING' | 'RUNNING' | 'RISK_LOCKED';
export type VpsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ExecutorMode = 'internal' | 'external';

/**
 * High-level operating mode — what the system is actually doing right now.
 *   AUTONOMOUS_AI   — VPS AI selects symbols, direction, entry/exit, sizing, TP/SL 24/7
 *   MANUAL_OVERRIDE — AI paused; user places trades manually
 *   RISK_LOCKED     — deterministic risk controls vetoed all activity
 */
export type OperatingMode = 'AUTONOMOUS_AI' | 'MANUAL_OVERRIDE' | 'RISK_LOCKED';

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
   *   'internal' = Replit-hosted internal executor (default, no host config needed)
   *   'external' = user-hosted external VPS (requires host/port/ssl)
   */
  executorMode: ExecutorMode;
}

export interface ReconciliationInfo {
  status: 'idle' | 'in_progress' | 'complete' | 'failed';
  matchedPositions: number;
  totalPositions: number;
  lastAt: string | null;
}

/**
 * Read-only system health telemetry from the VPS.
 * Contains only metadata — no private keys, no seed phrases.
 */
export interface SystemHealth {
  lastHeartbeat: string | null;
  heartbeatLatencyMs: number | null;
  lastMarketUpdate: string | null;
  lastUserStream: string | null;
  lastStrategyCycle: string | null;
  lastRestart: string | null;
  uptimeSeconds: number | null;
  reconciliation: ReconciliationInfo;
  /** True when VPS ↔ GMX RPC/API is healthy */
  gmxConnected: boolean;
  /** Primary wallet address monitored by VPS (display only, never the key) */
  walletAddress: string | null;
  /**
   * Delegated One-Click subaccount address (display only).
   * The actual signer key lives on the VPS only and is never sent to clients.
   */
  subaccountAddress: string | null;
  /** ISO timestamp: when the subaccount authorization expires */
  subaccountExpiresAt: string | null;
  /** Remaining authorized actions before re-authorization is needed */
  subaccountActionsRemaining: number | null;
  networkChainId: number;
  strategyVersion: string | null;
  riskLock: { reason: string; since: string } | null;
  vpsReachable: boolean;
}

interface VpsContextType {
  config: VpsConfig;
  vpsState: VpsEngineState;
  operatingMode: OperatingMode;
  connectionStatus: VpsConnectionStatus;
  connectionError: string;
  unattendedArmed: boolean;
  health: SystemHealth;
  saveConfig: (c: VpsConfig) => Promise<void>;
  testConnection: () => Promise<void>;
  disconnect: () => void;
  armUnattended: () => Promise<{ ok: boolean; error?: string }>;
  disarmUnattended: () => Promise<{ ok: boolean; error?: string }>;
  executorMode: ExecutorMode;
  setExecutorMode: (mode: ExecutorMode) => void;
  internalReady: boolean;
  internalSignerConfigured: boolean;
  internalDeploymentMode: 'reserved_vm' | 'development' | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = '@futures_vps_config';
const POLL_INTERVAL_MS = 30_000;  // 30-second health-check interval
const TIMEOUT_MS       = 8_000;

const DEFAULT_CONFIG: VpsConfig = { host: '', port: '8080', useSSL: true, executorMode: 'internal' };

const EMPTY_HEALTH: SystemHealth = {
  lastHeartbeat: null, heartbeatLatencyMs: null, lastMarketUpdate: null,
  lastUserStream: null, lastStrategyCycle: null, lastRestart: null,
  uptimeSeconds: null,
  reconciliation: { status: 'idle', matchedPositions: 0, totalPositions: 0, lastAt: null },
  gmxConnected: false, walletAddress: null, subaccountAddress: null,
  subaccountExpiresAt: null, subaccountActionsRemaining: null, networkChainId: 42161,
  strategyVersion: null, riskLock: null, vpsReachable: false,
};

// API server base — resolves through Replit path-based proxy
const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
  : '/api-server/api';

// ── Context ───────────────────────────────────────────────────────────────────

const VpsContext = createContext<VpsContextType | undefined>(undefined);

export function VpsProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig]               = useState<VpsConfig>(DEFAULT_CONFIG);
  const [vpsState, setVpsState]           = useState<VpsEngineState>('OFF');
  const [connectionStatus, setConnectionStatus] = useState<VpsConnectionStatus>('disconnected');
  const [connectionError, setConnectionError]   = useState('');
  const [unattendedArmed, setUnattendedArmed]   = useState(false);
  const [health, setHealth]               = useState<SystemHealth>(EMPTY_HEALTH);

  const [internalReady, setInternalReady]                             = useState(false);
  const [internalSignerConfigured, setInternalSignerConfigured]       = useState(false);
  const [internalDeploymentMode, setInternalDeploymentMode]           = useState<'reserved_vm' | 'development' | null>(null);

  const configRef     = useRef<VpsConfig>(DEFAULT_CONFIG);
  const pollingRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── State-transition tracking (for alerts) ─────────────────────────────────
  /** Previous connection status — used to detect transitions */
  const prevStatusRef      = useRef<VpsConnectionStatus>('disconnected');
  /** Previous vpsReachable — used to detect recovery */
  const prevReachableRef   = useRef<boolean>(false);
  /** Previous lastRestart ISO — used to detect VPS restart events */
  const prevLastRestartRef = useRef<string | null>(null);
  /** How many consecutive errors before we fire a "down" alert (debounce) */
  const errorStreakRef     = useRef(0);

  const operatingMode = deriveOperatingMode(vpsState, unattendedArmed);

  // Load persisted config on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<VpsConfig>;
        const loaded: VpsConfig = {
          host:            parsed.host            ?? '',
          port:            parsed.port            ?? '8080',
          useSSL:          parsed.useSSL          ?? true,
          subaccountLabel: parsed.subaccountLabel,
          executorMode:    parsed.executorMode    ?? 'internal',
        };
        setConfig(loaded);
        configRef.current = loaded;
      }
    }).catch(() => {});
  }, []);

  // ── Connection health alert logic ──────────────────────────────────────────
  const fireHealthAlert = useCallback(async (
    newStatus: VpsConnectionStatus,
    newReachable: boolean,
    newLastRestart: string | null,
  ) => {
    const prev        = prevStatusRef.current;
    const prevReach   = prevReachableRef.current;
    const prevRestart = prevLastRestartRef.current;

    // Detect VPS restart: lastRestart changed to a non-null newer value
    if (newLastRestart && newLastRestart !== prevRestart && prevRestart !== null) {
      scheduleRestartAlert(
        `VPS restarted at ${new Date(newLastRestart).toLocaleTimeString()}. Re-arming may be required.`,
      ).catch(() => {});
    }

    // Transition: connected/disconnected → error (VPS went down)
    if (newStatus === 'error' && prev !== 'error') {
      errorStreakRef.current += 1;
      // Only alert after 2 consecutive errors (debounce transient blips)
      if (errorStreakRef.current >= 2) {
        scheduleConnectionHealthAlert(
          'down',
          !newReachable
            ? 'VPS is unreachable — check VPS power and network.'
            : 'API server cannot reach VPS. Check VPS host/port in Settings.',
        ).catch(() => {});
      }
    } else if (newStatus === 'error' && prev === 'error') {
      errorStreakRef.current += 1;
    } else {
      errorStreakRef.current = 0;
    }

    // Transition: error → connected (recovery)
    if (newStatus === 'connected' && prev === 'error') {
      scheduleConnectionHealthAlert(
        'recovered',
        'VPS connection restored. System is back online.',
      ).catch(() => {});
    }

    // Transition: connected → VPS unreachable (degraded: API up but VPS down)
    if (newStatus === 'connected' && !newReachable && prevReach) {
      scheduleConnectionHealthAlert(
        'degraded',
        'API server is up but VPS is unreachable. Trades are not executing.',
      ).catch(() => {});
    }

    prevStatusRef.current      = newStatus;
    prevReachableRef.current   = newReachable;
    prevLastRestartRef.current = newLastRestart;
  }, []);

  // ── Poll status ─────────────────────────────────────────────────────────────
  const pollStatus = useCallback(async () => {
    const cfg = configRef.current;

    // ── Internal executor mode ────────────────────────────────────────────────
    if (cfg.executorMode === 'internal') {
      try {
        const res = await fetch(`${API_BASE}/executor/status`, {
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

        setInternalReady(data.ready ?? false);
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

        await fireHealthAlert('connected', true, data.startedAt);
      } catch {
        setConnectionStatus('error');
        setConnectionError('Cannot reach internal executor');
        setInternalReady(false);
        await fireHealthAlert('error', false, prevLastRestartRef.current);
      }
      return;
    }

    // ── External VPS mode (existing logic) ───────────────────────────────────
    if (!cfg.host.trim()) {
      setVpsState('OFF');
      setConnectionStatus('disconnected');
      setHealth(EMPTY_HEALTH);
      prevStatusRef.current = 'disconnected';
      errorStreakRef.current = 0;
      return;
    }

    try {
      const params = new URLSearchParams({
        host: cfg.host, port: cfg.port, ssl: String(cfg.useSSL),
      });
      const res = await fetch(`${API_BASE}/vps/status?${params}`, {
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
      const newReachable = data.vpsReachable ?? false;
      const newLastRestart = data.lastRestart ?? null;

      setVpsState((data.state as VpsEngineState) ?? 'OFF');
      setUnattendedArmed(data.unattendedArmed ?? false);
      setConnectionStatus(newStatus);
      setConnectionError(newReachable ? '' : 'VPS unreachable');

      const newHealth: SystemHealth = {
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
      };
      setHealth(newHealth);

      await fireHealthAlert(newStatus, newReachable, newLastRestart);

    } catch {
      if (cfg.host.trim()) {
        const newStatus: VpsConnectionStatus = 'error';
        setConnectionStatus(newStatus);
        setConnectionError('Cannot reach VPS');
        setVpsState('OFF');
        await fireHealthAlert(newStatus, false, prevLastRestartRef.current);
      }
    }
  }, [fireHealthAlert]);

  // ── Restart polling when host or executorMode changes ───────────────────────
  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    // Internal mode: always poll (executor is always running, no host needed)
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

  // ── saveConfig ──────────────────────────────────────────────────────────────
  const saveConfig = useCallback(async (c: VpsConfig) => {
    const merged: VpsConfig = { ...configRef.current, ...c, executorMode: c.executorMode ?? configRef.current.executorMode ?? 'internal' };
    setConfig(merged);
    configRef.current = merged;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged)).catch(() => {});
    setConnectionStatus('disconnected');
    setConnectionError('');
    setVpsState('OFF');
    setHealth(EMPTY_HEALTH);
  }, []);

  // ── setExecutorMode ─────────────────────────────────────────────────────────
  const setExecutorMode = useCallback(async (mode: ExecutorMode) => {
    const newConfig: VpsConfig = { ...configRef.current, executorMode: mode };
    setConfig(newConfig);
    configRef.current = newConfig;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig)).catch(() => {});
    // Reset connection state so the new mode's polling starts fresh
    setConnectionStatus('disconnected');
    setConnectionError('');
    setVpsState('OFF');
    setHealth(EMPTY_HEALTH);
    setInternalReady(false);
    prevStatusRef.current    = 'disconnected';
    prevReachableRef.current = false;
    errorStreakRef.current   = 0;
  }, []);

  const testConnection = useCallback(async () => {
    setConnectionStatus('connecting');
    setConnectionError('');
    // Reset tracking so the first result after a manual test fires alerts correctly
    prevStatusRef.current    = 'disconnected';
    prevReachableRef.current = false;
    errorStreakRef.current   = 0;
    await pollStatus();
  }, [pollStatus]);

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

  const armUnattended = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    // Internal mode: arm locally (executor always running)
    if (configRef.current.executorMode === 'internal') {
      setUnattendedArmed(true);
      setVpsState('ARMED');
      return { ok: true };
    }

    const cfg = configRef.current;
    if (!cfg.host.trim()) return { ok: false, error: 'VPS host not configured' };
    try {
      const res = await fetch(`${API_BASE}/vps/arm`, {
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

  const disarmUnattended = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    // Internal mode: disarm locally
    if (configRef.current.executorMode === 'internal') {
      setUnattendedArmed(false);
      setVpsState('OFF');
      return { ok: true };
    }

    const cfg = configRef.current;
    if (!cfg.host.trim()) return { ok: false, error: 'VPS not configured' };
    try {
      const res = await fetch(`${API_BASE}/vps/disarm`, {
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
      saveConfig, testConnection, disconnect,
      armUnattended, disarmUnattended,
      executorMode: config.executorMode ?? 'internal',
      setExecutorMode,
      internalReady,
      internalSignerConfigured,
      internalDeploymentMode,
    }}>
      {children}
    </VpsContext.Provider>
  );
}

export function useVps() {
  const ctx = useContext(VpsContext);
  if (!ctx) throw new Error('useVps must be used within VpsProvider');
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5_000) return 'now';
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

/** Truncate an address to 0x1234…abcd format */
export function truncateAddress(addr: string | null | undefined): string {
  if (!addr) return '—';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Return expiry status and days remaining */
export function subaccountExpiryStatus(
  expiresAt: string | null | undefined,
): { label: string; daysLeft: number | null; severity: 'ok' | 'warn' | 'expired' } {
  if (!expiresAt) return { label: '—', daysLeft: null, severity: 'ok' };
  const ms = new Date(expiresAt).getTime() - Date.now();
  const days = Math.floor(ms / 86_400_000);
  if (ms <= 0) return { label: 'EXPIRED', daysLeft: 0, severity: 'expired' };
  if (days <= 3) return { label: `${days}d left`, daysLeft: days, severity: 'warn' };
  return { label: `${days}d left`, daysLeft: days, severity: 'ok' };
}

export const STATE_COLORS: Record<VpsEngineState, string> = {
  OFF:         '#6b7280',
  ARMED:       '#06b6d4',
  RECONCILING: '#f59e0b',
  RUNNING:     '#22c55e',
  RISK_LOCKED: '#ef4444',
};

export const STATE_LABELS: Record<VpsEngineState, string> = {
  OFF:         'OFF',
  ARMED:       'ARMED',
  RECONCILING: 'RECONCILING',
  RUNNING:     'RUNNING',
  RISK_LOCKED: 'RISK LOCKED',
};
