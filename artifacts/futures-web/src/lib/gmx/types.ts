/**
 * GMX V2 shared types — Arbitrum One
 */

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface GmxToken {
  symbol: string;
  address: string;
  decimals: number;
  synthetic?: boolean;
}

export interface GmxMarket {
  name: string;          // "ETH/USD [ETH-USDC]"
  displayName: string;   // "ETH/USD"
  indexSymbol: string;   // "ETH"
  marketToken: string;   // GM token address
  indexToken: string;    // tracked asset address
  longToken: string;     // long collateral token
  shortToken: string;    // short collateral token (usually USDC)
  isListed: boolean;
}

/** Oracle price tick from the GMX price API */
export interface GmxOraclePrice {
  tokenAddress: string;
  tokenSymbol: string;   // "ETH", "BTC", "SOL" …
  priceUsd: number;      // mid price in USD (already converted)
  minPriceUsd: number;
  maxPriceUsd: number;
  updatedAt: number;     // ms timestamp
}

/** GMX V2 order types */
export type GmxOrderType =
  | 'MarketIncrease'    // open/add to position at market
  | 'LimitIncrease'     // open/add at limit price
  | 'MarketDecrease'    // close/reduce at market
  | 'LimitDecrease'     // close/reduce at limit price
  | 'StopLossDecrease'  // stop loss trigger
  | 'TakeProfit';       // take profit trigger

/** On-chain wallet connection status (read from VPS, no browser wallet needed) */
export interface WalletStatus {
  address: string | null;
  connected: boolean;
}

/** GMX delegated subaccount / One-Click trading authorization */
export interface SubaccountStatus {
  address: string | null;
  authorized: boolean;
  expiresAt: string | null;        // ISO timestamp or null
  actionsRemaining: number | null;
  isExpiringSoon: boolean;         // < 24 h to expiry
  isLowActions: boolean;           // < 10 actions remaining
}

/** Connection health for GMX API / RPC / relay */
export interface GmxConnectionHealth {
  gmxApiReachable: boolean;
  rpcReachable: boolean;
  relayReachable: boolean;
  chainId: number;                 // 42161 = Arbitrum One
  latencyMs: number | null;
}
