/**
 * Deterministic raw-candle REPLAY fixture for the Virtual400 lifecycle tests.
 *
 * The input is synthetic and must never be presented as live market performance.
 * Unlike virtualPaper400Replay.ts, this helper starts with closed 4h/1h/15m
 * candle arrays and obtains the actionable record from the real strategy runner.
 */
import type { CandleFrameInput, StrategyTimeframe } from '../../intel/candleFoundationV2';
import {
  STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
  type StrategyNetEdgeCostEvidence,
} from '../../intel/strategyNetEdgeResearchGateV1';
import { runStrategyShadowSymbol } from '../../intel/strategyShadowRunnerV2';
import type { StrategyShadowRecord } from '../../intel/strategyShadowAdapterV2';
import type { Candle } from '../../intel/types';

const STEPS: Record<StrategyTimeframe, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

function candles(timeframe: StrategyTimeframe, closeTimeMs: number): Candle[] {
  const step = STEPS[timeframe];
  const first = closeTimeMs - step - 239 * step;
  return Array.from({ length: 240 }, (_, index) => {
    const center = 100 + index * 0.18 + Math.sin(index * 0.72) * 0.9;
    const candle = {
      t: first + index * step,
      o: center - 0.12,
      h: center + 0.36,
      l: center - 0.36,
      c: center + 0.12,
      v: index === 239 ? 1_500 : 1_000,
    };
    if (index === 239) {
      candle.o = candle.c - 0.2;
      candle.h = candle.c + 0.1;
      candle.l = candle.o - 0.5;
    }
    return candle;
  });
}

function frame(timeframe: StrategyTimeframe, nowMs: number, closeTimeMs: number): CandleFrameInput {
  const values = candles(timeframe, closeTimeMs);
  if (timeframe === '15m') {
    const close = 140.9;
    values[238] = {
      ...values[238]!,
      o: 140.5,
      h: 140.6,
      l: 140.1,
      c: 140.2,
      v: 1_000,
    };
    values[239] = {
      ...values[239]!,
      o: 140.1,
      h: close + 0.1,
      l: close - 0.9,
      c: close,
      v: 1_500,
    };
  }
  return {
    symbol: 'BTC',
    timeframe,
    source: 'gmx-official-api',
    fetchedAtMs: nowMs,
    candles: values,
  };
}

function netEdgeCostEvidence(nowMs: number): StrategyNetEdgeCostEvidence {
  const market = '0x1111111111111111111111111111111111111111';
  const quote = (direction: 'LONG' | 'SHORT') => ({
    direction,
    market,
    orderType: 'MarketIncrease' as const,
    notionalUsd: 1_000,
    holdingHorizonHours: 12,
    source: 'PAPER_GMX_ESTIMATE' as const,
    blockNumber: null,
    observedAtMs: nowMs - 1_000,
    fetchedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 59_000,
    fundingRatePerHourFraction: 0,
    borrowingRatePerHourFraction: 0,
    positionFee: { usd: 0.2, bps: 2 },
    exitFee: { usd: 0.2, bps: 2 },
    funding: { usd: 0, bps: 0 },
    borrowing: { usd: 0, bps: 0 },
    priceImpact: { usd: 0.5, bps: 5 },
    network: { usd: 0.1, bps: 1 },
    totalRoundTripCost: { usd: 1, bps: 10 },
  });
  return {
    schemaVersion: STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
    market,
    notionalUsd: 1_000,
    holdingHorizonHours: 12,
    observedAtMs: nowMs - 1_000,
    bidirectionalValidated: true,
    holdingCostsDerivedFromRates: true,
    holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT',
    conservativeBasisDirection: 'LONG',
    directionalQuotes: { LONG: quote('LONG'), SHORT: quote('SHORT') },
  };
}

export function rawCandleVirtualReplaySignal(nowMs: number): StrategyShadowRecord {
  const closeTimeMs = Math.floor(nowMs / STEPS['4h']) * STEPS['4h'];
  const result = runStrategyShadowSymbol({
    symbol: 'BTC',
    evaluatedAt: nowMs,
    frames: {
      '15m': frame('15m', nowMs, closeTimeMs),
      '1h': frame('1h', nowMs, closeTimeMs),
      '4h': frame('4h', nowMs, closeTimeMs),
    },
    expectedCostsBps: 10,
    netEdgeCostEvidence: netEdgeCostEvidence(nowMs),
    previousRegime: null,
    lifecycleRecords: [],
    historyEvents: [],
    existingAi: null,
  });
  if (result.status !== 'EVALUATED' || result.record?.action !== 'LONG'
    || result.record.signalId === null || result.record.entryPrice === null
    || result.record.structuralStop === null || result.record.confidence === null
    || result.record.candleSignalEvidence?.disposition !== 'AGREED') {
    throw new Error(`raw-candle REPLAY did not produce an actionable LONG record: ${JSON.stringify({
      status: result.status,
      action: result.record?.action,
      reasons: result.record?.reasons ?? result.reasons,
      disposition: result.record?.candleSignalEvidence?.disposition,
    })}`);
  }
  return result.record;
}
