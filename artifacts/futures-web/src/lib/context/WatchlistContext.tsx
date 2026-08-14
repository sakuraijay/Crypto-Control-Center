import {
  createContext, useContext, useState, useEffect,
  ReactNode, useCallback, useRef,
} from 'react';
import { MOCK_WATCHLIST } from '../../../../futures-terminal/constants/mockData';
import { WatchlistSymbol } from './AppContext';
import {
  MarkPriceStream, StreamStatus,
  fetch24hStats, fetchMarkPrices,
} from '../binance/markPriceStream';

interface WatchlistContextType {
  watchlist: WatchlistSymbol[];
  streamStatus: StreamStatus;
  addSymbol: (symbol: string) => void;
  removeSymbol: (symbol: string) => void;
}

const WatchlistContext = createContext<WatchlistContextType | undefined>(undefined);

const LS_SYMBOLS = 'futures_watchlist_symbols';
const LS_WATCHLIST = 'futures_watchlist';

function loadInitialWatchlist(): WatchlistSymbol[] {
  try {
    const raw = localStorage.getItem(LS_WATCHLIST);
    if (raw) return JSON.parse(raw) as WatchlistSymbol[];
  } catch {}
  return MOCK_WATCHLIST;
}

function clamp(v: number, min = -100, max = 100) {
  return Math.max(min, Math.min(max, v));
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [watchlist, setWatchlist] = useState<WatchlistSymbol[]>(loadInitialWatchlist);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');

  // Separate symbol list — only changes when user adds/removes symbols.
  // Avoids reconnecting the WS on every score/price tick.
  const [symbolsList, setSymbolsList] = useState<string[]>(() =>
    loadInitialWatchlist().map(w => w.symbol)
  );

  const streamRef = useRef<MarkPriceStream | null>(null);

  // ── Persist watchlist to localStorage ──────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(LS_WATCHLIST, JSON.stringify(watchlist));
      localStorage.setItem(LS_SYMBOLS, JSON.stringify(symbolsList));
    } catch {}
  }, [watchlist, symbolsList]);

  // ── Binance mark-price WebSocket ────────────────────────────────
  useEffect(() => {
    if (symbolsList.length === 0) {
      setStreamStatus('offline');
      streamRef.current?.disconnect();
      return;
    }

    const handleUpdate = (upd: { symbol: string; markPrice: number; fundingRate: number }) => {
      setWatchlist(prev =>
        prev.map(w =>
          w.symbol === upd.symbol
            ? { ...w, price: upd.markPrice, fundingRate: upd.fundingRate }
            : w
        )
      );
    };

    if (!streamRef.current) {
      streamRef.current = new MarkPriceStream(handleUpdate, setStreamStatus);
      streamRef.current.connect(symbolsList);
    } else {
      streamRef.current.updateSymbols(symbolsList);
    }
  }, [symbolsList]); // only re-runs when user adds/removes a symbol

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.disconnect();
      streamRef.current = null;
    };
  }, []);

  // ── Initial REST seed: mark prices + 24h stats ──────────────────
  useEffect(() => {
    if (symbolsList.length === 0) return;

    // Fetch initial mark prices so the UI shows real numbers before the WS fires
    fetchMarkPrices(symbolsList).then(prices => {
      if (Object.keys(prices).length === 0) return;
      setWatchlist(prev =>
        prev.map(w => {
          const p = prices[w.symbol];
          return p !== undefined ? { ...w, price: p } : w;
        })
      );
    });

    // Fetch 24h change % and volume
    fetch24hStats(symbolsList).then(stats => {
      setWatchlist(prev =>
        prev.map(w => {
          const s = stats[w.symbol];
          return s !== undefined
            ? { ...w, change24h: s.changePercent, volume24h: s.volume }
            : w;
        })
      );
    });
  }, [symbolsList]);

  // ── Strategy score simulation (independent of price feed) ──────
  useEffect(() => {
    const id = setInterval(() => {
      setWatchlist(prev =>
        prev.map(w => {
          const s1 = clamp(w.score1h + (Math.random() * 6 - 3));
          const s4 = clamp(w.score4h + (Math.random() * 3 - 1.5));
          const sd = clamp(w.score1d + (Math.random() * 1.5 - 0.75));
          return {
            ...w,
            score1h: s1,
            score4h: s4,
            score1d: sd,
            combinedScore: clamp(s1 * 0.5 + s4 * 0.3 + sd * 0.2),
          };
        })
      );
    }, 3_000);
    return () => clearInterval(id);
  }, []);

  // ── Add / Remove symbols ────────────────────────────────────────
  const addSymbol = useCallback((sym: string) => {
    const s = sym.toUpperCase().endsWith('USDT')
      ? sym.toUpperCase()
      : `${sym.toUpperCase()}USDT`;

    setWatchlist(prev => {
      if (prev.find(p => p.symbol === s)) return prev;
      return [...prev, {
        symbol: s, price: 0, change24h: 0, volume24h: 0,
        score1h: 0, score4h: 0, score1d: 0, combinedScore: 0,
      }];
    });
    setSymbolsList(prev => {
      if (prev.includes(s)) return prev;
      return [...prev, s];
    });
  }, []);

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

export function useWatchlistContext() {
  const ctx = useContext(WatchlistContext);
  if (!ctx) throw new Error('useWatchlistContext must be used within WatchlistProvider');
  return ctx;
}
