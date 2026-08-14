import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MOCK_WATCHLIST } from '@/constants/mockData';
import {
  MarkPriceStream, StreamStatus,
  fetch24hStats, fetchMarkPrices,
} from '@/services/binanceMarkPriceStream';

export type { StreamStatus };

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
  fundingRate?: number;
}

interface WatchlistContextType {
  symbols: WatchlistSymbol[];
  streamStatus: StreamStatus;
  addSymbol: (symbol: string) => void;
  removeSymbol: (symbol: string) => void;
}

const WatchlistContext = createContext<WatchlistContextType | undefined>(undefined);

function clamp(v: number, min = -100, max = 100) {
  return Math.max(min, Math.min(max, v));
}

export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [symbols, setSymbols] = useState<WatchlistSymbol[]>(MOCK_WATCHLIST);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');

  // Separate symbol name list — only changes on add/remove (not on price ticks)
  const [symbolsList, setSymbolsList] = useState<string[]>(
    MOCK_WATCHLIST.map(w => w.symbol)
  );

  const streamRef = useRef<MarkPriceStream | null>(null);

  // ── Load persisted symbol list ──────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(WL_KEY).then(data => {
      if (!data) return;
      try {
        const saved: string[] = JSON.parse(data);
        const merged = MOCK_WATCHLIST.filter(s => saved.includes(s.symbol));
        const extras = saved
          .filter(s => !MOCK_WATCHLIST.find(m => m.symbol === s))
          .map(s => ({ symbol: s, price: 0, change24h: 0, score1h: 0, score4h: 0, score1d: 0, combinedScore: 0, volume24h: 0 }));
        const list = [...merged, ...extras];
        setSymbols(list);
        setSymbolsList(list.map(s => s.symbol));
      } catch {}
    });
  }, []);

  // ── Binance WebSocket for live mark prices ──────────────────────
  useEffect(() => {
    if (symbolsList.length === 0) { setStreamStatus('offline'); return; }

    const handleUpdate = (upd: { symbol: string; markPrice: number; fundingRate: number }) => {
      setSymbols(prev => prev.map(w =>
        w.symbol === upd.symbol
          ? { ...w, price: upd.markPrice, fundingRate: upd.fundingRate }
          : w
      ));
    };

    if (!streamRef.current) {
      streamRef.current = new MarkPriceStream(handleUpdate, setStreamStatus);
      streamRef.current.connect(symbolsList);
    } else {
      streamRef.current.updateSymbols(symbolsList);
    }
  }, [symbolsList]);

  useEffect(() => {
    return () => {
      streamRef.current?.disconnect();
      streamRef.current = null;
    };
  }, []);

  // ── REST seed: initial mark prices + 24h stats ──────────────────
  useEffect(() => {
    if (symbolsList.length === 0) return;

    fetchMarkPrices(symbolsList).then(prices => {
      if (!prices || Object.keys(prices).length === 0) return;
      setSymbols(prev => prev.map(w => {
        const p = prices[w.symbol];
        return p !== undefined ? { ...w, price: p } : w;
      }));
    });

    fetch24hStats(symbolsList).then(stats => {
      setSymbols(prev => prev.map(w => {
        const s = stats[w.symbol];
        return s !== undefined ? { ...w, change24h: s.changePercent, volume24h: s.volume } : w;
      }));
    });
  }, [symbolsList]);

  // ── Strategy score simulation (separate from price feed) ────────
  useEffect(() => {
    const interval = setInterval(() => {
      setSymbols(prev => prev.map(sym => {
        const priceDelta = sym.price > 0 ? sym.price * (Math.random() * 0.002 - 0.001) : 0;
        const s1 = clamp(sym.score1h + (Math.random() * 6 - 3));
        const s4 = clamp(sym.score4h + (Math.random() * 3 - 1.5));
        const sd = clamp(sym.score1d + (Math.random() * 1.5 - 0.75));
        return {
          ...sym,
          // Only apply price drift if WS is not connected (offline fallback)
          price: streamStatus === 'offline' || streamStatus === 'reconnecting'
            ? sym.price + priceDelta
            : sym.price,
          score1h: s1,
          score4h: s4,
          score1d: sd,
          combinedScore: clamp(s1 * 0.5 + s4 * 0.3 + sd * 0.2),
        };
      }));
    }, 3_000);
    return () => clearInterval(interval);
  }, [streamStatus]);

  // ── Add / Remove ────────────────────────────────────────────────
  const addSymbol = useCallback((symbol: string) => {
    const s = symbol.toUpperCase().endsWith('USDT')
      ? symbol.toUpperCase()
      : `${symbol.toUpperCase()}USDT`;

    setSymbols(prev => {
      if (prev.find(x => x.symbol === s)) return prev;
      const next = [...prev, { symbol: s, price: 0, change24h: 0, score1h: 0, score4h: 0, score1d: 0, combinedScore: 0, volume24h: 0 }];
      AsyncStorage.setItem(WL_KEY, JSON.stringify(next.map(x => x.symbol)));
      return next;
    });
    setSymbolsList(prev => {
      if (prev.includes(s)) return prev;
      return [...prev, s];
    });
  }, []);

  const removeSymbol = useCallback((symbol: string) => {
    setSymbols(prev => {
      const next = prev.filter(x => x.symbol !== symbol);
      AsyncStorage.setItem(WL_KEY, JSON.stringify(next.map(x => x.symbol)));
      return next;
    });
    setSymbolsList(prev => prev.filter(p => p !== symbol));
  }, []);

  return (
    <WatchlistContext.Provider value={{ symbols, streamStatus, addSymbol, removeSymbol }}>
      {children}
    </WatchlistContext.Provider>
  );
}

export function useWatchlist() {
  const ctx = useContext(WatchlistContext);
  if (!ctx) throw new Error('useWatchlist must be used within WatchlistProvider');
  return ctx;
}
