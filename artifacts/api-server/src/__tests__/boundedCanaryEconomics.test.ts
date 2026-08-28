import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  BOUNDED_CANARY_NOTIONALS_USD,
  BOUNDED_CANARY_QUOTE_LIMIT,
  expireBoundedCanaryEconomicResult,
  exploreBoundedCanaryEconomics,
} from '../lib/boundedCanaryEconomics';
import { MARKET_BY_SYMBOL_SERVER } from '../lib/gmxMarkets';
import type { CostSnapshot } from '../lib/costSnapshot';

const NOW = 1_777_000_000_000;
const MARKET = MARKET_BY_SYMBOL_SERVER.get('BTC')!.marketToken;

function snapshot(notionalUsd: number, costUsd: number, overrides: Partial<CostSnapshot> = {}): CostSnapshot {
  const observedAt = NOW - 1_000;
  return {
    market: MARKET,
    isLong: true,
    orderType: 'MarketIncrease',
    notionalUsd,
    positionFeeUsd: costUsd,
    executionFeeUsd: 0,
    estimatedPriceImpactUsd: 0,
    fundingFeeUsd: 0,
    borrowingFeeUsd: 0,
    estimatedExitFeeUsd: 0,
    estimatedExitPriceImpactUsd: 0,
    fundingRatePerHourFraction: 0,
    borrowingRatePerHourFraction: 0,
    totalEstimatedRoundTripCostUsd: costUsd,
    source: 'GMX_API',
    blockNumber: null,
    apiTimestamp: new Date(observedAt).toISOString(),
    fetchedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(observedAt + 60_000).toISOString(),
    ...overrides,
  };
}

describe('bounded Controlled Canary economics', () => {
  it('quotes the fixed bounded grid exactly once without interpolation', async () => {
    const costs = new Map([
      [2, 0.10], [4, 0.11], [6, 0.15], [8, 0.21], [10, 0.31],
      [12, 0.43], [14, 0.39], [16, 0.44], [18, 0.38], [20, 0.48],
    ]);
    const fetchQuote = vi.fn(async ({ notionalUsd }: { notionalUsd: number }) => ({
      ok: true as const,
      snapshot: snapshot(notionalUsd, costs.get(notionalUsd)!),
    }));

    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote,
      nowMs: () => NOW,
    });

    expect(result.status).toBe('AVAILABLE');
    expect(result.search).toEqual({
      minNotionalUsd: 2,
      maxNotionalUsd: 20,
      stepUsd: 2,
      quoteLimit: 10,
      testedQuoteCount: 10,
      fetchedQuoteCount: 10,
      complete: true,
      nonlinearInferenceUsed: false,
    });
    expect(fetchQuote.mock.calls.map(([arg]) => arg.notionalUsd))
      .toEqual([...BOUNDED_CANARY_NOTIONALS_USD]);
    expect(result.observedAffordableRanges).toEqual([
      { minNotionalUsd: 2, maxNotionalUsd: 10, stepUsd: 2, observedPoints: [2, 4, 6, 8, 10] },
      { minNotionalUsd: 14, maxNotionalUsd: 14, stepUsd: 2, observedPoints: [14] },
      { minNotionalUsd: 18, maxNotionalUsd: 18, stepUsd: 2, observedPoints: [18] },
    ]);
    expect(result.constraints).toEqual({
      maxNotionalUsd: 20,
      maxCollateralUsd: 10,
      maxLeverage: 2,
      maxRoundTripCostUsd: 0.4,
    });
    expect(BOUNDED_CANARY_QUOTE_LIMIT).toBe(10);
  });

  it('uses the fresh exact $20 readiness quote as a seed and fetches only nine more points', async () => {
    const fetchQuote = vi.fn(async ({ notionalUsd }: { notionalUsd: number }) => ({
      ok: true as const,
      snapshot: snapshot(notionalUsd, 0.2),
    }));
    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote,
      nowMs: () => NOW,
      seedQuotes: new Map([[20, { ok: true as const, snapshot: snapshot(20, 0.2) }]]),
    });

    expect(result.search).toMatchObject({
      testedQuoteCount: 10,
      fetchedQuoteCount: 9,
      complete: true,
    });
    expect(fetchQuote).toHaveBeenCalledTimes(9);
    expect(fetchQuote.mock.calls.some(([arg]) => arg.notionalUsd === 20)).toBe(false);
  });

  it('returns UNECONOMIC only after every exact quote succeeds above cap', async () => {
    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote: async ({ notionalUsd }) => ({
        ok: true,
        snapshot: snapshot(notionalUsd, 0.400001),
      }),
      nowMs: () => NOW,
    });

    expect(result.status).toBe('UNECONOMIC');
    expect(result.search.complete).toBe(true);
    expect(result.quotes).toHaveLength(10);
    expect(result.observedAffordableRanges).toEqual([]);
  });

  it.each([
    ['missing quote', async () => ({ ok: false as const, reason: 'component unavailable' })],
    ['wrong notional binding', async ({ notionalUsd }: { notionalUsd: number }) => ({
      ok: true as const,
      snapshot: snapshot(notionalUsd + 1, 0.2),
    })],
    ['stale quote', async ({ notionalUsd }: { notionalUsd: number }) => ({
      ok: true as const,
      snapshot: snapshot(notionalUsd, 0.2, {
        apiTimestamp: new Date(NOW - 31_000).toISOString(),
        fetchedAt: new Date(NOW - 31_000).toISOString(),
        expiresAt: new Date(NOW + 10_000).toISOString(),
      }),
    })],
  ])('returns UNAVAILABLE for %s', async (_name, fetchQuote) => {
    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote,
      nowMs: () => NOW,
    });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.search.complete).toBe(false);
    expect(result.observedAffordableRanges).toEqual([]);
  });

  it('preserves structured component evidence for the failed exact quote', async () => {
    const component = {
      componentId: 'SDK_PRICE_IMPACT' as const,
      sourceId: 'GMX_SDK_PRICE_IMPACT' as const,
      state: 'MISSING' as const,
      code: 'COST_SDK_PRICE_IMPACT_MISSING',
      observedAtMs: null,
      ageMs: null,
      fresh: false,
    };
    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote: async () => ({
        ok: false,
        reason: 'price impact unavailable',
        diagnostics: {
          firstFailure: null,
          failures: [],
          sourceTraces: [],
          attemptCount: 1,
          retryCount: 0,
          failoverCount: 0,
          attemptedAtMs: NOW,
          components: [component],
        },
      }),
      nowMs: () => NOW,
    });

    expect(result).toMatchObject({
      status: 'UNAVAILABLE',
      failureId: 'BOUNDED_CANARY_BTC_QUOTE_UNAVAILABLE',
      failedNotionalUsd: 2,
      componentDiagnostics: [component],
    });
  });

  it('drops hostile bounded component diagnostics at the public freshness boundary', () => {
    const result = expireBoundedCanaryEconomicResult({
      status: 'UNAVAILABLE',
      symbol: 'BTC',
      boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION',
      constraints: {
        maxNotionalUsd: 20,
        maxCollateralUsd: 10,
        maxLeverage: 2,
        maxRoundTripCostUsd: 0.4,
      },
      search: {
        minNotionalUsd: 2,
        maxNotionalUsd: 20,
        stepUsd: 2,
        quoteLimit: 10,
        testedQuoteCount: 0,
        fetchedQuoteCount: 0,
        complete: false,
        nonlinearInferenceUsed: false,
      },
      quotes: [],
      observedAffordableRanges: [],
      evaluatedAtMs: NOW,
      expiresAtMs: null,
      failureId: 'BOUNDED_CANARY_BTC_QUOTE_UNAVAILABLE',
      detail: 'safe',
      failedNotionalUsd: 999,
      componentDiagnostics: [{
        componentId: 'TICKERS',
        sourceId: 'GMX_API_MARKETS_TICKERS',
        state: 'FAILED',
        code: 'https://evil.example/?signature=SHOULD_NOT_LEAK',
        observedAtMs: NOW,
        ageMs: 0,
        fresh: true,
      }, {
        componentId: 'MARKETS_INFO',
        sourceId: 'GMX_API_MARKETS_INFO',
        state: 'SUCCESS',
        code: 'COST_MARKETS_INFO_SUCCESS',
        observedAtMs: null,
        ageMs: null,
        fresh: true,
      }, {
        componentId: 'SDK_PRICE_IMPACT',
        sourceId: 'GMX_SDK_PRICE_IMPACT',
        state: 'SUCCESS',
        code: 'COST_SDK_PRICE_IMPACT_5XX',
        observedAtMs: NOW,
        ageMs: 0,
        fresh: true,
      }, {
        componentId: 'FUNDING',
        sourceId: 'GMX_API_MARKETS_TICKERS',
        state: 'SUCCESS',
        code: 'COST_FUNDING_SUCCESS',
        observedAtMs: NOW + 1,
        ageMs: -1,
        fresh: true,
      }],
    }, NOW);

    expect(result.failedNotionalUsd).toBeNull();
    expect(result.componentDiagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('evil.example');
    expect(JSON.stringify(result)).not.toContain('SHOULD_NOT_LEAK');
  });

  it('expires the whole quote set without reusing stale affordable points', async () => {
    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote: async ({ notionalUsd }) => ({
        ok: true,
        snapshot: snapshot(notionalUsd, 0.2),
      }),
      nowMs: () => NOW,
    });
    const expired = expireBoundedCanaryEconomicResult(result, NOW + 31_000);
    expect(expired.status).toBe('UNAVAILABLE');
    expect(expired.failureId).toBe('BOUNDED_CANARY_BTC_STALE');
    expect(expired.observedAffordableRanges).toEqual([]);
  });

  it('returns UNAVAILABLE when the earliest quote expires before the scan completes', async () => {
    let clockCall = 0;
    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote: async ({ notionalUsd }) => ({
        ok: true,
        snapshot: snapshot(notionalUsd, 0.2),
      }),
      // Ten point validations remain individually fresh through 27 seconds,
      // but the final whole-set check occurs at 30 seconds. The fixture was
      // observed one second before NOW, so its 30-second window has expired.
      nowMs: () => NOW + (clockCall++ * 3_000),
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.failureId)
      .toBe('BOUNDED_CANARY_BTC_SET_STALE_AT_COMPLETION');
    expect(result.search).toMatchObject({
      testedQuoteCount: 10,
      complete: false,
    });
    expect(result.observedAffordableRanges).toEqual([]);
  });

  it('rejects a seed set that becomes stale while the remaining grid is fetched', async () => {
    let clockCall = 0;
    const result = await exploreBoundedCanaryEconomics({
      symbol: 'BTC',
      market: MARKET,
      fetchQuote: async ({ notionalUsd }) => ({
        ok: true,
        snapshot: snapshot(notionalUsd, 0.2),
      }),
      nowMs: () => NOW + (clockCall++ * 3_000),
      seedQuotes: new Map([
        [20, { ok: true as const, snapshot: snapshot(20, 0.2) }],
      ]),
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.failureId)
      .toBe('BOUNDED_CANARY_BTC_SET_STALE_AT_COMPLETION');
    expect(result.search.fetchedQuoteCount).toBe(9);
  });

  it('is structurally read-only and does not import execution capabilities', () => {
    const source = readFileSync(
      new URL('../lib/boundedCanaryEconomics.ts', import.meta.url),
      'utf8',
    );
    for (const forbidden of [
      'db',
      'delegatedSigner',
      'relaySubmission',
      'gmxApiExecution',
      'ownerApprovalSession',
      'executionIntents',
    ]) {
      expect(source).not.toContain(`from './${forbidden}'`);
    }
  });
});