import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { MOCK_ACCOUNT, MOCK_POSITIONS, MOCK_TRADES, MOCK_LOGS } from '../../../../futures-terminal/constants/mockData';
import {
  Account, Position, Trade, StrategyLog,
  NewOrderParams, EquityPoint, TodayStats,
} from './AppContext';
import { useAppContext } from './AppContext';
import { GmxPriceStream } from '../gmx/priceStream';
import { FALLBACK_PRICES, displaySymbol, MARKET_BY_SYMBOL } from '../gmx/markets';

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
  updatePositionRisk: (id: string, tp: number | null, sl: number | null, trailing?: number | null) => void;
  /** How many consecutive losing trades since last winner — updated live */
  consecutiveLosses: number;
}

const TradingContext = createContext<TradingContextType | undefined>(undefined);

/**
 * GMX V2 liquidation price (simplified, ignores accrued fees for paper trading)
 * LONG:  liq ≈ entry × (1 − (collateral/size − maintenanceMargin))
 * SHORT: liq ≈ entry × (1 + (collateral/size − maintenanceMargin))
 * maintenanceMargin on GMX ≈ 1% of size
 */
function calcLiqPrice(side: 'LONG' | 'SHORT', entry: number, leverage: number): number {
  const mm = 0.01; // 1% maintenance margin
  return side === 'LONG'
    ? entry * (1 - (1 / leverage - mm))
    : entry * (1 + (1 / leverage - mm));
}

function generateInitialEquity(balance: number): EquityPoint[] {
  const pts: EquityPoint[] = [];
  const now = Date.now();
  const start = balance * 0.91;
  for (let i = 47; i >= 1; i--) {
    const t = now - i * 30 * 60_000;
    const prog = (47 - i) / 46;
    const noise = (Math.random() - 0.42) * 120;
    pts.push({ time: t, equity: Math.max(balance * 0.7, start + (balance - start) * prog + noise) });
  }
  pts.push({ time: now, equity: balance + (MOCK_ACCOUNT as Account).unrealizedPnl });
  return pts;
}

function persistTrade(trade: Trade) {
  fetch('/api-server/api/data/trades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...trade,
      timestamp: trade.timestamp.toISOString(),
      closeTime: (trade as { closeTime?: number }).closeTime ?? 0,
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

export function TradingProvider({ children }: { children: ReactNode }) {
  const { engineState, stopNewOrders } = useAppContext();
  const consecutiveLossesRef = useRef(0);

  const [positions, setPositions] = useState<Position[]>(MOCK_POSITIONS as Position[]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>(MOCK_TRADES as Trade[]);
  const [logs, setLogs] = useState<StrategyLog[]>(MOCK_LOGS as StrategyLog[]);
  const [account, setAccount] = useState<Account>(MOCK_ACCOUNT as Account);
  const [equityHistory, setEquityHistory] = useState<EquityPoint[]>(() =>
    generateInitialEquity((MOCK_ACCOUNT as Account).balance)
  );

  const syncedIds = useRef<Set<string>>(new Set((MOCK_TRADES as Array<{ id: string }>).map(t => t.id)));

  // GMX oracle prices from polling stream
  const livePrices = useRef<Map<string, number>>(new Map());
  const streamRef  = useRef<GmxPriceStream | null>(null);

  // ── Load persisted trades from server on mount ─────────────────
  useEffect(() => {
    fetch('/api-server/api/data/trades', { signal: AbortSignal.timeout(5_000) })
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
          displaySymbol: displaySymbol(r.symbol),
          side:          r.side as 'LONG' | 'SHORT',
          action:        (r.action ?? 'CLOSE') as 'OPEN' | 'CLOSE',
          sizeInUsd:     parseFloat(r.sizeInUsd ?? r.size ?? '0'),
          price:         parseFloat(r.price),
          pnl:           parseFloat(r.pnl),
          strategy:      r.strategy,
          timestamp:     new Date(r.timestamp),
          closeTime:     r.closeTime ?? 0,
        }));
        setClosedTrades(loaded);
        syncedIds.current = new Set(loaded.map(t => t.id));
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync newly added trades to server ─────────────────────────
  useEffect(() => {
    for (const trade of closedTrades) {
      if (!syncedIds.current.has(trade.id)) {
        syncedIds.current.add(trade.id);
        persistTrade(trade);
      }
    }
  }, [closedTrades]);

  // ── GMX price stream for open position symbols ─────────────────
  const posSymbolsKey = [...new Set(positions.map(p => p.symbol))].sort().join(',');
  useEffect(() => {
    const syms = [...new Set(positions.map(p => p.symbol))];
    if (syms.length === 0) {
      streamRef.current?.disconnect();
      return;
    }
    if (!streamRef.current) {
      streamRef.current = new GmxPriceStream(
        priceMap => {
          priceMap.forEach((tick, sym) => {
            // only store by symbol string (not address)
            if (!sym.startsWith('0x')) {
              livePrices.current.set(sym, tick.priceUsd);
            }
          });
        },
        () => {}, // status not shown in trading context
      );
      streamRef.current.connect(syms);
    } else {
      streamRef.current.updateSymbols(syms);
    }
  }, [posSymbolsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { streamRef.current?.disconnect(); streamRef.current = null; };
  }, []);

  // ── Equity snapshot every 30 s ─────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      setEquityHistory(prev => {
        const pt: EquityPoint = { time: Date.now(), equity: account.balance + account.unrealizedPnl };
        return [...(prev.length > 96 ? prev.slice(1) : prev), pt];
      });
    }, 30_000);
    return () => clearInterval(id);
  }, [account.balance, account.unrealizedPnl]);

  // ── Price tick every 1 s (live GMX price preferred) ────────────
  useEffect(() => {
    const id = setInterval(() => {
      setPositions(prev => {
        let totalUnrealized = 0;
        let totalPosValue   = 0;

        const next = prev.map(pos => {
          const live = livePrices.current.get(pos.symbol);
          const newMark = live !== undefined
            ? live + live * (Math.random() * 0.0001 - 0.00005)
            : pos.markPrice + pos.markPrice * (Math.random() * 0.002 - 0.001);

          // GMX PnL: price delta relative to sizeInUsd
          const priceDeltaRatio = pos.side === 'LONG'
            ? (newMark - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - newMark) / pos.entryPrice;
          const newPnl = priceDeltaRatio * pos.sizeInUsd;
          const newRoe = pos.collateralUsd > 0 ? (newPnl / pos.collateralUsd) * 100 : 0;

          // Accrue fee simulation (tiny per-tick)
          const newBorrow  = pos.pendingBorrowingFeeUsd + pos.sizeInUsd * 0.00003 / 3600;
          const newFunding = pos.pendingFundingFeeUsd;

          totalUnrealized += newPnl;
          totalPosValue   += pos.sizeInUsd + newPnl;

          // ── Trailing stop ratchet ─────────────────────────────────────
          let updatedSlPrice = pos.slPrice;
          let updatedHighWater = pos._trailingHighWater;
          if (pos.trailingStopPct && pos.trailingStopPct > 0) {
            const hw = updatedHighWater ?? pos.entryPrice;
            if (pos.side === 'LONG' && newMark > hw) {
              updatedHighWater = newMark;
              updatedSlPrice   = newMark * (1 - pos.trailingStopPct / 100);
            } else if (pos.side === 'SHORT' && newMark < hw) {
              updatedHighWater = newMark;
              updatedSlPrice   = newMark * (1 + pos.trailingStopPct / 100);
            }
          }

          // ── TP / SL auto-close ─────────────────────────────────────────
          let shouldClose = false;
          let closeReason = '';
          if (pos.tpPrice) {
            if (pos.side === 'LONG'  && newMark >= pos.tpPrice) { shouldClose = true; closeReason = 'TP HIT'; }
            if (pos.side === 'SHORT' && newMark <= pos.tpPrice) { shouldClose = true; closeReason = 'TP HIT'; }
          }
          if (updatedSlPrice) {
            if (pos.side === 'LONG'  && newMark <= updatedSlPrice) { shouldClose = true; closeReason = pos.trailingStopPct ? 'TRAILING SL HIT' : 'SL HIT'; }
            if (pos.side === 'SHORT' && newMark >= updatedSlPrice) { shouldClose = true; closeReason = pos.trailingStopPct ? 'TRAILING SL HIT' : 'SL HIT'; }
          }

          if (shouldClose) {
            // Update consecutive loss counter
            if (newPnl < 0) {
              consecutiveLossesRef.current += 1;
            } else {
              consecutiveLossesRef.current = 0;
            }
            const closedTrade: Trade = {
              id: `closed-${Date.now()}-${pos.id}`,
              symbol: pos.symbol, displaySymbol: pos.displaySymbol, side: pos.side,
              action: 'CLOSE', sizeInUsd: pos.sizeInUsd,
              price: newMark, pnl: newPnl,
              collateralToken: pos.collateralToken,
              gmxMarketAddress: MARKET_BY_SYMBOL.get(pos.symbol)?.marketToken,
              strategy: closeReason,
              timestamp: new Date(), closeTime: Date.now(),
            };
            setClosedTrades(ts => [closedTrade, ...ts]);
            setLogs(l => [{
              id: `log-${Date.now()}`,
              level: 'TRADE' as const,
              message: `[PAPER] ${closeReason}: ${pos.displaySymbol} ${pos.side} PnL $${newPnl.toFixed(2)}`,
              timestamp: new Date(),
            }, ...l]);
            return null;
          }

          return {
            ...pos,
            markPrice: newMark, unrealizedPnl: newPnl, roe: newRoe,
            pendingBorrowingFeeUsd: newBorrow, pendingFundingFeeUsd: newFunding,
            slPrice: updatedSlPrice, _trailingHighWater: updatedHighWater,
          };
        }).filter(Boolean) as Position[];

        setAccount(a => ({
          ...a,
          unrealizedPnl: totalUnrealized,
          totalPositionValue: totalPosValue,
          marginRatio: a.collateralBalanceUsd > 0
            ? (a.collateralBalanceUsd - a.availableBalance) / a.collateralBalanceUsd
            : 0,
        }));

        return next;
      });
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  // ── Today stats ────────────────────────────────────────────────
  const todayStats: TodayStats = (() => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = closedTrades.filter(t => new Date(t.timestamp) >= midnight);
    return {
      realized: today.reduce((s, t) => s + t.pnl, 0),
      wins:     today.filter(t => t.pnl > 0).length,
      losses:   today.filter(t => t.pnl <= 0).length,
      count:    today.length,
    };
  })();

  // ── placeOrder ─────────────────────────────────────────────────
  const placeOrder = useCallback((params: NewOrderParams): PlaceOrderResult => {
    if (engineState === 'EMERGENCY_STOP')
      return { success: false, error: 'Emergency stop is active. Reset before trading.' };
    if (stopNewOrders)
      return { success: false, error: 'New orders are currently disabled.' };
    if (engineState === 'OFFLINE')
      return { success: false, error: 'Engine is offline. Set to PAPER TRADING to trade.' };

    const isMarket = params.orderType === 'MarketIncrease';
    const entryPrice = isMarket
      ? (livePrices.current.get(params.symbol) ?? FALLBACK_PRICES[params.symbol] ?? 100)
      : (params.limitPrice ?? 0);
    if (entryPrice <= 0) return { success: false, error: 'Invalid price. Set a valid limit price.' };

    const collateralUsd = params.sizeInUsd / params.leverage;
    const liqPrice      = calcLiqPrice(params.side, entryPrice, params.leverage);
    const collToken     = params.collateralToken ?? 'USDC';
    const sym           = params.symbol.toUpperCase();

    const newPos: Position = {
      id:                    `pos-${Date.now()}`,
      symbol:                sym,
      displaySymbol:         displaySymbol(sym),
      side:                  params.side,
      isLong:                params.side === 'LONG',
      sizeInUsd:             params.sizeInUsd,
      collateralUsd,
      collateralToken:       collToken,
      leverage:              params.leverage,
      entryPrice,
      markPrice:             entryPrice,
      liquidationPrice:      liqPrice,
      unrealizedPnl:         0,
      roe:                   0,
      pendingBorrowingFeeUsd: 0,
      pendingFundingFeeUsd:   0,
      openTime:              new Date(),
      tpPrice:               params.tpPrice,
      slPrice:               params.slPrice,
      trailingStopPct:       params.trailingStopPct,
      _trailingHighWater:    params.trailingStopPct ? entryPrice : undefined,
    };

    setPositions(prev => [...prev, newPos]);
    setAccount(a => ({
      ...a,
      availableBalance:   a.availableBalance   - collateralUsd,
      totalPositionValue: a.totalPositionValue + params.sizeInUsd,
    }));
    setLogs(l => [{
      id: `log-${Date.now()}`, level: 'TRADE' as const,
      message: `[PAPER] OPENED ${displaySymbol(sym)} ${params.side} $${params.sizeInUsd.toFixed(0)} × ${params.leverage}x (${params.orderType})`,
      timestamp: new Date(),
    }, ...l]);
    return { success: true };
  }, [engineState, stopNewOrders]);

  // Expose consecutive losses as reactive state (derived from ref via a state mirror)
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);

  // Mirror ref → state so consumers can react to changes
  // (updated in closedTrades effect below)
  useEffect(() => {
    setConsecutiveLosses(consecutiveLossesRef.current);
  }, [closedTrades]);

  // ── closePosition ──────────────────────────────────────────────
  const closePosition = useCallback((id: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === id);
      if (!pos) return prev;
      const remaining = prev.filter(p => p.id !== id);
      setAccount(a => ({
        ...a,
        unrealizedPnl:      remaining.reduce((s, p) => s + p.unrealizedPnl, 0),
        totalPositionValue: remaining.reduce((s, p) => s + p.sizeInUsd + p.unrealizedPnl, 0),
        realizedPnlToday:   a.realizedPnlToday + pos.unrealizedPnl,
        availableBalance:   a.availableBalance  + pos.collateralUsd + pos.unrealizedPnl
                                                - pos.pendingBorrowingFeeUsd,
      }));
      const trade: Trade = {
        id: `closed-${Date.now()}`, symbol: pos.symbol, displaySymbol: pos.displaySymbol,
        side: pos.side, action: 'CLOSE', sizeInUsd: pos.sizeInUsd,
        price: pos.markPrice, pnl: pos.unrealizedPnl,
        collateralToken: pos.collateralToken,
        gmxMarketAddress: MARKET_BY_SYMBOL.get(pos.symbol)?.marketToken,
        strategy: 'Manual',
        timestamp: new Date(), closeTime: Date.now(),
      };
      setClosedTrades(ts => [trade, ...ts]);
      setLogs(l => [{
        id: `log-${Date.now()}`, level: 'TRADE' as const,
        message: `[PAPER] CLOSED ${pos.displaySymbol} ${pos.side} — PnL $${pos.unrealizedPnl.toFixed(2)}`,
        timestamp: new Date(),
      }, ...l]);
      return remaining;
    });
  }, []);

  // ── clearAllPositions ──────────────────────────────────────────
  const clearAllPositions = useCallback(() => {
    setPositions(prev => {
      const now = Date.now();
      const newTrades: Trade[] = prev.map((pos, i) => ({
        id: `closed-${now}-${i}`, symbol: pos.symbol, displaySymbol: pos.displaySymbol,
        side: pos.side, action: 'CLOSE' as const, sizeInUsd: pos.sizeInUsd,
        price: pos.markPrice, pnl: pos.unrealizedPnl,
        collateralToken: pos.collateralToken,
        gmxMarketAddress: MARKET_BY_SYMBOL.get(pos.symbol)?.marketToken,
        strategy: 'Clear All',
        timestamp: new Date(), closeTime: now,
      }));
      setClosedTrades(ts => [...newTrades, ...ts]);
      setAccount(a => ({ ...a, unrealizedPnl: 0, totalPositionValue: 0 }));
      setLogs(l => [{
        id: `log-${now}`, level: 'WARN' as const,
        message: '[PAPER] All positions cleared',
        timestamp: new Date(),
      }, ...l]);
      return [];
    });
  }, []);

  // ── updatePositionRisk ─────────────────────────────────────────
  const updatePositionRisk = useCallback((id: string, tp: number | null, sl: number | null, trailing?: number | null) => {
    setPositions(prev => prev.map(p => {
      if (p.id !== id) return p;
      const trailPct = trailing ?? p.trailingStopPct;
      return {
        ...p,
        tpPrice: tp ?? undefined,
        slPrice: sl ?? undefined,
        trailingStopPct: trailPct ?? undefined,
        _trailingHighWater: trailPct ? p.markPrice : undefined,
      };
    }));
    const parts = [`TP=${tp ?? 'none'}`, `SL=${sl ?? 'none'}`];
    if (trailing != null) parts.push(`Trailing=${trailing}%`);
    setLogs(l => [{
      id: `log-${Date.now()}`, level: 'INFO' as const,
      message: `[PAPER] Updated risk orders: ${parts.join(' ')}`,
      timestamp: new Date(),
    }, ...l]);
  }, []);

  return (
    <TradingContext.Provider value={{
      account, positions, closedTrades, logs, equityHistory, todayStats,
      placeOrder, closePosition, clearAllPositions, updatePositionRisk, consecutiveLosses,
    }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTradingContext must be used within TradingProvider');
  return ctx;
}
