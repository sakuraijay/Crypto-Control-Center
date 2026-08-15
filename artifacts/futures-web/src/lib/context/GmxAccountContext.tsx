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
 *   - /api-server/api/gmx/markets       — 마켓 주소 → 심볼 매핑
 */

import {
  createContext, useCallback, useContext, useEffect,
  useRef, useState, ReactNode,
} from 'react';
import { useWallet } from './WalletContext';

// ── Subgraph ──────────────────────────────────────────────────────────────────
const SUBGRAPH_URL =
  'https://subgraph.satsuma-prod.com/3b2ced13c8d9/gmx/synthetics-arbitrum-stats/api';

const POSITIONS_QUERY = `
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

// ── GMX precision: sizeInUsd / realisedPnlUsd use 30 decimals ────────────────
const GMX_PRECISION = 1e30;

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
}

export type GmxAccountLoadStatus = 'idle' | 'loading' | 'ok' | 'error' | 'unavailable';

export interface GmxAccountState {
  positions:   GmxOnchainPosition[];
  status:      GmxAccountLoadStatus;
  error:       string | null;
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
// Populated from /api-server/api/gmx/markets (marketToken → indexToken → symbol)

let marketSymbolCache: Record<string, string> | null = null;
let marketCacheAt = 0;

async function getMarketSymbols(): Promise<Record<string, string>> {
  if (marketSymbolCache && Date.now() - marketCacheAt < 300_000) return marketSymbolCache;
  try {
    const [marketsRes, tokensRes] = await Promise.all([
      fetch('/api-server/api/gmx/markets', { signal: AbortSignal.timeout(5_000) }),
      fetch('/api-server/api/gmx/tokens',  { signal: AbortSignal.timeout(5_000) }),
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
    positions:   [],
    status:      'idle',
    error:       null,
    lastUpdated: null,
  });

  const abortRef = useRef<AbortController | null>(null);

  const fetchPositions = useCallback(async (address: string) => {
    // Cancel any in-flight request
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState(prev => ({ ...prev, status: 'loading' }));

    try {
      // Load market → symbol registry in parallel with subgraph query
      const [symbolMap, sgRes] = await Promise.all([
        getMarketSymbols(),
        fetch(SUBGRAPH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: POSITIONS_QUERY,
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
          }>;
        };
        errors?: Array<{ message: string }>;
      };

      if (json.errors?.length) throw new Error(json.errors[0].message);

      const rawPositions = json.data?.positions ?? [];

      const positions: GmxOnchainPosition[] = rawPositions.map(p => {
        const sym = symbolMap[p.market?.toLowerCase()] ?? 'Unknown';
        // USDC collateral: 6 decimals
        const collateralUsd = parseBigIntUsd(p.collateralAmount, 1e6);
        return {
          id:             p.id,
          symbol:         sym,
          direction:      p.isLong ? 'LONG' : 'SHORT',
          sizeUsd:        parseBigIntUsd(p.sizeInUsd, GMX_PRECISION),
          collateralUsd,
          realisedPnlUsd: parseBigIntUsd(p.realisedPnlUsd, GMX_PRECISION),
          market:         p.market,
          openedAt:       p.increasedAtTime ? Number(p.increasedAtTime) : null,
        };
      });

      setState({
        positions,
        status:      'ok',
        error:       null,
        lastUpdated: new Date(),
      });
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return; // cancelled, don't update state
      console.warn('[GmxAccount] fetch failed:', err);
      setState(prev => ({
        ...prev,
        status:  prev.positions.length > 0 ? 'ok' : 'unavailable',
        error:   (err as Error)?.message ?? String(err),
        lastUpdated: new Date(),
      }));
    }
  }, []);

  // ── Trigger fetch when wallet connects on Arbitrum ────────────────────────
  useEffect(() => {
    if (!(wallet.status === 'connected' && wallet.isArbitrum && wallet.address)) {
      // Wallet disconnected or wrong network — reset state
      abortRef.current?.abort();
      setState({ positions: [], status: 'idle', error: null, lastUpdated: null });
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
