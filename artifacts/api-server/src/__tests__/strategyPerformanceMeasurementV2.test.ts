import { describe, expect, it } from 'vitest';
import {
  computeStrategyPerformanceAggregate,
  emptyStrategyPerformanceMeasurementPlan,
  IMMUTABLE_PERFORMANCE_COST_CAP_USD,
  type StrategyPerformanceMeasurementPlan,
  type StrategyPerformanceObservation,
} from '../intel/strategyPerformanceMeasurementV2';

const HOUR_MS = 60 * 60 * 1_000;
const BASE_TIME = Date.parse('2026-09-05T00:00:00.000Z');

const observation = (
  id: string,
  overrides: Partial<StrategyPerformanceObservation> = {},
): StrategyPerformanceObservation => {
  const endedAt = BASE_TIME + Number(id) * 4 * HOUR_MS;
  return {
    candidateId: id,
    variant: 'STANDARD_EXISTING',
    strategyId: 'TREND_PULLBACK',
    regime: 'STRONG_BULL',
    direction: 'LONG',
    measuredAtMs: endedAt,
    horizonHours: 4,
    outcomeWindowStartedAtMs: endedAt - 4 * HOUR_MS,
    outcomeWindowEndedAtMs: endedAt,
    completionEvidenceId: `closed-candles:${id}`,
    outcomeStatus: 'COMPLETE',
    costEvidenceId: `cost:${id}`,
    grossPnlUsd: 10,
    totalCostUsd: 0.2,
    netPnlUsd: 9.8,
    riskUsd: 4,
    ...overrides,
  };
};

const plan = (rows: StrategyPerformanceObservation[]): StrategyPerformanceMeasurementPlan => ({
  ...emptyStrategyPerformanceMeasurementPlan(),
  candidates: rows.map(row => ({
    candidateId: row.candidateId,
    variant: row.variant,
    strategyId: row.strategyId,
    regime: row.regime,
    symbol: 'BTC',
    direction: row.direction,
    evaluatedAt: row.outcomeWindowStartedAtMs,
    notionalUsd: 20,
    expectedTotalCostUsd: row.totalCostUsd,
    costEvidenceId: row.costEvidenceId,
    costEvidenceObservedAtMs: row.outcomeWindowStartedAtMs - 1_000,
    costEvidenceExpiresAtMs: row.outcomeWindowStartedAtMs + 59_000,
    riskUsd: row.riskUsd,
    status: 'ELIGIBLE',
    reasons: [],
    authority: 'MEASUREMENT_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  })),
});

describe('strategy performance measurement v2', () => {
  it('aggregates evidenced net/gross/cost, expectancy, PF, win rate, drawdown and R', () => {
    const rows = [
      observation('1'),
      observation('2', { grossPnlUsd: -4, totalCostUsd: 0.1, netPnlUsd: -4.1, riskUsd: 5 }),
      observation('3', { grossPnlUsd: 3, totalCostUsd: 0.1, netPnlUsd: 2.9, riskUsd: 2 }),
    ];
    const result = computeStrategyPerformanceAggregate({ plan: plan(rows), observations: rows });
    expect(result.status).toBe('OK');
    expect(result.overall).toMatchObject({
      tradeCount: 3,
      grossPnlUsd: 9,
      totalCostUsd: 0.4,
      winRate: 2 / 3,
      maxDrawdownUsd: 4.1,
    });
    expect(result.overall?.netPnlUsd).toBeCloseTo(8.6);
    expect(result.overall?.feeToGrossRatio).toBeCloseTo(0.4 / 13);
    expect(result.overall?.expectancyUsd).toBeCloseTo(8.6 / 3);
    expect(result.overall?.profitFactor).toBeCloseTo(12.7 / 4.1);
    expect(result.overall?.averageR).toBeCloseTo((9.8 / 4 - 4.1 / 5 + 2.9 / 2) / 3);
    expect(result.executionAuthorized).toBe(false);
    expect(result.paperPositionMutationAllowed).toBe(false);
    expect(IMMUTABLE_PERFORMANCE_COST_CAP_USD).toBe(0.40);
  });

  it('separates Standard/Aggressive and regime/strategy/direction buckets', () => {
    const rows = [
      observation('1'),
      observation('2', { variant: 'AGGRESSIVE_CANDIDATE' }),
      observation('3', { regime: 'RANGE', direction: 'SHORT' }),
      observation('4', { strategyId: 'VOLATILITY_BREAKOUT' }),
    ];
    const result = computeStrategyPerformanceAggregate({ plan: plan(rows), observations: rows });
    expect(result.byVariant.STANDARD_EXISTING?.tradeCount).toBe(3);
    expect(result.byVariant.AGGRESSIVE_CANDIDATE?.tradeCount).toBe(1);
    expect(Object.keys(result.byStrategyRegimeVariant)).toEqual([
      'TREND_PULLBACK|RANGE|STANDARD_EXISTING|SHORT',
      'TREND_PULLBACK|STRONG_BULL|AGGRESSIVE_CANDIDATE|LONG',
      'TREND_PULLBACK|STRONG_BULL|STANDARD_EXISTING|LONG',
      'VOLATILITY_BREAKOUT|STRONG_BULL|STANDARD_EXISTING|LONG',
    ]);
  });

  it('excludes incomplete, ambiguous, missing-cost and inconsistent outcomes without zero fill', () => {
    const rows = [
      observation('1', { outcomeStatus: 'INCOMPLETE' }),
      observation('2', { outcomeStatus: 'AMBIGUOUS_INTRABAR' }),
      observation('3', { totalCostUsd: null, netPnlUsd: null, costEvidenceId: null }),
      observation('4', { grossPnlUsd: 10, totalCostUsd: 0.2, netPnlUsd: 9 }),
    ];
    const result = computeStrategyPerformanceAggregate({ plan: plan(rows), observations: rows });
    expect(result.status).toBe('NOT_EVALUATED');
    expect(result.excludedCount).toBe(4);
    expect(result.overall).toBeNull();
  });

  it('returns null ratios when gross profit, losses or risk evidence are absent', () => {
    const rows = [
      observation('1', { grossPnlUsd: -1, totalCostUsd: 0.1, netPnlUsd: -1.1, riskUsd: null }),
    ];
    const result = computeStrategyPerformanceAggregate({ plan: plan(rows), observations: rows });
    expect(result.overall?.feeToGrossRatio).toBeNull();
    expect(result.overall?.profitFactor).toBe(0);
    expect(result.overall?.averageR).toBeNull();
  });

  it('excludes unissued, duplicate and cost-provenance mismatched observations', () => {
    const issued = observation('1');
    const duplicate = observation('2');
    const rows = [
      issued,
      duplicate,
      { ...duplicate },
      observation('3', { costEvidenceId: null, totalCostUsd: 0, netPnlUsd: 10 }),
      observation('4', { candidateId: 'unissued', costEvidenceId: 'cost:unissued' }),
    ];
    const measurementPlan = plan([issued, duplicate, rows[3]]);
    const result = computeStrategyPerformanceAggregate({ plan: measurementPlan, observations: rows });
    expect(result.overall?.tradeCount).toBe(1);
    expect(result.excludedCount).toBe(4);
  });

  it('rejects a forged 4h label when the evidenced outcome interval is shorter', () => {
    const row = observation('1', {
      outcomeWindowStartedAtMs: BASE_TIME,
      outcomeWindowEndedAtMs: BASE_TIME + HOUR_MS,
      measuredAtMs: BASE_TIME + HOUR_MS,
    });
    const result = computeStrategyPerformanceAggregate({ plan: plan([row]), observations: [row] });
    expect(result.status).toBe('NOT_EVALUATED');
    expect(result.excludedCount).toBe(1);
  });

  it('rejects hand-crafted zero-cost candidates even when numeric PnL arithmetic balances', () => {
    const row = observation('1', { totalCostUsd: 0, netPnlUsd: 10 });
    const result = computeStrategyPerformanceAggregate({ plan: plan([row]), observations: [row] });
    expect(result.status).toBe('NOT_EVALUATED');
    expect(result.overall).toBeNull();
  });

  it('rejects matching but non-canonical candidate and observation variants', () => {
    const row = observation('1');
    row.variant = 'UNKNOWN_VARIANT' as never;
    const result = computeStrategyPerformanceAggregate({ plan: plan([row]), observations: [row] });
    expect(result.status).toBe('NOT_EVALUATED');
    expect(result.byVariant).toEqual({
      STANDARD_EXISTING: null,
      AGGRESSIVE_CANDIDATE: null,
    });
  });
});