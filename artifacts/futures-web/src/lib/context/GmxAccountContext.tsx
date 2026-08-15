/**
 * GmxAccountContext — GMX V2 온체인 계정 데이터 (Read-only)
 *
 * 연결된 지갑 주소를 기준으로 GMX Synthetics 서브그래프에서
 * 실제 온체인 포지션을 조회합니다.
 *
 * 보안 원칙:
 *   ✅ eth_call / 서브그래프 read-only 조회만 허용
 *   ❌ 서명, 트랜잭션 전송, 개인키 접근 금지
 *   ❌ 실제 주문 실행 없음
 *
 * 데이터 소스:
 *   - GMX Synthetics Subgraph (Satsuma) — 포지션 목록
 *   - /api/gmx/markets       — 마켓 주소 → 심볼 매핑
 */

import {
  createContext, useCallback, useContext, useEffect,
  useRef, useState, ReactNode,
} from 'react';
import { useWallet } from './WalletContext';

// ── Positions are fetched via the API server proxy (/api/gmx/positions) ───────
//
// The browser no longer calls the Satsuma subgraph directly.  Reasons:
//   1. Satsuma's CORS policy blocks browser requests in many environments.
//   2. Proxying through the API server lets the server handle schema fallbacks
//      (liquidationPrice) and retry logic without involving the browser.
//
// The API server returns { positions: SubgraphPosition[], source: 'subgraph'|'unavailable' }.
// When source = 'unavailable' the positions array is empty and subgraphOk=false
// is reported to the wallet diagnostic.

/** Raw position shape as returned by /api/gmx/positions (mirrors Satsuma GraphQL). */
type ProxyPosition = {
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

// ── GMX precision: sizeInUsd / realisedPnlUsd use 30 decimals ────────────────
const GMX_PRECISION = 1e30;

/**
 * Native USDC on Arbitrum One (6 decimals).
 * Leverage is only computed when collateralToken matches this address — other
 * GMX collateral tokens (WETH 18 dec, WBTC 8 dec) require token-price conversion
 * that is not performed here, so we show N/A for leverage to avoid misleading values.
 */
const ARBITRUM_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'; // lowercase

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GmxOnchainPosition {
  id:            string;
  /** Best-effort symbol (e.g. "ETH") — "Unknown" if market not in registry */
  symbol:        string;
  direction:     'LONG' | 'SHORT';
  /** Notional position size in USD */
  sizeUsd:       number;
  /** Collateral amount in USD (USDC = 6 decimals) */
  collateralUsd: number;
  /** Cumulative realized PnL in USD for this position */
  realisedPnlUsd: number;
  /** Raw market token address */
  market:        string;
  /** Unix timestamp of last increase (seconds) */
  openedAt:      number | null;
  /**
   * Effective leverage = sizeUsd / collateralUsd.
   * null when either value is zero/negative (trust-safe only).
   */
  leverage:      number | null;
  /**
   * Liquidation price in USD from the GMX subgraph.
   * null when the subgraph does not expose the field or returns 0/null.
   * Never estimated — only real subgraph values are stored here.
   */
  liquidationPrice: number | null;
  /**
   * Unrealized PnL in USD.
   * Computed from: sizeInTokens (subgraph) + current mark price (/api/gmx/prices).
   * null when either data source is unavailable — never estimated.
   */
  unrealizedPnlUsd: number | null;
  /**
   * Current mark price per token in USD (from /api/gmx/prices cache).
   * null when price is unavailable.
   */
  markPriceUsd: number | null;
  /**
   * true when liquidationPrice is non-null AND markPrice is non-null AND
   * the distance is ≤5% of markPrice — triggers a dashboard warning banner.
   */
  nearLiquidation: boolean;
}

export type GmxAccountLoadStatus = 'idle' | 'loading' | 'ok' | 'error' | 'unavailable';

export interface GmxAccountState {
  positions:   GmxOnchainPosition[];
  status:      GmxAccountLoadStatus;
  error:       string | null;
  /** Timestamp of the most recent SUCCESSFUL subgraph response — never overwritten on failure */
  lastSuccessUpdated: Date | null;
  /** Timestamp of the most recent fetch attempt (success or failure) */
  lastUpdated: Date | null;
  /** Duration of the last successful subgraph round-trip in milliseconds */
  lastFetchMs: number | null;
}

interface GmxAccountContextType extends GmxAccountState {
  refresh: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse BigInt strings safely — returns 0 on failure */
function parseBigIntUsd(raw: string | null | undefined, precision: number): number {
  if (!raw) return 0;
  try {
    return Number(BigInt(raw)) / precision;
  } catch {
    return 0;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

const GmxAccountContext = createContext<GmxAccountContextType | undefined>(undefined);

// ── Market registry ───────────────────────────────────────────────────────────
// Populated from /api/gmx/markets (marketToken → indexToken → symbol)

let marketSymbolCache: Record<string, string> | null = null;
let marketCacheAt = 0;

async function getMarketSymbols(): Promise<Record<string, string>> {
  if (marketSymbolCache && Date.now() - marketCacheAt < 300_000) return marketSymbolCache;
  try {
    const [marketsRes, tokensRes] = await Promise.all([
      fetch('/api/gmx/markets', { signal: AbortSignal.timeout(5_000) }),
      fetch('/api/gmx/tokens',  { signal: AbortSignal.timeout(5_000) }),
    ]);
    if (!marketsRes.ok || !tokensRes.ok) throw new Error('markets/tokens fetch failed');

    // /api/gmx/markets and /api/gmx/tokens return raw arrays (not wrapped objects)
    const markets = await marketsRes.json() as Array<{ marketToken: string; indexToken: string }>;
    const tokens  = await tokensRes.json()  as Array<{ address: string; symbol: string }>;

    // Build: token address (lowercase) → symbol
    const tokenMap: Record<string, string> = {};
    for (const t of tokens) tokenMap[t.address.toLowerCase()] = t.symbol;

    // Build: marketToken (lowercase) → symbol (via indexToken)
    const result: Record<string, string> = {};
    for (const m of markets) {
      const sym = tokenMap[m.indexToken?.toLowerCase()] ?? null;
      if (sym) result[m.marketToken.toLowerCase()] = sym;
    }

    marketSymbolCache = result;
    marketCacheAt = Date.now();
    return result;
  } catch {
    return marketSymbolCache ?? {};
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;

export function GmxAccountProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();

  const [state, setState] = useState<GmxAccountState>({
    positions:          [],
    status:             'idle',
    error:              null,
    lastSuccessUpdated: null,
    lastUpdated:        null,
    lastFetchMs:        null,
  });

  const abortRef = useRef<AbortController | null>(null);

  const fetchPositions = useCallback(async (address: string) => {
    // Cancel any in-flight request
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState(prev => ({ ...prev, status: 'loading' }));

    const fetchStart = Date.now();

    try {
      // ── Fetch via API server proxy (no direct Satsuma call from browser) ──
      // The server handles CORS, schema fallback, and caching.
      const [symbolMap, pricesRes, posRes] = await Promise.all([
        getMarketSymbols(),
        fetch('/api/gmx/prices', { signal: AbortSignal.timeout(5_000) }).catch(() => null),
        fetch(
          `/api/gmx/positions?account=${encodeURIComponent(address.toLowerCase())}`,
          { signal: ctrl.signal },
        ),
      ]);

      if (!posRes.ok) throw new Error(`Positions proxy HTTP ${posRes.status}`);

      const { positions: rawPositions, source } = await posRes.json() as {
        positions: ProxyPosition[];
        source:    'subgraph' | 'rpc' | 'unavailable';
      };

      // When both Satsuma and RPC are unavailable, keep the existing positions
      // on-screen rather than replacing them with an empty array.  The user
      // sees their last known positions until connectivity is restored.
      if (source === 'unavailable') {
        setState(prev => ({
          ...prev,
          status:      prev.positions.length > 0 ? 'ok' : 'unavailable',
          error:       'Position data temporarily unavailable — showing last known positions',
          // lastSuccessUpdated NOT updated — preserves the last good timestamp
          lastUpdated: new Date(),
          lastFetchMs: Date.now() - fetchStart,
        }));
        void fetch('/api/wallet/diagnostic', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletConnected:    true,
            addressFingerprint: `${address.slice(0, 6)}\u2026${address.slice(-4)}`,
            subgraphOk:         false,
            positionCount:      0,
            lastRefreshAt:      new Date().toISOString(),
          }),
        }).catch(() => {});
        return;
      }

      // Parse mark prices (non-fatal — unrealizedPnl stays null on error)
      let markPriceBySymbol: Record<string, number> = {};
      try {
        if (pricesRes?.ok) {
          const pricesData = await pricesRes.json() as Array<{ tokenSymbol: string; priceUsd: number }>;
          for (const p of pricesData) {
            if (p.priceUsd > 0) markPriceBySymbol[p.tokenSymbol] = p.priceUsd;
          }
        }
      } catch { /* non-fatal */ }

      const positions: GmxOnchainPosition[] = rawPositions.map(p => {
        const sym = symbolMap[p.market?.toLowerCase()] ?? 'Unknown';
        // USDC collateral: 6 decimals
        const collateralUsd = parseBigIntUsd(p.collateralAmount, 1e6);
        const sizeUsd       = parseBigIntUsd(p.sizeInUsd, GMX_PRECISION);

        // Leverage: only computed when collateral token is verified USDC (6 decimals, USD-pegged).
        // WETH (18 dec) and WBTC (8 dec) positions require token→USD price conversion
        // that is not available here — show N/A rather than a wildly wrong value.
        const isUsdcCollateral =
          p.collateralToken?.toLowerCase() === ARBITRUM_USDC;
        const leverage =
          isUsdcCollateral && sizeUsd > 0 && collateralUsd > 0
            ? sizeUsd / collateralUsd
            : null;

        // Liquidation price: from subgraph only — never estimated
        // GMX V2 stores liquidationPrice with 30-decimal precision (same as sizeInUsd)
        const rawLiqPrice = p.liquidationPrice;
        const liquidationPrice =
          rawLiqPrice && rawLiqPrice !== '0'
            ? parseBigIntUsd(rawLiqPrice, GMX_PRECISION)
            : null;

        // ── Unrealized PnL — sizeInTokens (1e18) + mark price ─────────────
        // GMX V2 stores sizeInTokens with 18 decimals. sizeInUsd (1e30) / sizeInTokens (1e18)
        // gives average entry price in USD per token (scaled by 1e12).
        // Requires: sizeInTokens > 0 AND current mark price in cache.
        // Never estimated — null when either source unavailable.
        const markPriceUsd = markPriceBySymbol[sym] ?? null;
        let unrealizedPnlUsd: number | null = null;
        if (p.sizeInTokens && p.sizeInTokens !== '0' && markPriceUsd != null) {
          try {
            const sizeInTokensRaw = Number(BigInt(p.sizeInTokens)) / 1e18;
            if (sizeInTokensRaw > 0 && sizeUsd > 0) {
              const avgEntryPrice = sizeUsd / sizeInTokensRaw;  // USD per token at entry
              const pnlPerToken   = p.isLong
                ? (markPriceUsd - avgEntryPrice)
                : (avgEntryPrice - markPriceUsd);
              unrealizedPnlUsd = pnlPerToken * sizeInTokensRaw;
            }
          } catch { /* BigInt parse failed — leave null */ }
        }

        // Liquidation warning: mark price within 5% of liquidation price
        const nearLiquidation =
          liquidationPrice != null &&
          markPriceUsd != null &&
          markPriceUsd > 0 &&
          Math.abs(markPriceUsd - liquidationPrice) / markPriceUsd <= 0.05;

        return {
          id:               p.id,
          symbol:           sym,
          direction:        p.isLong ? 'LONG' : 'SHORT',
          sizeUsd,
          collateralUsd,
          realisedPnlUsd:   parseBigIntUsd(p.realisedPnlUsd, GMX_PRECISION),
          market:           p.market,
          openedAt:         p.increasedAtTime ? Number(p.increasedAtTime) : null,
          leverage,
          liquidationPrice,
          unrealizedPnlUsd,
          markPriceUsd,
          nearLiquidation,
        };
      });

      const now = new Date();
      setState({
        positions,
        status:             'ok',
        error:              null,
        lastSuccessUpdated: now,  // only updated on success
        lastUpdated:        now,
        lastFetchMs:        Date.now() - fetchStart,
      });

      // ── Diagnostic snapshot — boolean flags only, no financial amounts ──────
      // subgraphOk = true when the server proxy reached the subgraph (source='subgraph').
      // Even 'unavailable' (all upstream sources failed) is a valid outcome —
      // it clears the "fetch failed" error log and gives a meaningful diagnostic signal.
      void fetch('/api/wallet/diagnostic', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletConnected:    true,
          addressFingerprint: `${address.slice(0, 6)}\u2026${address.slice(-4)}`,
          subgraphOk:         source !== 'unavailable',
          positionCount:      positions.length,
          lastRefreshAt:      now.toISOString(),
        }),
      }).catch(() => {});
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return; // cancelled, don't update state

      // Diagnostic: subgraph failure (fire-and-forget, no financial data)
      void fetch('/api/wallet/diagnostic', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subgraphOk:    false,
          positionCount: 0,
          lastRefreshAt: new Date().toISOString(),
        }),
      }).catch(() => {});

      console.warn('[GmxAccount] fetch failed:', err);
      setState(prev => ({
        ...prev,
        status:      prev.positions.length > 0 ? 'ok' : 'unavailable',
        error:       (err as Error)?.message ?? String(err),
        // lastSuccessUpdated intentionally NOT updated — preserves last good timestamp
        lastUpdated: new Date(),
      }));
    }
  }, []);

  // ── Trigger fetch when wallet connects on Arbitrum ────────────────────────
  useEffect(() => {
    if (!(wallet.status === 'connected' && wallet.isArbitrum && wallet.address)) {
      // Wallet disconnected or wrong network — reset state
      abortRef.current?.abort();
      setState({ positions: [], status: 'idle', error: null, lastSuccessUpdated: null, lastUpdated: null, lastFetchMs: null });
      return;
    }

    fetchPositions(wallet.address);
    const t = setInterval(() => fetchPositions(wallet.address!), POLL_INTERVAL_MS);
    return () => {
      clearInterval(t);
      abortRef.current?.abort();
    };
  }, [wallet.status, wallet.isArbitrum, wallet.address, fetchPositions]);

  const refresh = useCallback(() => {
    if (wallet.address && wallet.isArbitrum) fetchPositions(wallet.address);
  }, [wallet.address, wallet.isArbitrum, fetchPositions]);

  return (
    <GmxAccountContext.Provider value={{ ...state, refresh }}>
      {children}
    </GmxAccountContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useGmxAccount(): GmxAccountContextType {
  const ctx = useContext(GmxAccountContext);
  if (!ctx) throw new Error('useGmxAccount must be used inside GmxAccountProvider');
  return ctx;
}
