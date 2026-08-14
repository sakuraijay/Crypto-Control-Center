import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MOCK_WATCHLIST } from '@/constants/mockData';
import {
  GmxPriceStream, StreamStatus,
  fetchGmxPrices,
} from '@/services/gmxPriceStream';

export type { StreamStatus };

const WL_KEY = '@ft_watchlist_v2'; // v2 = GMX symbols (no USDT suffix)

export interface WatchlistSymbol {
  symbol: string;          // GMX index symbol: "ETH", "BTC"
  displaySymbol: string;   // "ETH/USD"
  price: number;
  change24h: number;
  score1h: number;
  score4h: number;
  score1d: number;
  combinedScore: number;
  volume24h: number;
  borrowingRatePerHour?: number;  // GMX borrowing fee rate per hour
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

function toDisplaySymbol(sym: string): string {
  return `${sym}/USD`;
}

export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [symbols, setSymbols]         = useState<WatchlistSymbol[]>(MOCK_WATCHLIST as WatchlistSymbol[]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');

  // Separate symbol name list — only changes on add/remove (not on price ticks)
  const [symbolsList, setSymbolsList] = useState<string[]>(
    (MOCK_WATCHLIST as WatchlistSymbol[]).map(w => w.symbol)
  );

  const streamRef = useRef<GmxPriceStream | null>(null);

  // ── Load persisted symbol list ───────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(WL_KEY).then(data => {
      if (!data) return;
      try {
        const saved: string[] = JSON.parse(data);
        // Filter out stale Binance symbols (contain "USDT")
        const clean = saved.filter(s => !s.includes('USDT'));
        const merged = (MOCK_WATCHLIST as WatchlistSymbol[]).filter(s => clean.includes(s.symbol));
        const extras = clean
          .filter(s => !(MOCK_WATCHLIST as WatchlistSymbol[]).find(m => m.symbol === s))
          .map(s => ({
            symbol: s, displaySymbol: toDisplaySymbol(s),
            price: 0, change24h: 0, score1h: 0, score4h: 0, score1d: 0, combinedScore: 0, volume24h: 0,
          }));
        const list = [...merged, ...extras];
        setSymbols(list);
        setSymbolsList(list.map(s => s.symbol));
      } catch {}
    });
  }, []);

  // ── GMX price stream ─────────────────────────────────────────────
  useEffect(() => {
    if (symbolsList.length === 0) { setStreamStatus('offline'); return; }

    const handleUpdate = (tick: { tokenSymbol: string; priceUsd: number }) => {
      setSymbols(prev => prev.map(w =>
        w.symbol === tick.tokenSymbol
          ? { ...w, price: tick.priceUsd }
          : w
      ));
    };

    if (!streamRef.current) {
      streamRef.current = new GmxPriceStream(handleUpdate, setStreamStatus);
      streamRef.current.connect(symbolsList);
    } else {
      streamRef.current.updateSymbols(symbolsList);
    }
  }, [symbolsList]);

  useEffect(() => () => { streamRef.current?.disconnect(); streamRef.current = null; }, []);

  // ── Seed prices once on mount ────────────────────────────────────
  useEffect(() => {
    if (symbolsList.length === 0) return;
    fetchGmxPrices(symbolsList).then(prices => {
      if (Object.keys(prices).length === 0) return;
      setSymbols(prev => prev.map(w => {
        const p = prices[w.symbol];
        return p !== undefined ? { ...w, price: p } : w;
      }));
    });
  }, [symbolsList]);

  // ── Strategy score simulation (independent of price feed) ────────
  useEffect(() => {
    const interval = setInterval(() => {
      setSymbols(prev => prev.map(sym => {
        // Slight random walk price when stream is offline
        const priceDelta = streamStatus !== 'connected' && sym.price > 0
          ? sym.price * (Math.random() * 0.002 - 0.001)
          : 0;
        const s1 = clamp(sym.score1h + (Math.random() * 6 - 3));
        const s4 = clamp(sym.score4h + (Math.random() * 3 - 1.5));
        const sd = clamp(sym.score1d + (Math.random() * 1.5 - 0.75));
        return {
          ...sym,
          price:         sym.price + priceDelta,
          score1h:       s1,
          score4h:       s4,
          score1d:       sd,
          combinedScore: clamp(s1 * 0.5 + s4 * 0.3 + sd * 0.2),
        };
      }));
    }, 3_000);
    return () => clearInterval(interval);
  }, [streamStatus]);

  // ── Add symbol ───────────────────────────────────────────────────
  const addSymbol = useCallback((symbol: string) => {
    // Normalise: strip USDT suffix if present
    const s = symbol.toUpperCase().replace(/USDT$/, '').replace(/\/USD$/, '');

    setSymbols(prev => {
      if (prev.find(x => x.symbol === s)) return prev;
      const next: WatchlistSymbol[] = [
        ...prev,
        { symbol: s, displaySymbol: toDisplaySymbol(s), price: 0, change24h: 0, score1h: 0, score4h: 0, score1d: 0, combinedScore: 0, volume24h: 0 },
      ];
      AsyncStorage.setItem(WL_KEY, JSON.stringify(next.map(x => x.symbol)));
      return next;
    });
    setSymbolsList(prev => prev.includes(s) ? prev : [...prev, s]);
  }, []);

  // ── Remove symbol ────────────────────────────────────────────────
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
