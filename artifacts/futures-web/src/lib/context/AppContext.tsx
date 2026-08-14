import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

// ── Engine State ──────────────────────────────────────────────────────────────
export type EngineState =
  | 'OFFLINE' | 'MONITORING' | 'PAPER_TRADING'
  | 'LIVE_READY' | 'LIVE_TRADING' | 'RISK_LOCKED' | 'EMERGENCY_STOP';

// ── Account ───────────────────────────────────────────────────────────────────
// Reflects GMX V2 account model: collateral-denominated balances
export interface Account {
  balance: number;                // total equity in USDC
  collateralBalanceUsd: number;   // USDC deposited as collateral (replaces marginBalance)
  availableBalance: number;       // free collateral not in positions
  unrealizedPnl: number;
  realizedPnlToday: number;
  weeklyPnl: number;
  marginRatio: number;            // collateralUsed / totalCollateral
  totalPositionValue: number;     // sum of sizeInUsd across all open positions
}

// ── Position ──────────────────────────────────────────────────────────────────
// GMX V2 positions are USD-denominated (sizeInUsd, collateralUsd)
export interface Position {
  id: string;
  // Market
  symbol: string;           // GMX index symbol: "ETH", "BTC"
  displaySymbol: string;    // display name: "ETH/USD"
  // Direction
  side: 'LONG' | 'SHORT';  // kept for UI compatibility
  isLong: boolean;
  // Size & Collateral (USD-denominated, GMX-native)
  sizeInUsd: number;        // total position value in USD
  collateralUsd: number;    // USD value of deposited collateral
  collateralToken: string;  // "USDC", "WBTC.b", "WETH"
  leverage: number;         // sizeInUsd / collateralUsd
  // Pricing
  entryPrice: number;       // average entry price in USD
  markPrice: number;        // current GMX oracle price in USD
  liquidationPrice: number;
  // PnL
  unrealizedPnl: number;    // USD
  roe: number;              // return on collateral %
  // Pending fees (simulated for paper trading, real for live)
  pendingBorrowingFeeUsd: number;   // accrued borrowing fee
  pendingFundingFeeUsd: number;     // positive = receiving, negative = paying
  // Orders
  openTime: Date;
  tpPrice?: number;
  slPrice?: number;
  /** Trailing stop distance as % of mark price (e.g. 2 = 2%).
   *  When set, slPrice is automatically ratcheted as price moves in-profit. */
  trailingStopPct?: number;
  /** Internal: best price seen in-profit direction — used to ratchet trailing SL. */
  _trailingHighWater?: number;
}

// ── Watchlist ─────────────────────────────────────────────────────────────────
export interface WatchlistSymbol {
  symbol: string;           // GMX index symbol: "ETH", "BTC"
  displaySymbol: string;    // "ETH/USD"
  price: number;
  change24h: number;
  volume24h: number;
  score1h: number;
  score4h: number;
  score1d: number;
  combinedScore: number;
  borrowingRatePerHour?: number;  // GMX borrowing fee rate per hour (%)
}

// ── Trade ─────────────────────────────────────────────────────────────────────
export interface Trade {
  id: string;
  symbol: string;
  displaySymbol: string;
  side: 'LONG' | 'SHORT';
  action?: 'OPEN' | 'CLOSE';
  sizeInUsd: number;        // position value in USD
  price: number;            // execution price
  pnl: number;
  collateralToken?: string;
  strategy: string;
  timestamp: Date;
  closeTime?: number;
}

// ── Strategy Log ──────────────────────────────────────────────────────────────
export interface StrategyLog {
  id: string;
  level: 'INFO' | 'WARN' | 'TRADE';
  message: string;
  timestamp: Date;
}

// ── Order Params ──────────────────────────────────────────────────────────────
// GMX V2 order params — uses USD-denominated size
export interface NewOrderParams {
  symbol: string;           // "ETH", "BTC"
  side: 'LONG' | 'SHORT';
  orderType: 'MarketIncrease' | 'LimitIncrease' | 'MarketDecrease' | 'LimitDecrease';
  sizeInUsd: number;        // position size in USD
  leverage: number;
  collateralToken?: string; // default "USDC"
  limitPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  trailingStopPct?: number;
}

// ── Equity ────────────────────────────────────────────────────────────────────
export interface EquityPoint {
  time: number;   // unix ms
  equity: number; // USD
}

export interface TodayStats {
  realized: number;
  wins: number;
  losses: number;
  count: number;
}

// ── AppContext ────────────────────────────────────────────────────────────────
interface AppContextType {
  engineState: EngineState;
  stopNewOrders: boolean;
  toggleStopNewOrders: () => void;
  triggerEmergencyStop: () => void;
  resetFromEmergency: () => void;
  setEngineState: (state: EngineState) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [engineState, setEngineState] = useState<EngineState>('PAPER_TRADING');
  const [stopNewOrders, setStopNewOrders] = useState(false);

  const toggleStopNewOrders = useCallback(() => setStopNewOrders(prev => !prev), []);

  const triggerEmergencyStop = useCallback(() => {
    setEngineState('EMERGENCY_STOP');
    setStopNewOrders(true);
  }, []);

  const resetFromEmergency = useCallback(() => {
    setEngineState('PAPER_TRADING');
    setStopNewOrders(false);
  }, []);

  return (
    <AppContext.Provider value={{ engineState, stopNewOrders, toggleStopNewOrders, triggerEmergencyStop, resetFromEmergency, setEngineState }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
