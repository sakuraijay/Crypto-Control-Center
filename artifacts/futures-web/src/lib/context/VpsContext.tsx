import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface VpsConfig {
  host: string;
  port: string;
  /** Reference name for the API key — never the actual key value */
  apiKeyName: string;
  useSSL: boolean;
}

export type VpsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface VpsContextType {
  config: VpsConfig;
  status: VpsStatus;
  errorMsg: string;
  latencyMs: number | null;
  saveConfig: (c: VpsConfig) => void;
  testConnection: () => Promise<void>;
  disconnect: () => void;
}

const DEFAULT_CONFIG: VpsConfig = { host: '', port: '8080', apiKeyName: '', useSSL: true };

function loadConfig(): VpsConfig {
  try {
    const s = localStorage.getItem('futures_vps_config');
    return s ? (JSON.parse(s) as VpsConfig) : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

const VpsContext = createContext<VpsContextType | undefined>(undefined);

export function VpsProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<VpsConfig>(loadConfig);
  const [status, setStatus] = useState<VpsStatus>('disconnected');
  const [errorMsg, setErrorMsg] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const saveConfig = useCallback((c: VpsConfig) => {
    setConfig(c);
    try { localStorage.setItem('futures_vps_config', JSON.stringify(c)); } catch { /* noop */ }
    setStatus('disconnected');
    setErrorMsg('');
    setLatencyMs(null);
  }, []);

  const testConnection = useCallback(async () => {
    if (!config.host.trim()) {
      setStatus('error');
      setErrorMsg('Host address is required.');
      return;
    }
    setStatus('connecting');
    setErrorMsg('');
    setLatencyMs(null);
    // Simulate network round-trip — no actual connection in paper mode
    const start = Date.now();
    await new Promise(res => setTimeout(res, 800 + Math.random() * 600));
    const elapsed = Date.now() - start;
    // Paper mode always returns "success" — real implementation would hit the VPS endpoint
    setLatencyMs(elapsed);
    setStatus('connected');
  }, [config.host]);

  const disconnect = useCallback(() => {
    setStatus('disconnected');
    setLatencyMs(null);
    setErrorMsg('');
  }, []);

  return (
    <VpsContext.Provider value={{ config, status, errorMsg, latencyMs, saveConfig, testConnection, disconnect }}>
      {children}
    </VpsContext.Provider>
  );
}

export function useVpsContext() {
  const ctx = useContext(VpsContext);
  if (!ctx) throw new Error('useVpsContext must be used within VpsProvider');
  return ctx;
}
