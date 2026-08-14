import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { MOCK_ACCOUNT, MOCK_POSITIONS, MOCK_TRADES, MOCK_LOGS } from '../../../../futures-terminal/constants/mockData';
import { Account, Position, Trade, StrategyLog } from './AppContext';

interface TradingContextType {
  account: Account;
  positions: Position[];
  closedTrades: Trade[];
  logs: StrategyLog[];
  closePosition: (id: string) => void;
  clearAllPositions: () => void;
}

const TradingContext = createContext<TradingContextType | undefined>(undefined);

export function TradingProvider({ children }: { children: ReactNode }) {
  const [positions, setPositions] = useState<Position[]>(MOCK_POSITIONS);
  const [closedTrades, setClosedTrades] = useState<Trade[]>(MOCK_TRADES);
  const [logs, setLogs] = useState<StrategyLog[]>(MOCK_LOGS);
  const [account, setAccount] = useState<Account>(MOCK_ACCOUNT);

  useEffect(() => {
    const interval = setInterval(() => {
      setPositions(prevPositions => {
        let totalUnrealized = 0;
        let totalPosValue = 0;

        const nextPositions = prevPositions.map(pos => {
          const drift = pos.markPrice * (Math.random() * 0.002 - 0.001); // 0.1% drift
          const newMarkPrice = pos.markPrice + drift;
          const diff = pos.side === 'LONG' ? newMarkPrice - pos.entryPrice : pos.entryPrice - newMarkPrice;
          const newUnrealizedPnl = diff * pos.size;
          const newRoe = (newUnrealizedPnl / pos.marginUsed) * 100;
          
          totalUnrealized += newUnrealizedPnl;
          totalPosValue += newMarkPrice * pos.size;

          return {
            ...pos,
            markPrice: newMarkPrice,
            unrealizedPnl: newUnrealizedPnl,
            roe: newRoe
          };
        });

        setAccount(prevAccount => ({
          ...prevAccount,
          unrealizedPnl: totalUnrealized,
          totalPositionValue: totalPosValue
        }));

        return nextPositions;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const closePosition = useCallback((id: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === id);
      if (pos) {
        setClosedTrades(trades => [{
          id: `closed-\${Date.now()}`,
          symbol: pos.symbol,
          side: pos.side,
          size: pos.size,
          price: pos.markPrice,
          pnl: pos.unrealizedPnl,
          strategy: 'Manual Close',
          timestamp: new Date()
        }, ...trades]);
        
        setLogs(l => [{
          id: `log-\${Date.now()}`,
          level: 'TRADE',
          message: `[PAPER] Manually closed \${pos.symbol} \${pos.side} PnL: $\${pos.unrealizedPnl.toFixed(2)}`,
          timestamp: new Date()
        }, ...l]);
      }
      return prev.filter(p => p.id !== id);
    });
  }, []);

  const clearAllPositions = useCallback(() => {
    setPositions(prev => {
      prev.forEach(pos => {
        setClosedTrades(trades => [{
          id: `closed-\${Date.now()}-\${Math.random()}`,
          symbol: pos.symbol,
          side: pos.side,
          size: pos.size,
          price: pos.markPrice,
          pnl: pos.unrealizedPnl,
          strategy: 'Clear All',
          timestamp: new Date()
        }, ...trades]);
      });
      return [];
    });
    setLogs(l => [{
      id: `log-\${Date.now()}`,
      level: 'WARN',
      message: `[PAPER] Cleared all positions`,
      timestamp: new Date()
    }, ...l]);
  }, []);

  return (
    <TradingContext.Provider value={{ account, positions, closedTrades, logs, closePosition, clearAllPositions }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTradingContext must be used within TradingProvider');
  return ctx;
}
