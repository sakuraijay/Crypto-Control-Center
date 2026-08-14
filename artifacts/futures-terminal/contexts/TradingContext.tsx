import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { MOCK_ACCOUNT, MOCK_POSITIONS, MOCK_TRADES } from '@/constants/mockData';

export interface Position {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  marginUsed: number;
  unrealizedPnl: number;
  roe: number;
  liquidationPrice: number;
  openTime: Date;
}

export interface Trade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  action: 'OPEN' | 'CLOSE';
  size: number;
  price: number;
  pnl: number;
  strategy: string;
  timestamp: Date;
}

export interface AccountSummary {
  balance: number;
  marginBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
  weeklyPnl: number;
  marginRatio: number;
  totalPositionValue: number;
}

interface TradingContextType {
  account: AccountSummary;
  positions: Position[];
  trades: Trade[];
  closePosition: (id: string) => void;
  clearAllPositions: () => void;
}

const TradingContext = createContext<TradingContextType | undefined>(undefined);

function tickPosition(pos: Position): Position {
  const change = pos.markPrice * (Math.random() * 0.004 - 0.002);
  const newMark = pos.markPrice + change;
  const pnlPerUnit = pos.side === 'LONG' ? newMark - pos.entryPrice : pos.entryPrice - newMark;
  const unrealizedPnl = pnlPerUnit * pos.size;
  const roe = (unrealizedPnl / pos.marginUsed) * 100;
  return { ...pos, markPrice: newMark, unrealizedPnl, roe };
}

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const [positions, setPositions] = useState<Position[]>(MOCK_POSITIONS as Position[]);
  const [trades, setTrades] = useState<Trade[]>(MOCK_TRADES as Trade[]);
  const [account, setAccount] = useState<AccountSummary>(MOCK_ACCOUNT);

  // Simulate live price ticks
  useEffect(() => {
    const interval = setInterval(() => {
      setPositions(prev => prev.map(tickPosition));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Keep account unrealizedPnl in sync
  useEffect(() => {
    const total = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    setAccount(prev => ({ ...prev, unrealizedPnl: total }));
  }, [positions]);

  const closePosition = useCallback((id: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === id);
      if (pos) {
        const trade: Trade = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          symbol: pos.symbol,
          side: pos.side,
          action: 'CLOSE',
          size: pos.size,
          price: pos.markPrice,
          pnl: pos.unrealizedPnl,
          strategy: 'Manual',
          timestamp: new Date(),
        };
        setTrades(t => [trade, ...t]);
        setAccount(a => ({
          ...a,
          realizedPnlToday: a.realizedPnlToday + pos.unrealizedPnl,
          weeklyPnl: a.weeklyPnl + pos.unrealizedPnl,
          availableBalance: a.availableBalance + pos.marginUsed + pos.unrealizedPnl,
        }));
      }
      return prev.filter(p => p.id !== id);
    });
  }, []);

  const clearAllPositions = useCallback(() => {
    setPositions(prev => {
      const totalPnl = prev.reduce((s, p) => s + p.unrealizedPnl, 0);
      const totalMargin = prev.reduce((s, p) => s + p.marginUsed, 0);
      setAccount(a => ({
        ...a,
        realizedPnlToday: a.realizedPnlToday + totalPnl,
        weeklyPnl: a.weeklyPnl + totalPnl,
        availableBalance: a.availableBalance + totalMargin + totalPnl,
      }));
      return [];
    });
  }, []);

  return (
    <TradingContext.Provider value={{ account, positions, trades, closePosition, clearAllPositions }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTrading must be used within TradingProvider');
  return ctx;
}
