import type { StrategyShadowRecord } from '../../intel/strategyShadowAdapterV2';
import {
  evaluateStrategyNetEdgeResearch,
  STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
  type StrategyNetEdgeCostEvidence,
  type StrategyNetEdgeResearchResult,
} from '../../intel/strategyNetEdgeResearchGateV1';
import { DEFAULT_SIGNAL_LIFECYCLE_CONFIG } from '../../intel/signalLifecycleV2';
import type { StrategySignal } from '../../intel/strategySignalV2';

const NOTIONAL_USD = 1_000;
const COST_BPS = 20;
const HORIZON_HOURS = 12;

export function buildTestNetEdgeResearch(
  record: StrategyShadowRecord,
): StrategyNetEdgeResearchResult | null {
  if ((record.action !== 'LONG' && record.action !== 'SHORT')
    || record.signalId === null || record.strategyId === null
    || record.confidence === null || record.entryPrice === null
    || record.structuralStop === null || record.expectedNetEdgeBps === null
    || record.expectedNetRR === null || record.expectedNetRR <= 0) {
    return null;
  }
  const observedAtMs = record.evaluatedAt - 1_000;
  const quote = (direction: 'LONG' | 'SHORT') => ({
    direction,
    market: '0x1111111111111111111111111111111111111111',
    orderType: 'MarketIncrease' as const,
    notionalUsd: NOTIONAL_USD,
    holdingHorizonHours: HORIZON_HOURS,
    source: 'PAPER_GMX_ESTIMATE' as const,
    blockNumber: null,
    observedAtMs,
    fetchedAtMs: observedAtMs,
    expiresAtMs: observedAtMs + 60_000,
    fundingRatePerHourFraction: 0.3 / NOTIONAL_USD / HORIZON_HOURS,
    borrowingRatePerHourFraction: 0.2 / NOTIONAL_USD / HORIZON_HOURS,
    positionFee: { usd: 0.5, bps: 5 },
    exitFee: { usd: 0.5, bps: 5 },
    funding: { usd: 0.3, bps: 3 },
    borrowing: { usd: 0.2, bps: 2 },
    priceImpact: { usd: 0.4, bps: 4 },
    network: { usd: 0.1, bps: 1 },
    totalRoundTripCost: { usd: 2, bps: COST_BPS },
  });
  const costEvidence: StrategyNetEdgeCostEvidence = {
    schemaVersion: STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
    market: '0x1111111111111111111111111111111111111111',
    notionalUsd: NOTIONAL_USD,
    holdingHorizonHours: HORIZON_HOURS,
    observedAtMs,
    bidirectionalValidated: true,
    holdingCostsDerivedFromRates: true,
    holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT',
    conservativeBasisDirection: 'LONG',
    directionalQuotes: { LONG: quote('LONG'), SHORT: quote('SHORT') },
  };
  const signal: StrategySignal = {
    schemaVersion: 'strategy-signal/v2',
    signalId: record.signalId,
    strategyId: record.strategyId,
    symbol: record.symbol,
    regime: record.regime,
    direction: record.action,
    confidence: record.confidence,
    entryZoneLow: record.entryPrice,
    entryZoneHigh: record.entryPrice,
    proposedEntryPrice: record.entryPrice,
    structuralStop: record.structuralStop,
    stopDistancePct: record.expectedNetEdgeBps / record.expectedNetRR / 100,
    invalidationPrice: record.structuralStop,
    targets: [{ price: record.entryPrice, expectedR: record.expectedNetRR, allocationPct: 100 }],
    grossExpectedEdgeBps: record.expectedNetEdgeBps + COST_BPS,
    expectedCostsBps: COST_BPS,
    netExpectedEdgeBps: record.expectedNetEdgeBps,
    expectedNetRR: record.expectedNetRR,
    higherTimeframeTrend: 'UP',
    marketStructure: 'TEST_FIXTURE',
    confirmationPattern: 'TEST_FIXTURE',
    sourceTimeframes: ['4h', '1h', '15m'],
    sourceCandleCloseTime: record.sourceCandleCloseTime,
    dataQuality: 'GOOD',
    volumeConfirmation: null,
    reasons: [],
    warnings: [],
  };
  const result = evaluateStrategyNetEdgeResearch({
    signal,
    costEvidence,
    eligibility: {
      configVersion: DEFAULT_SIGNAL_LIFECYCLE_CONFIG.version,
      signalId: record.signalId,
      eligible: record.lifecycleEligible === true,
      codes: record.lifecycleEligible === true ? ['ELIGIBLE'] : ['STOP_LOSS_COOLDOWN'],
      blockedUntilCandleCloseTime: null,
      strategyConsecutiveLosses: 0,
      symbolConsecutiveLosses: 0,
      reasons: [],
      warnings: [],
    },
    evaluatedAt: record.evaluatedAt,
  });
  if (!result.eligible) {
    throw new Error(`test Net-Edge fixture unexpectedly ineligible: ${result.reasons.join('; ')}`);
  }
  return result;
}