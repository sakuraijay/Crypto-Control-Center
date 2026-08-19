import { MARKET_BY_SYMBOL_SERVER } from './gmxMarkets';

export function deriveCanaryDecimalsReadiness(entries: Array<{
  tokenAddress: string;
  stale: boolean;
  source: string;
}>): Record<'BTC' | 'ETH', boolean> {
  const freshValidated = new Set(
    entries
      .filter((entry) => !entry.stale && entry.source === 'sdk+onchain')
      .map((entry) => entry.tokenAddress.toLowerCase()),
  );
  return {
    BTC: freshValidated.has(MARKET_BY_SYMBOL_SERVER.get('BTC')!.indexToken.toLowerCase()),
    ETH: freshValidated.has(MARKET_BY_SYMBOL_SERVER.get('ETH')!.indexToken.toLowerCase()),
  };
}