import {
  createContext, useContext, useState, useEffect,
  ReactNode, useCallback, useRef,
} from 'react';
import { MOCK_WATCHLIST } from '../../../../futures-terminal/constants/mockData';
import { WatchlistSymbol } from './AppContext';
import { GmxPriceStream, StreamStatus, fetchGmxPrices } from '../gmx/priceStream';
import { displaySymbol, DEFAULT_WATCHLIST_SYMBOLS } from '../gmx/markets';

export type { StreamStatus };

interface WatchlistContextType {
  watchlist: WatchlistSymbol[];
  streamStatus: StreamStatus;
  addSymbol: (symbol: string) => void;
  removeSymbol: (symbol: string) => void;
}

const WatchlistContext = createContext<WatchlistContextType | undefined>(undefined);

const LS_SYMBOLS   = 'futures_watchlist_symbols_v2';
const LS_WATCHLIST = 'futures_watchlist_v2';

function loadInitialWatchlist(): WatchlistSymbol[] {
  try {
    const raw = localStorage.getItem(LS_WATCHLIST);
    if (raw) {
      const parsed = JSON.parse(raw) as WatchlistSymbol[];
      if (parsed.every(w => !w.symbol.includes('USDT'))) return parsed;
    }
  } catch {}
  return (MOCK_WATCHLIST as WatchlistSymbol[]).map(w => ({
    ...w,
    displaySymbol: w.displaySymbol ?? displaySymbol(w.symbol),
  }));
}

function clamp(v: number, min = -100, max = 100) {
  return Math.max(min, Math.min(max, v));
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [watchlist, setWatchlist] = useState<WatchlistSymbol[]>(loadInitialWatchlist);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');

  const [symbolsList, setSymbolsList] = useState<string[]>(() =>
    loadInitialWatchlist().map(w => w.symbol)
  );

  const streamRef = useRef<GmxPriceStream | null>(null);

  // ── Persist to localStorage ────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(LS_WATCHLIST, JSON.stringify(watchlist));
      localStorage.setItem(LS_SYMBOLS, JSON.stringify(symbolsList));
    } catch {}
  }, [watchlist, symbolsList]);

  // ── GMX price stream ───────────────────────────────────────────
  useEffect(() => {
    if (symbolsList.length === 0) {
      setStreamStatus('offline');
      streamRef.current?.disconnect();
      return;
    }

    const handleUpdate = (priceMap: Map<string, { tokenSymbol: string; priceUsd: number; borrowingRatePerHour?: number }>) => {
      setWatchlist(prev =>
        prev.map(w => {
          const tick = priceMap.get(w.symbol);
          if (!tick) return w;
          return { ...w, price: tick.priceUsd };
        })
      );
    };

    if (!streamRef.current) {
      streamRef.current = new GmxPriceStream(handleUpdate, setStreamStatus);
      streamRef.current.connect(symbolsList);
    } else {
      streamRef.current.updateSymbols(symbolsList);
    }
  }, [symbolsList]);

  useEffect(() => {
    return () => { streamRef.current?.disconnect(); streamRef.current = null; };
  }, []);

  // ── Seed initial prices from GMX REST (before first poll fires) ─
  useEffect(() => {
    if (symbolsList.length === 0) return;
    fetchGmxPrices().then(priceMap => {
      if (priceMap.size === 0) return;
      setWatchlist(prev =>
        prev.map(w => {
          const tick = priceMap.get(w.symbol);
          return tick ? { ...w, price: tick.priceUsd } : w;
        })
      );
    });
  }, [symbolsList]);

  // ── Fetch 24h price change from API (on mount + every 5 min) ───
  useEffect(() => {
    const fetch24h = async () => {
      try {
        const res = await fetch('/api-server/api/gmx/change24h');
        if (!res.ok) return;
        const data = await res.json() as { symbol: string; change24hPct: number }[];
        if (!Array.isArray(data) || data.length === 0) return;
        const changeMap = new Map(data.map(d => [d.symbol, d.change24hPct]));
        setWatchlist(prev =>
          prev.map(w => {
            const change = changeMap.get(w.symbol);
            return change !== undefined ? { ...w, change24h: change } : w;
          })
        );
      } catch { /* non-fatal */ }
    };

    void fetch24h();
    const id = setInterval(fetch24h, 5 * 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Strategy score simulation (independent of price feed) ──────
  useEffect(() => {
    const id = setInterval(() => {
      setWatchlist(prev =>
        prev.map(w => {
          const s1 = clamp(w.score1h + (Math.random() * 6 - 3));
          const s4 = clamp(w.score4h + (Math.random() * 3 - 1.5));
          const sd = clamp(w.score1d + (Math.random() * 1.5 - 0.75));
          return { ...w, score1h: s1, score4h: s4, score1d: sd, combinedScore: clamp(s1 * 0.5 + s4 * 0.3 + sd * 0.2) };
        })
      );
    }, 3_000);
    return () => clearInterval(id);
  }, []);

  // ── Add symbol ─────────────────────────────────────────────────
  const addSymbol = useCallback((sym: string) => {
    const s = sym.toUpperCase().replace(/USDT$/, '').replace(/\/USD$/, '');
    setWatchlist(prev => {
      if (prev.find(p => p.symbol === s)) return prev;
      return [...prev, {
        symbol: s, displaySymbol: displaySymbol(s),
        price: 0, change24h: 0, volume24h: 0,
        score1h: 0, score4h: 0, score1d: 0, combinedScore: 0,
        borrowingRatePerHour: 0,
      }];
    });
    setSymbolsList(prev => prev.includes(s) ? prev : [...prev, s]);
  }, []);

  // ── Remove symbol ──────────────────────────────────────────────
  const removeSymbol = useCallback((sym: string) => {
    setWatchlist(prev => prev.filter(p => p.symbol !== sym));
    setSymbolsList(prev => prev.filter(p => p !== sym));
  }, []);

  return (
    <WatchlistContext.Provider value={{ watchlist, streamStatus, addSymbol, removeSymbol }}>
      {children}
    </WatchlistContext.Provider>
  );
}

export { DEFAULT_WATCHLIST_SYMBOLS };

export function useWatchlistContext() {
  const ctx = useContext(WatchlistContext);
  if (!ctx) throw new Error('useWatchlistContext must be used within WatchlistProvider');
  return ctx;
}
