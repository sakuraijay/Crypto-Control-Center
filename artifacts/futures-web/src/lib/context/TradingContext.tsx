import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { MOCK_ACCOUNT, MOCK_POSITIONS, MOCK_TRADES, MOCK_LOGS } from '../../../../futures-terminal/constants/mockData';
import {
  Account, Position, Trade, StrategyLog,
  NewOrderParams, EquityPoint, TodayStats,
} from './AppContext';
import { useAppContext } from './AppContext';
import { MarkPriceStream } from '../binance/markPriceStream';

export interface PlaceOrderResult {
  success: boolean;
  error?: string;
}

interface TradingContextType {
  account: Account;
  positions: Position[];
  closedTrades: Trade[];
  logs: StrategyLog[];
  equityHistory: EquityPoint[];
  todayStats: TodayStats;
  placeOrder: (params: NewOrderParams) => PlaceOrderResult;
  closePosition: (id: string) => void;
  clearAllPositions: () => void;
  updatePositionRisk: (id: string, tp: number | null, sl: number | null) => void;
}

const TradingContext = createContext<TradingContextType | undefined>(undefined);

// Fallback prices used before live WS data arrives or for unknown symbols
const FALLBACK_PRICES: Record<string, number> = {
  BTCUSDT: 43856, ETHUSDT: 2356, SOLUSDT: 101,
  BNBUSDT: 312, ADAUSDT: 0.48, DOGEUSDT: 0.093, XRPUSDT: 0.56,
};

function calcLiquidationPrice(side: 'LONG' | 'SHORT', entryPrice: number, leverage: number): number {
  const mm = 0.005; // maintenance margin 0.5%
  return side === 'LONG'
    ? entryPrice * (1 - 1 / leverage + mm)
    : entryPrice * (1 + 1 / leverage - mm);
}

function generateInitialEquity(currentBalance: number): EquityPoint[] {
  const points: EquityPoint[] = [];
  const now = Date.now();
  const startBalance = currentBalance * 0.91;
  for (let i = 47; i >= 1; i--) {
    const t = now - i * 30 * 60 * 1000;
    const progress = (47 - i) / 46;
    const noise = (Math.random() - 0.42) * 120;
    points.push({ time: t, equity: Math.max(currentBalance * 0.7, startBalance + (currentBalance - startBalance) * progress + noise) });
  }
  points.push({ time: now, equity: currentBalance + MOCK_ACCOUNT.unrealizedPnl });
  return points;
}

export function TradingProvider({ children }: { children: ReactNode }) {
  const { engineState, stopNewOrders } = useAppContext();

  const [positions, setPositions] = useState<Position[]>(MOCK_POSITIONS as Position[]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>(MOCK_TRADES);
  const [logs, setLogs] = useState<StrategyLog[]>(MOCK_LOGS);
  const [account, setAccount] = useState<Account>(MOCK_ACCOUNT);
  const [equityHistory, setEquityHistory] = useState<EquityPoint[]>(() =>
    generateInitialEquity(MOCK_ACCOUNT.balance)
  );

  // Live mark prices from Binance — updated by WS, consumed by tick loop
  const liveMarkPrices = useRef<Map<string, number>>(new Map());
  const posStreamRef = useRef<MarkPriceStream | null>(null);

  // ── Binance WS for active position symbols ──────────────────────
  const posSymbolsKey = positions.map(p => p.symbol).sort().join(',');
  useEffect(() => {
    const syms = [...new Set(positions.map(p => p.symbol))];
    if (syms.length === 0) {
      posStreamRef.current?.disconnect();
      return;
    }
    if (!posStreamRef.current) {
      posStreamRef.current = new MarkPriceStream(
        upd => { liveMarkPrices.current.set(upd.symbol, upd.markPrice); },
        () => {}, // status not shown in trading context
      );
      posStreamRef.current.connect(syms);
    } else {
      posStreamRef.current.updateSymbols(syms);
    }
  }, [posSymbolsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { posStreamRef.current?.disconnect(); posStreamRef.current = null; };
  }, []);

  // ── Equity snapshot every 30 s ──────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      setEquityHistory(prev => {
        const latest: EquityPoint = { time: Date.now(), equity: account.balance + account.unrealizedPnl };
        return [...(prev.length > 96 ? prev.slice(1) : prev), latest];
      });
    }, 30_000);
    return () => clearInterval(id);
  }, [account.balance, account.unrealizedPnl]);

  // ── Price tick every 1 s (uses live WS price when available) ────
  useEffect(() => {
    const id = setInterval(() => {
      setPositions(prev => {
        let totalUnrealized = 0;
        let totalPosValue = 0;

        const next = prev.map(pos => {
          // Prefer live Binance mark price; fall back to random walk when offline
          const livePrice = liveMarkPrices.current.get(pos.symbol);
          const newMark = livePrice !== undefined
            ? livePrice + livePrice * (Math.random() * 0.0001 - 0.00005) // minimal spread noise
            : pos.markPrice + pos.markPrice * (Math.random() * 0.002 - 0.001);

          const diff = pos.side === 'LONG' ? newMark - pos.entryPrice : pos.entryPrice - newMark;
          const newPnl = diff * pos.size;
          const newRoe = (newPnl / pos.marginUsed) * 100;

          totalUnrealized += newPnl;
          totalPosValue += newMark * pos.size;

          // TP/SL auto-close check
          let shouldClose = false;
          let closeReason = '';
          if (pos.tpPrice && pos.side === 'LONG' && newMark >= pos.tpPrice) { shouldClose = true; closeReason = 'TP HIT'; }
          if (pos.tpPrice && pos.side === 'SHORT' && newMark <= pos.tpPrice) { shouldClose = true; closeReason = 'TP HIT'; }
          if (pos.slPrice && pos.side === 'LONG' && newMark <= pos.slPrice) { shouldClose = true; closeReason = 'SL HIT'; }
          if (pos.slPrice && pos.side === 'SHORT' && newMark >= pos.slPrice) { shouldClose = true; closeReason = 'SL HIT'; }

          if (shouldClose) {
            setClosedTrades(ts => [{ id: `closed-${Date.now()}`, symbol: pos.symbol, side: pos.side, size: pos.size, price: newMark, pnl: newPnl, strategy: closeReason, timestamp: new Date() }, ...ts]);
            setLogs(l => [{ id: `log-${Date.now()}`, level: 'TRADE' as const, message: `[PAPER] ${closeReason}: ${pos.symbol} ${pos.side} PnL $${newPnl.toFixed(2)}`, timestamp: new Date() }, ...l]);
            return null;
          }

          return { ...pos, markPrice: newMark, unrealizedPnl: newPnl, roe: newRoe };
        }).filter(Boolean) as Position[];

        setAccount(a => ({
          ...a, unrealizedPnl: totalUnrealized, totalPositionValue: totalPosValue,
          marginRatio: a.marginBalance > 0 ? (a.marginBalance - a.availableBalance) / a.marginBalance : 0,
        }));

        return next;
      });
    }, 1_000); // 1-second tick to match Binance stream frequency
    return () => clearInterval(id);
  }, []);

  // ── Today stats ─────────────────────────────────────────────────
  const todayStats: TodayStats = (() => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = closedTrades.filter(t => new Date(t.timestamp) >= midnight);
    return {
      realized: today.reduce((s, t) => s + t.pnl, 0),
      wins: today.filter(t => t.pnl > 0).length,
      losses: today.filter(t => t.pnl <= 0).length,
      count: today.length,
    };
  })();

  // ── placeOrder ──────────────────────────────────────────────────
  const placeOrder = useCallback((params: NewOrderParams): PlaceOrderResult => {
    if (engineState === 'EMERGENCY_STOP') return { success: false, error: 'Emergency stop is active. Reset before trading.' };
    if (stopNewOrders) return { success: false, error: 'New orders are currently disabled.' };
    if (engineState === 'OFFLINE') return { success: false, error: 'Engine is offline. Set to PAPER TRADING to trade.' };

    const entryPrice = params.orderType === 'MARKET'
      ? (liveMarkPrices.current.get(params.symbol) ?? FALLBACK_PRICES[params.symbol] ?? 100)
      : (params.limitPrice ?? 0);

    if (entryPrice <= 0) return { success: false, error: 'Invalid price. Set a valid limit price.' };

    const marginUsed = (entryPrice * params.size) / params.leverage;
    const liquidationPrice = calcLiquidationPrice(params.side, entryPrice, params.leverage);

    const newPos: Position = {
      id: `pos-${Date.now()}`,
      symbol: params.symbol, side: params.side, size: params.size,
      entryPrice, markPrice: entryPrice, liquidationPrice,
      unrealizedPnl: 0, roe: 0, marginUsed, leverage: params.leverage,
      openTime: new Date(), tpPrice: params.tpPrice, slPrice: params.slPrice,
    };

    setPositions(prev => [...prev, newPos]);
    setAccount(a => ({ ...a, availableBalance: a.availableBalance - marginUsed, totalPositionValue: a.totalPositionValue + entryPrice * params.size }));
    setLogs(l => [{ id: `log-${Date.now()}`, level: 'TRADE' as const, message: `[PAPER] OPENED ${params.symbol} ${params.side} ${params.size} @ ${entryPrice.toFixed(2)} × ${params.leverage}x (${params.orderType})`, timestamp: new Date() }, ...l]);
    return { success: true };
  }, [engineState, stopNewOrders]);

  // ── closePosition ───────────────────────────────────────────────
  const closePosition = useCallback((id: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === id);
      if (!pos) return prev;
      const remaining = prev.filter(p => p.id !== id);
      setAccount(a => ({ ...a, unrealizedPnl: remaining.reduce((s, p) => s + p.unrealizedPnl, 0), totalPositionValue: remaining.reduce((s, p) => s + p.markPrice * p.size, 0), realizedPnlToday: a.realizedPnlToday + pos.unrealizedPnl, availableBalance: a.availableBalance + pos.marginUsed + pos.unrealizedPnl }));
      setClosedTrades(ts => [{ id: `closed-${Date.now()}`, symbol: pos.symbol, side: pos.side, size: pos.size, price: pos.markPrice, pnl: pos.unrealizedPnl, strategy: 'Manual', timestamp: new Date() }, ...ts]);
      setLogs(l => [{ id: `log-${Date.now()}`, level: 'TRADE' as const, message: `[PAPER] CLOSED ${pos.symbol} ${pos.side} — PnL $${pos.unrealizedPnl.toFixed(2)}`, timestamp: new Date() }, ...l]);
      return remaining;
    });
  }, []);

  // ── clearAllPositions ───────────────────────────────────────────
  const clearAllPositions = useCallback(() => {
    setPositions(prev => {
      const now = Date.now();
      const newTrades: Trade[] = prev.map((pos, i) => ({ id: `closed-${now}-${i}`, symbol: pos.symbol, side: pos.side, size: pos.size, price: pos.markPrice, pnl: pos.unrealizedPnl, strategy: 'Clear All', timestamp: new Date() }));
      setClosedTrades(ts => [...newTrades, ...ts]);
      setAccount(a => ({ ...a, unrealizedPnl: 0, totalPositionValue: 0 }));
      setLogs(l => [{ id: `log-${now}`, level: 'WARN' as const, message: '[PAPER] All positions cleared', timestamp: new Date() }, ...l]);
      return [];
    });
  }, []);

  // ── updatePositionRisk ──────────────────────────────────────────
  const updatePositionRisk = useCallback((id: string, tp: number | null, sl: number | null) => {
    setPositions(prev => prev.map(p => p.id === id ? { ...p, tpPrice: tp ?? undefined, slPrice: sl ?? undefined } : p));
    setLogs(l => [{ id: `log-${Date.now()}`, level: 'INFO' as const, message: `[PAPER] Updated risk orders: TP=${tp ?? 'none'} SL=${sl ?? 'none'}`, timestamp: new Date() }, ...l]);
  }, []);

  return (
    <TradingContext.Provider value={{ account, positions, closedTrades, logs, equityHistory, todayStats, placeOrder, closePosition, clearAllPositions, updatePositionRisk }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTradingContext must be used within TradingProvider');
  return ctx;
}
