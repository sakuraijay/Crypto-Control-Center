import { describe, expect, it } from 'vitest';
import type { CostSnapshot } from '../lib/costSnapshot';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import type { StrategyShadowRunnerResult } from '../intel/strategyShadowRunnerV2';
import {
  buildStrategyShadowWorkerBatch,
  deriveConservativeShadowCostBps,
  type StrategyShadowWorkerBatchInput,
} from '../intel/strategyShadowWorkerBatchV2';

const NOW = Date.parse('2026-08-23T00:00:00.000Z');
const MARKET = '0x1111111111111111111111111111111111111111';

function cost(isLong: boolean, total = 0.48, overrides: Partial<CostSnapshot> = {}): CostSnapshot {
  return {
    market: MARKET,
    isLong,
    orderType: 'MarketIncrease',
    notionalUsd: 20,
    positionFeeUsd: 0.1,
    executionFeeUsd: 0.1,
    estimatedPriceImpactUsd: 0.05,
    fundingFeeUsd: 0.03,
    borrowingFeeUsd: 0.02,
    estimatedExitFeeUsd: 0.1,
    estimatedExitPriceImpactUsd: total - 0.4,
    fundingRatePerHourFraction: 0.0001,
    borrowingRatePerHourFraction: 0.0001,
    totalEstimatedRoundTripCostUsd: total,
    source: 'PAPER_GMX_ESTIMATE',
    blockNumber: null,
    apiTimestamp: new Date(NOW - 1_000).toISOString(),
    fetchedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 59_000).toISOString(),
    ...overrides,
  };
}

function costPair() {
  return {
    market: MARKET,
    notionalUsd: 20,
    holdingHorizonHours: 12,
    long: cost(true, 0.4),
    short: cost(false, 0.5),
  };
}

function input(symbols = ['BTC', 'ETH']): StrategyShadowWorkerBatchInput {
  return {
    cycleNumber: 1,
    evaluatedAt: NOW,
    expectedSymbols: symbols,
    framesBySymbol: {},
    costsBySymbol: {},
    previousRegimes: {},
    lifecycleRecords: [],
    historyEvents: [],
    existingAi: {
      decisionId: 'decision-1',
      action: 'NO_TRADE',
      confidence: 0,
      primarySymbol: null,
      createdAt: new Date(NOW - 100).toISOString(),
    },
  };
}

function record(symbol: string): StrategyShadowRecord {
  return {
    schemaVersion: 'strategy-shadow-adapter/v1',
    shadowRecordId: `${symbol}:record`,
    mode: 'SHADOW_ONLY',
    symbol,
    evaluatedAt: NOW,
    sourceCandleCloseTime: NOW - 900_000,
    regime: 'RANGE',
    action: 'NO_TRADE',
    comparison: 'AGREE_NO_TRADE',
    strategyId: null,
    signalId: null,
    direction: 'NONE',
    confidence: null,
    selectedScore: null,
    entryPrice: null,
    structuralStop: null,
    expectedNetEdgeBps: null,
    expectedNetRR: null,
    lifecycleEligible: null,
    existingAi: null,
    reasons: ['stub'],
    warnings: [],
    executionAuthorized: false,
    paperPositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}

function evaluated(symbol: string): StrategyShadowRunnerResult {
  return {
    schemaVersion: 'strategy-shadow-runner/v1',
    status: 'EVALUATED',
    symbol,
    sourceCandleCloseTime: NOW - 900_000,
    dataQuality: 'GOOD',
    regime: null,
    candidates: [],
    arbiter: null,
    eligibility: null,
    record: record(symbol),
    reasons: [],
    warnings: [],
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}

function missing(symbol: string): StrategyShadowRunnerResult {
  return { ...evaluated(symbol), status: 'NOT_EVALUATED', record: null, reasons: ['frame missing'] };
}

describe('Strategy SHADOW worker batch bridge', () => {
  it('uses the more expensive of valid LONG/SHORT cost evidence', () => {
    const result = deriveConservativeShadowCostBps({
      market: MARKET, notionalUsd: 20, holdingHorizonHours: 12,
      long: cost(true, 0.4), short: cost(false, 0.5),
    }, NOW);
    expect(result.reasons).toEqual([]);
    expect(result.expectedCostsBps).toBeCloseTo(255, 8);
    expect(result.costEvidence).toMatchObject({
      conservativeBasisDirection: 'SHORT',
      holdingHorizonHours: 12,
      bidirectionalValidated: true,
      holdingCostsDerivedFromRates: true,
      holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT',
      directionalQuotes: {
        LONG: { direction: 'LONG', funding: { usd: 0.03, bps: 15 },
          borrowing: { usd: 0.03, bps: 15 } },
        SHORT: { direction: 'SHORT', totalRoundTripCost: { usd: 0.51, bps: 255 } },
      },
    });
    const conservative = result.costEvidence!.directionalQuotes.SHORT;
    expect(conservative.positionFee.usd + conservative.exitFee.usd + conservative.funding.usd
      + conservative.borrowing.usd + conservative.priceImpact.usd
      + conservative.network.usd).toBeCloseTo(0.51, 8);
  });

  it('binds funding and borrowing to the declared holding horizon', () => {
    const fourHours = deriveConservativeShadowCostBps({
      market: MARKET, notionalUsd: 20, holdingHorizonHours: 4,
      long: cost(true, 0.4), short: cost(false, 0.5),
    }, NOW);
    const twelveHours = deriveConservativeShadowCostBps({
      market: MARKET, notionalUsd: 20, holdingHorizonHours: 12,
      long: cost(true, 0.4), short: cost(false, 0.5),
    }, NOW);
    expect(fourHours.expectedCostsBps).toBeCloseTo(235, 8);
    expect(twelveHours.expectedCostsBps).toBeCloseTo(255, 8);
    expect(twelveHours.costEvidence!.directionalQuotes.SHORT.funding.usd)
      .toBeGreaterThan(fourHours.costEvidence!.directionalQuotes.SHORT.funding.usd);
  });

  it('rejects a declared horizon when either directional holding rate is missing', () => {
    const result = deriveConservativeShadowCostBps({
      market: MARKET, notionalUsd: 20, holdingHorizonHours: 12,
      long: cost(true, 0.4, { fundingRatePerHourFraction: null }),
      short: cost(false, 0.5),
    }, NOW);
    expect(result.expectedCostsBps).toBeNull();
    expect(result.costEvidence).toBeNull();
    expect(result.reasons.join(' ')).toContain('HOLDING_COST_UNAVAILABLE');
  });

  it('rejects a lower-notional quote even inside the execution validator 1% tolerance', () => {
    const result = deriveConservativeShadowCostBps({
      market: MARKET, notionalUsd: 20, holdingHorizonHours: 12,
      long: cost(true, 0.4, { notionalUsd: 19.9 }),
      short: cost(false, 0.5),
    }, NOW);
    expect(result.expectedCostsBps).toBeNull();
    expect(result.costEvidence).toBeNull();
    expect(result.reasons.join(' ')).toContain('notional exact');
  });

  it('returns null instead of inventing zero when either direction is absent', () => {
    const result = deriveConservativeShadowCostBps({
      market: MARKET, notionalUsd: 20, holdingHorizonHours: 12,
      long: cost(true), short: null,
    }, NOW);
    expect(result.expectedCostsBps).toBeNull();
    expect(result.reasons[0]).toContain('양방향');
  });

  it('rejects stale or market-mismatched cost evidence', () => {
    const result = deriveConservativeShadowCostBps({
      market: MARKET,
      notionalUsd: 20,
      holdingHorizonHours: 12,
      long: cost(true, 0.48, { expiresAt: new Date(NOW - 1).toISOString() }),
      short: cost(false, 0.48, { market: '0x2222222222222222222222222222222222222222' }),
    }, NOW);
    expect(result.expectedCostsBps).toBeNull();
    expect(result.reasons).toHaveLength(2);
  });

  it('rejects old observations even when expiresAt is forged into the future', () => {
    const old = NOW - 10 * 60_000;
    const result = deriveConservativeShadowCostBps({
      market: MARKET,
      notionalUsd: 20,
      holdingHorizonHours: 12,
      long: cost(true, 0.48, {
        apiTimestamp: new Date(old).toISOString(),
        fetchedAt: new Date(old).toISOString(),
        expiresAt: new Date(NOW + 60_000).toISOString(),
      }),
      short: cost(false),
    }, NOW);
    expect(result.expectedCostsBps).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/age 초과|TTL 비정상/);
  });

  it('keeps an all-missing batch NOT_EVALUATED with no fabricated records', () => {
    let runnerCalls = 0;
    const result = buildStrategyShadowWorkerBatch(input(), {
      runSymbol: x => {
        runnerCalls++;
        return missing(x.symbol);
      },
    });
    expect(result.envelope.status).toBe('NOT_EVALUATED');
    expect(result.envelope.records).toEqual([]);
    expect(result.notEvaluatedSymbols.map(x => x.symbol)).toEqual(['BTC', 'ETH']);
    expect(result.notEvaluatedSymbols[0].reasons.join(' ')).toContain('비용');
    expect(runnerCalls).toBe(0);
    expect(result.executionAuthorized).toBe(false);
    expect(result.paperPositionMutationAllowed).toBe(false);
  });

  it('stores only evaluated records and marks a mixed batch PARTIAL', () => {
    const base = input();
    const result = buildStrategyShadowWorkerBatch({
      ...base,
      costsBySymbol: { BTC: costPair(), ETH: costPair() },
    }, {
      runSymbol: x => x.symbol === 'BTC' ? evaluated('BTC') : missing('ETH'),
    });
    expect(result.envelope.status).toBe('PARTIAL');
    expect(result.envelope.records.map(x => x.symbol)).toEqual(['BTC']);
    expect(result.envelope.missingSymbols).toEqual(['ETH']);
    expect(result.notEvaluatedSymbols[0].reasons).toContain('frame missing');
  });

  it('filters lifecycle and history evidence by symbol', () => {
    const base = {
      ...input(['BTC']),
      costsBySymbol: { BTC: costPair() },
    };
    let received: StrategyShadowWorkerBatchInput | null = null;
    const result = buildStrategyShadowWorkerBatch({ ...base }, {
      runSymbol: x => {
        expect(x.lifecycleRecords).toEqual([]);
        expect(x.historyEvents).toEqual([]);
        received = base;
        return evaluated(x.symbol);
      },
    });
    expect(received).not.toBeNull();
    expect(result.envelope.status).toBe('EVALUATED');
  });

  it('passes conservative component cost evidence into the pure runner', () => {
    const base = {
      ...input(['BTC']),
      costsBySymbol: { BTC: costPair() },
    };
    const result = buildStrategyShadowWorkerBatch(base, {
      runSymbol: x => {
        expect(x.expectedCostsBps).toBe(255);
        expect(x.netEdgeCostEvidence).toMatchObject({
          conservativeBasisDirection: 'SHORT',
          holdingHorizonHours: 12,
          bidirectionalValidated: true,
          directionalQuotes: {
            SHORT: { totalRoundTripCost: { usd: 0.51, bps: 255 } },
          },
        });
        return evaluated(x.symbol);
      },
    });
    expect(result.envelope.status).toBe('EVALUATED');
    expect(result.executionAuthorized).toBe(false);
  });

  it('normalizes cost symbol keys consistently with expected symbols', () => {
    const base = input(['btc']);
    let receivedSymbol: string | null = null;
    const result = buildStrategyShadowWorkerBatch({
      ...base,
      costsBySymbol: { btc: costPair() },
    }, {
      runSymbol: x => {
        receivedSymbol = x.symbol;
        return evaluated(x.symbol);
      },
    });
    expect(receivedSymbol).toBe('BTC');
    expect(result.envelope.status).toBe('EVALUATED');
  });

  it('fails closed on duplicate canonical cost keys', () => {
    let runnerCalls = 0;
    const result = buildStrategyShadowWorkerBatch({
      ...input(['BTC']),
      costsBySymbol: { BTC: costPair(), btc: costPair() },
    }, {
      runSymbol: x => {
        runnerCalls++;
        return evaluated(x.symbol);
      },
    });
    expect(result.schemaVersion).toBe('INVALID');
    expect(result.envelope.records).toEqual([]);
    expect(result.envelope.executionAuthorized).toBe(false);
    expect(runnerCalls).toBe(0);
  });

  it('fails closed on duplicate or malformed expected symbols', () => {
    const result = buildStrategyShadowWorkerBatch(input(['BTC', 'btc']));
    expect(result.schemaVersion).toBe('INVALID');
    expect(result.envelope.records).toEqual([]);
    expect(result.executionAuthorized).toBe(false);
    expect(result.approvalCreationAllowed).toBe(false);
    expect(result.livePositionMutationAllowed).toBe(false);
  });
});
