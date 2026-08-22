import { describe, expect, it } from 'vitest';
import type { CostSnapshot } from '../lib/costSnapshot';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';
import type { StrategyShadowRunnerResult } from './strategyShadowRunnerV2';
import {
  buildStrategyShadowWorkerBatch,
  deriveConservativeShadowCostBps,
  type StrategyShadowWorkerBatchInput,
} from './strategyShadowWorkerBatchV2';

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
    estimatedExitPriceImpactUsd: 0.08,
    fundingRatePerHourFraction: 0.0001,
    borrowingRatePerHourFraction: 0.0001,
    totalEstimatedRoundTripCostUsd: total,
    source: 'PAPER_GMX_ESTIMATE',
    blockNumber: null,
    apiTimestamp: new Date(NOW - 1_000).toISOString(),
    fetchedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides,
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
      market: MARKET, notionalUsd: 20, long: cost(true, 0.4), short: cost(false, 0.5),
    }, NOW);
    expect(result.reasons).toEqual([]);
    expect(result.expectedCostsBps).toBe(250);
  });

  it('returns null instead of inventing zero when either direction is absent', () => {
    const result = deriveConservativeShadowCostBps({
      market: MARKET, notionalUsd: 20, long: cost(true), short: null,
    }, NOW);
    expect(result.expectedCostsBps).toBeNull();
    expect(result.reasons[0]).toContain('양방향');
  });

  it('rejects stale or market-mismatched cost evidence', () => {
    const result = deriveConservativeShadowCostBps({
      market: MARKET,
      notionalUsd: 20,
      long: cost(true, 0.48, { expiresAt: new Date(NOW - 1).toISOString() }),
      short: cost(false, 0.48, { market: '0x2222222222222222222222222222222222222222' }),
    }, NOW);
    expect(result.expectedCostsBps).toBeNull();
    expect(result.reasons).toHaveLength(2);
  });

  it('keeps an all-missing batch NOT_EVALUATED with no fabricated records', () => {
    const result = buildStrategyShadowWorkerBatch(input(), { runSymbol: x => missing(x.symbol) });
    expect(result.envelope.status).toBe('NOT_EVALUATED');
    expect(result.envelope.records).toEqual([]);
    expect(result.notEvaluatedSymbols.map(x => x.symbol)).toEqual(['BTC', 'ETH']);
    expect(result.executionAuthorized).toBe(false);
    expect(result.paperPositionMutationAllowed).toBe(false);
  });

  it('stores only evaluated records and marks a mixed batch PARTIAL', () => {
    const result = buildStrategyShadowWorkerBatch(input(), {
      runSymbol: x => x.symbol === 'BTC' ? evaluated('BTC') : missing('ETH'),
    });
    expect(result.envelope.status).toBe('PARTIAL');
    expect(result.envelope.records.map(x => x.symbol)).toEqual(['BTC']);
    expect(result.envelope.missingSymbols).toEqual(['ETH']);
    expect(result.notEvaluatedSymbols[0].reasons).toContain('frame missing');
  });

  it('filters lifecycle and history evidence by symbol', () => {
    const base = input(['BTC']);
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

  it('fails closed on duplicate or malformed expected symbols', () => {
    const result = buildStrategyShadowWorkerBatch(input(['BTC', 'btc']));
    expect(result.schemaVersion).toBe('INVALID');
    expect(result.envelope.records).toEqual([]);
    expect(result.executionAuthorized).toBe(false);
    expect(result.approvalCreationAllowed).toBe(false);
    expect(result.livePositionMutationAllowed).toBe(false);
  });
});
