import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';

export interface IndicatorConfig {
  id: string;
  name: string;
  enabled: boolean;
  params: Record<string, string | number>;
}

export interface RiskLimits {
  // ── Capital settings ─────────────────────────────────────────────────────
  /**
   * Seed money committed to trading (USDT).
   * Must not exceed actual wallet USDC equity — validated on the Strategy page.
   * Basis for drawdown %, max-risk-per-symbol, and profit-lock calculations.
   */
  tradingCapital: number;
  /**
   * Reserve cash held back from active trading (0–50 %).
   * Effective deployable capital = tradingCapital × (1 − reserveCashPct / 100).
   */
  reserveCashPct: number;
  /**
   * Daily PnL soft KPI (USDT) — monitoring display only.
   * NEVER drives AI entry decisions, leverage increases, or risk escalation.
   * The Risk Engine is fully independent of this value.
   */
  dailyTargetUSDT: number;
  // ── Hard risk controls (enforced by Risk Engine · veto authority over AI) ──
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
  /**
   * Max risk per symbol as % of tradingCapital (0.5–10 %).
   * Hard cap on margin committed to any single index symbol.
   */
  maxRiskPerSymbolPct: number;
  /**
   * When daily realized PnL ≥ tradingCapital × profitLockThresholdPct,
   * Profit-lock Lv.1 activates (exposure stepped down, trailing tightened).
   * Each additional threshold × N advances to Lv.N (max Lv.3).
   */
  profitLockThresholdPct: number;
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
  // Capital
  tradingCapital:           10_000,   // seed money (must not exceed wallet equity)
  reserveCashPct:               20,   // keep 20 % as reserve — deploys 80 %
  dailyTargetUSDT:             500,   // soft KPI only — NOT enforced by AI engine
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
  maxRiskPerSymbolPct:           2,   // 2 % of tradingCapital per symbol
  profitLockThresholdPct:        1,   // Lv.1 activates at +1 % daily PnL
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
    if (!saved) return DEFAULT_LIMITS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = JSON.parse(saved) as Record<string, any>;
    // ── Backward-compat migration: startingCapital → tradingCapital ──────────
    // Older saves used `startingCapital`. Promote to `tradingCapital` on first
    // load, then fall through to the normal merge so all new fields get defaults.
    if ('startingCapital' in raw && !('tradingCapital' in raw)) {
      raw.tradingCapital = raw.startingCapital;
    }
    return { ...DEFAULT_LIMITS, ...raw };
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = data.limits as Record<string, any>;
          // Backward-compat migration: startingCapital → tradingCapital
          if ('startingCapital' in raw && !('tradingCapital' in raw)) {
            raw.tradingCapital = raw.startingCapital;
          }
          // Merge with defaults in case server row pre-dates new fields
          const merged = { ...DEFAULT_LIMITS, ...raw };
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
