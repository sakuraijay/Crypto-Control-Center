/**
 * GMX V2 API proxy — Arbitrum One
 * Proxies public GMX infrastructure endpoints with server-side caching.
 * No API key required — all data is publicly available.
 *
 * Endpoints:
 *   GET /api/gmx/prices   — oracle prices, refreshed every 3 s
 *   GET /api/gmx/markets  — listed perpetual markets, cached 60 s
 *   GET /api/gmx/tokens   — token registry with decimals, cached 5 min
 *   GET /api/gmx/candles  — OHLCV candles for backtesting
 */

import { Router } from "express";

const router = Router();
const GMX_API = "https://arbitrum-api.gmxinfra.io";
const POLL_MS = 3_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface RawTicker {
  tokenAddress: string;
  tokenSymbol: string;
  minPrice: string;
  maxPrice: string;
  updatedAt: number;
}

export interface PriceTick {
  tokenAddress: string;
  tokenSymbol: string;
  priceUsd: number;
  minPriceUsd: number;
  maxPriceUsd: number;
  updatedAt: number;
}

interface GmxToken { symbol: string; address: string; decimals: number; synthetic?: boolean; }
interface GmxMarket { name: string; marketToken: string; indexToken: string; longToken: string; shortToken: string; isListed: boolean; }
interface CacheEntry<T> { data: T; expiresAt: number; }

// ── Decimal registry ─────────────────────────────────────────────────────────
// Prices from gmxinfra are scaled: priceUSD = rawPrice / 10^(30 - decimals)

const DECIMALS_FALLBACK: Record<string, number> = {
  ETH: 18, WETH: 18, ARB: 18, LINK: 18, AVAX: 18, EIGEN: 18, UNI: 18,
  BTC: 8, "WBTC.b": 8,  tBTC: 18,
  SOL: 9, DOGE: 8, LTC: 8, BONK: 5, MEW: 5, FLOKI: 9, TAO: 9,
  USDC: 6, USDT: 6, "USDT.e": 6, USDe: 18, DAI: 18, GHO: 18,
};

let decimalsMap: Record<string, number> = { ...DECIMALS_FALLBACK };
let decimalsLoadedAt = 0;

async function loadDecimals(): Promise<Record<string, number>> {
  if (Date.now() - decimalsLoadedAt < 300_000) return decimalsMap;
  try {
    const r = await fetch(`${GMX_API}/tokens`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const tokens = (await r.json()) as GmxToken[];
      const m: Record<string, number> = { ...DECIMALS_FALLBACK };
      for (const t of tokens) m[t.symbol] = t.decimals;
      decimalsMap = m;
      decimalsLoadedAt = Date.now();
    }
  } catch { /* keep stale */ }
  return decimalsMap;
}

function convertPrice(raw: string, decimals: number): number {
  try {
    const exponent = 30 - decimals;
    // Use floating-point for large numbers (precision sufficient for display)
    return Number(raw) / Math.pow(10, exponent);
  } catch {
    return 0;
  }
}

// ── Price cache + background poller ─────────────────────────────────────────

let priceCache: CacheEntry<PriceTick[]> | null = null;
let marketCache: CacheEntry<GmxMarket[]> | null = null;
let tokenCache: CacheEntry<GmxToken[]> | null = null;
let pollerStarted = false;

async function refreshPrices() {
  try {
    const [tickers, dec] = await Promise.all([
      fetch(`${GMX_API}/prices/tickers`, { signal: AbortSignal.timeout(5_000) })
        .then(r => r.ok ? r.json() as Promise<RawTicker[]> : Promise.reject(new Error("upstream"))),
      loadDecimals(),
    ]);
    const prices: PriceTick[] = tickers.map(t => {
      const d = dec[t.tokenSymbol] ?? 18;
      return {
        tokenAddress: t.tokenAddress,
        tokenSymbol: t.tokenSymbol,
        priceUsd: convertPrice(t.minPrice, d),
        minPriceUsd: convertPrice(t.minPrice, d),
        maxPriceUsd: convertPrice(t.maxPrice, d),
        updatedAt: t.updatedAt,
      };
    });
    priceCache = { data: prices, expiresAt: Date.now() + 10_000 };
  } catch { /* keep stale cache */ }
}

function ensurePoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  void refreshPrices();
  setInterval(() => void refreshPrices(), POLL_MS);
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/gmx/prices
 * All GMX oracle prices with USD conversion. Refreshed every 3 s server-side.
 * Clients poll this; no browser CORS issues.
 */
router.get("/gmx/prices", async (_req, res) => {
  ensurePoller();
  if (!priceCache || Date.now() > priceCache.expiresAt) await refreshPrices();
  if (!priceCache) return res.status(502).json({ error: "GMX price feed unavailable" });
  res.setHeader("Cache-Control", "no-cache");
  return res.json(priceCache.data);
});

/**
 * GET /api/gmx/markets
 * All listed GMX V2 perpetual markets on Arbitrum One. Cached 60 s.
 */
router.get("/gmx/markets", async (_req, res) => {
  if (!marketCache || Date.now() > marketCache.expiresAt) {
    try {
      const r = await fetch(`${GMX_API}/markets`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { markets?: GmxMarket[] } | GmxMarket[];
      const markets: GmxMarket[] = Array.isArray(data) ? data : (data.markets ?? []);
      marketCache = { data: markets.filter(m => m.isListed), expiresAt: Date.now() + 60_000 };
    } catch {
      if (!marketCache) return res.status(502).json({ error: "GMX markets unavailable" });
    }
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  return res.json(marketCache!.data);
});

/**
 * GET /api/gmx/tokens
 * GMX token registry with addresses and decimals. Cached 5 min.
 */
router.get("/gmx/tokens", async (_req, res) => {
  if (!tokenCache || Date.now() > tokenCache.expiresAt) {
    try {
      const r = await fetch(`${GMX_API}/tokens`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      tokenCache = { data: await r.json() as GmxToken[], expiresAt: Date.now() + 300_000 };
    } catch {
      if (!tokenCache) return res.status(502).json({ error: "GMX tokens unavailable" });
    }
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.json(tokenCache!.data);
});

/**
 * GET /api/gmx/candles?symbol=ETH&period=1h&countBack=500
 * OHLCV candle data for backtesting via GMX stats API.
 * Falls back to synthetic data (random walk) in dev if stats API is unavailable.
 */
router.get("/gmx/candles", async (req, res) => {
  const { symbol = "ETH", period = "1h", countBack = "500" } = req.query as Record<string, string>;
  const count = Math.min(Number(countBack) || 500, 1500);

  try {
    const url = `https://stats.gmx.io/api/candleSticks?tokenSymbol=${symbol}&period=${period}&preferredChainId=42161&countBack=${count}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (upstream.ok) {
      const data = await upstream.json() as { prices?: number[][] } | number[][];
      const prices = Array.isArray(data) ? data : (data.prices ?? null);
      if (prices && prices.length > 0) {
        res.setHeader("Cache-Control", "public, max-age=300");
        return res.json({ prices, source: "gmx-stats" });
      }
    }
  } catch { /* fall through to synthetic */ }

  // Synthetic fallback — random walk from current oracle price
  const seed = priceCache?.data.find(p => p.tokenSymbol === symbol)?.priceUsd ?? 2000;
  const msPerBar: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000,
    "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
  };
  const ms = msPerBar[period] ?? 3_600_000;
  const nowSec = Math.floor(Date.now() / 1000);
  let price = seed;
  const prices: number[][] = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = nowSec - i * (ms / 1000);
    price = price * (1 + (Math.random() * 0.012 - 0.006));
    const h = price * (1 + Math.random() * 0.004);
    const l = price * (1 - Math.random() * 0.004);
    const c = price + (Math.random() * 0.008 - 0.004) * price;
    prices.push([t, price, h, l, c, Math.random() * 1e7]);
  }
  res.setHeader("Cache-Control", "no-cache");
  return res.json({ prices, source: "synthetic" });
});

export default router;
