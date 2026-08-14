import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STRATEGY_KEY = '@ft_strategy';

export interface IndicatorConfig {
  ema: { enabled: boolean; fastPeriod: number; slowPeriod: number };
  rsi: { enabled: boolean; period: number; overbought: number; oversold: number };
  macd: { enabled: boolean; fast: number; slow: number; signal: number };
  bollingerBands: { enabled: boolean; period: number; deviation: number };
  volumeBreakout: { enabled: boolean; multiplier: number };
  priceBreakout: { enabled: boolean; lookback: number };
  multiTimeframeTrend: { enabled: boolean };
  fundingRateFilter: { enabled: boolean; maxRate: number };
  btcDirectionFilter: { enabled: boolean };
  combinedScoring: { enabled: boolean; minScore: number };
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

export interface StrategyConfig {
  indicators: IndicatorConfig;
  riskLimits: RiskLimits;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  indicators: {
    ema: { enabled: true, fastPeriod: 9, slowPeriod: 21 },
    rsi: { enabled: true, period: 14, overbought: 70, oversold: 30 },
    macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    bollingerBands: { enabled: false, period: 20, deviation: 2 },
    volumeBreakout: { enabled: true, multiplier: 2.0 },
    priceBreakout: { enabled: false, lookback: 20 },
    multiTimeframeTrend: { enabled: true },
    fundingRateFilter: { enabled: true, maxRate: 0.05 },
    btcDirectionFilter: { enabled: true },
    combinedScoring: { enabled: true, minScore: 60 },
  },
  riskLimits: {
    maxTotalExposureUSDT: 5000,
    maxMarginPerTrade: 200,
    maxLeverage: 10,
    maxSimultaneousPositions: 5,
    dailyLossLimitUSDT: 500,
    weeklyLossLimitUSDT: 1500,
    maxDrawdownPercent: 15,
    consecutiveLossLimit: 5,
    cooldownMinutes: 30,
    maxTradesPerHour: 6,
  },
};

interface StrategyContextType {
  config: StrategyConfig;
  updateIndicator: <K extends keyof IndicatorConfig>(key: K, value: Partial<IndicatorConfig[K]>) => void;
  updateRiskLimit: <K extends keyof RiskLimits>(key: K, value: RiskLimits[K]) => void;
  resetToDefaults: () => void;
}

const StrategyContext = createContext<StrategyContextType | undefined>(undefined);

export function StrategyProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<StrategyConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    AsyncStorage.getItem(STRATEGY_KEY).then(data => {
      if (!data) return;
      try {
        const saved = JSON.parse(data) as Partial<StrategyConfig>;
        setConfig(prev => ({
          indicators: { ...prev.indicators, ...(saved.indicators ?? {}) },
          riskLimits: { ...prev.riskLimits, ...(saved.riskLimits ?? {}) },
        }));
      } catch {}
    });
  }, []);

  const persist = useCallback((c: StrategyConfig) => {
    AsyncStorage.setItem(STRATEGY_KEY, JSON.stringify(c));
  }, []);

  const updateIndicator = useCallback(<K extends keyof IndicatorConfig>(
    key: K,
    value: Partial<IndicatorConfig[K]>,
  ) => {
    setConfig(prev => {
      const next = {
        ...prev,
        indicators: { ...prev.indicators, [key]: { ...prev.indicators[key], ...value } },
      };
      persist(next);
      return next;
    });
  }, [persist]);

  const updateRiskLimit = useCallback(<K extends keyof RiskLimits>(
    key: K,
    value: RiskLimits[K],
  ) => {
    setConfig(prev => {
      const next = { ...prev, riskLimits: { ...prev.riskLimits, [key]: value } };
      persist(next);
      return next;
    });
  }, [persist]);

  const resetToDefaults = useCallback(() => {
    setConfig(DEFAULT_CONFIG);
    persist(DEFAULT_CONFIG);
  }, [persist]);

  return (
    <StrategyContext.Provider value={{ config, updateIndicator, updateRiskLimit, resetToDefaults }}>
      {children}
    </StrategyContext.Provider>
  );
}

export function useStrategy() {
  const ctx = useContext(StrategyContext);
  if (!ctx) throw new Error('useStrategy must be used within StrategyProvider');
  return ctx;
}
