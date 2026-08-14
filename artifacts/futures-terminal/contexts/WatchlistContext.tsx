import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MOCK_WATCHLIST } from '@/constants/mockData';

const WL_KEY = '@ft_watchlist';

export interface WatchlistSymbol {
  symbol: string;
  price: number;
  change24h: number;
  score1h: number;
  score4h: number;
  score1d: number;
  combinedScore: number;
  volume24h: number;
}

interface WatchlistContextType {
  symbols: WatchlistSymbol[];
  addSymbol: (symbol: string) => void;
  removeSymbol: (symbol: string) => void;
}

const WatchlistContext = createContext<WatchlistContextType | undefined>(undefined);

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function tickSymbol(sym: WatchlistSymbol): WatchlistSymbol {
  const priceDelta = sym.price > 0 ? sym.price * (Math.random() * 0.006 - 0.003) : 0;
  const noise = () => Math.random() * 10 - 5;
  return {
    ...sym,
    price: sym.price + priceDelta,
    score1h: clamp(sym.score1h + noise(), -100, 100),
    score4h: clamp(sym.score4h + noise() * 0.5, -100, 100),
    score1d: clamp(sym.score1d + noise() * 0.2, -100, 100),
    combinedScore: clamp(sym.combinedScore + noise() * 0.6, -100, 100),
  };
}

export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [symbols, setSymbols] = useState<WatchlistSymbol[]>(MOCK_WATCHLIST);

  useEffect(() => {
    AsyncStorage.getItem(WL_KEY).then(data => {
      if (!data) return;
      try {
        const saved: string[] = JSON.parse(data);
        const merged = MOCK_WATCHLIST.filter(s => saved.includes(s.symbol));
        const extras = saved
          .filter(s => !MOCK_WATCHLIST.find(m => m.symbol === s))
          .map(s => ({
            symbol: s, price: 0, change24h: 0,
            score1h: 0, score4h: 0, score1d: 0, combinedScore: 0, volume24h: 0,
          }));
        setSymbols([...merged, ...extras]);
      } catch {}
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setSymbols(prev => prev.map(tickSymbol));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const addSymbol = useCallback((symbol: string) => {
    const s = symbol.toUpperCase();
    setSymbols(prev => {
      if (prev.find(x => x.symbol === s)) return prev;
      const newSym: WatchlistSymbol = {
        symbol: s, price: 0, change24h: 0,
        score1h: 0, score4h: 0, score1d: 0, combinedScore: 0, volume24h: 0,
      };
      const updated = [...prev, newSym];
      AsyncStorage.setItem(WL_KEY, JSON.stringify(updated.map(x => x.symbol)));
      return updated;
    });
  }, []);

  const removeSymbol = useCallback((symbol: string) => {
    setSymbols(prev => {
      const updated = prev.filter(x => x.symbol !== symbol);
      AsyncStorage.setItem(WL_KEY, JSON.stringify(updated.map(x => x.symbol)));
      return updated;
    });
  }, []);

  return (
    <WatchlistContext.Provider value={{ symbols, addSymbol, removeSymbol }}>
      {children}
    </WatchlistContext.Provider>
  );
}

export function useWatchlist() {
  const ctx = useContext(WatchlistContext);
  if (!ctx) throw new Error('useWatchlist must be used within WatchlistProvider');
  return ctx;
}
