import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';

export interface IndicatorConfig {
  id: string;
  name: string;
  enabled: boolean;
  params: Record<string, string | number>;
}

export interface RiskLimits {
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
  { id: 'ema', name: 'EMA', enabled: true, params: { fast: 9, slow: 21 } },
  { id: 'rsi', name: 'RSI', enabled: true, params: { period: 14, OB: 70, OS: 30 } },
  { id: 'macd', name: 'MACD', enabled: false, params: { fast: 12, slow: 26, signal: 9 } },
  { id: 'bb', name: 'Bollinger Bands', enabled: false, params: { period: 20, deviation: 2.0 } },
  { id: 'vol', name: 'Volume Breakout', enabled: true, params: { multiplier: 2.0 } },
  { id: 'price', name: 'Price Breakout', enabled: false, params: { lookback: 20 } },
  { id: 'mtf', name: 'Multi-TF Trend', enabled: true, params: {} },
  { id: 'funding', name: 'Funding Rate Filter', enabled: true, params: { maxRate: 0.05 } },
  { id: 'btc_dir', name: 'BTC Direction Filter', enabled: true, params: {} },
  { id: 'combined', name: 'Combined Scoring', enabled: true, params: { minScore: 60 } },
];

const DEFAULT_LIMITS: RiskLimits = {
  maxTotalExposureUSDT: 5000,
  maxMarginPerTrade: 200,
  maxLeverage: 10,
  maxSimultaneousPositions: 5,
  dailyLossLimitUSDT: 500,
  weeklyLossLimitUSDT: 1500,
  maxDrawdownPercent: 15,
  consecutiveLossLimit: 5,
  cooldownMinutes: 30,
  maxTradesPerHour: 6
};

interface StrategyContextType {
  indicators: IndicatorConfig[];
  limits: RiskLimits;
  updateIndicator: (id: string, updates: Partial<IndicatorConfig>) => void;
  updateLimit: (key: keyof RiskLimits, value: number) => void;
  resetToDefaults: () => void;
}

const StrategyContext = createContext<StrategyContextType | undefined>(undefined);

export function StrategyProvider({ children }: { children: ReactNode }) {
  const [indicators, setIndicators] = useState<IndicatorConfig[]>(() => {
    const saved = localStorage.getItem('futures_indicators');
    return saved ? JSON.parse(saved) : DEFAULT_INDICATORS;
  });

  const [limits, setLimits] = useState<RiskLimits>(() => {
    const saved = localStorage.getItem('futures_limits');
    return saved ? JSON.parse(saved) : DEFAULT_LIMITS;
  });

  useEffect(() => {
    localStorage.setItem('futures_indicators', JSON.stringify(indicators));
  }, [indicators]);

  useEffect(() => {
    localStorage.setItem('futures_limits', JSON.stringify(limits));
  }, [limits]);

  const updateIndicator = useCallback((id: string, updates: Partial<IndicatorConfig>) => {
    setIndicators(prev => prev.map(ind => ind.id === id ? { ...ind, ...updates } : ind));
  }, []);

  const updateLimit = useCallback((key: keyof RiskLimits, value: number) => {
    setLimits(prev => ({ ...prev, [key]: value }));
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
