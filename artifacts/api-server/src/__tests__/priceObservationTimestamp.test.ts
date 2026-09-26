import { describe, expect, it } from 'vitest';
import { createProductionFetchers } from '../intel/dataSource';

function makeFetchers(updatedAt?: number) {
  return createProductionFetchers({
    getCachedPrices: () => [{
      tokenSymbol: 'ETH',
      priceUsd: 3_000,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    }],
    getCachedChange24h: () => ({}),
    fetchGmxCandles: async () => null,
    nowFn: () => 9_999_999,
  }).fetchers;
}

describe('price observation timestamp authenticity', () => {
  it('cached price without upstream updatedAt is rejected instead of stamped with local now', async () => {
    expect(await makeFetchers().fetchPrice('ETH')).toBeNull();
  });

  it('preserves the authentic upstream updatedAt exactly', async () => {
    expect(await makeFetchers(123_456).fetchPrice('ETH')).toEqual({
      price: 3_000,
      observedAtMs: 123_456,
    });
  });
});