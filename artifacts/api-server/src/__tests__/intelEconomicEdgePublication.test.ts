import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runIntelCycle } = vi.hoisted(() => ({ runIntelCycle: vi.fn() }));
vi.mock('../intel/intelCycle', () => ({ runIntelCycle }));
vi.mock('../intel/dataSource', () => ({
  createProductionFetchers: () => ({
    fetchers: {}, stats: { candleRequests: 0, candleCacheHits: 0 }, beginCycle: () => {},
  }),
  RequestBudgetExceededError: class extends Error {},
  RateLimitBackoffError: class extends Error {},
  COST_SOURCE_PIN: 'arbitrum.gmxapi.io/v1/markets/tickers@sdk1.7.0(MarketTicker per-hour 1e30, 음수=지불)',
}));
vi.mock('../intel/shadowStore', () => ({
  persistIntelCycle: vi.fn(), getCompletedSampleCount: vi.fn(),
  enrichShadowOutcomes: vi.fn(async () => ({ scanned: 0 })),
  getCalibrationBucketStats: vi.fn(),
}));
vi.mock('../routes/gmx', () => ({
  getCachedPrices: () => null, getCachedChange24h: () => null,
  fetchGmxCandles: vi.fn(), getCandleFetchStats: () => ({}),
}));

import {
  __resetIntelServiceForTests, runIntelServiceCycle, stopIntelService, resumeIntelService,
} from '../intel/intelService';
import {
  __resetPaperRuntimeReadinessForTests, getPaperEconomicEdgeEvidenceSnapshot,
} from '../lib/paperRuntimeReadiness';
import { INTEL_MEASURED_COST_SOURCE } from '../intel/costEngine';
import { COST_SOURCE_PIN } from '../intel/dataSource';

const NOW = 1_777_000_000_000;
const gates = { nowMs: NOW } as never;
const candidate = {
  symbol: 'BTC', direction: 'LONG', decision: 'SHADOW_ONLY', dataQuality: 'GOOD',
  finalNotionalUsd: 20, expectedGrossWinUsd: 1, totalExpectedCostUsd: 0.2,
  cost: {
    holdingHoursAssumed: 1, costSnapshotFetchedAtMs: NOW - 1_000,
    costSource: INTEL_MEASURED_COST_SOURCE, sourcePin: COST_SOURCE_PIN,
    entryFeeUsd: 0.01, estimatedExitFeeUsd: 0.01, fundingCostUsd: 0.01,
    borrowingCostUsd: 0.01, priceImpactUsd: 0, slippageUsd: 0,
    gasExecutionFeeUsd: 0.1, latencyRiskReserveUsd: 0, failureRiskReserveUsd: 0,
  },
};

beforeEach(() => {
  __resetIntelServiceForTests();
  __resetPaperRuntimeReadinessForTests();
  runIntelCycle.mockReset();
});

describe('Intel accepted-cycle PAPER economic edge publication', () => {
  it('publishes only accepted current record and clears on BLOCKED and lifecycle transitions', async () => {
    runIntelCycle.mockResolvedValue({
      cycleId: 'w5923333', nowMs: NOW, decision: 'NO_TRADE', candidates: [candidate],
      universeCount: 1, shortlistCount: 1, blockedReason: null,
    });
    await runIntelServiceCycle({ cycleNum: 1, gates });
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toMatchObject({
      cycleId: 'w5923333', generation: expect.any(Number), source: expect.stringContaining(INTEL_MEASURED_COST_SOURCE),
    });

    runIntelCycle.mockResolvedValue({
      cycleId: 'w5923334', nowMs: NOW + 300_000, decision: 'BLOCKED', candidates: [candidate],
      universeCount: 1, shortlistCount: 1, blockedReason: 'persist blocked',
    });
    await runIntelServiceCycle({ cycleNum: 2, gates: { nowMs: NOW + 300_000 } as never });
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();

    runIntelCycle.mockResolvedValueOnce({
      cycleId: 'w5923335', nowMs: NOW + 600_000, decision: 'NO_TRADE',
      candidates: [{
        ...candidate,
        cost: { ...candidate.cost, costSnapshotFetchedAtMs: NOW + 599_000 },
      }],
      universeCount: 1, shortlistCount: 1, blockedReason: null,
    });
    await runIntelServiceCycle({ cycleNum: 3, gates: { nowMs: NOW + 600_000 } as never });
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).not.toBeNull();
    runIntelCycle.mockRejectedValueOnce(new Error('injected Intel failure'));
    await runIntelServiceCycle({ cycleNum: 4, gates: { nowMs: NOW + 900_000 } as never });
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();

    stopIntelService();
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
    resumeIntelService();
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
  });
});