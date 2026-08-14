import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { MOCK_WATCHLIST } from '../../../../futures-terminal/constants/mockData';
import { WatchlistSymbol } from './AppContext';

interface WatchlistContextType {
  watchlist: WatchlistSymbol[];
  addSymbol: (symbol: string) => void;
  removeSymbol: (symbol: string) => void;
}

const WatchlistContext = createContext<WatchlistContextType | undefined>(undefined);

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [watchlist, setWatchlist] = useState<WatchlistSymbol[]>(() => {
    const saved = localStorage.getItem('futures_watchlist');
    return saved ? JSON.parse(saved) : MOCK_WATCHLIST;
  });

  useEffect(() => {
    localStorage.setItem('futures_watchlist', JSON.stringify(watchlist));
  }, [watchlist]);

  useEffect(() => {
    const interval = setInterval(() => {
      setWatchlist(prev => prev.map(item => {
        const pNoise = item.price * (Math.random() * 0.002 - 0.001);
        const sNoise1 = Math.random() * 4 - 2;
        const sNoise4 = Math.random() * 2 - 1;
        const sNoise24 = Math.random() * 1 - 0.5;
        
        const score1h = Math.max(-100, Math.min(100, item.score1h + sNoise1));
        const score4h = Math.max(-100, Math.min(100, item.score4h + sNoise4));
        const score1d = Math.max(-100, Math.min(100, item.score1d + sNoise24));
        
        const combinedScore = (score1h * 0.5) + (score4h * 0.3) + (score1d * 0.2);

        return {
          ...item,
          price: item.price + pNoise,
          score1h,
          score4h,
          score1d,
          combinedScore
        };
      }));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const addSymbol = useCallback((sym: string) => {
    const s = sym.toUpperCase().endsWith('USDT') ? sym.toUpperCase() : sym.toUpperCase() + 'USDT';
    setWatchlist(prev => {
      if (prev.find(p => p.symbol === s)) return prev;
      return [...prev, {
        symbol: s,
        price: 100 + Math.random() * 100,
        change24h: Math.random() * 10 - 5,
        volume24h: 1000000 + Math.random() * 10000000,
        score1h: 0,
        score4h: 0,
        score1d: 0,
        combinedScore: 0
      }];
    });
  }, []);

  const removeSymbol = useCallback((sym: string) => {
    setWatchlist(prev => prev.filter(p => p.symbol !== sym));
  }, []);

  return (
    <WatchlistContext.Provider value={{ watchlist, addSymbol, removeSymbol }}>
      {children}
    </WatchlistContext.Provider>
  );
}

export function useWatchlistContext() {
  const ctx = useContext(WatchlistContext);
  if (!ctx) throw new Error('useWatchlistContext must be used within WatchlistProvider');
  return ctx;
}
