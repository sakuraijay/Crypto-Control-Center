/**
 * GMX V2 API proxy — Arbitrum One
 * Proxies public GMX infrastructure endpoints with server-side caching.
 * No API key required — all data is publicly available.
 *
 * Endpoints:
 *   GET /api/gmx/prices     — oracle prices with 24h change, refreshed every 3 s
 *   GET /api/gmx/change24h  — 24h price change % per symbol, cached 5 min
 *   GET /api/gmx/markets    — listed perpetual markets, cached 60 s
 *   GET /api/gmx/tokens     — token registry with decimals, cached 5 min
 *   GET /api/gmx/candles    — OHLCV candles for backtesting
 */

import { Router } from "express";

const router = Router();
const GMX_API  = "https://arbitrum-api.gmxinfra.io";
const STATS_API = "https://stats.gmx.io";
const POLL_MS  = 3_000;

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
  /** 24-hour price change percent (positive = up). 0 when unavailable. */
  change24hPct: number;
  updatedAt: number;
}

interface GmxToken  { symbol: string; address: string; decimals: number; synthetic?: boolean; }
interface GmxMarket { name: string; marketToken: string; indexToken: string; longToken: string; shortToken: string; isListed: boolean; }
interface CacheEntry<T> { data: T; expiresAt: number; }

// ── Decimal registry ─────────────────────────────────────────────────────────

const DECIMALS_FALLBACK: Record<string, number> = {
  ETH: 18, WETH: 18, ARB: 18, LINK: 18, AVAX: 18, EIGEN: 18, UNI: 18,
  BTC: 8, "WBTC.b": 8, tBTC: 18,
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
    return Number(raw) / Math.pow(10, 30 - decimals);
  } catch {
    return 0;
  }
}

// ── 24h change cache ──────────────────────────────────────────────────────────
// Supported GMX V2 perpetual symbols on Arbitrum One
const SUPPORTED_SYMBOLS = ["ETH", "BTC", "SOL", "ARB", "LINK", "AVAX", "DOGE"];

/** symbol → 24h change % */
let change24hCache: CacheEntry<Record<string, number>> | null = null;

// ── In-memory price snapshot ring (24h change fallback) ─────────────────────
// Stores price snapshots every 5 min per symbol so we can compute 24h change
// even when stats.gmx.io is unreachable.
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const MAX_SNAPSHOTS        = 300; // 25 h of 5-min snapshots
const priceSnapshotRing    = new Map<string, Array<{ price: number; ts: number }>>();

function takeSnapshot() {
  if (!priceCache) return;
  const now = Date.now();
  for (const tick of priceCache.data) {
    if (!SUPPORTED_SYMBOLS.includes(tick.tokenSymbol)) continue;
    const ring = priceSnapshotRing.get(tick.tokenSymbol) ?? [];
    ring.push({ price: tick.priceUsd, ts: now });
    if (ring.length > MAX_SNAPSHOTS) ring.shift();
    priceSnapshotRing.set(tick.tokenSymbol, ring);
  }
}

/** Compute 24h change for one symbol from the snapshot ring. Returns 0 when insufficient data. */
function change24hFromRing(sym: string): number {
  const ring = priceSnapshotRing.get(sym);
  if (!ring || ring.length < 2) return 0;
  const currentPrice = priceCache?.data.find(p => p.tokenSymbol === sym)?.priceUsd ?? 0;
  if (!currentPrice) return 0;
  const target = Date.now() - 24 * 60 * 60_000;
  // find snapshot closest to 24h ago
  const snap = ring.reduce((best, s) =>
    Math.abs(s.ts - target) < Math.abs(best.ts - target) ? s : best,
  );
  return snap.price > 0 ? ((currentPrice - snap.price) / snap.price) * 100 : 0;
}

/**
 * Fetch 24h price change for all supported symbols using the GMX stats API
 * (1-day candles: compare yesterday's close → today's current price).
 * Falls back to in-memory snapshot ring per symbol when stats.gmx.io is down.
 * Stale cache values are preserved on total failure.
 */
async function refreshChange24h(): Promise<void> {
  const results: Record<string, number> = {};
  const failed  = new Set<string>();

  await Promise.allSettled(
    SUPPORTED_SYMBOLS.map(async (sym) => {
      try {
        // countBack=2 gives [yesterday, today] daily candles
        const url = `${STATS_API}/api/candleSticks?tokenSymbol=${sym}&period=1d&preferredChainId=42161&countBack=2`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) { failed.add(sym); return; }
        const data = await r.json() as { prices?: number[][] } | number[][];
        const prices = Array.isArray(data) ? data : ((data as { prices?: number[][] }).prices ?? null);
        if (!prices || prices.length < 2) { failed.add(sym); return; }
        const prevClose = prices[prices.length - 2]?.[4];
        const currClose = prices[prices.length - 1]?.[4];
        if (!prevClose || !currClose || prevClose === 0) { failed.add(sym); return; }
        results[sym] = ((currClose - prevClose) / prevClose) * 100;
      } catch {
        failed.add(sym);
      }
    }),
  );

  // Snapshot-ring fallback for each symbol that failed upstream
  for (const sym of failed) {
    const ringChange = change24hFromRing(sym);
    // Fall back to stale cache if ring also has no data
    results[sym] = ringChange !== 0 ? ringChange : (change24hCache?.data[sym] ?? 0);
  }

  change24hCache = { data: results, expiresAt: Date.now() + 5 * 60_000 };
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
    const ch = change24hCache?.data ?? {};
    const prices: PriceTick[] = tickers.map(t => {
      const d = dec[t.tokenSymbol] ?? 18;
      return {
        tokenAddress:  t.tokenAddress,
        tokenSymbol:   t.tokenSymbol,
        priceUsd:      convertPrice(t.minPrice, d),
        minPriceUsd:   convertPrice(t.minPrice, d),
        maxPriceUsd:   convertPrice(t.maxPrice, d),
        change24hPct:  ch[t.tokenSymbol] ?? 0,
        updatedAt:     t.updatedAt,
      };
    });
    priceCache = { data: prices, expiresAt: Date.now() + 10_000 };
  } catch { /* keep stale cache */ }
}

function ensurePoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  // Initial fetches
  void refreshPrices();
  void refreshChange24h();
  // Price: every 3s; snapshot every 5 min; 24h change: every 5 min
  setInterval(() => void refreshPrices(), POLL_MS);
  setInterval(() => takeSnapshot(), SNAPSHOT_INTERVAL_MS);
  setInterval(() => void refreshChange24h(), 5 * 60_000);
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/gmx/prices
 * All GMX oracle prices with USD conversion and 24h change. Refreshed every 3 s server-side.
 */
router.get("/gmx/prices", async (_req, res) => {
  ensurePoller();
  if (!priceCache || Date.now() > priceCache.expiresAt) await refreshPrices();
  if (!priceCache) return res.status(502).json({ error: "GMX price feed unavailable" });
  res.setHeader("Cache-Control", "no-cache");
  return res.json(priceCache.data);
});

/**
 * GET /api/gmx/change24h
 * 24-hour price change % for all supported GMX V2 symbols. Cached 5 min.
 * Returns: [{ symbol: string, change24hPct: number }]
 */
router.get("/gmx/change24h", async (_req, res) => {
  ensurePoller();
  if (!change24hCache || Date.now() > change24hCache.expiresAt) {
    await refreshChange24h();
  }
  const data = change24hCache?.data ?? {};
  const result = Object.entries(data).map(([symbol, change24hPct]) => ({ symbol, change24hPct }));
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.json(result);
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
      const markets = Array.isArray(data) ? data : ((data as { markets?: GmxMarket[] }).markets ?? []);
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
 * Token registry with decimals. Cached 5 min.
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
    const url = `${STATS_API}/api/candleSticks?tokenSymbol=${symbol}&period=${period}&preferredChainId=42161&countBack=${count}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (upstream.ok) {
      const data = await upstream.json() as { prices?: number[][] } | number[][];
      const prices = Array.isArray(data) ? data : ((data as { prices?: number[][] }).prices ?? null);
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
