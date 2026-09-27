/** Serializable advisory contract for Regime-Aware Strategy Ensemble v2. */
import type { MarketRegime } from './regimeEngineV2';

export const STRATEGY_SIGNAL_SCHEMA_VERSION = 'strategy-signal/v2' as const;
export type StrategyId = 'TREND_PULLBACK' | 'VOLATILITY_BREAKOUT' | 'RANGE_MEAN_REVERSION';
export type StrategyDirection = 'LONG' | 'SHORT' | 'NONE';
export type StrategyDataQuality = 'GOOD' | 'DEGRADED' | 'INVALID';

export interface StrategySignalTarget {
  price: number;
  expectedR: number;
  allocationPct: number;
}

/** Candidate evidence only. Risk Engine and Execution Gate retain final authority. */
export interface StrategySignal {
  schemaVersion: typeof STRATEGY_SIGNAL_SCHEMA_VERSION;
  signalId: string;
  strategyId: StrategyId;
  symbol: string;
  regime: MarketRegime;
  direction: StrategyDirection;
  confidence: number;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  proposedEntryPrice: number | null;
  structuralStop: number | null;
  stopDistancePct: number | null;
  invalidationPrice: number | null;
  targets: StrategySignalTarget[];
  grossExpectedEdgeBps: number | null;
  expectedCostsBps: number | null;
  netExpectedEdgeBps: number | null;
  expectedNetRR: number | null;
  higherTimeframeTrend: string;
  marketStructure: string;
  confirmationPattern: string | null;
  sourceTimeframes: Array<'15m' | '1h' | '4h'>;
  sourceCandleCloseTime: number;
  dataQuality: StrategyDataQuality;
  volumeConfirmation: boolean | null;
  reasons: string[];
  warnings: string[];
}

export function buildStrategySignalId(
  symbol: string,
  strategyId: StrategyId,
  direction: StrategyDirection,
  timeframe: '15m' | '1h' | '4h',
  sourceCandleCloseTime: number,
): string {
  return [symbol.trim().toUpperCase(), strategyId, direction, timeframe, sourceCandleCloseTime].join(':');
}
