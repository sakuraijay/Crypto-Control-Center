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

// ── Internal exports (for server-side worker — avoids HTTP overhead) ──────────

/**
 * Returns the latest cached price ticks, or null when the cache is empty.
 * Used by the AI worker to read prices without an HTTP round-trip.
 */
export function getCachedPrices(): PriceTick[] | null {
  return priceCache ? priceCache.data : null;
}

/**
 * Returns the latest cached 24h change % map, or null when unavailable.
 * Used by the AI worker to enrich indicator calculations.
 */
export function getCachedChange24h(): Record<string, number> | null {
  return change24hCache ? change24hCache.data : null;
}

/**
 * Ensures the background price poller is running.
 * Safe to call multiple times — idempotent via pollerStarted guard.
 */
export { ensurePoller as ensureGmxPoller };

// ── Positions proxy — Arbitrum RPC ────────────────────────────────────────────
//
// Browser → GET /api/gmx/positions?account=0x…
//         → server queries Arbitrum RPC (GMX V2 PositionReader)
//         → { positions: SubgraphPosition[], source: "rpc" }
//         → { positions: [], source: "unavailable" } on RPC failure
//
// "unavailable" is returned only when RPC fails — the browser must NOT
// clear displayed positions in that case; it shows last known positions.
//
// Cache policy:
//   - Successful result (rpc): 30 s TTL
//   - unavailable: 5 s TTL (allows quick retry on next browser poll)
//
// Privacy: wallet address only; no keys, signatures, or balances stored.

import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { arbitrum } from "viem/chains";

// ── GMX V2 Arbitrum contract addresses (verified on-chain 2026-08-15) ────────
// PositionReader: confirmed via eth_getCode (21535 bytes)
// DataStore: confirmed via Reader.dataStore() → getAccountPositions returns 200
const POSITION_READER_ADDRESS = "0x5Ca84c34a381434786738735265b9f3FD814b824" as const;
const DATASTORE_ADDRESS       = "0xfd70de6b91282d8017aa4e741e9ae325cab992d8" as const;

// Arbitrum public RPC nodes (confirmed reachable from Replit sandbox)
const ARBITRUM_RPC_URLS = [
  "https://arb1.arbitrum.io/rpc",
  "https://rpc.ankr.com/arbitrum",
] as const;

/** GMX V2 PositionReader.getAccountPositions ABI fragment. */
const POSITION_READER_ABI = [
  {
    name: "getAccountPositions",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      { name: "dataStore", type: "address" as const },
      { name: "account",   type: "address" as const },
      { name: "start",     type: "uint256" as const },
      { name: "end",       type: "uint256" as const },
    ],
    outputs: [
      {
        type: "tuple[]" as const,
        components: [
          {
            name: "addresses",
            type: "tuple" as const,
            components: [
              { name: "account",        type: "address" as const },
              { name: "market",         type: "address" as const },
              { name: "collateralToken",type: "address" as const },
            ],
          },
          {
            name: "numbers",
            type: "tuple" as const,
            components: [
              { name: "sizeInUsd",                                 type: "uint256" as const },
              { name: "sizeInTokens",                              type: "uint256" as const },
              { name: "collateralAmount",                          type: "uint256" as const },
              { name: "realisedPnlUsd",                            type: "int256"  as const },
              { name: "increasedAtTime",                           type: "uint256" as const },
              { name: "decreasedAtTime",                           type: "uint256" as const },
              { name: "borrowingFactor",                           type: "uint256" as const },
              { name: "fundingFeeAmountPerSize",                   type: "uint256" as const },
              { name: "longTokenClaimableFundingAmountPerSize",    type: "uint256" as const },
              { name: "shortTokenClaimableFundingAmountPerSize",   type: "uint256" as const },
            ],
          },
          {
            name: "flags",
            type: "tuple" as const,
            components: [
              { name: "isLong", type: "bool" as const },
            ],
          },
        ],
      },
    ],
  },
] as const;

// All position reads go through Arbitrum RPC (GMX V2 PositionReader). See fetchFromRpc().

/** Raw position shape from Arbitrum RPC normaliser. */
type SubgraphPosition = {
  id:               string;
  account:          string;
  market:           string;
  collateralToken:  string;
  sizeInUsd:        string;
  sizeInTokens?:    string | null;
  collateralAmount: string;
  realisedPnlUsd:   string;
  isLong:           boolean;
  increasedAtTime?: string | null;
  liquidationPrice?: string | null;
};

export interface PositionsResult {
  positions: SubgraphPosition[];
  /**
   * 'rpc'         — Arbitrum RPC via GMX V2 PositionReader (only active source)
   * 'unavailable' — RPC failed; browser MUST keep showing last known positions
   */
  source: 'rpc' | 'unavailable';
}

/** Per-account position cache. */
const positionsCache = new Map<string, CacheEntry<PositionsResult>>();
const POSITIONS_CACHE_TTL         = 30_000; // successful fetch
const POSITIONS_UNAVAILABLE_TTL   =  5_000; // failure — retry sooner

// ── LIVE TEST server-side verification cache ──────────────────────────────────
// Short TTL to keep data fresh for every AI cycle without hammering the subgraph.
const LIVE_TEST_VERIFY_TTL_OK  = 30_000; // success: cache 30s
const LIVE_TEST_VERIFY_TTL_ERR =  3_000; // failure: retry sooner (fail-closed window)

interface LiveTestServerData {
  /** Number of active on-chain GMX positions. 999 = fail-closed sentinel. */
  positionCount: number;
  /** true = authoritative server-side subgraph/RPC query succeeded. false = fail-closed. */
  subgraphOk: boolean;
  fetchedAt: number;
  expiresAt: number;
}

let liveTestServerCache: LiveTestServerData | null = null;

/**
 * fetchServerLiveTestData — authoritative server-side LIVE TEST position and
 * connectivity verification using GMX_WALLET_ADDRESS env var.
 *
 * Queries Arbitrum RPC directly (GMX V2 PositionReader contract).
 * Results are cached for LIVE_TEST_VERIFY_TTL_OK ms on success to avoid
 * hammering the RPC on every AI cycle (typically 60s).
 * Browser-posted diagnostics are NOT used.
 *
 * Returns { positionCount: 999, subgraphOk: false } on any failure so the
 * LIVE TEST hardcap always fails closed when the data source is unavailable.
 */
export async function fetchServerLiveTestData(): Promise<{ positionCount: number; subgraphOk: boolean }> {
  // Serve from cache if still fresh
  if (liveTestServerCache && Date.now() < liveTestServerCache.expiresAt) {
    return { positionCount: liveTestServerCache.positionCount, subgraphOk: liveTestServerCache.subgraphOk };
  }

  const walletAddress = process.env.GMX_WALLET_ADDRESS?.toLowerCase() ?? '';
  if (!walletAddress || !isValidAddress(walletAddress)) {
    // GMX_WALLET_ADDRESS not configured — fail-closed (cannot verify)
    liveTestServerCache = {
      positionCount: 999, subgraphOk: false,
      fetchedAt: Date.now(), expiresAt: Date.now() + LIVE_TEST_VERIFY_TTL_ERR,
    };
    return { positionCount: 999, subgraphOk: false };
  }

  // Use RPC directly (GMX V2 PositionReader contract on Arbitrum).
  const positions: SubgraphPosition[] | null = await fetchFromRpc(walletAddress);
  const ok = positions !== null;

  if (ok && positions !== null) {
    const positionCount = positions.length;
    liveTestServerCache = {
      positionCount, subgraphOk: true,
      fetchedAt: Date.now(), expiresAt: Date.now() + LIVE_TEST_VERIFY_TTL_OK,
    };
    return { positionCount, subgraphOk: true };
  }

  // Both upstreams failed → fail-closed (sentinel 999 blocks LIVE TEST immediately)
  liveTestServerCache = {
    positionCount: 999, subgraphOk: false,
    fetchedAt: Date.now(), expiresAt: Date.now() + LIVE_TEST_VERIFY_TTL_ERR,
  };
  return { positionCount: 999, subgraphOk: false };
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * 6G-2 §5 — CLOSE 실행 전 열린 포지션 증거 (온체인 PositionReader, 권위 소스).
 * 조회 실패 = null (호출부는 fail-closed로 CLOSE 차단해야 한다).
 * fetchServerLiveTestData와 달리 캐시 없이 실조회 — CLOSE는 즉시성이 중요하다.
 */
export async function fetchServerOpenPositions(): Promise<
  { marketAddress: string; isLong: boolean; sizeUsd: number }[] | null
> {
  const walletAddress = process.env.GMX_WALLET_ADDRESS?.toLowerCase() ?? '';
  if (!walletAddress || !isValidAddress(walletAddress)) return null;
  const positions = await fetchFromRpc(walletAddress);
  if (positions === null) return null;
  return positions.map((p) => ({
    marketAddress: p.market,
    isLong: p.isLong,
    sizeUsd: Number(p.sizeInUsd) / 1e30,
  }));
}

/**
 * Primary (and only): read positions on-chain via GMX V2 PositionReader on Arbitrum.
 * Uses viem for proper ABI decode. liquidationPrice is not available on-chain
 * without oracle data, so it is left null.
 */
async function fetchFromRpc(account: string): Promise<SubgraphPosition[] | null> {
  for (const rpcUrl of ARBITRUM_RPC_URLS) {
    try {
      const client = createPublicClient({
        chain:     arbitrum,
        transport: http(rpcUrl, { timeout: 8_000 }),
      });

      type RawPos = {
        addresses: { account: `0x${string}`; market: `0x${string}`; collateralToken: `0x${string}` };
        numbers:   { sizeInUsd: bigint; sizeInTokens: bigint; collateralAmount: bigint; realisedPnlUsd: bigint; increasedAtTime: bigint };
        flags:     { isLong: boolean };
      };

      const rawPositions = await client.readContract({
        address:      POSITION_READER_ADDRESS,
        abi:          POSITION_READER_ABI,
        functionName: "getAccountPositions",
        args: [
          DATASTORE_ADDRESS,
          account as `0x${string}`,
          0n,
          20n,
        ],
      }) as unknown as RawPos[];

      // Normalise on-chain data to the SubgraphPosition shape.
      // Position key = keccak256(account || market || collateralToken || isLong) — matches GMX V2 spec.
      return rawPositions.map(pos => {
        const positionKey = keccak256(
          encodeAbiParameters(
            parseAbiParameters("address, address, address, bool"),
            [
              pos.addresses.account,
              pos.addresses.market,
              pos.addresses.collateralToken,
              pos.flags.isLong,
            ],
          ),
        );
        return {
          id:               positionKey,
          account:          pos.addresses.account.toLowerCase(),
          market:           pos.addresses.market.toLowerCase(),
          collateralToken:  pos.addresses.collateralToken.toLowerCase(),
          sizeInUsd:        pos.numbers.sizeInUsd.toString(),
          sizeInTokens:     pos.numbers.sizeInTokens.toString(),
          collateralAmount: pos.numbers.collateralAmount.toString(),
          realisedPnlUsd:   pos.numbers.realisedPnlUsd.toString(),
          isLong:           pos.flags.isLong,
          increasedAtTime:  pos.numbers.increasedAtTime.toString(),
          liquidationPrice: null, // not available from RPC without oracle prices
        };
      });
    } catch {
      // Try the next RPC endpoint.
    }
  }
  return null; // all RPC endpoints failed
}

/**
 * GET /api/gmx/positions?account=0x…
 *
 * Returns active GMX V2 positions for the given wallet address.
 * Data source: Arbitrum RPC (GMX V2 PositionReader).
 *
 * When source = "unavailable" the browser MUST NOT clear displayed positions —
 * it should keep showing the last known positions as stale data.
 *
 * Cache TTL: 30 s on success, 5 s on unavailable (so the next poll retries quickly).
 */
router.get("/gmx/positions", async (req, res) => {
  const account = String(req.query.account ?? "").toLowerCase();
  if (!isValidAddress(account)) {
    return res
      .status(400)
      .json({ error: "Invalid account address — must be 0x + 40 hex chars" });
  }

  // Serve from cache when fresh
  const cached = positionsCache.get(account);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader("Cache-Control", "no-cache");
    return res.json(cached.data);
  }

  // Arbitrum RPC via GMX V2 PositionReader — only active data source.
  const rpcPositions = await fetchFromRpc(account);
  if (rpcPositions != null) {
    const result: PositionsResult = { positions: rpcPositions, source: "rpc" };
    positionsCache.set(account, { data: result, expiresAt: Date.now() + POSITIONS_CACHE_TTL });
    res.setHeader("Cache-Control", "no-cache");
    return res.json(result);
  }

  // 2. RPC failed — return empty with unavailable signal.
  // Short cache TTL so the next browser poll retries in 5 s, not 30 s.
  const result: PositionsResult = { positions: [], source: "unavailable" };
  positionsCache.set(account, { data: result, expiresAt: Date.now() + POSITIONS_UNAVAILABLE_TTL });
  res.setHeader("Cache-Control", "no-cache");
  return res.json(result);
});

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
 * 내부 재사용 — GMX stats 캔들 조회. 실패/빈 응답 = null (합성 데이터 생성 금지).
 * 6I-1 §2 결함 수정: 이전의 random-walk synthetic fallback은 출처 없는 값 생성이자
 * 200 응답으로 실패를 은닉하는 fail-open이었으므로 완전 제거했다.
 */
export async function fetchGmxCandles(
  symbol: string, period: string, countBack: number,
): Promise<{ prices: number[][]; source: "gmx-stats" } | null> {
  const count = Math.min(Math.max(1, Math.floor(countBack) || 500), 1500);
  try {
    const url = `${STATS_API}/api/candleSticks?tokenSymbol=${symbol}&period=${period}&preferredChainId=42161&countBack=${count}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!upstream.ok) return null;
    const data = await upstream.json() as { prices?: number[][] } | number[][];
    const prices = Array.isArray(data) ? data : ((data as { prices?: number[][] }).prices ?? null);
    if (!prices || prices.length === 0) return null;
    return { prices, source: "gmx-stats" };
  } catch {
    return null;
  }
}

/**
 * GET /api/gmx/candles?symbol=ETH&period=1h&countBack=500
 * OHLCV candle data for backtesting via GMX stats API.
 * 실패 시 502 — 합성(random walk) 데이터 생성 금지 (6I-1 §3: 출처 없는 값 생성 금지).
 */
router.get("/gmx/candles", async (req, res) => {
  const { symbol = "ETH", period = "1h", countBack = "500" } = req.query as Record<string, string>;
  const result = await fetchGmxCandles(symbol, period, Number(countBack) || 500);
  if (!result) {
    res.setHeader("Cache-Control", "no-cache");
    return res.status(502).json({ error: "candles unavailable", reason: "GMX stats API 실패 — 합성 데이터 대체 금지" });
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.json(result);
});

export default router;
