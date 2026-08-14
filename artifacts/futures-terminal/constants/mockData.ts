/**
 * Mock data for paper trading — GMX V2 / Arbitrum One
 * All symbols are GMX index symbols (ETH, BTC, SOL …), not Binance pairs.
 */

export const MOCK_ACCOUNT = {
  balance:            10_000,
  collateralBalanceUsd: 9_847.32,
  availableBalance:    7_234.18,
  unrealizedPnl:         247.32,
  realizedPnlToday:      183.45,
  weeklyPnl:             612.80,
  marginRatio:             0.23,
  totalPositionValue:  4_820.50,
};

// GMX positions use sizeInUsd (position value) + collateralUsd (deposited collateral)
export const MOCK_POSITIONS = [
  {
    id: 'pos1',
    symbol: 'BTC',
    displaySymbol: 'BTC/USD',
    side: 'LONG' as const,
    isLong: true,
    sizeInUsd: 2192.80,      // 0.05 BTC × $43,856
    collateralUsd: 219.28,   // 10× leverage
    collateralToken: 'WBTC.b',
    leverage: 10,
    entryPrice: 43_200.00,
    markPrice: 43_856.50,
    liquidationPrice: 38_880.00,
    unrealizedPnl: 32.83,
    roe: 14.98,
    pendingBorrowingFeeUsd: 0.84,
    pendingFundingFeeUsd: -0.22,
    openTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
  },
  {
    id: 'pos2',
    symbol: 'ETH',
    displaySymbol: 'ETH/USD',
    side: 'SHORT' as const,
    isLong: false,
    sizeInUsd: 1884.80,      // 0.8 ETH × $2,356
    collateralUsd: 376.96,   // 5× leverage
    collateralToken: 'USDC',
    leverage: 5,
    entryPrice: 2_380.00,
    markPrice: 2_356.40,
    liquidationPrice: 2_856.00,
    unrealizedPnl: 18.88,
    roe: 5.01,
    pendingBorrowingFeeUsd: 0.31,
    pendingFundingFeeUsd: 0.09,
    openTime: new Date(Date.now() - 1.5 * 60 * 60 * 1000),
  },
  {
    id: 'pos3',
    symbol: 'SOL',
    displaySymbol: 'SOL/USD',
    side: 'LONG' as const,
    isLong: true,
    sizeInUsd: 1_214.88,     // 12 SOL × $101.24
    collateralUsd: 151.86,   // 8× leverage
    collateralToken: 'USDC',
    leverage: 8,
    entryPrice: 98.50,
    markPrice: 101.24,
    liquidationPrice: 86.69,
    unrealizedPnl: 32.88,
    roe: 21.65,
    pendingBorrowingFeeUsd: 0.19,
    pendingFundingFeeUsd: -0.04,
    openTime: new Date(Date.now() - 0.5 * 60 * 60 * 1000),
  },
];

// GMX watchlist uses index symbols (ETH, BTC …) not Binance pairs
export const MOCK_WATCHLIST = [
  { symbol: 'BTC',  displaySymbol: 'BTC/USD',  price: 43_856.50, change24h:  2.34, score1h:  72, score4h:  65, score1d:  80, combinedScore:  72, volume24h: 28_340_000_000, borrowingRatePerHour: 0.0042 },
  { symbol: 'ETH',  displaySymbol: 'ETH/USD',  price:  2_356.40, change24h: -1.12, score1h: -45, score4h: -38, score1d:  20, combinedScore: -21, volume24h: 14_200_000_000, borrowingRatePerHour: 0.0031 },
  { symbol: 'SOL',  displaySymbol: 'SOL/USD',  price:    101.24, change24h:  4.87, score1h:  85, score4h:  78, score1d:  82, combinedScore:  82, volume24h:  3_840_000_000, borrowingRatePerHour: 0.0058 },
  { symbol: 'ARB',  displaySymbol: 'ARB/USD',  price:      0.52, change24h:  0.43, score1h:  12, score4h:  28, score1d:  45, combinedScore:  28, volume24h:    890_000_000, borrowingRatePerHour: 0.0071 },
  { symbol: 'LINK', displaySymbol: 'LINK/USD', price:     14.50, change24h: -2.17, score1h: -62, score4h: -48, score1d: -30, combinedScore: -47, volume24h:    640_000_000, borrowingRatePerHour: 0.0049 },
  { symbol: 'AVAX', displaySymbol: 'AVAX/USD', price:     25.00, change24h:  1.23, score1h:  35, score4h:  22, score1d:  15, combinedScore:  24, volume24h:    520_000_000, borrowingRatePerHour: 0.0055 },
  { symbol: 'DOGE', displaySymbol: 'DOGE/USD', price:      0.093,change24h: -0.78, score1h: -18, score4h:  10, score1d:  25, combinedScore:   6, volume24h:    410_000_000, borrowingRatePerHour: 0.0063 },
];

export const MOCK_TRADES = [
  { id: 't1',  symbol: 'BTC',  displaySymbol: 'BTC/USD',  side: 'LONG'  as const, action: 'CLOSE' as const, sizeInUsd: 1310.00, price: 43_650.00, pnl:  87.45, collateralToken: 'WBTC.b', strategy: 'EMA+RSI',    timestamp: new Date(Date.now() -  2 * 3600_000), closeTime: Date.now() -  2 * 3600_000 },
  { id: 't2',  symbol: 'ETH',  displaySymbol: 'ETH/USD',  side: 'SHORT' as const, action: 'CLOSE' as const, sizeInUsd: 1205.00, price:  2_410.00, pnl: -23.50, collateralToken: 'USDC',   strategy: 'MACD',       timestamp: new Date(Date.now() -  4 * 3600_000), closeTime: Date.now() -  4 * 3600_000 },
  { id: 't3',  symbol: 'SOL',  displaySymbol: 'SOL/USD',  side: 'LONG'  as const, action: 'CLOSE' as const, sizeInUsd:  782.40, price:     97.80, pnl:  45.60, collateralToken: 'USDC',   strategy: 'Breakout',   timestamp: new Date(Date.now() -  6 * 3600_000), closeTime: Date.now() -  6 * 3600_000 },
  { id: 't4',  symbol: 'ARB',  displaySymbol: 'ARB/USD',  side: 'LONG'  as const, action: 'CLOSE' as const, sizeInUsd:  616.00, price:      0.308, pnl: 18.40, collateralToken: 'USDC',   strategy: 'MTF Trend',  timestamp: new Date(Date.now() -  8 * 3600_000), closeTime: Date.now() -  8 * 3600_000 },
  { id: 't5',  symbol: 'LINK', displaySymbol: 'LINK/USD', side: 'SHORT' as const, action: 'CLOSE' as const, sizeInUsd:  742.50, price:     14.85, pnl:  31.25, collateralToken: 'USDC',   strategy: 'BB',         timestamp: new Date(Date.now() - 10 * 3600_000), closeTime: Date.now() - 10 * 3600_000 },
  { id: 't6',  symbol: 'BTC',  displaySymbol: 'BTC/USD',  side: 'SHORT' as const, action: 'CLOSE' as const, sizeInUsd:  882.00, price: 44_100.00, pnl: -14.20, collateralToken: 'WBTC.b', strategy: 'EMA+RSI',    timestamp: new Date(Date.now() - 12 * 3600_000), closeTime: Date.now() - 12 * 3600_000 },
  { id: 't7',  symbol: 'DOGE', displaySymbol: 'DOGE/USD', side: 'LONG'  as const, action: 'CLOSE' as const, sizeInUsd:   92.00, price:      0.092, pnl: 12.00, collateralToken: 'USDC',   strategy: 'Vol Breakout', timestamp: new Date(Date.now() - 14 * 3600_000), closeTime: Date.now() - 14 * 3600_000 },
  { id: 't8',  symbol: 'SOL',  displaySymbol: 'SOL/USD',  side: 'SHORT' as const, action: 'CLOSE' as const, sizeInUsd: 1045.00, price:    104.50, pnl: -38.00, collateralToken: 'USDC',   strategy: 'MTF Trend',  timestamp: new Date(Date.now() - 16 * 3600_000), closeTime: Date.now() - 16 * 3600_000 },
  { id: 't9',  symbol: 'ETH',  displaySymbol: 'ETH/USD',  side: 'LONG'  as const, action: 'CLOSE' as const, sizeInUsd:  928.00, price:  2_320.00, pnl:  52.80, collateralToken: 'USDC',   strategy: 'MACD',       timestamp: new Date(Date.now() - 18 * 3600_000), closeTime: Date.now() - 18 * 3600_000 },
  { id: 't10', symbol: 'BTC',  displaySymbol: 'BTC/USD',  side: 'LONG'  as const, action: 'CLOSE' as const, sizeInUsd: 2140.00, price: 42_800.00, pnl:  92.50, collateralToken: 'WBTC.b', strategy: 'Combined',   timestamp: new Date(Date.now() - 20 * 3600_000), closeTime: Date.now() - 20 * 3600_000 },
  { id: 't11', symbol: 'AVAX', displaySymbol: 'AVAX/USD', side: 'SHORT' as const, action: 'CLOSE' as const, sizeInUsd:  578.00, price:     24.20, pnl:  -8.70, collateralToken: 'USDC',   strategy: 'RSI',        timestamp: new Date(Date.now() - 22 * 3600_000), closeTime: Date.now() - 22 * 3600_000 },
  { id: 't12', symbol: 'LINK', displaySymbol: 'LINK/USD', side: 'SHORT' as const, action: 'CLOSE' as const, sizeInUsd:  450.00, price:     16.00, pnl:  16.50, collateralToken: 'USDC',   strategy: 'BB',         timestamp: new Date(Date.now() - 24 * 3600_000), closeTime: Date.now() - 24 * 3600_000 },
];

export const MOCK_LOGS = [
  { id: 'l1',  level: 'INFO'  as const, message: '[PAPER] BTC 1H score updated: +72 (LONG bias)',                   timestamp: new Date(Date.now() -  5 * 60_000) },
  { id: 'l2',  level: 'TRADE' as const, message: '[PAPER] Signal: BTC/USD LONG — Combined score 72/100',            timestamp: new Date(Date.now() -  8 * 60_000) },
  { id: 'l3',  level: 'INFO'  as const, message: '[PAPER] ETH borrowing rate: 0.003%/hr — filter PASSED',           timestamp: new Date(Date.now() - 12 * 60_000) },
  { id: 'l4',  level: 'WARN'  as const, message: '[PAPER] SOL 4H RSI overbought (76.4) — monitoring',               timestamp: new Date(Date.now() - 18 * 60_000) },
  { id: 'l5',  level: 'INFO'  as const, message: '[PAPER] BTC direction filter: BULLISH — LONG signals active',     timestamp: new Date(Date.now() - 25 * 60_000) },
  { id: 'l6',  level: 'TRADE' as const, message: '[PAPER] Closed ETH/USD SHORT +$18.88 ROE 5.01% · fees $0.40',    timestamp: new Date(Date.now() - 35 * 60_000) },
  { id: 'l7',  level: 'INFO'  as const, message: '[PAPER] Risk check: 3/5 positions, collateral ratio 23%',         timestamp: new Date(Date.now() - 45 * 60_000) },
  { id: 'l8',  level: 'INFO'  as const, message: '[PAPER] EMA crossover: SOL 1H fast(9) crossed slow(21)',          timestamp: new Date(Date.now() - 55 * 60_000) },
  { id: 'l9',  level: 'WARN'  as const, message: '[PAPER] Daily loss check: $183.45 realized (limit $500)',         timestamp: new Date(Date.now() - 65 * 60_000) },
  { id: 'l10', level: 'INFO'  as const, message: '[PAPER] Engine heartbeat: PAPER_TRADING — OK',                    timestamp: new Date(Date.now() - 75 * 60_000) },
  { id: 'l11', level: 'INFO'  as const, message: '[PAPER] MACD disabled — skipping MACD signals',                   timestamp: new Date(Date.now() - 90 * 60_000) },
  { id: 'l12', level: 'WARN'  as const, message: '[PAPER] BTC volume spike 3.2× — vol breakout triggered',          timestamp: new Date(Date.now() - 110 * 60_000) },
];
