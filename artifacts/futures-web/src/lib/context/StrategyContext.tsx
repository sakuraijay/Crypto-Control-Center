import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';

export interface IndicatorConfig {
  id: string;
  name: string;
  enabled: boolean;
  params: Record<string, string | number>;
}

export interface RiskLimits {
  // ── Planning assumptions (monitoring KPIs — never drive leverage or risk) ──
  startingCapital: number;      // USDT — basis for drawdown % calculations
  dailyTargetUSDT: number;      // USDT — display KPI only; Risk Engine is independent
  // ── Hard risk controls (enforced by Risk Engine with veto authority) ──
  maxTotalExposureUSDT: number;
  maxMarginPerTrade: number;
  maxLeverage: number;
  maxSimultaneousPositions: number;
  dailyLossLimitUSDT: number;
  weeklyLossLimitUSDT: number;
  maxDrawdownPercent: number;
  consecutiveLossLimit: number;
  cooldownMinutes: number;
  maxTradesPerHour: number;
}

const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'ema',      name: 'EMA',                 enabled: true,  params: { fast: 9, slow: 21 } },
  { id: 'rsi',      name: 'RSI',                 enabled: true,  params: { period: 14, OB: 70, OS: 30 } },
  { id: 'macd',     name: 'MACD',                enabled: false, params: { fast: 12, slow: 26, signal: 9 } },
  { id: 'bb',       name: 'Bollinger Bands',      enabled: false, params: { period: 20, deviation: 2.0 } },
  { id: 'vol',      name: 'Volume Breakout',      enabled: true,  params: { multiplier: 2.0 } },
  { id: 'price',    name: 'Price Breakout',       enabled: false, params: { lookback: 20 } },
  { id: 'mtf',      name: 'Multi-TF Trend',       enabled: true,  params: {} },
  { id: 'funding',  name: 'Funding Rate Filter',  enabled: true,  params: { maxRate: 0.05 } },
  { id: 'btc_dir',  name: 'BTC Direction Filter', enabled: true,  params: {} },
  { id: 'combined', name: 'Combined Scoring',     enabled: true,  params: { minScore: 60 } },
];

const DEFAULT_LIMITS: RiskLimits = {
  // Planning assumptions
  startingCapital:          10_000,
  dailyTargetUSDT:             500,
  // Hard risk controls
  maxTotalExposureUSDT:      5_000,
  maxMarginPerTrade:           200,
  maxLeverage:                  10,
  maxSimultaneousPositions:      5,
  dailyLossLimitUSDT:          500,
  weeklyLossLimitUSDT:       1_500,
  maxDrawdownPercent:           15,
  consecutiveLossLimit:          5,
  cooldownMinutes:              30,
  maxTradesPerHour:              6,
};

interface StrategyContextType {
  indicators: IndicatorConfig[];
  limits: RiskLimits;
  updateIndicator: (id: string, updates: Partial<IndicatorConfig>) => void;
  updateLimit: (key: keyof RiskLimits, value: number) => void;
  resetToDefaults: () => void;
}

const StrategyContext = createContext<StrategyContextType | undefined>(undefined);

const SERVER_SYNC_DELAY_MS = 2000; // debounce server writes

export function StrategyProvider({ children }: { children: ReactNode }) {
  const [indicators, setIndicators] = useState<IndicatorConfig[]>(() => {
    const saved = localStorage.getItem('futures_indicators');
    return saved ? JSON.parse(saved) : DEFAULT_INDICATORS;
  });

  const [limits, setLimits] = useState<RiskLimits>(() => {
    const saved = localStorage.getItem('futures_limits');
    // Merge with defaults so new fields (startingCapital, dailyTargetUSDT)
    // are always present even when loading pre-existing localStorage data.
    return saved ? { ...DEFAULT_LIMITS, ...JSON.parse(saved) } : DEFAULT_LIMITS;
  });

  const serverSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedFromServer = useRef(false);

  // ── Load from server on mount (server overrides localStorage if found) ───
  useEffect(() => {
    fetch('/api/data/strategy', { signal: AbortSignal.timeout(5_000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        if (data.indicators && Array.isArray(data.indicators) && data.indicators.length > 0) {
          setIndicators(data.indicators as IndicatorConfig[]);
          localStorage.setItem('futures_indicators', JSON.stringify(data.indicators));
        }
        if (data.limits && typeof data.limits === 'object') {
          // Merge with defaults in case server row pre-dates new fields
          const merged = { ...DEFAULT_LIMITS, ...(data.limits as RiskLimits) };
          setLimits(merged);
          localStorage.setItem('futures_limits', JSON.stringify(merged));
        }
        initializedFromServer.current = true;
      })
      .catch(() => { /* server unavailable — use localStorage */ });
  }, []);

  // ── Persist to localStorage immediately, server with debounce ────────────
  useEffect(() => {
    localStorage.setItem('futures_indicators', JSON.stringify(indicators));
    if (!initializedFromServer.current) return; // don't push until we've pulled
    if (serverSyncTimer.current) clearTimeout(serverSyncTimer.current);
    serverSyncTimer.current = setTimeout(() => {
      fetch('/api/data/strategy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indicators, limits }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }, SERVER_SYNC_DELAY_MS);
  }, [indicators]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem('futures_limits', JSON.stringify(limits));
    if (!initializedFromServer.current) return;
    if (serverSyncTimer.current) clearTimeout(serverSyncTimer.current);
    serverSyncTimer.current = setTimeout(() => {
      fetch('/api/data/strategy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indicators, limits }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }, SERVER_SYNC_DELAY_MS);
  }, [limits]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateIndicator = useCallback((id: string, updates: Partial<IndicatorConfig>) => {
    setIndicators(prev => prev.map(ind => ind.id === id ? { ...ind, ...updates } : ind));
    initializedFromServer.current = true; // allow server writes after any user change
  }, []);

  const updateLimit = useCallback((key: keyof RiskLimits, value: number) => {
    setLimits(prev => ({ ...prev, [key]: value }));
    initializedFromServer.current = true;
  }, []);

  const resetToDefaults = useCallback(() => {
    setIndicators(DEFAULT_INDICATORS);
    setLimits(DEFAULT_LIMITS);
  }, []);

  return (
    <StrategyContext.Provider value={{ indicators, limits, updateIndicator, updateLimit, resetToDefaults }}>
      {children}
    </StrategyContext.Provider>
  );
}

export function useStrategyContext() {
  const ctx = useContext(StrategyContext);
  if (!ctx) throw new Error('useStrategyContext must be used within StrategyProvider');
  return ctx;
}
