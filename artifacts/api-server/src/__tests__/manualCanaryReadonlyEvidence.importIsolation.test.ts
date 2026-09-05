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

    expect(calls).toEqual([
      'decimals:BTC',
      'cost:BTC',
      'cost:BTC',
      'decimals:ETH',
      'cost:ETH',
      'cost:ETH',
    ]);
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
});