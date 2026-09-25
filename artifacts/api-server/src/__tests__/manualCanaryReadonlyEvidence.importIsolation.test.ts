import { afterEach, describe, expect, it, vi } from 'vitest';

const forbiddenLoads = vi.hoisted(() => [] as string[]);

function forbiddenModule(name: string): never {
  forbiddenLoads.push(name);
  throw new Error(`forbidden read-only adapter import: ${name}`);
}

vi.mock('@workspace/db', () => forbiddenModule('@workspace/db'));
vi.mock('drizzle-orm', () => forbiddenModule('drizzle-orm'));
vi.mock('../lib/manualCanaryDeps', () => forbiddenModule('manualCanaryDeps'));
vi.mock('../lib/delegatedSigner', () => forbiddenModule('delegatedSigner'));
vi.mock('../lib/executionIntents', () => forbiddenModule('executionIntents'));
vi.mock('../lib/relayLifecycle', () => forbiddenModule('relayLifecycle'));
vi.mock('../lib/ownerApprovalSession', () => forbiddenModule('ownerApprovalSession'));
vi.mock('../lib/gmxApiOrders', () => forbiddenModule('gmxApiOrders'));
vi.mock('../lib/gmxLivePreflight', () => forbiddenModule('gmxLivePreflight'));
vi.mock('../workers/liveTestExecutor', () => forbiddenModule('liveTestExecutor'));
vi.mock('../workers/protectionExecutor', () => forbiddenModule('protectionExecutor'));
vi.mock('../workers/aiWorker', () => forbiddenModule('aiWorker'));

describe('manualCanaryReadonlyEvidence import isolation', () => {
  afterEach(async () => {
    const adapter = await import('../lib/manualCanaryReadonlyEvidence');
    adapter.__setManualCanaryReadonlyReadersForTests(null);
  });

  it('loads and refreshes BTC/ETH evidence without loading forbidden capability modules', async () => {
    const adapter = await import('../lib/manualCanaryReadonlyEvidence');
    const calls: string[] = [];
    adapter.__setManualCanaryReadonlyReadersForTests({
      resolveDecimals: async (symbol) => {
        calls.push(`decimals:${symbol}`);
        return { ok: true, detail: `${symbol} verified` };
      },
      fetchCost: async ({ symbol }) => {
        calls.push(`cost:${symbol}`);
        return { ok: false, reason: `${symbol} unavailable` };
      },
    });

    const result = await adapter.refreshManualCanaryReadonlyEvidence();

    expect(calls.filter((call) => call === 'decimals:BTC')).toHaveLength(1);
    expect(calls.filter((call) => call === 'decimals:ETH')).toHaveLength(1);
    expect(calls.filter((call) => call === 'cost:BTC')).toHaveLength(2);
    expect(calls.filter((call) => call === 'cost:ETH')).toHaveLength(2);
    expect(result.decimals.BTC.ok).toBe(true);
    expect(result.costs.BTC).toMatchObject({
      ok: false,
      snapshot: null,
      roundTripCostUsd: null,
    });
    expect(result.boundedEconomics?.BTC).toMatchObject({
      status: 'UNAVAILABLE',
      search: {
        testedQuoteCount: 0,
        fetchedQuoteCount: 1,
        complete: false,
      },
    });
    expect(forbiddenLoads).toEqual([]);
  });

  it('publishes each symbol from the final $20 grid quote without an extra successful read', async () => {
    const adapter = await import('../lib/manualCanaryReadonlyEvidence');
    const calls: Array<{ symbol: string; notionalUsd: number }> = [];
    adapter.__setManualCanaryReadonlyReadersForTests({
      resolveDecimals: async (symbol) => ({ ok: true, detail: `${symbol} verified` }),
      fetchCost: async ({ symbol, notionalUsd }) => {
        calls.push({ symbol, notionalUsd });
        const observedAt = Date.now();
        return {
          ok: true as const,
          roundTripCostUsd: 0.2,
          snapshot: {
            market: symbol === 'BTC'
              ? '0x7C11F78Ce78768518D743E81Fdfa2F860C6b9A77'
              : '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
            isLong: true,
            orderType: 'MarketIncrease' as const,
            notionalUsd,
            positionFeeUsd: 0.2,
            executionFeeUsd: 0,
            estimatedPriceImpactUsd: 0,
            fundingFeeUsd: 0,
            borrowingFeeUsd: 0,
            estimatedExitFeeUsd: 0,
            estimatedExitPriceImpactUsd: 0,
            fundingRatePerHourFraction: 0,
            borrowingRatePerHourFraction: 0,
            totalEstimatedRoundTripCostUsd: 0.2,
            source: 'GMX_API' as const,
            blockNumber: null,
            apiTimestamp: new Date(observedAt).toISOString(),
            fetchedAt: new Date(observedAt).toISOString(),
            expiresAt: new Date(observedAt + 60_000).toISOString(),
          },
        };
      },
    });

    const result = await adapter.refreshManualCanaryReadonlyEvidence();

    for (const symbol of ['BTC', 'ETH'] as const) {
      const symbolCalls = calls.filter((call) => call.symbol === symbol);
      expect(symbolCalls).toHaveLength(symbol === 'BTC' ? 11 : 10);
      expect(symbolCalls.at(-1)?.notionalUsd).toBe(20);
      expect(result.costs[symbol]).toMatchObject({
        ok: true,
        roundTripCostUsd: 0.2,
        snapshot: { notionalUsd: 20 },
      });
      expect(result.boundedEconomics?.[symbol]).toMatchObject({
        search: { fetchedQuoteCount: 10, complete: true },
      });
    }
    expect(forbiddenLoads).toEqual([]);
  });
});
