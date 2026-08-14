import { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { MOCK_ACCOUNT, MOCK_POSITIONS, MOCK_TRADES, MOCK_WATCHLIST, MOCK_LOGS } from '../../../../futures-terminal/constants/mockData';

// --- Types ---
export type EngineState = 'OFFLINE' | 'MONITORING' | 'PAPER_TRADING' | 'LIVE_READY' | 'LIVE_TRADING' | 'RISK_LOCKED' | 'EMERGENCY_STOP';

export interface Account { balance: number; marginBalance: number; availableBalance: number; unrealizedPnl: number; realizedPnlToday: number; weeklyPnl: number; marginRatio: number; totalPositionValue: number; }

export interface Position { id: string; symbol: string; side: 'LONG' | 'SHORT'; size: number; entryPrice: number; markPrice: number; liquidationPrice: number; unrealizedPnl: number; roe: number; marginUsed: number; leverage: number; openTime: Date; }

export interface WatchlistSymbol { symbol: string; price: number; change24h: number; volume24h: number; score1h: number; score4h: number; score1d: number; combinedScore: number; }

export interface Trade { id: string; symbol: string; side: 'LONG' | 'SHORT'; size: number; price: number; pnl: number; strategy: string; timestamp: Date; action?: string; }

export interface StrategyLog { id: string; level: 'INFO' | 'WARN' | 'TRADE'; message: string; timestamp: Date; }

// --- AppContext ---
interface AppContextType {
  engineState: EngineState;
  stopNewOrders: boolean;
  toggleStopNewOrders: () => void;
  triggerEmergencyStop: () => void;
  resetFromEmergency: () => void;
  setEngineState: (state: EngineState) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [engineState, setEngineState] = useState<EngineState>('PAPER_TRADING');
  const [stopNewOrders, setStopNewOrders] = useState(false);

  const toggleStopNewOrders = useCallback(() => {
    setStopNewOrders(prev => !prev);
  }, []);

  const triggerEmergencyStop = useCallback(() => {
    setEngineState('EMERGENCY_STOP');
    setStopNewOrders(true);
  }, []);

  const resetFromEmergency = useCallback(() => {
    setEngineState('PAPER_TRADING');
    setStopNewOrders(false);
  }, []);

  return (
    <AppContext.Provider value={{ engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop, resetFromEmergency, setEngineState }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
