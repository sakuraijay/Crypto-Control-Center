/**
 * Pure historical replay adapter. All market, cost and risk state is supplied by
 * the caller; this module has no runtime/DB/network/execution dependency.
 */
import { evaluateCandleSignal } from './candleSignalCore';
import type { CandleFrameInput, StrategyTimeframe } from './candleFoundationV2';
import type { OfflineDecision, OfflineHistoricalCostEvidence } from './offlineWalkForwardBacktestV2';
import type { RegimeState } from './regimeEngineV2';
import { runStrategyShadowSymbol } from './strategyShadowRunnerV2';
import { adaptStrategySignalToRisk } from './strategyRiskAdapterV2';
import { EMPTY_LOCKS, evaluateRiskState, type PersistedLocks } from '../lib/riskStateMachine';

export interface OfflineRiskEvidence {
  observedAtMs: number;
  dailyRiskCapitalUsd: number | null;
  weeklyRiskCapitalUsd: number | null;
  currentEquityUsd: number | null;
  dailyRealizedNetPnlUsd: number | null;
  dailyLossAwareNetPnlUsd: number | null;
  estimatedExitNetPnlUsd: number | null;
  weeklyRealizedNetPnlUsd: number | null;
  dailyEntryCount: number;
  consecutiveLossCount: number;
  openPositionCount: number;
  persistenceEvidenceOk: boolean;
  marketDataFresh: boolean;
  locks?: PersistedLocks;
}

export interface OfflineDecisionReplayInput {
  evaluatedAtMs: number;
  frames: Record<StrategyTimeframe, CandleFrameInput>;
  costEvidence: OfflineHistoricalCostEvidence | null;
  riskEvidence: OfflineRiskEvidence | null;
  previousRegime: RegimeState | null;
  profile: 'conservative' | 'aggressive';
}

const validAt = (observedAtMs: number, evaluatedAtMs: number): boolean =>
  Number.isFinite(observedAtMs) && observedAtMs <= evaluatedAtMs;

/**
 * Replays CandleSignal plus regime, all three strategy evaluators, arbiter and
 * the authoritative risk policy. Missing point-in-time evidence fails closed.
 */
export function replayOfflineDecision(input: OfflineDecisionReplayInput): OfflineDecision {
  const candleSignal = evaluateCandleSignal({
    symbol: 'BTC',
    frames: input.frames,
    evaluatedAtMs: input.evaluatedAtMs,
  });
  const cost = input.costEvidence;
  const expectedCostsBps = cost && validAt(cost.observedAtMs, input.evaluatedAtMs)
    ? cost.feeBpsPerSide * 2 + cost.entrySlippageBps + cost.exitSlippageBps + cost.impactBps
    : null;
  const shadow = runStrategyShadowSymbol({
    symbol: 'BTC',
    evaluatedAt: input.evaluatedAtMs,
    frames: input.frames,
    expectedCostsBps,
    previousRegime: input.previousRegime,
    lifecycleRecords: [],
    historyEvents: [],
    existingAi: null,
  });
  const selected = shadow.arbiter?.selectedSignal ?? null;
  const record = shadow.record;
  const riskEvidence = input.riskEvidence;
  const riskEvaluation = riskEvidence && validAt(riskEvidence.observedAtMs, input.evaluatedAtMs)
    ? evaluateRiskState({
      dailyRiskCapitalUsd: riskEvidence.dailyRiskCapitalUsd,
      weeklyRiskCapitalUsd: riskEvidence.weeklyRiskCapitalUsd,
      currentEquityUsd: riskEvidence.currentEquityUsd,
      dailyRealizedNetPnlUsd: riskEvidence.dailyRealizedNetPnlUsd,
      dailyLossAwareNetPnlUsd: riskEvidence.dailyLossAwareNetPnlUsd,
      estimatedExitNetPnlUsd: riskEvidence.estimatedExitNetPnlUsd,
      weeklyRealizedNetPnlUsd: riskEvidence.weeklyRealizedNetPnlUsd,
      dailyEntryCount: riskEvidence.dailyEntryCount,
      consecutiveLossCount: riskEvidence.consecutiveLossCount,
      openPositionCount: riskEvidence.openPositionCount,
      dbOk: riskEvidence.persistenceEvidenceOk,
      feeDataOk: expectedCostsBps !== null,
      marketDataFresh: riskEvidence.marketDataFresh,
      locks: riskEvidence.locks ?? EMPTY_LOCKS,
    })
    : null;
  const risk = record === null
    ? null
    : adaptStrategySignalToRisk({ shadowRecord: record, riskEvaluation });
  const usable = candleSignal.direction !== 'NO_TRADE'
    && selected !== null
    && candleSignal.direction === selected.direction
    && record !== null
    && risk !== null
    && (risk.action === 'ALLOW' || risk.action === 'REDUCE');
  const last15m = input.frames['15m'].candles?.at(-1);
  const closeTime = shadow.sourceCandleCloseTime
    ?? (last15m ? last15m.t + 15 * 60 * 1_000 : input.evaluatedAtMs);
  return {
    decisionId: `BTC:OFFLINE_REPLAY:${closeTime}`,
    symbol: 'BTC',
    sourceCandleCloseTime: closeTime,
    strategyId: usable ? selected.strategyId : null,
    regime: shadow.regime?.regime ?? 'UNKNOWN',
    profile: input.profile,
    direction: usable ? selected.direction : 'NONE',
    confidence: usable ? Math.min(selected.confidence, candleSignal.confidence) : 0,
    structuralStop: usable ? selected.structuralStop : null,
    targetPrice: usable ? (selected.targets[0]?.price ?? null) : null,
    riskDecision: risk?.action ?? 'REJECT',
    costEvidence: cost && validAt(cost.observedAtMs, closeTime) ? cost : null,
    regimeState: shadow.regime ? {
      symbol: shadow.regime.symbol, regime: shadow.regime.regime, confidence: shadow.regime.confidence,
      sinceCandleCloseTime: shadow.regime.sinceCandleCloseTime, heldCandles: shadow.regime.heldCandles,
      pendingRegime: shadow.regime.pendingRegime, pendingCount: shadow.regime.pendingCount,
    } : null,
  };
}