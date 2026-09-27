import { describe, it, expect, vi } from 'vitest';
vi.mock('../routes/gmx', () => ({ getCachedPrices: () => null }));
import { VIRTUAL_GMX_MARKETS, scanVirtualGmxUniverse, selectVirtualAnalysisBatch, virtualGmxQuote } from '../lib/virtualGmxUniverse';
const now = Date.now();
const market = VIRTUAL_GMX_MARKETS.find(m => m.name === 'XRP/USD')!;
const record = () => ({ marketTokenAddress: market.marketToken, indexTokenAddress: market.indexToken,
  longTokenAddress: market.longToken, shortTokenAddress: market.shortToken, isDisabled: false, isSpotOnly: false,
  poolValueMin: (2_000_000n * 10n ** 30n).toString() });
const tick = () => ({ tokenAddress: market.indexToken, tokenSymbol: 'XRP', priceUsd: 1.4, minPriceUsd: 1.4,
  maxPriceUsd: 1.401, updatedAt: now, change24hPct: 0 });
describe('GMX-wide PAPER discovery with address-bound eligibility', () => {
  it('admits a verified nonlegacy asset without a BTC/ETH/SOL or seven-coin allowlist', () => {
    const u = scanVirtualGmxUniverse([record()], now, [tick()]);
    expect(u.complete).toBe(true); expect(u.eligibleSymbols).toEqual(['XRP']);
    expect(u.markets[0]).toEqual(market);
    expect(virtualGmxQuote('XRP', now, [tick()])).toEqual({ priceUsd: 1.4, ageMs: 0 });
  });
  it('does not confuse spot-only zero-index pools with the ETH index token', () => {
    expect(VIRTUAL_GMX_MARKETS.some(m => /^0x0{40}$/i.test(m.indexToken))).toBe(false);
    const eth = VIRTUAL_GMX_MARKETS.find(m=>m.name==='ETH/USD')!;
    expect(virtualGmxQuote('ETH', now, [{...tick(),tokenSymbol:'ETH',tokenAddress:eth.indexToken}])).not.toBeNull();
  });
  it.each(['disabled','spot','missingFlag','identity','liquidity','missingLiquidity','stale','future','wrongToken','unknown'])('excludes %s with an explicit reason', flaw => {
    const r = record(); const t = tick();
    if (flaw === 'disabled') r.isDisabled = true;
    if (flaw === 'spot') r.isSpotOnly = true;
    if (flaw === 'missingFlag') delete (r as any).isDisabled;
    if (flaw === 'identity') r.indexTokenAddress = '0x'+'1'.repeat(40);
    if (flaw === 'liquidity') r.poolValueMin = '1';
    if (flaw === 'missingLiquidity') delete (r as any).poolValueMin;
    if (flaw === 'stale') t.updatedAt -= 60_001;
    if (flaw === 'future') t.updatedAt++;
    if (flaw === 'wrongToken') t.tokenAddress = '0x'+'1'.repeat(40);
    if (flaw === 'unknown') r.marketTokenAddress = '0x'+'1'.repeat(40);
    const u = scanVirtualGmxUniverse([r], now, [t]);
    expect(u.eligibleSymbols).toEqual([]); expect(u.excluded).toHaveLength(1);
  });
  it('marks corrupt, duplicate and unavailable lists incomplete; never falls back to old three coins', () => {
    for (const raw of [null, {}, [], [null], [record(),record()]]) {
      const u = scanVirtualGmxUniverse(raw, now, [tick()]);
      expect(u.complete).toBe(false); expect(selectVirtualAnalysisBatch(u, {})).toEqual([]);
    }
  });
  it('rotates all eligible assets within the same three-asset analysis budget', () => {
    const u = { ...scanVirtualGmxUniverse([record()], now, [tick()]), eligibleSymbols: ['XRP','DOGE','LINK','ARB','SOL','BTC','ETH'] };
    const history: Record<string, number> = {}; const seen = new Set<string>();
    for (let i=1;i<=3;i++) {
      const batch = selectVirtualAnalysisBatch(u, history);
      expect(batch).toHaveLength(3);
      for (const s of batch) { history[s] = i; seen.add(s); }
    }
    expect([...seen].sort()).toEqual([...u.eligibleSymbols].sort());
  });
});
