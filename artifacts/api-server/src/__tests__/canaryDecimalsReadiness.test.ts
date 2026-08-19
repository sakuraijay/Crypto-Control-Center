import { describe, expect, it } from 'vitest';
import { deriveCanaryDecimalsReadiness } from '../routes/gmxapi';
import { MARKET_BY_SYMBOL_SERVER } from '../lib/gmxMarkets';

const fresh = (tokenAddress: string, source = 'sdk+onchain') => ({
  tokenAddress,
  source,
  stale: false,
});

describe('Manual Canary decimals readiness', () => {
  it('requires exact fresh SDK+onchain evidence for both BTC and ETH', () => {
    const btc = MARKET_BY_SYMBOL_SERVER.get('BTC')!.indexToken;
    const eth = MARKET_BY_SYMBOL_SERVER.get('ETH')!.indexToken;
    expect(deriveCanaryDecimalsReadiness([fresh(btc), fresh(eth)])).toEqual({
      BTC: true,
      ETH: true,
    });
  });

  it('does not accept two unrelated fresh entries or stale/mis-sourced evidence', () => {
    const btc = MARKET_BY_SYMBOL_SERVER.get('BTC')!.indexToken;
    const eth = MARKET_BY_SYMBOL_SERVER.get('ETH')!.indexToken;
    expect(deriveCanaryDecimalsReadiness([
      fresh(`0x${'11'.repeat(20)}`),
      fresh(`0x${'22'.repeat(20)}`),
    ])).toEqual({ BTC: false, ETH: false });
    expect(deriveCanaryDecimalsReadiness([
      { ...fresh(btc), stale: true },
      fresh(eth, 'cache-only'),
    ])).toEqual({ BTC: false, ETH: false });
  });
});