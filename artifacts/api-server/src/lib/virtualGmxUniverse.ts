/** PAPER-only discovery. Listing is not execution authority. Never mutates LIVE registries. */
import { createRequire } from 'node:module';
import { createGmxApiTransport } from './gmxApiTransport';
import { getCachedPrices, type PriceTick } from '../routes/gmx';
import { usd30StrToNumber } from '../intel/usd30';
import type { GmxMarketInfo } from './gmxMarkets';
const requireSdk = createRequire(import.meta.url ?? __filename);
const { MARKETS } = requireSdk('@gmx-io/sdk/configs/markets');
const { TOKENS } = requireSdk('@gmx-io/sdk/configs/tokens');
const addr = /^0x[0-9a-fA-F]{40}$/;
type Token = { address: string; symbol: string; baseSymbol?: string; decimals: number };
type Market = { marketTokenAddress: string; indexTokenAddress: string; longTokenAddress: string; shortTokenAddress: string };
const tokens = TOKENS[42161] as Token[];
export const VIRTUAL_GMX_MARKETS: readonly GmxMarketInfo[] = Object.values(MARKETS[42161] as Record<string, Market>).flatMap(m => {
  const t = tokens.find(t => t.address.toLowerCase() === m.indexTokenAddress.toLowerCase());
  const symbol = (t?.baseSymbol ?? t?.symbol ?? '').toUpperCase();
  if (/^0x0{40}$/i.test(m.indexTokenAddress) || !t || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 30 || !/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(symbol)
    || ![m.marketTokenAddress, m.indexTokenAddress, m.longTokenAddress, m.shortTokenAddress].every(a => addr.test(a))) return [];
  return [{ name: `${symbol}/USD`, marketToken: m.marketTokenAddress, indexToken: m.indexTokenAddress, longToken: m.longTokenAddress, shortToken: m.shortTokenAddress }];
});
export const VIRTUAL_GMX_SYMBOLS = [...new Set(VIRTUAL_GMX_MARKETS.map(m => m.name.split('/')[0]))];
export function virtualMarketForAddress(address: string): GmxMarketInfo | undefined {
  return VIRTUAL_GMX_MARKETS.find(m => m.marketToken.toLowerCase() === address.toLowerCase());
}
export function virtualGmxQuote(symbol: string, now = Date.now(), ticks = getCachedPrices()): { priceUsd: number; ageMs: number } | null {
  const bindings = VIRTUAL_GMX_MARKETS.filter(m => m.name === `${symbol}/USD`);
  const addresses = new Set(bindings.map(m => m.indexToken.toLowerCase()));
  if (addresses.size !== 1) return null; // ambiguous asset identity cannot be priced by symbol
  const matches = (ticks ?? []).filter(t => addresses.has(t.tokenAddress.toLowerCase()) && t.tokenSymbol.toUpperCase() === symbol);
  if (matches.length !== 1) return null;
  const t = matches[0]; const ageMs = now - t.updatedAt;
  return Number.isFinite(t.priceUsd) && t.priceUsd > 0 && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 60_000
    ? { priceUsd: t.priceUsd, ageMs } : null;
}
export interface VirtualUniverse {
  source: 'GMX_ARBITRUM'; observedAt: number; complete: boolean; reason: string | null;
  totalMarkets: number; eligibleSymbols: string[]; markets: GmxMarketInfo[];
  excluded: { market: string; reason: string }[];
}
/** API /markets/info schema pinned to installed SDK. Pool value is not executable capacity;
 * final directional cost/impact/risk checks remain mandatory. */
export function scanVirtualGmxUniverse(raw: unknown, now: number, ticks: PriceTick[] | null): VirtualUniverse {
  const result: VirtualUniverse = { source: 'GMX_ARBITRUM', observedAt: now, complete: Array.isArray(raw), reason: null,
    totalMarkets: Array.isArray(raw) ? raw.length : 0, eligibleSymbols: [], markets: [], excluded: [] };
  if (!Array.isArray(raw) || !raw.length) return { ...result, complete: false, reason: 'UNIVERSE_LIST_UNAVAILABLE' };
  const eligible: { market: GmxMarketInfo; pool: number }[] = [];
  const counts = new Map<string, number>();
  for (const row of raw) {
    const a = typeof row?.marketTokenAddress === 'string' ? row.marketTokenAddress.toLowerCase() : '';
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  for (const row of raw) {
    const a = typeof row?.marketTokenAddress === 'string' ? row.marketTokenAddress : '';
    const m = virtualMarketForAddress(a);
    let reason: string | null = null;
    if (!addr.test(a) || counts.get(a.toLowerCase()) !== 1) { reason = 'INVALID_OR_DUPLICATE_MARKET'; result.complete = false; }
    else if (!m) reason = 'SDK_METADATA_UNVERIFIED';
    else if (String(row.indexTokenAddress ?? '').toLowerCase() !== m.indexToken.toLowerCase()
      || String(row.longTokenAddress ?? '').toLowerCase() !== m.longToken.toLowerCase()
      || String(row.shortTokenAddress ?? '').toLowerCase() !== m.shortToken.toLowerCase()) reason = 'MARKET_IDENTITY_MISMATCH';
    else if (row.isDisabled !== false || row.isSpotOnly !== false) reason = 'MARKET_NOT_ACTIVE_PERPETUAL';
    const pool = usd30StrToNumber(row?.poolValueMin);
    if (!reason && (pool === null || pool < 1_000_000)) reason = 'POOL_LIQUIDITY_UNAVAILABLE_OR_LOW';
    if (!reason && !virtualGmxQuote(m!.name.split('/')[0], now, ticks)) reason = 'BOUND_PRICE_UNAVAILABLE';
    if (reason) result.excluded.push({ market: addr.test(a) ? a : 'INVALID', reason });
    else eligible.push({ market: m!, pool: pool! });
  }
  // Choose one verified pool per asset deterministically; no fixed coin whitelist.
  eligible.sort((a,b) => b.pool - a.pool || a.market.marketToken.localeCompare(b.market.marketToken));
  for (const e of eligible) {
    const symbol = e.market.name.split('/')[0];
    if (result.eligibleSymbols.includes(symbol)) continue;
    result.eligibleSymbols.push(symbol); result.markets.push(e.market);
  }
  if (!result.complete) result.reason = 'UNIVERSE_LIST_INVALID';
  return result;
}
let cache: { at: number; raw: unknown; failure: string | null } | null = null;
let flight: Promise<void> | null = null;
export async function discoverVirtualGmxUniverse(now = Date.now()): Promise<VirtualUniverse> {
  if (!cache || now < cache.at || now - cache.at >= (cache.failure ? 60_000 : 240_000)) {
    if (!flight) flight = (async () => {
      const r = await createGmxApiTransport(process.env).getJson('/markets/info');
      cache = { at: Date.now(), raw: r.ok ? r.data : null, failure: r.ok ? null : `UNIVERSE_${r.kind.toUpperCase()}` };
    })().catch(() => { cache = { at: Date.now(), raw: null, failure: 'UNIVERSE_FETCH_FAILED' }; }).finally(() => { flight = null; });
    await flight;
  }
  const c = cache!;
  const result = scanVirtualGmxUniverse(c.raw, Date.now(), getCachedPrices());
  return { ...result, observedAt: c.at, reason: c.failure ?? result.reason };
}
/** Three symbols per cycle preserves the previous costly-analysis budget. Least-recently
 * analyzed rotation prevents low-ranked eligible assets from permanent starvation. */
export function selectVirtualAnalysisBatch(universe: VirtualUniverse, last: Record<string, number>, max = 3): string[] {
  if (!universe.complete) return [];
  return [...universe.eligibleSymbols].sort((a,b) => (last[a] ?? 0) - (last[b] ?? 0) || a.localeCompare(b)).slice(0,max);
}
