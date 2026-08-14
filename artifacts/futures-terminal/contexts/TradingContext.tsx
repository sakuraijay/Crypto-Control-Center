import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { MOCK_ACCOUNT, MOCK_POSITIONS, MOCK_TRADES } from '@/constants/mockData';
import { MarkPriceStream } from '@/services/binanceMarkPriceStream';

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
  tpPrice?: number;
  slPrice?: number;
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
  closeTime: number; // unix ms — used for today-stats filtering
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

export interface NewOrderParams {
  symbol: string;
  side: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT';
  size: number;
  leverage: number;
  limitPrice?: number;
  tpPrice?: number;
  slPrice?: number;
}

export interface PlaceOrderResult {
  success: boolean;
  error?: string;
}

interface TradingContextType {
  account: AccountSummary;
  positions: Position[];
  trades: Trade[];
  placeOrder: (params: NewOrderParams) => PlaceOrderResult;
  closePosition: (id: string) => void;
  clearAllPositions: () => void;
  updatePositionRisk: (id: string, tp: number | null, sl: number | null) => void;
}

const TradingContext = createContext<TradingContextType | undefined>(undefined);

// Fallback prices used before live WS data arrives
const FALLBACK_PRICES: Record<string, number> = {
  BTCUSDT: 43856, ETHUSDT: 2356, SOLUSDT: 101,
  BNBUSDT: 312, ADAUSDT: 0.48, DOGEUSDT: 0.093, XRPUSDT: 0.56,
};

function calcLiqPrice(side: 'LONG' | 'SHORT', entry: number, lev: number) {
  return side === 'LONG'
    ? entry * (1 - 1 / lev + 0.005)
    : entry * (1 + 1 / lev - 0.005);
}

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const [positions, setPositions] = useState<Position[]>(MOCK_POSITIONS as Position[]);
  const [trades, setTrades] = useState<Trade[]>(MOCK_TRADES as Trade[]);
  const [account, setAccount] = useState<AccountSummary>(MOCK_ACCOUNT);

  // Live mark prices from Binance WebSocket
  const liveMarkPrices = useRef<Map<string, number>>(new Map());
  const posStreamRef = useRef<MarkPriceStream | null>(null);

  // ── Binance WS for active position symbols ──────────────────────
  const posSymbolsKey = [...new Set(positions.map(p => p.symbol))].sort().join(',');
  useEffect(() => {
    const syms = [...new Set(positions.map(p => p.symbol))];
    if (syms.length === 0) {
      posStreamRef.current?.disconnect();
      return;
    }
    if (!posStreamRef.current) {
      posStreamRef.current = new MarkPriceStream(
        upd => { liveMarkPrices.current.set(upd.symbol, upd.markPrice); },
        () => {},
      );
      posStreamRef.current.connect(syms);
    } else {
      posStreamRef.current.updateSymbols(syms);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posSymbolsKey]);

  useEffect(() => {
    return () => { posStreamRef.current?.disconnect(); posStreamRef.current = null; };
  }, []);

  // ── Price tick every 1 s (live price preferred, random walk fallback) ─
  useEffect(() => {
    const interval = setInterval(() => {
      setPositions(prev => {
        const closed: Position[] = [];
        const next: Position[] = [];

        for (const pos of prev) {
          const livePrice = liveMarkPrices.current.get(pos.symbol);
          const newMark = livePrice !== undefined
            ? livePrice + livePrice * (Math.random() * 0.0001 - 0.00005)
            : pos.markPrice + pos.markPrice * (Math.random() * 0.004 - 0.002);

          const pnlPerUnit = pos.side === 'LONG' ? newMark - pos.entryPrice : pos.entryPrice - newMark;
          const unrealizedPnl = pnlPerUnit * pos.size;
          const roe = (unrealizedPnl / pos.marginUsed) * 100;

          // TP/SL check
          let shouldClose = false;
          let closeReason = '';
          if (pos.tpPrice && pos.side === 'LONG' && newMark >= pos.tpPrice) { shouldClose = true; closeReason = 'TP/SL'; }
          if (pos.tpPrice && pos.side === 'SHORT' && newMark <= pos.tpPrice) { shouldClose = true; closeReason = 'TP/SL'; }
          if (pos.slPrice && pos.side === 'LONG' && newMark <= pos.slPrice) { shouldClose = true; closeReason = 'TP/SL'; }
          if (pos.slPrice && pos.side === 'SHORT' && newMark >= pos.slPrice) { shouldClose = true; closeReason = 'TP/SL'; }

          if (shouldClose) {
            closed.push({ ...pos, markPrice: newMark, unrealizedPnl, roe });
          } else {
            next.push({ ...pos, markPrice: newMark, unrealizedPnl, roe });
          }
        }

        if (closed.length > 0) {
          const now = Date.now();
          const newTrades: Trade[] = closed.map(pos => ({
            id: `${now}-${pos.id}`,
            symbol: pos.symbol, side: pos.side, action: 'CLOSE' as const,
            size: pos.size, price: pos.markPrice, pnl: pos.unrealizedPnl,
            strategy: 'TP/SL', timestamp: new Date(), closeTime: now,
          }));
          setTrades(t => [...newTrades, ...t]);
          setAccount(a => ({
            ...a,
            realizedPnlToday: a.realizedPnlToday + closed.reduce((s, p) => s + p.unrealizedPnl, 0),
            availableBalance: a.availableBalance + closed.reduce((s, p) => s + p.marginUsed + p.unrealizedPnl, 0),
          }));
        }

        return next;
      });
    }, 1_000);
    return () => clearInterval(interval);
  }, []);

  // ── Keep account unrealizedPnl in sync ──────────────────────────
  useEffect(() => {
    const total = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const posValue = positions.reduce((s, p) => s + p.markPrice * p.size, 0);
    const marginUsed = positions.reduce((s, p) => s + p.marginUsed, 0);
    setAccount(prev => ({
      ...prev,
      unrealizedPnl: total,
      totalPositionValue: posValue,
      marginRatio: prev.marginBalance > 0 ? marginUsed / prev.marginBalance : 0,
    }));
  }, [positions]);

  // ── placeOrder ──────────────────────────────────────────────────
  const placeOrder = useCallback((params: NewOrderParams): PlaceOrderResult => {
    const entry = params.orderType === 'MARKET'
      ? (liveMarkPrices.current.get(params.symbol) ?? FALLBACK_PRICES[params.symbol] ?? 100)
      : (params.limitPrice ?? 0);
    if (entry <= 0) return { success: false, error: 'Invalid entry price.' };

    const marginUsed = (entry * params.size) / params.leverage;
    const now = Date.now();
    const newPos: Position = {
      id: `pos-${now}`,
      symbol: params.symbol, side: params.side, size: params.size,
      entryPrice: entry, markPrice: entry, leverage: params.leverage,
      marginUsed, unrealizedPnl: 0, roe: 0,
      liquidationPrice: calcLiqPrice(params.side, entry, params.leverage),
      openTime: new Date(), tpPrice: params.tpPrice, slPrice: params.slPrice,
    };

    setPositions(prev => [...prev, newPos]);
    setAccount(a => ({ ...a, availableBalance: a.availableBalance - marginUsed, totalPositionValue: a.totalPositionValue + entry * params.size }));
    const trade: Trade = { id: `${now}-open`, symbol: params.symbol, side: params.side, action: 'OPEN', size: params.size, price: entry, pnl: 0, strategy: 'Manual', timestamp: new Date(), closeTime: 0 };
    setTrades(t => [trade, ...t]);
    return { success: true };
  }, []);

  // ── closePosition ───────────────────────────────────────────────
  const closePosition = useCallback((id: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === id);
      if (pos) {
        const now = Date.now();
        const trade: Trade = { id: `${now}-close`, symbol: pos.symbol, side: pos.side, action: 'CLOSE', size: pos.size, price: pos.markPrice, pnl: pos.unrealizedPnl, strategy: 'Manual', timestamp: new Date(), closeTime: now };
        setTrades(t => [trade, ...t]);
        setAccount(a => ({ ...a, realizedPnlToday: a.realizedPnlToday + pos.unrealizedPnl, weeklyPnl: a.weeklyPnl + pos.unrealizedPnl, availableBalance: a.availableBalance + pos.marginUsed + pos.unrealizedPnl }));
      }
      return prev.filter(p => p.id !== id);
    });
  }, []);

  // ── clearAllPositions ───────────────────────────────────────────
  const clearAllPositions = useCallback(() => {
    setPositions(prev => {
      const totalPnl = prev.reduce((s, p) => s + p.unrealizedPnl, 0);
      const totalMargin = prev.reduce((s, p) => s + p.marginUsed, 0);
      setAccount(a => ({ ...a, realizedPnlToday: a.realizedPnlToday + totalPnl, weeklyPnl: a.weeklyPnl + totalPnl, availableBalance: a.availableBalance + totalMargin + totalPnl }));
      return [];
    });
  }, []);

  // ── updatePositionRisk ──────────────────────────────────────────
  const updatePositionRisk = useCallback((id: string, tp: number | null, sl: number | null) => {
    setPositions(prev => prev.map(p => p.id === id ? { ...p, tpPrice: tp ?? undefined, slPrice: sl ?? undefined } : p));
  }, []);

  return (
    <TradingContext.Provider value={{ account, positions, trades, placeOrder, closePosition, clearAllPositions, updatePositionRisk }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTrading must be used within TradingProvider');
  return ctx;
}
