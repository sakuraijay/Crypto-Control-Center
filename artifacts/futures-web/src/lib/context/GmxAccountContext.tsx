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

// ── Subgraph ──────────────────────────────────────────────────────────────────
const SUBGRAPH_URL =
  'https://subgraph.satsuma-prod.com/3b2ced13c8d9/gmx/synthetics-arbitrum-stats/api';

/**
 * Full query — includes liquidationPrice.
 * GMX V2 Synthetics subgraph (Satsuma) may or may not expose this field depending on
 * deployment version. We try this first and fall back to POSITIONS_QUERY_BASIC on a
 * schema error to avoid breaking position display entirely.
 */
const POSITIONS_QUERY_FULL = `
  query AccountPositions($account: String!) {
    positions(
      first: 20
      where: { account: $account, sizeInUsd_gt: "0" }
    ) {
      id
      account
      market
      collateralToken
      sizeInUsd
      collateralAmount
      realisedPnlUsd
      isLong
      increasedAtTime
      liquidationPrice
    }
  }
`;

/** Fallback query — omits liquidationPrice when the subgraph schema does not support it. */
const POSITIONS_QUERY_BASIC = `
  query AccountPositions($account: String!) {
    positions(
      first: 20
      where: { account: $account, sizeInUsd_gt: "0" }
    ) {
      id
      account
      market
      collateralToken
      sizeInUsd
      collateralAmount
      realisedPnlUsd
      isLong
      increasedAtTime
    }
  }
`;

/**
 * Module-level flag: start optimistic (try liquidationPrice).
 * Set to false once we confirm the subgraph schema does not expose that field —
 * avoids sending a known-failing query on every subsequent poll.
 */
let sgSupportsLiqPrice = true;

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

    const { markets } = await marketsRes.json() as { markets: Array<{ marketToken: string; indexToken: string }> };
    const { tokens }  = await tokensRes.json()  as { tokens:  Array<{ address: string; symbol: string }> };

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
  });

  const abortRef = useRef<AbortController | null>(null);

  const fetchPositions = useCallback(async (address: string) => {
    // Cancel any in-flight request
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState(prev => ({ ...prev, status: 'loading' }));

    try {
      // ── Choose query based on cached schema-support flag ─────────────────
      const activeQuery = sgSupportsLiqPrice
        ? POSITIONS_QUERY_FULL
        : POSITIONS_QUERY_BASIC;

      // Load market → symbol registry in parallel with subgraph query
      const [symbolMap, sgRes] = await Promise.all([
        getMarketSymbols(),
        fetch(SUBGRAPH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: activeQuery,
            variables: { account: address.toLowerCase() },
          }),
          signal: AbortSignal.timeout(12_000),
        }),
      ]);

      if (!sgRes.ok) throw new Error(`Subgraph HTTP ${sgRes.status}`);

      const json = await sgRes.json() as {
        data?: {
          positions?: Array<{
            id: string; account: string; market: string;
            collateralToken: string; sizeInUsd: string;
            collateralAmount: string; realisedPnlUsd: string;
            isLong: boolean; increasedAtTime?: string | null;
            liquidationPrice?: string | null;
          }>;
        };
        errors?: Array<{ message: string }>;
      };

      // ── Detect "liquidationPrice not in schema" error and retry ──────────
      // When the subgraph schema doesn't expose liquidationPrice, GraphQL returns
      // an errors array with "Cannot query field" and no data. We flip the flag
      // and immediately retry with the basic query so positions still display.
      if (
        json.errors?.length &&
        sgSupportsLiqPrice &&
        json.errors.some(e =>
          e.message.toLowerCase().includes('liquidationprice') ||
          e.message.toLowerCase().includes('cannot query field')
        )
      ) {
        console.info('[GmxAccount] subgraph does not support liquidationPrice — falling back to basic query');
        sgSupportsLiqPrice = false;

        const fallbackRes = await fetch(SUBGRAPH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: POSITIONS_QUERY_BASIC,
            variables: { account: address.toLowerCase() },
          }),
          signal: AbortSignal.timeout(12_000),
        });
        if (!fallbackRes.ok) throw new Error(`Subgraph HTTP ${fallbackRes.status}`);
        const fallbackJson = await fallbackRes.json() as typeof json;
        if (fallbackJson.errors?.length) throw new Error(fallbackJson.errors[0].message);
        // Overwrite json so the rest of the processing is identical
        Object.assign(json, fallbackJson);
      } else if (json.errors?.length) {
        throw new Error(json.errors[0].message);
      }

      const rawPositions = json.data?.positions ?? [];

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
        };
      });

      const now = new Date();
      setState({
        positions,
        status:             'ok',
        error:              null,
        lastSuccessUpdated: now,  // only updated on success
        lastUpdated:        now,
      });
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return; // cancelled, don't update state
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
      setState({ positions: [], status: 'idle', error: null, lastSuccessUpdated: null, lastUpdated: null });
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
