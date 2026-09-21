/** Explicit synthetic REPLAY fixture. Never market performance or a runtime fallback. */
import { buildCandleStrategyShadowEvidence } from '../../intel/candleStrategyShadowEvidenceV2';
import type { CandleSignalToRisk } from '../../intel/candleSignalContract';
import type { StrategyShadowRecord } from '../../intel/strategyShadowAdapterV2';
import type { CostSnapshot } from '../../lib/costSnapshot';
import { MARKET_BY_SYMBOL_SERVER } from '../../lib/gmxMarkets';

export function virtualReplaySignal(nowMs: number, symbol = 'BTC'): StrategyShadowRecord {
  const close = Math.floor(nowMs / 900_000) * 900_000;
  const record: StrategyShadowRecord = {
    schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: `REPLAY:${close}`,
    mode: 'SHADOW_ONLY', symbol, evaluatedAt: nowMs, sourceCandleCloseTime: close,
    regime: 'TREND_UP', action: 'LONG', comparison: 'ENSEMBLE_ONLY', strategyId: 'TREND_PULLBACK',
    signalId: `REPLAY:${symbol}:${close}`, direction: 'LONG', confidence: 85, selectedScore: 85,
    entryPrice: 50_000, structuralStop: 49_000, expectedNetEdgeBps: 200, expectedNetRR: 2,
    lifecycleEligible: true, existingAi: null, reasons: ['SYNTHETIC REPLAY'], warnings: [],
    executionAuthorized: false, paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED',
  };
  record.candleSignalEvidence = buildCandleStrategyShadowEvidence({
    candleSignal: { schemaVersion: 'candle-signal/v1', symbol, evaluatedAtMs: nowMs,
      direction: 'LONG', dataQuality: { status: 'GOOD', frameCloseTimesMs: {
        '15m': close, '1h': Math.floor(close / 3_600_000) * 3_600_000,
        '4h': Math.floor(close / 14_400_000) * 14_400_000 } } } as CandleSignalToRisk,
    v2Regime: { configVersion: 'regime-engine/v2', symbol, calculatedAt: close } as never,
    shadowRecord: record,
  })!;
  return record;
}

export function virtualReplayCost(nowMs: number, notionalUsd: number): CostSnapshot {
  return { market: MARKET_BY_SYMBOL_SERVER.get('BTC')!.marketToken,
    isLong: true, orderType: 'MarketIncrease', notionalUsd,
    positionFeeUsd: 0.01, executionFeeUsd: 0.01, estimatedPriceImpactUsd: 0,
    fundingFeeUsd: 0.001, borrowingFeeUsd: 0.001, estimatedExitFeeUsd: 0.01,
    estimatedExitPriceImpactUsd: 0, fundingRatePerHourFraction: 0.00001,
    borrowingRatePerHourFraction: 0.00001, totalEstimatedRoundTripCostUsd: 0.032,
    source: 'PAPER_GMX_ESTIMATE', blockNumber: null, apiTimestamp: new Date(nowMs).toISOString(),
    fetchedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 60_000).toISOString() };
}
