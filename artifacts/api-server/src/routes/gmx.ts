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
import { createRequire } from "node:module";

// ── #120: 공식 SDK token registry (address→symbol/decimals 결속) ─────────────
// 과거 심볼 기반 decimals 추측(기본 18)이 XRP(6)/HYPE(8) 가격을 1e10~1e12배
// 과대 오염시켰다 (upstream /tokens 404 → fallback만 동작). 이제 tokenAddress를
// 공식 @gmx-io/sdk configs/tokens[42161]에 결속하고, 미등재·심볼 불일치·범위 밖
// 가격은 tick 자체를 폐기한다 (추측/클램프/0 대체 금지 — fail-closed).
const _require = createRequire(import.meta.url ?? __filename);
const { TOKENS: SDK_TOKENS } = _require("@gmx-io/sdk/configs/tokens") as typeof import("@gmx-io/sdk/configs/tokens");

export const PRICE_SOURCE_PIN =
  "arbitrum-api.gmxinfra.io/prices/tickers(1e30-scale)+@gmx-io/sdk configs/tokens[42161] address-bound decimals";

/** 합리적 USD 가격 범위 — 범위 밖 = 스케일 오염 의심, tick 폐기 (클램프 금지) */
export const PRICE_SANE_MIN_USD = 1e-9;
export const PRICE_SANE_MAX_USD = 1e8;

interface SdkTokenBinding { symbol: string; decimals: number; }
// 주소 하나에 복수 심볼 허용: 공식 tickers는 native 심볼(ETH)을 wrapped 주소(WETH)로
// 보고한다 — SDK native 항목의 wrappedAddress도 native 심볼로 함께 등록 (추측 아님,
// SDK registry의 명시 필드 결속).
const sdkTokensByAddress: Map<string, SdkTokenBinding[]> = (() => {
  const m = new Map<string, SdkTokenBinding[]>();
  const add = (addr: string, b: SdkTokenBinding) => {
    const k = addr.toLowerCase();
    const arr = m.get(k) ?? [];
    if (!arr.some((x) => x.symbol === b.symbol)) arr.push(b);
    m.set(k, arr);
  };
  type SdkTokenEntry = { symbol: string; address: string; decimals: number; wrappedAddress?: string; isNative?: boolean };
  const arb = (SDK_TOKENS as Record<number, SdkTokenEntry[] | Record<string, SdkTokenEntry>>)[42161] ?? [];
  const list: SdkTokenEntry[] = Array.isArray(arb) ? arb : Object.values(arb);
  for (const t of list) {
    if (typeof t?.address !== "string" || typeof t?.symbol !== "string" || !Number.isInteger(t?.decimals)) continue;
    add(t.address, { symbol: t.symbol, decimals: t.decimals });
    if (t.isNative && typeof t.wrappedAddress === "string") {
      add(t.wrappedAddress, { symbol: t.symbol, decimals: t.decimals });
    }
  }
  return m;
})();

/** #120 계측 — 폐기 사유별 카운터 (0 위장 방지: 폐기는 침묵하지 않고 집계) */
export const priceTickRejectStats = {
  unknownAddress: 0, symbolMismatch: 0, badRaw: 0, outOfRange: 0,
  lastRejectAtMs: 0 as number, lastRejectSymbols: [] as string[],
};

const router = Router();
const GMX_API  = "https://arbitrum-api.gmxinfra.io";
// 공식 GMX API — stats.gmx.io는 DNS 소멸(2026-08 관찰)로 candles를 이 API로 전환
const GMX_API_BASE = "https://arbitrum-api.gmxinfra.io";
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

/** raw 1e30-scale 문자열 → USD. 비정상 입력은 null (0 대체 금지). */
function convertPrice(raw: string, decimals: number): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const v = Number(raw) / Math.pow(10, 30 - decimals);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * #120 — RawTicker 1건을 SDK registry 결속 + 범위 검증으로 변환.
 * 미등재 주소·심볼 불일치·비정상 raw·범위 밖 가격 = null (tick 폐기, 집계).
 */
export function bindAndConvertTick(t: RawTicker, ch: Record<string, number>): PriceTick | null {
  const reject = (kind: keyof typeof priceTickRejectStats & string) => {
    (priceTickRejectStats as Record<string, number | unknown>)[kind] =
      (priceTickRejectStats as unknown as Record<string, number>)[kind] + 1;
    priceTickRejectStats.lastRejectAtMs = Date.now();
    const tag = `${t.tokenSymbol}:${kind}`;
    if (!priceTickRejectStats.lastRejectSymbols.includes(tag)) {
      priceTickRejectStats.lastRejectSymbols.push(tag);
      if (priceTickRejectStats.lastRejectSymbols.length > 20) priceTickRejectStats.lastRejectSymbols.shift();
    }
    return null;
  };
  if (typeof t.tokenAddress !== "string") return reject("unknownAddress");
  const candidates = sdkTokensByAddress.get(t.tokenAddress.toLowerCase());
  if (!candidates || candidates.length === 0) return reject("unknownAddress");
  // 대소문자 차이만 있는 결속 허용 (SDK 'USDC.E' vs tickers 'USDC.e' — 동일 주소·동일 토큰)
  const sdk = candidates.find((c) => c.symbol.toLowerCase() === String(t.tokenSymbol).toLowerCase());
  if (!sdk) return reject("symbolMismatch");
  const minUsd = convertPrice(t.minPrice, sdk.decimals);
  const maxUsd = convertPrice(t.maxPrice, sdk.decimals);
  if (minUsd === null || maxUsd === null) return reject("badRaw");
  if (minUsd < PRICE_SANE_MIN_USD || maxUsd > PRICE_SANE_MAX_USD || maxUsd < minUsd) return reject("outOfRange");
  return {
    tokenAddress: t.tokenAddress,
    tokenSymbol: t.tokenSymbol,
    priceUsd: minUsd,
    minPriceUsd: minUsd,
    maxPriceUsd: maxUsd,
    change24hPct: ch[t.tokenSymbol] ?? 0,
    updatedAt: t.updatedAt,
  };
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
        // limit=2 gives [today, yesterday] daily candles (공식 API, 최신→과거)
        const url = `${GMX_API_BASE}/prices/candles?tokenSymbol=${sym}&period=1d&limit=2`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) { failed.add(sym); return; }
        const data = await r.json() as { candles?: number[][] };
        const raw = Array.isArray(data?.candles) ? data.candles : null;
        if (!raw || raw.length < 2) { failed.add(sym); return; }
        const prices = [...raw].sort((a, b) => a[0] - b[0]);
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
    void dec; // decimals API 맵은 /gmx/tokens 표시용으로만 유지 — 가격 결속은 SDK registry 전용 (#120)
    const prices: PriceTick[] = [];
    for (const t of tickers) {
      const tick = bindAndConvertTick(t, ch);
      if (tick) prices.push(tick);
    }
    // 전량 폐기 = 피드 오염/계약 위반 의심 — 빈 캐시로 교체하지 않고 stale 유지 (0 위장 금지)
    if (prices.length === 0) return;
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
// Browser → GET /api/gmx/positions (server-configured owner account)
//         → server queries Arbitrum RPC (GMX V2 PositionReader)
//         → { positions: CanonicalPosition[], source: "rpc" }
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
  formatEther,
  formatUnits,
} from "viem";
import { arbitrum } from "viem/chains";

// ── GMX V2 Arbitrum contract addresses (verified on-chain 2026-08-15) ────────
// PositionReader: confirmed via eth_getCode (21535 bytes)
// DataStore: confirmed via Reader.dataStore() → getAccountPositions returns 200
const POSITION_READER_ADDRESS = "0x5Ca84c34a381434786738735265b9f3FD814b824" as const;
const DATASTORE_ADDRESS       = "0xfd70de6b91282d8017aa4e741e9ae325cab992d8" as const;
const ARBITRUM_USDC_ADDRESS   = "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const;

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" as const }],
    outputs: [{ name: "balance", type: "uint256" as const }],
  },
] as const;

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
type CanonicalPosition = {
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
  positions: CanonicalPosition[];
  /**
   * 'rpc'         — Arbitrum RPC via GMX V2 PositionReader (only active source)
   * 'unavailable' — RPC failed; browser MUST keep showing last known positions
   */
  source: 'rpc' | 'unavailable';
  /** Server request time for stale-data detection; never an on-chain block timestamp. */
  fetchedAtMs: number;
  /** Whether the server-configured owner account or an explicit development query was used. */
  accountSource: 'configured' | 'query';
  /** Read-only GMX API count cross-check; never used as execution evidence. */
  apiCrosscheck: {
    ok: boolean;
    positionCount: number | null;
    consistency: 'matched' | 'mismatch' | 'unavailable' | 'rpc-unavailable';
  };
  balances: {
    source: 'rpc' | 'unavailable';
    eth: string | null;
    usdc: string | null;
  };
}

/** Per-account position cache. */
const positionsCache = new Map<string, CacheEntry<PositionsResult>>();
const POSITIONS_CACHE_TTL         = 30_000; // successful fetch
const POSITIONS_UNAVAILABLE_TTL   =  5_000; // failure — retry sooner

// ── LIVE TEST server-side verification cache ──────────────────────────────────
// Short TTL to keep data fresh for every AI cycle without hammering Arbitrum RPC.
const LIVE_TEST_VERIFY_TTL_OK  = 30_000; // success: cache 30s
const LIVE_TEST_VERIFY_TTL_ERR =  3_000; // failure: retry sooner (fail-closed window)

interface LiveTestServerData {
  /** Number of active on-chain GMX positions. 999 = fail-closed sentinel. */
  positionCount: number;
  /** Legacy field name: true only when authoritative server-side RPC succeeded. */
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
  const positions: CanonicalPosition[] | null = await fetchFromRpc(walletAddress);
  const ok = positions !== null;

  if (ok && positions !== null) {
    const positionCount = positions.length;
    liveTestServerCache = {
      positionCount, subgraphOk: true,
      fetchedAt: Date.now(), expiresAt: Date.now() + LIVE_TEST_VERIFY_TTL_OK,
    };
    return { positionCount, subgraphOk: true };
  }

  // Authoritative RPC failed → fail-closed (sentinel 999 blocks LIVE TEST immediately)
  liveTestServerCache = {
    positionCount: 999, subgraphOk: false,
    fetchedAt: Date.now(), expiresAt: Date.now() + LIVE_TEST_VERIFY_TTL_ERR,
  };
  return { positionCount: 999, subgraphOk: false };
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export type PositionsAccountResolution =
  | { ok: true; account: string; source: 'configured' | 'query' }
  | { ok: false; status: 400 | 403 | 503; error: string };

/**
 * Resolve the canonical read-only account without requiring a browser wallet.
 * A configured owner account wins; an explicit mismatched query is rejected so
 * the personal dashboard cannot silently switch to a different account.
 */
export function resolvePositionsAccount(
  queryValue: unknown,
  configuredValue: string | undefined,
): PositionsAccountResolution {
  const query = typeof queryValue === 'string' ? queryValue.trim().toLowerCase() : '';
  const configured = configuredValue?.trim().toLowerCase() ?? '';

  if (query && !isValidAddress(query)) {
    return { ok: false, status: 400, error: 'Invalid account address — must be 0x + 40 hex chars' };
  }
  if (configured && !isValidAddress(configured)) {
    return { ok: false, status: 503, error: 'Configured GMX account is invalid' };
  }
  if (configured) {
    if (query && query !== configured) {
      return { ok: false, status: 403, error: 'Requested account does not match configured GMX account' };
    }
    return { ok: true, account: configured, source: 'configured' };
  }
  if (query) return { ok: true, account: query, source: 'query' };
  return { ok: false, status: 503, error: 'GMX_WALLET_ADDRESS is not configured' };
}

export function classifyPositionCountConsistency(
  rpcCount: number | null,
  apiCount: number | null,
): PositionsResult['apiCrosscheck']['consistency'] {
  if (rpcCount === null) return apiCount === null ? 'unavailable' : 'rpc-unavailable';
  if (apiCount === null) return 'unavailable';
  return rpcCount === apiCount ? 'matched' : 'mismatch';
}

let gmxApiSdkPromise: Promise<{
  fetchPositionsInfo(args: { address: string }): Promise<unknown[]>;
}> | null = null;
const GMX_API_CROSSCHECK_TIMEOUT_MS = 5_000;

export async function readWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * Official GMX API read used only to cross-check the canonical RPC count.
 * No signer, key material, order method, or delegated account is initialized.
 */
async function fetchGmxApiPositionCount(account: string): Promise<number | null> {
  try {
    gmxApiSdkPromise ??= import('@gmx-io/sdk/v2').then(({ GmxApiSdk }) =>
      new GmxApiSdk({ chainId: arbitrum.id }),
    );
    const sdk = await gmxApiSdkPromise;
    const positions = await readWithTimeout(
      sdk.fetchPositionsInfo({ address: account }),
      GMX_API_CROSSCHECK_TIMEOUT_MS,
    );
    return Array.isArray(positions) ? positions.length : null;
  } catch {
    return null;
  }
}

async function fetchAccountBalancesFromRpc(
  account: string,
): Promise<PositionsResult['balances']> {
  for (const rpcUrl of ARBITRUM_RPC_URLS) {
    try {
      const client = createPublicClient({
        chain: arbitrum,
        transport: http(rpcUrl, { timeout: 8_000 }),
      });
      const [ethWei, usdcRaw] = await Promise.all([
        client.getBalance({ address: account as `0x${string}` }),
        client.readContract({
          address: ARBITRUM_USDC_ADDRESS,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [account as `0x${string}`],
        }),
      ]);
      return {
        source: 'rpc',
        eth: formatEther(ethWei),
        usdc: formatUnits(usdcRaw, 6),
      };
    } catch {
      // Try the next read-only RPC endpoint.
    }
  }
  return { source: 'unavailable', eth: null, usdc: null };
}

/**
 * 6G-2 §5 — CLOSE 실행 전 열린 포지션 증거 (온체인 PositionReader, 권위 소스).
 * 조회 실패 = null (호출부는 fail-closed로 CLOSE 차단해야 한다).
 * fetchServerLiveTestData와 달리 캐시 없이 실조회 — CLOSE는 즉시성이 중요하다.
 */
export async function fetchServerOpenPositions(): Promise<
  {
    positionKey: string;
    accountAddress: string;
    marketAddress: string;
    collateralToken: string;
    isLong: boolean;
    sizeUsd: number;
    sizeUsd30: string;
  }[] | null
> {
  const walletAddress = process.env.GMX_WALLET_ADDRESS?.toLowerCase() ?? '';
  if (!walletAddress || !isValidAddress(walletAddress)) return null;
  const positions = await fetchFromRpc(walletAddress);
  if (positions === null) return null;
  return positions.map((p) => ({
    positionKey: p.id,
    accountAddress: p.account,
    marketAddress: p.market,
    collateralToken: p.collateralToken,
    isLong: p.isLong,
    sizeUsd: Number(p.sizeInUsd) / 1e30,
    sizeUsd30: p.sizeInUsd,
  }));
}

/**
 * Authoritative read: positions on-chain via GMX V2 PositionReader on Arbitrum.
 * Uses viem for proper ABI decode. liquidationPrice is not available on-chain
 * without oracle data, so it is left null.
 */
async function fetchFromRpc(account: string): Promise<CanonicalPosition[] | null> {
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

      // Normalise on-chain data to the canonical API response shape.
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
 * GET /api/gmx/positions[?account=0x…]
 *
 * Returns active GMX V2 positions for the server-configured owner account.
 * An explicit query is development-only when no owner is configured, or must
 * exactly match the configured account.
 * Data source: Arbitrum RPC (GMX V2 PositionReader).
 *
 * When source = "unavailable" the browser MUST NOT clear displayed positions —
 * it should keep showing the last known positions as stale data.
 *
 * Cache TTL: 30 s on success, 5 s on unavailable (so the next poll retries quickly).
 */
router.get("/gmx/positions", async (req, res) => {
  const resolved = resolvePositionsAccount(req.query.account, process.env.GMX_WALLET_ADDRESS);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const { account } = resolved;

  // Serve from cache when fresh
  const cached = positionsCache.get(account);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader("Cache-Control", "no-cache");
    return res.json(cached.data);
  }

  // The GMX API request is a read-only count cross-check only. RPC remains the
  // sole source for exact position identity/size and all execution evidence.
  const apiCountPromise = fetchGmxApiPositionCount(account);
  const balancesPromise = fetchAccountBalancesFromRpc(account);
  const rpcPositions = await fetchFromRpc(account);
  const [apiPositionCount, balances] = await Promise.all([apiCountPromise, balancesPromise]);
  const consistency = classifyPositionCountConsistency(
    rpcPositions?.length ?? null,
    apiPositionCount,
  );
  const apiCrosscheck: PositionsResult['apiCrosscheck'] = {
    ok: apiPositionCount !== null,
    positionCount: apiPositionCount,
    consistency,
  };
  const fetchedAtMs = Date.now();
  if (rpcPositions != null) {
    const result: PositionsResult = {
      positions: rpcPositions,
      source: "rpc",
      fetchedAtMs,
      accountSource: resolved.source,
      apiCrosscheck,
      balances,
    };
    positionsCache.set(account, { data: result, expiresAt: Date.now() + POSITIONS_CACHE_TTL });
    res.setHeader("Cache-Control", "no-cache");
    return res.json(result);
  }

  // 2. RPC failed — return empty with unavailable signal.
  // Short cache TTL so the next browser poll retries in 5 s, not 30 s.
  const result: PositionsResult = {
    positions: [],
    source: "unavailable",
    fetchedAtMs,
    accountSource: resolved.source,
    apiCrosscheck,
    balances,
  };
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
/** 6I-2 §4 — candle fetch 계측 (읽기 전용 관측치; 상태 API에서 노출) */
export interface CandleFetchStats {
  requests: number;
  ok: number;
  http429: number;
  http5xx: number;
  httpOther: number;
  timeouts: number;
  invalidPayload: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastErrorKind: string | null;
  last429AtMs: number | null;
}
const candleFetchStats: CandleFetchStats = {
  requests: 0, ok: 0, http429: 0, http5xx: 0, httpOther: 0,
  timeouts: 0, invalidPayload: 0, totalLatencyMs: 0, maxLatencyMs: 0,
  lastErrorKind: null, last429AtMs: null,
};
export function getCandleFetchStats(): Readonly<CandleFetchStats> {
  return candleFetchStats;
}

/** 응답 크기 상한 — 1500 캔들 × ~60byte 여유 포함 */
const CANDLE_RESPONSE_MAX_BYTES = 512 * 1024;
const CANDLE_PERIOD_ALLOWLIST = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

/**
 * 6I-2 §5 — 검증된 GMX infrastructure endpoint 계약:
 *  - host 고정(arbitrum-api.gmxinfra.io, HTTPS) · redirect 금지 · period allowlist
 *  - 응답 크기 상한 · JSON schema 검증([t,o,h,l,c] 숫자 5개 이상) · 중복 timestamp 제거
 *  - 최신→과거 역순 응답 → ascending 정렬 (t는 초 단위 open time)
 *  - 실패 = null (합성 데이터 생성 금지) + 계측만 기록 (응답 원문/URL 로그 금지)
 */
export async function fetchGmxCandles(
  symbol: string, period: string, countBack: number,
): Promise<{ prices: number[][]; source: "gmx-official-api" } | null> {
  const count = Math.min(Math.max(1, Math.floor(countBack) || 500), 1500);
  if (!CANDLE_PERIOD_ALLOWLIST.has(period)) {
    candleFetchStats.invalidPayload++; candleFetchStats.lastErrorKind = "PERIOD_NOT_ALLOWED";
    return null;
  }
  if (!/^[A-Z0-9.]{1,15}$/i.test(symbol)) {
    candleFetchStats.invalidPayload++; candleFetchStats.lastErrorKind = "SYMBOL_INVALID";
    return null;
  }
  candleFetchStats.requests++;
  const startedAt = Date.now();
  try {
    const url = `${GMX_API_BASE}/prices/candles?tokenSymbol=${encodeURIComponent(symbol)}&period=${period}&limit=${count}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    const latency = Date.now() - startedAt;
    candleFetchStats.totalLatencyMs += latency;
    candleFetchStats.maxLatencyMs = Math.max(candleFetchStats.maxLatencyMs, latency);
    if (!upstream.ok) {
      if (upstream.status === 429) { candleFetchStats.http429++; candleFetchStats.last429AtMs = Date.now(); candleFetchStats.lastErrorKind = "HTTP_429"; }
      else if (upstream.status >= 500 && upstream.status < 600) { candleFetchStats.http5xx++; candleFetchStats.lastErrorKind = "HTTP_5XX"; }
      else { candleFetchStats.httpOther++; candleFetchStats.lastErrorKind = `HTTP_${upstream.status}`; }
      return null;
    }
    const text = await upstream.text();
    if (text.length > CANDLE_RESPONSE_MAX_BYTES) {
      candleFetchStats.invalidPayload++; candleFetchStats.lastErrorKind = "RESPONSE_TOO_LARGE";
      return null;
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch {
      candleFetchStats.invalidPayload++; candleFetchStats.lastErrorKind = "NON_JSON";
      return null;
    }
    const candles = (data as { candles?: unknown })?.candles;
    if (!Array.isArray(candles) || candles.length === 0) {
      candleFetchStats.invalidPayload++; candleFetchStats.lastErrorKind = "SCHEMA_MISMATCH";
      return null;
    }
    // schema 검증 + 중복 timestamp 제거 (schema 위반=전체 거부, fail-closed)
    const seen = new Set<number>();
    const cleaned: number[][] = [];
    for (const row of candles) {
      if (!Array.isArray(row) || row.length < 5 || row.slice(0, 5).some(v => typeof v !== "number" || !Number.isFinite(v))) {
        candleFetchStats.invalidPayload++; candleFetchStats.lastErrorKind = "SCHEMA_MISMATCH";
        return null;
      }
      if (seen.has(row[0])) continue;   // 중복 candle timestamp 제거
      seen.add(row[0]);
      cleaned.push(row as number[]);
    }
    if (cleaned.length === 0) { candleFetchStats.invalidPayload++; candleFetchStats.lastErrorKind = "EMPTY_AFTER_DEDUPE"; return null; }
    // 오름차순 정렬(과거→최신) — consumers(backtest, intel)는 ascending 가정
    cleaned.sort((a, b) => a[0] - b[0]);
    candleFetchStats.ok++;
    candleFetchStats.lastErrorKind = null;
    return { prices: cleaned, source: "gmx-official-api" };
  } catch (e) {
    const latency = Date.now() - startedAt;
    candleFetchStats.totalLatencyMs += latency;
    candleFetchStats.maxLatencyMs = Math.max(candleFetchStats.maxLatencyMs, latency);
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") { candleFetchStats.timeouts++; candleFetchStats.lastErrorKind = "TIMEOUT"; }
    else { candleFetchStats.httpOther++; candleFetchStats.lastErrorKind = "NETWORK"; }
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
