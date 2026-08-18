import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef, useMemo } from 'react';
import {
  Account, Position, Trade, StrategyLog,
  NewOrderParams, EquityPoint, TodayStats,
} from './AppContext';
import { useAppContext } from './AppContext';
import { GmxPriceStream } from '../gmx/priceStream';
import { displaySymbol, MARKET_BY_SYMBOL } from '../gmx/markets';

export interface PlaceOrderResult {
  success: boolean;
  error?: string;
}

/**
 * PAPER 데이터 로드 상태.
 *  - loading: tradingCapital(전략 설정) 또는 거래 이력 로드 중
 *  - ok:      실제 DB 데이터 기준으로 계좌 지표 계산 가능
 *  - error:   API/DB 조회 실패 — mock 대체값 표시 금지, UI는 'Unavailable' 표기
 */
export type PaperDataStatus = 'loading' | 'ok' | 'error';

interface TradingContextType {
  account: Account;
  positions: Position[];
  closedTrades: Trade[];
  logs: StrategyLog[];
  equityHistory: EquityPoint[];
  todayStats: TodayStats;
  /** PAPER 계좌 데이터 로드 상태 — 'ok'가 아니면 금융 숫자를 표시하지 말 것 */
  dataStatus: PaperDataStatus;
  placeOrder: (params: NewOrderParams) => PlaceOrderResult;
  closePosition: (id: string) => void;
  clearAllPositions: () => void;
  /**
   * Update TP/SL/trailing stop for a paper position.
   * @param highWater Optional: preserve this high-water mark (profit-lock tightening).
   *   When provided, `_trailingHighWater` is set to this value instead of resetting to
   *   `markPrice`, so the ratchet continues from the correct base after tightening.
   *   The caller is responsible for computing and passing a `sl` that is already tighter
   *   than the existing stop.
   */
  updatePositionRisk: (id: string, tp: number | null, sl: number | null, trailing?: number | null, highWater?: number | null) => void;
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

function persistTrade(trade: Trade) {
  fetch('/api/data/trades', {
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

/**
 * DB 거래 이력에서 미청산 OPEN 포지션을 복원한다.
 * CLOSE 레코드를 symbol+side FIFO로 OPEN에 매칭시키고, 남은 OPEN이 곧
 * 현재 열려 있는 페이퍼 포지션이다 (새로고침 후에도 담보·미실현 PnL 유지).
 */
function hydrateOpenPositions(trades: Trade[]): Position[] {
  const sorted = [...trades].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const openQueues = new Map<string, Trade[]>(); // key: symbol|side
  for (const t of sorted) {
    const key = `${t.symbol}|${t.side}`;
    if (t.action === 'OPEN') {
      const q = openQueues.get(key) ?? [];
      q.push(t);
      openQueues.set(key, q);
    } else {
      openQueues.get(key)?.shift(); // FIFO 매칭
    }
  }
  const positions: Position[] = [];
  for (const q of openQueues.values()) {
    for (const t of q) {
      const leverage = t.leverage && t.leverage > 0 ? t.leverage : 1;
      const collateralUsd = t.collateralUsd && t.collateralUsd > 0
        ? t.collateralUsd
        : t.sizeInUsd / leverage;
      positions.push({
        id:                     `pos-db-${t.id}`,
        symbol:                 t.symbol,
        displaySymbol:          t.displaySymbol ?? displaySymbol(t.symbol),
        side:                   t.side,
        isLong:                 t.side === 'LONG',
        sizeInUsd:              t.sizeInUsd,
        collateralUsd,
        collateralToken:        t.collateralToken ?? 'USDC',
        leverage,
        entryPrice:             t.price,
        markPrice:              t.price, // 실시간 가격 수신 전까지 entry 유지 (임의값 금지)
        liquidationPrice:       calcLiqPrice(t.side, t.price, leverage),
        unrealizedPnl:          0,
        roe:                    0,
        pendingBorrowingFeeUsd: 0,
        pendingFundingFeeUsd:   0,
        openTime:               new Date(t.timestamp),
        tpPrice:                undefined,
        slPrice:                undefined,
        trailingStopPct:        undefined,
        managedBy:              t.managedBy ?? null,
      });
    }
  }
  return positions;
}

/** 이번 주 월요일 00:00 UTC (서버 aiWorker의 weekly 창과 동일 기준) */
function weekStartUtc(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return monday.getTime();
}

export function TradingProvider({ children }: { children: ReactNode }) {
  const { engineState, stopNewOrders } = useAppContext();

  // ── 실제 데이터만 사용 — mock/demo 초기값 없음 ─────────────────────────────
  const [positions, setPositions] = useState<Position[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<StrategyLog[]>([]);
  const [equityHistory, setEquityHistory] = useState<EquityPoint[]>([]);

  // tradingCapital — 서버 전략 설정(/api/data/strategy)이 유일한 출처.
  // null = 미로드/로드 실패 → 계좌 지표 표시 불가 (mock 대체 금지)
  const [tradingCapital, setTradingCapital] = useState<number | null>(null);
  const [capitalStatus, setCapitalStatus] = useState<PaperDataStatus>('loading');
  const [tradesStatus, setTradesStatus] = useState<PaperDataStatus>('loading');

  const syncedIds = useRef<Set<string>>(new Set());

  // GMX oracle prices from polling stream
  const livePrices = useRef<Map<string, number>>(new Map());
  const streamRef  = useRef<GmxPriceStream | null>(null);

  // ── Load tradingCapital from server strategy config ────────────
  useEffect(() => {
    fetch('/api/data/strategy', { signal: AbortSignal.timeout(8_000) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { limits?: { tradingCapital?: unknown } } | null) => {
        const cap = Number(data?.limits?.tradingCapital);
        if (Number.isFinite(cap) && cap > 0) {
          setTradingCapital(cap);
          setCapitalStatus('ok');
        } else {
          // 설정 행이 없거나 값이 비정상 — 추정값 대신 오류 상태 유지
          setCapitalStatus('error');
        }
      })
      .catch(() => setCapitalStatus('error'));
  }, []);

  // ── Load persisted trades from server on mount ─────────────────
  useEffect(() => {
    fetch('/api/data/trades', { signal: AbortSignal.timeout(8_000) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((rows: Array<{
        id: string; symbol: string; side: string; action?: string;
        sizeInUsd?: string; size?: string; price: string; pnl: string;
        strategy: string; timestamp: string; closeTime?: number;
        gmxMarketAddress?: string | null; collateralToken?: string | null;
        managedBy?: string | null;
      }> | null) => {
        const loaded: Trade[] = (rows ?? []).map(r => ({
          id:               r.id,
          symbol:           r.symbol,
          displaySymbol:    displaySymbol(r.symbol),
          side:             r.side as 'LONG' | 'SHORT',
          action:           (r.action ?? 'CLOSE') as 'OPEN' | 'CLOSE',
          sizeInUsd:        parseFloat(r.sizeInUsd ?? r.size ?? '0'),
          price:            parseFloat(r.price),
          pnl:              parseFloat(r.pnl),
          strategy:         r.strategy,
          timestamp:        new Date(r.timestamp),
          closeTime:        r.closeTime ?? 0,
          gmxMarketAddress: r.gmxMarketAddress ?? undefined,
          collateralToken:  r.collateralToken ?? undefined,
          managedBy:        r.managedBy === 'SERVER' ? 'SERVER' : null,
        }));
        // 0건도 유효한 실제 상태 (신규 계정) — mock으로 대체하지 않음
        setClosedTrades(loaded);
        syncedIds.current = new Set(loaded.map(t => t.id));
        // DB의 미청산 OPEN 레코드에서 열린 포지션 복원 (새로고침 내구성)
        setPositions(prev => prev.length === 0 ? hydrateOpenPositions(loaded) : prev);
        setTradesStatus('ok');
      })
      .catch(() => setTradesStatus('error'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dataStatus: PaperDataStatus =
    capitalStatus === 'error' || tradesStatus === 'error' ? 'error'
    : capitalStatus === 'ok' && tradesStatus === 'ok' ? 'ok'
    : 'loading';

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

  // ── Price tick every 1 s — 실제 GMX oracle 가격만 사용, 임의 노이즈 없음 ──
  useEffect(() => {
    const id = setInterval(() => {
      setPositions(prev => {
        if (prev.length === 0) return prev;

        const next = prev.map(pos => {
          const live = livePrices.current.get(pos.symbol);
          // 실시간 가격이 없으면 mark를 변경하지 않는다 (random walk 금지)
          const newMark = live !== undefined ? live : pos.markPrice;

          // ── Task #111 — 서버 관리 포지션: 표시(mark/PnL)만 갱신, SL/TP/트레일링·
          // 자동 청산은 전부 서버 권위 (브라우저 이중 체결 금지) ────────────────
          if (pos.managedBy === 'SERVER') {
            const deltaRatio = pos.side === 'LONG'
              ? (newMark - pos.entryPrice) / pos.entryPrice
              : (pos.entryPrice - newMark) / pos.entryPrice;
            const pnl = deltaRatio * pos.sizeInUsd;
            return {
              ...pos, markPrice: newMark, unrealizedPnl: pnl,
              roe: pos.collateralUsd > 0 ? (pnl / pos.collateralUsd) * 100 : 0,
            };
          }

          // GMX PnL: price delta relative to sizeInUsd
          const priceDeltaRatio = pos.side === 'LONG'
            ? (newMark - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - newMark) / pos.entryPrice;
          const newPnl = priceDeltaRatio * pos.sizeInUsd;
          const newRoe = pos.collateralUsd > 0 ? (newPnl / pos.collateralUsd) * 100 : 0;

          // Accrue borrowing fee (deterministic per-tick approximation of GMX hourly rate)
          const newBorrow  = pos.pendingBorrowingFeeUsd + pos.sizeInUsd * 0.00003 / 3600;
          const newFunding = pos.pendingFundingFeeUsd;

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

        return next;
      });
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  // ── Today stats — 실제 CLOSE 거래(오늘 00:00 로컬~)만 근거 ─────────────────
  const todayStats: TodayStats = useMemo(() => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = closedTrades.filter(t => t.action !== 'OPEN' && new Date(t.timestamp) >= midnight);
    return {
      realized: today.reduce((s, t) => s + t.pnl, 0),
      wins:     today.filter(t => t.pnl > 0).length,
      losses:   today.filter(t => t.pnl <= 0).length,
      count:    today.length,
    };
  }, [closedTrades]);

  // ── Account — 전부 실제 데이터에서 파생 (mock 기반 상태 없음) ─────────────
  //  Paper Equity  = tradingCapital + 전체 실현 PnL + 미실현 PnL
  //  Paper Cash    = tradingCapital + 전체 실현 PnL
  //  Available     = Paper Cash − 사용 중 담보
  //  Margin Ratio  = 담보 사용 / Paper Cash (포지션 없으면 0)
  const account: Account = useMemo(() => {
    const realizedAll = closedTrades.reduce((s, t) => t.action !== 'OPEN' ? s + t.pnl : s, 0);
    const wkStart = weekStartUtc();
    const weeklyPnl = closedTrades.reduce(
      (s, t) => t.action !== 'OPEN' && new Date(t.timestamp).getTime() >= wkStart ? s + t.pnl : s, 0);
    const unrealized      = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const collateralUsed  = positions.reduce((s, p) => s + p.collateralUsd, 0);
    const totalPosValue   = positions.reduce((s, p) => s + p.sizeInUsd + p.unrealizedPnl, 0);
    const capital         = tradingCapital ?? 0;
    const paperCash       = capital + realizedAll;
    return {
      balance:              paperCash + unrealized,
      collateralBalanceUsd: paperCash,
      availableBalance:     paperCash - collateralUsed,
      unrealizedPnl:        unrealized,
      realizedPnlToday:     todayStats.realized,
      weeklyPnl,
      marginRatio:          positions.length > 0 && paperCash > 0 ? collateralUsed / paperCash : 0,
      totalPositionValue:   totalPosValue,
    };
  }, [positions, closedTrades, tradingCapital, todayStats.realized]);

  // ── Equity snapshot every 30 s (실데이터 로드 완료 후에만 기록) ────────────
  // balance는 ref로 읽어 interval이 가격 틱마다 재생성되지 않도록 고정한다.
  const balanceRef = useRef(account.balance);
  balanceRef.current = account.balance;
  useEffect(() => {
    if (dataStatus !== 'ok') return;
    const snap = () => {
      setEquityHistory(prev => {
        const pt: EquityPoint = { time: Date.now(), equity: balanceRef.current };
        return [...(prev.length > 96 ? prev.slice(1) : prev), pt];
      });
    };
    snap(); // 첫 스냅샷 즉시
    const id = setInterval(snap, 30_000);
    return () => clearInterval(id);
  }, [dataStatus]);

  // ── placeOrder ─────────────────────────────────────────────────
  const placeOrder = useCallback((params: NewOrderParams): PlaceOrderResult => {
    if (engineState === 'EMERGENCY_STOP')
      return { success: false, error: 'Emergency stop is active. Reset before trading.' };
    if (stopNewOrders)
      return { success: false, error: 'New orders are currently disabled.' };
    if (engineState === 'OFFLINE')
      return { success: false, error: 'Engine is offline. Set to PAPER TRADING to trade.' };

    const isMarket = params.orderType === 'MarketIncrease';
    // 시장가: 실시간 GMX oracle 가격만 허용 — 고정 fallback 가격 금지
    const entryPrice = isMarket
      ? (livePrices.current.get(params.symbol) ?? 0)
      : (params.limitPrice ?? 0);
    if (entryPrice <= 0) {
      return {
        success: false,
        error: isMarket
          ? 'Market price unavailable — GMX price feed not connected. Try again shortly.'
          : 'Invalid price. Set a valid limit price.',
      };
    }

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

    // Record OPEN trade (matches mobile behaviour; persisted via the sync effect)
    // leverage + collateralUsd are included so the server-side AI Worker can do
    // accurate mark-to-market and maxDrawdown calculations without falling back
    // to a 1x default.
    const openTrade: Trade = {
      id:               `open-${Date.now()}`,
      symbol:           sym,
      displaySymbol:    displaySymbol(sym),
      side:             params.side,
      action:           'OPEN',
      sizeInUsd:        params.sizeInUsd,
      price:            entryPrice,
      pnl:              0,
      collateralToken:  collToken,
      gmxMarketAddress: MARKET_BY_SYMBOL.get(sym)?.marketToken,
      strategy:         params.orderType,
      timestamp:        new Date(),
      closeTime:        0,
      leverage:         params.leverage,
      collateralUsd,
    };
    setClosedTrades(ts => [openTrade, ...ts]);

    setLogs(l => [{
      id: `log-${Date.now()}`, level: 'TRADE' as const,
      message: `[PAPER] OPENED ${displaySymbol(sym)} ${params.side} $${params.sizeInUsd.toFixed(0)} × ${params.leverage}x (${params.orderType})`,
      timestamp: new Date(),
    }, ...l]);
    return { success: true };
  }, [engineState, stopNewOrders]);

  // ── Consecutive losses — DB에 로드된 이력 포함, 모든 CLOSE 경로(수동/자동)에서
  //    일관되게 파생: 최신 CLOSE부터 연속 손실(pnl<0) 스트릭을 센다.
  const consecutiveLosses = useMemo(() => {
    const closes = closedTrades
      .filter(t => t.action !== 'OPEN')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    let streak = 0;
    for (const t of closes) {
      if (t.pnl < 0) streak += 1;
      else break;
    }
    return streak;
  }, [closedTrades]);

  // ── closePosition ──────────────────────────────────────────────
  const closePosition = useCallback((id: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === id);
      if (!pos) return prev;
      // Task #111 — 서버 관리 포지션은 브라우저에서 청산 불가 (서버 권위, 이중 청산 금지)
      if (pos.managedBy === 'SERVER') {
        setLogs(l => [{
          id: `log-${Date.now()}`, level: 'WARN' as const,
          message: `[PAPER] ${pos.displaySymbol}은(는) 서버 Worker가 관리 중 — 브라우저 청산 불가`,
          timestamp: new Date(),
        }, ...l]);
        return prev;
      }
      const remaining = prev.filter(p => p.id !== id);
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
      // Task #111 — 서버 관리 포지션은 제외 (서버가 CASH/RiskEngine 규칙으로 청산)
      const serverManaged = prev.filter(p => p.managedBy === 'SERVER');
      const clientOwned   = prev.filter(p => p.managedBy !== 'SERVER');
      if (clientOwned.length === 0) return prev;
      const newTrades: Trade[] = clientOwned.map((pos, i) => ({
        id: `closed-${now}-${i}`, symbol: pos.symbol, displaySymbol: pos.displaySymbol,
        side: pos.side, action: 'CLOSE' as const, sizeInUsd: pos.sizeInUsd,
        price: pos.markPrice, pnl: pos.unrealizedPnl,
        collateralToken: pos.collateralToken,
        gmxMarketAddress: MARKET_BY_SYMBOL.get(pos.symbol)?.marketToken,
        strategy: 'Clear All',
        timestamp: new Date(), closeTime: now,
      }));
      setClosedTrades(ts => [...newTrades, ...ts]);
      setLogs(l => [{
        id: `log-${now}`, level: 'WARN' as const,
        message: serverManaged.length > 0
          ? `[PAPER] 브라우저 포지션 청산 — 서버 관리 ${serverManaged.length}건은 서버가 청산`
          : '[PAPER] All positions cleared',
        timestamp: new Date(),
      }, ...l]);
      return serverManaged;
    });
  }, []);

  // ── updatePositionRisk ─────────────────────────────────────────
  const updatePositionRisk = useCallback((
    id: string, tp: number | null, sl: number | null,
    trailing?: number | null,
    highWater?: number | null,   // explicit high-water to preserve (profit-lock use)
  ) => {
    setPositions(prev => prev.map(p => {
      if (p.id !== id) return p;
      const trailPct = trailing !== undefined ? (trailing ?? undefined) : p.trailingStopPct;
      // When caller passes an explicit highWater (e.g. profit-lock tightening),
      // preserve it so the trailing ratchet continues from the correct base.
      // Otherwise fall back to the original behaviour of resetting to markPrice.
      const newHighWater = highWater != null ? highWater : (trailPct ? p.markPrice : undefined);
      return {
        ...p,
        tpPrice: tp ?? undefined,
        slPrice: sl ?? undefined,
        trailingStopPct: trailPct ?? undefined,
        _trailingHighWater: newHighWater,
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
      account, positions, closedTrades, logs, equityHistory, todayStats, dataStatus,
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
