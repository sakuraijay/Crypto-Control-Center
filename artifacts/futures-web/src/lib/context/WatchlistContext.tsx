import {
  createContext, useContext, useState, useEffect,
  ReactNode, useCallback, useRef,
} from 'react';
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

/** 심볼 → 0으로 초기화된 watchlist 행. 가격·24h 변동은 실데이터 로드 후에만 채워진다. */
function emptyRow(symbol: string): WatchlistSymbol {
  return {
    symbol, displaySymbol: displaySymbol(symbol),
    price: 0, change24h: 0, volume24h: 0,
    score1h: 0, score4h: 0, score1d: 0, combinedScore: 0,
    borrowingRatePerHour: 0,
  };
}

/**
 * 초기 watchlist — localStorage에서는 **심볼 목록만** 복원한다.
 * 과거에 저장된 mock 가격·랜덤 점수는 무시 (모든 수치는 0에서 시작해
 * 실제 GMX 가격/24h 변동 데이터로만 갱신됨).
 */
function loadInitialWatchlist(): WatchlistSymbol[] {
  let symbols: string[] = [...DEFAULT_WATCHLIST_SYMBOLS];
  try {
    const raw = localStorage.getItem(LS_SYMBOLS);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(s => typeof s === 'string' && !s.includes('USDT'))) {
        symbols = parsed;
      }
    }
  } catch {}
  return symbols.map(emptyRow);
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [watchlist, setWatchlist] = useState<WatchlistSymbol[]>(loadInitialWatchlist);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');

  const [symbolsList, setSymbolsList] = useState<string[]>(() =>
    loadInitialWatchlist().map(w => w.symbol)
  );

  const streamRef = useRef<GmxPriceStream | null>(null);

  // ── Persist to localStorage — 심볼 목록만 저장 (수치 캐시 금지) ──
  useEffect(() => {
    try {
      localStorage.removeItem(LS_WATCHLIST); // 과거 mock 수치 캐시 제거
      localStorage.setItem(LS_SYMBOLS, JSON.stringify(symbolsList));
    } catch {}
  }, [symbolsList]);

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
        const res = await fetch('/api/gmx/change24h');
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

  // NOTE: 과거의 "strategy score simulation"(랜덤 점수 드리프트)은 제거됨 —
  // 점수는 실제 산출 소스가 연결되기 전까지 0으로 유지된다.

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
