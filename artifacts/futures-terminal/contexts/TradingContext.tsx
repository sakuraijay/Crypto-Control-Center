import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { MOCK_ACCOUNT, MOCK_POSITIONS, MOCK_TRADES } from '@/constants/mockData';
import { GmxPriceStream } from '@/services/gmxPriceStream';
import { MARKET_BY_SYMBOL } from '@/lib/gmx/markets';

// ── Types (GMX V2) ────────────────────────────────────────────────────────────

export interface Position {
  id: string;
  symbol: string;          // GMX index symbol: "ETH", "BTC"
  displaySymbol: string;   // "ETH/USD"
  side: 'LONG' | 'SHORT';
  isLong: boolean;
  // USD-denominated (GMX native)
  sizeInUsd: number;       // total position value in USD
  collateralUsd: number;   // deposited collateral in USD
  collateralToken: string; // "USDC", "WBTC.b", "WETH"
  leverage: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  roe: number;             // return on collateral %
  pendingBorrowingFeeUsd: number;
  pendingFundingFeeUsd: number;
  openTime: Date;
  tpPrice?: number;
  slPrice?: number;
}

export interface Trade {
  id: string;
  symbol: string;
  displaySymbol: string;
  side: 'LONG' | 'SHORT';
  action: 'OPEN' | 'CLOSE';
  sizeInUsd: number;
  price: number;
  pnl: number;
  collateralToken?: string;
  gmxMarketAddress?: string; // GMX market token address (Arbitrum One)
  strategy: string;
  timestamp: Date;
  closeTime: number;
}

export interface AccountSummary {
  balance: number;
  collateralBalanceUsd: number;  // replaces marginBalance (GMX: deposited USDC)
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
  orderType: 'MarketIncrease' | 'LimitIncrease' | 'MarketDecrease' | 'LimitDecrease';
  sizeInUsd: number;          // GMX-native: position size in USD
  leverage: number;
  collateralToken?: string;   // default "USDC"
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
  closeAllPositions: () => void;  // alias expected by EngineContext
  clearAllPositions: () => void;
  updatePositionRisk: (id: string, tp: number | null, sl: number | null) => void;
}

const TradingContext = createContext<TradingContextType | undefined>(undefined);

// API server base
const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api-server/api`
  : '/api-server/api';

// GMX fallback prices (before live feed arrives)
const FALLBACK_PRICES: Record<string, number> = {
  ETH: 1877, BTC: 43856, SOL: 101,
  ARB: 0.52, LINK: 14.5, AVAX: 25, DOGE: 0.093,
};

function calcLiqPrice(side: 'LONG' | 'SHORT', entry: number, lev: number): number {
  const mm = 0.01; // 1% GMX maintenance margin
  return side === 'LONG'
    ? entry * (1 - (1 / lev - mm))
    : entry * (1 + (1 / lev - mm));
}

function displaySym(sym: string): string {
  return `${sym}/USD`;
}

function persistTrade(trade: Trade) {
  fetch(`${API_BASE}/data/trades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...trade, timestamp: trade.timestamp.toISOString() }),
  }).catch(() => {});
}

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const [positions, setPositions] = useState<Position[]>(MOCK_POSITIONS as Position[]);
  const [trades, setTrades]       = useState<Trade[]>(MOCK_TRADES as Trade[]);
  const [account, setAccount]     = useState<AccountSummary>(MOCK_ACCOUNT as AccountSummary);

  const syncedIds  = useRef<Set<string>>(new Set((MOCK_TRADES as Trade[]).map(t => t.id)));
  const livePrices = useRef<Map<string, number>>(new Map());
  const streamRef  = useRef<GmxPriceStream | null>(null);

  // ── Load persisted trades on mount ──────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/data/trades`, { signal: AbortSignal.timeout(6_000) })
      .then(r => r.ok ? r.json() : null)
      .then((rows: Array<{
        id: string; symbol: string; side: string; action?: string;
        sizeInUsd?: string; size?: string; price: string; pnl: string;
        strategy: string; timestamp: string; closeTime?: number;
      }> | null) => {
        if (!rows || rows.length === 0) return;
        const loaded: Trade[] = rows.map(r => ({
          id:            r.id,
          symbol:        r.symbol,
          displaySymbol: displaySym(r.symbol),
          side:          r.side as 'LONG' | 'SHORT',
          action:        (r.action ?? 'CLOSE') as 'OPEN' | 'CLOSE',
          sizeInUsd:     parseFloat(r.sizeInUsd ?? r.size ?? '0'),
          price:         parseFloat(r.price),
          pnl:           parseFloat(r.pnl),
          strategy:      r.strategy,
          timestamp:     new Date(r.timestamp),
          closeTime:     r.closeTime ?? 0,
        }));
        setTrades(loaded);
        syncedIds.current = new Set(loaded.map(t => t.id));
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync new trades to server ────────────────────────────────────
  useEffect(() => {
    for (const trade of trades) {
      if (!syncedIds.current.has(trade.id)) {
        syncedIds.current.add(trade.id);
        persistTrade(trade);
      }
    }
  }, [trades]);

  // ── GMX price stream for open position symbols ──────────────────
  const posSymbolsKey = [...new Set(positions.map(p => p.symbol))].sort().join(',');
  useEffect(() => {
    const syms = [...new Set(positions.map(p => p.symbol))];
    if (syms.length === 0) { streamRef.current?.disconnect(); return; }
    if (!streamRef.current) {
      streamRef.current = new GmxPriceStream(
        tick => { livePrices.current.set(tick.tokenSymbol, tick.priceUsd); },
        () => {},
      );
      streamRef.current.connect(syms);
    } else {
      streamRef.current.updateSymbols(syms);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posSymbolsKey]);

  useEffect(() => () => { streamRef.current?.disconnect(); streamRef.current = null; }, []);

  // ── 1-second price tick ──────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      setPositions(prev => {
        const closed: Position[] = [];
        const next:   Position[] = [];

        for (const pos of prev) {
          const live = livePrices.current.get(pos.symbol);
          const newMark = live !== undefined
            ? live + live * (Math.random() * 0.0001 - 0.00005)
            : pos.markPrice + pos.markPrice * (Math.random() * 0.004 - 0.002);

          const ratio  = pos.side === 'LONG'
            ? (newMark - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - newMark) / pos.entryPrice;
          const pnl = ratio * pos.sizeInUsd;
          const roe = pos.collateralUsd > 0 ? (pnl / pos.collateralUsd) * 100 : 0;

          const borrow = pos.pendingBorrowingFeeUsd + pos.sizeInUsd * 0.00003 / 3600;

          // TP/SL check
          let shouldClose = false;
          if (pos.tpPrice) {
            if (pos.side === 'LONG'  && newMark >= pos.tpPrice) shouldClose = true;
            if (pos.side === 'SHORT' && newMark <= pos.tpPrice) shouldClose = true;
          }
          if (pos.slPrice) {
            if (pos.side === 'LONG'  && newMark <= pos.slPrice) shouldClose = true;
            if (pos.side === 'SHORT' && newMark >= pos.slPrice) shouldClose = true;
          }

          if (shouldClose) {
            closed.push({ ...pos, markPrice: newMark, unrealizedPnl: pnl, roe });
          } else {
            next.push({ ...pos, markPrice: newMark, unrealizedPnl: pnl, roe, pendingBorrowingFeeUsd: borrow });
          }
        }

        if (closed.length > 0) {
          const now = Date.now();
          const newTrades: Trade[] = closed.map(pos => ({
            id: `${now}-${pos.id}`, symbol: pos.symbol, displaySymbol: pos.displaySymbol,
            side: pos.side, action: 'CLOSE' as const, sizeInUsd: pos.sizeInUsd,
            price: pos.markPrice, pnl: pos.unrealizedPnl,
            collateralToken: pos.collateralToken, strategy: 'TP/SL',
            timestamp: new Date(), closeTime: now,
          }));
          setTrades(t => [...newTrades, ...t]);
          setAccount(a => ({
            ...a,
            realizedPnlToday: a.realizedPnlToday + closed.reduce((s, p) => s + p.unrealizedPnl, 0),
            availableBalance:  a.availableBalance  + closed.reduce((s, p) => s + p.collateralUsd + p.unrealizedPnl, 0),
          }));
        }

        return next;
      });
    }, 1_000);
    return () => clearInterval(interval);
  }, []);

  // ── Keep account in sync with positions ──────────────────────────
  useEffect(() => {
    const total    = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const posValue = positions.reduce((s, p) => s + p.sizeInUsd + p.unrealizedPnl, 0);
    const colUsed  = positions.reduce((s, p) => s + p.collateralUsd, 0);
    setAccount(prev => ({
      ...prev,
      unrealizedPnl:      total,
      totalPositionValue: posValue,
      marginRatio:        prev.collateralBalanceUsd > 0 ? colUsed / prev.collateralBalanceUsd : 0,
    }));
  }, [positions]);

  // ── placeOrder ───────────────────────────────────────────────────
  const placeOrder = useCallback((params: NewOrderParams): PlaceOrderResult => {
    const isMarket = params.orderType === 'MarketIncrease';
    const entry = isMarket
      ? (livePrices.current.get(params.symbol) ?? FALLBACK_PRICES[params.symbol] ?? 100)
      : (params.limitPrice ?? 0);
    if (entry <= 0) return { success: false, error: 'Invalid entry price.' };

    const collateralUsd = params.sizeInUsd / params.leverage;
    const sym           = params.symbol.toUpperCase();
    const now           = Date.now();

    const newPos: Position = {
      id: `pos-${now}`, symbol: sym, displaySymbol: displaySym(sym),
      side: params.side, isLong: params.side === 'LONG',
      sizeInUsd: params.sizeInUsd, collateralUsd,
      collateralToken: params.collateralToken ?? 'USDC',
      leverage: params.leverage, entryPrice: entry, markPrice: entry,
      liquidationPrice: calcLiqPrice(params.side, entry, params.leverage),
      unrealizedPnl: 0, roe: 0,
      pendingBorrowingFeeUsd: 0, pendingFundingFeeUsd: 0,
      openTime: new Date(), tpPrice: params.tpPrice, slPrice: params.slPrice,
    };

    setPositions(prev => [...prev, newPos]);
    setAccount(a => ({
      ...a,
      availableBalance:   a.availableBalance   - collateralUsd,
      totalPositionValue: a.totalPositionValue + params.sizeInUsd,
    }));
    const trade: Trade = {
      id: `${now}-open`, symbol: sym, displaySymbol: displaySym(sym),
      side: params.side, action: 'OPEN', sizeInUsd: params.sizeInUsd,
      price: entry, pnl: 0,
      collateralToken: params.collateralToken ?? 'USDC',
      gmxMarketAddress: MARKET_BY_SYMBOL.get(sym)?.marketAddress,
      strategy: 'Manual', timestamp: new Date(), closeTime: 0,
    };
    setTrades(t => [trade, ...t]);
    return { success: true };
  }, []);

  // ── closePosition ────────────────────────────────────────────────
  const closePosition = useCallback((id: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === id);
      if (pos) {
        const now = Date.now();
        const trade: Trade = {
          id: `${now}-close`, symbol: pos.symbol, displaySymbol: pos.displaySymbol,
          side: pos.side, action: 'CLOSE', sizeInUsd: pos.sizeInUsd,
          price: pos.markPrice, pnl: pos.unrealizedPnl,
          collateralToken: pos.collateralToken,
          gmxMarketAddress: MARKET_BY_SYMBOL.get(pos.symbol)?.marketAddress,
          strategy: 'Manual', timestamp: new Date(), closeTime: now,
        };
        setTrades(t => [trade, ...t]);
        setAccount(a => ({
          ...a,
          realizedPnlToday: a.realizedPnlToday + pos.unrealizedPnl,
          weeklyPnl:        a.weeklyPnl        + pos.unrealizedPnl,
          availableBalance:  a.availableBalance  + pos.collateralUsd + pos.unrealizedPnl,
        }));
      }
      return prev.filter(p => p.id !== id);
    });
  }, []);

  // ── clearAllPositions / closeAllPositions ────────────────────────
  const clearAllPositions = useCallback(() => {
    setPositions(prev => {
      const totalPnl = prev.reduce((s, p) => s + p.unrealizedPnl, 0);
      const totalCol = prev.reduce((s, p) => s + p.collateralUsd,  0);
      setAccount(a => ({
        ...a,
        realizedPnlToday: a.realizedPnlToday + totalPnl,
        weeklyPnl:        a.weeklyPnl        + totalPnl,
        availableBalance:  a.availableBalance  + totalCol + totalPnl,
      }));
      return [];
    });
  }, []);

  const closeAllPositions = clearAllPositions; // alias expected by EngineContext

  // ── updatePositionRisk ───────────────────────────────────────────
  const updatePositionRisk = useCallback((id: string, tp: number | null, sl: number | null) => {
    setPositions(prev => prev.map(p => p.id === id ? { ...p, tpPrice: tp ?? undefined, slPrice: sl ?? undefined } : p));
  }, []);

  return (
    <TradingContext.Provider value={{
      account, positions, trades,
      placeOrder, closePosition, closeAllPositions, clearAllPositions, updatePositionRisk,
    }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTrading must be used within TradingProvider');
  return ctx;
}
