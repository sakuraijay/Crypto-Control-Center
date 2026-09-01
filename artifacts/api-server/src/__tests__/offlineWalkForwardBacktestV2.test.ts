import { describe, expect, it } from 'vitest';
import {
  OFFLINE_CONFIDENCE_THRESHOLDS,
  runOfflineWalkForwardBacktest,
  type OfflineDecision,
  type OfflineWalkForwardConfig,
} from '../intel/offlineWalkForwardBacktestV2';
import type { Candle } from '../intel/types';

const STEP = 15 * 60 * 1_000;
const BASE = 1_800_000_000_000;

const config: OfflineWalkForwardConfig = {
  initialCapitalUsd: 1_000,
  positionSizePct: 0.1,
  trainBars: 4,
  purgeBars: 1,
  oosBars: 4,
  stepBars: 4,
  minimumFolds: 2,
  maximumHoldingBars: 2,
  thresholds: OFFLINE_CONFIDENCE_THRESHOLDS,
};

function candles(count = 16): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    t: BASE + index * STEP,
    o: 100,
    h: 103,
    l: 97,
    c: 100,
    v: 10 + index,
  }));
}

function decision(signalIndex: number, overrides: Partial<OfflineDecision> = {}): OfflineDecision {
  return {
    decisionId: `BTC:OOS:${signalIndex}`,
    symbol: 'BTC',
    sourceCandleCloseTime: BASE + (signalIndex + 1) * STEP,
    strategyId: 'TREND_PULLBACK',
    regime: 'TREND_UP',
    profile: 'conservative',
    direction: 'LONG',
    confidence: 75,
    structuralStop: 99,
    targetPrice: 101,
    riskDecision: 'ALLOW',
    costEvidence: {
      observedAtMs: BASE + (signalIndex + 1) * STEP,
      feeBpsPerSide: 1,
      entrySlippageBps: 1,
      exitSlippageBps: 1,
      fundingBpsPerHour: 0.1,
      borrowingBpsPerHour: 0.1,
      impactBps: 1,
    },
    ...overrides,
  };
}

function run(overrides: Partial<Parameters<typeof runOfflineWalkForwardBacktest>[0]> = {}) {
  const series = candles();
  return runOfflineWalkForwardBacktest({
    symbol: 'BTC',
    source: 'immutable-test-fixture',
    generatedAtMs: BASE + series.length * STEP,
    candles15m: series,
    decisions: [decision(5), decision(9)],
    config,
    ...overrides,
  });
}

function runExitScenario(args: {
  direction: 'LONG' | 'SHORT';
  stop: number;
  target: number;
  exitCandle: Candle;
}) {
  const series = candles();
  series[6] = { ...series[6], h: 100.5, l: 99.5 };
  series[7] = args.exitCandle;
  const result = run({
    candles15m: series,
    decisions: [decision(5, {
      direction: args.direction,
      structuralStop: args.stop,
      targetPrice: args.target,
    })],
  });
  return result.thresholds[0].aggregateOos.trades[0];
}

describe('offline BTC walk-forward/OOS backtest v2', () => {
  it('고정된 다섯 confidence threshold를 동일 fold 경계로 비교한다', () => {
    const result = run();
    expect(result.status).toBe('OK');
    expect(result.thresholds.map(row => row.threshold)).toEqual([60, 65, 70, 75, 80]);
    expect(result.thresholds.every(row => row.folds.length === 2)).toBe(true);
    const boundaries = result.thresholds.map(row => row.folds.map(fold => [fold.oosStartTime, fold.oosEndTime]));
    expect(boundaries.every(value => JSON.stringify(value) === JSON.stringify(boundaries[0]))).toBe(true);
    expect(result.autoPromotionAllowed).toBe(false);
    expect(result.liveExecutionAuthorized).toBe(false);
  });

  it('신호 봉이 아니라 다음 봉 시가에 진입한다', () => {
    const result = run();
    const trade = result.thresholds[0].aggregateOos.trades[0];
    expect(trade.signalCloseTime).toBe(BASE + 6 * STEP);
    expect(trade.entryTime).toBe(BASE + 6 * STEP);
    expect(trade.entryPrice).toBe(100);
  });

  it('같은 봉에서 TP와 SL이 모두 닿으면 보수적으로 SL을 먼저 적용한다', () => {
    const result = run();
    const trade = result.thresholds[0].aggregateOos.trades[0];
    expect(trade.exitReason).toBe('AMBIGUOUS_STOP_FIRST');
    expect(trade.exitPrice).toBe(99);
    expect(trade.netPnlUsd).toBeLessThan(trade.grossPnlUsd);
  });

  it.each([
    {
      name: 'LONG stop gap-down',
      direction: 'LONG' as const,
      stop: 99,
      target: 101,
      exitCandle: { t: BASE + 7 * STEP, o: 95, h: 96, l: 94, c: 95, v: 17 },
      expectedPrice: 95,
    },
    {
      name: 'SHORT stop gap-up',
      direction: 'SHORT' as const,
      stop: 101,
      target: 99,
      exitCandle: { t: BASE + 7 * STEP, o: 105, h: 106, l: 104, c: 105, v: 17 },
      expectedPrice: 105,
    },
  ])('$name은 이미 stop을 넘은 candle open의 더 불리한 가격으로 체결한다', scenario => {
    const trade = runExitScenario(scenario);
    expect(trade.exitReason).toBe('STOP');
    expect(trade.exitPrice).toBe(scenario.expectedPrice);
  });

  it.each([
    {
      name: 'LONG target gap-up',
      direction: 'LONG' as const,
      stop: 99,
      target: 101,
      exitCandle: { t: BASE + 7 * STEP, o: 105, h: 106, l: 104, c: 105, v: 17 },
    },
    {
      name: 'SHORT target gap-down',
      direction: 'SHORT' as const,
      stop: 101,
      target: 99,
      exitCandle: { t: BASE + 7 * STEP, o: 95, h: 96, l: 94, c: 95, v: 17 },
    },
  ])('$name은 target을 넘은 open의 추가 이익을 합성하지 않는다', scenario => {
    const trade = runExitScenario(scenario);
    expect(trade.exitReason).toBe('TARGET');
    expect(trade.exitPrice).toBe(scenario.target);
  });

  it.each([
    {
      name: '일반 LONG intrabar stop',
      direction: 'LONG' as const,
      stop: 99,
      target: 101,
      exitCandle: { t: BASE + 7 * STEP, o: 100, h: 100.5, l: 98.5, c: 99.5, v: 17 },
      expectedReason: 'STOP',
      expectedPrice: 99,
    },
    {
      name: '일반 SHORT intrabar target',
      direction: 'SHORT' as const,
      stop: 101,
      target: 99,
      exitCandle: { t: BASE + 7 * STEP, o: 100, h: 100.5, l: 98.5, c: 99.5, v: 17 },
      expectedReason: 'TARGET',
      expectedPrice: 99,
    },
  ])('$name은 기존 경계 가격 체결을 유지한다', scenario => {
    const trade = runExitScenario(scenario);
    expect(trade.exitReason).toBe(scenario.expectedReason);
    expect(trade.exitPrice).toBe(scenario.expectedPrice);
  });

  it('open gap fill도 비용 차감과 offline-only 결정론을 유지한다', () => {
    const scenario = {
      direction: 'LONG' as const,
      stop: 99,
      target: 101,
      exitCandle: { t: BASE + 7 * STEP, o: 95, h: 96, l: 94, c: 95, v: 17 },
    };
    const first = runExitScenario(scenario);
    const second = runExitScenario(scenario);
    const pieces = first.costs.feesUsd + first.costs.slippageUsd + first.costs.fundingUsd
      + first.costs.borrowingUsd + first.costs.impactUsd;
    expect(first).toEqual(second);
    expect(first.costs.totalUsd).toBeCloseTo(pieces, 10);
    expect(first.netPnlUsd).toBeCloseTo(first.grossPnlUsd - first.costs.totalUsd, 10);

    const result = run();
    expect(result.autoPromotionAllowed).toBe(false);
    expect(result.liveExecutionAuthorized).toBe(false);
  });

  it('비용을 gross와 분리하고 fee/slippage/funding/borrowing/impact 합계를 보존한다', () => {
    const result = run();
    const trade = result.thresholds[0].aggregateOos.trades[0];
    const pieces = trade.costs.feesUsd + trade.costs.slippageUsd + trade.costs.fundingUsd
      + trade.costs.borrowingUsd + trade.costs.impactUsd;
    expect(trade.costs.totalUsd).toBeCloseTo(pieces, 10);
    expect(trade.netPnlUsd).toBeCloseTo(trade.grossPnlUsd - trade.costs.totalUsd, 10);
    expect(result.thresholds[0].aggregateOos.metrics.expectancyUsd).not.toBeNull();
    expect(result.thresholds[0].aggregateOos.metrics.averageR).not.toBeNull();
  });

  it('과거 비용 근거가 없으면 비용 0으로 위장하지 않고 거래를 차단한다', () => {
    const result = run({ decisions: [decision(5, { costEvidence: null }), decision(9, { costEvidence: null })] });
    const sample = result.thresholds[0].aggregateOos;
    expect(sample.trades).toHaveLength(0);
    expect(sample.blocked.COST_UNAVAILABLE).toBe(2);
    expect(sample.metrics.netReturnPct).toBeNull();
    expect(sample.metrics.profitFactor).toBeNull();
  });

  it('거래량 누락을 0으로 바꾸지 않고 전체 보고서를 fail-closed 처리한다', () => {
    const series = candles();
    series[3] = { ...series[3], v: null };
    const result = run({ candles15m: series });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.issues.join(' ')).toContain('candle INVALID');
    expect(result.thresholds).toEqual([]);
  });

  it('중복·역순·gap candle과 미마감 candle을 거부한다', () => {
    const gap = candles();
    gap[4] = { ...gap[4], t: gap[3].t + 2 * STEP };
    expect(run({ candles15m: gap }).issues.join(' ')).toContain('gap candle');

    const open = candles();
    const result = run({ candles15m: open, generatedAtMs: BASE + open.length * STEP - 1 });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.issues.join(' ')).toContain('미마감');
  });

  it('OOS 마지막 신호에 다음 봉이 없으면 체결하지 않는다', () => {
    const result = run({ decisions: [decision(8), decision(12)] });
    const sample = result.thresholds[0].aggregateOos;
    expect(sample.trades).toHaveLength(0);
    expect(sample.blocked.NEXT_BAR_UNAVAILABLE).toBe(2);
  });

  it('threshold 미달은 손실 거래가 아니라 별도 blocked 사유로 집계한다', () => {
    const result = run({ decisions: [decision(5, { confidence: 69 }), decision(9, { confidence: 69 })] });
    expect(result.thresholds.find(row => row.threshold === 65)?.aggregateOos.trades).toHaveLength(2);
    const threshold70 = result.thresholds.find(row => row.threshold === 70)?.aggregateOos;
    expect(threshold70?.trades).toHaveLength(0);
    expect(threshold70?.blocked.INSUFFICIENT_CONFIDENCE).toBe(2);
  });

  it('동일 입력은 동일한 결정론적 보고서를 생성한다', () => {
    expect(run()).toEqual(run());
  });

  it('stale snapshot과 holding interval의 cost gap을 fail-closed 처리한다', () => {
    const stale = decision(5, { costEvidence: { ...decision(5).costEvidence!, observedAtMs: BASE - 10 * 60 * 60 * 1_000 } });
    expect(run({ decisions: [stale, decision(9)] }).thresholds[0].aggregateOos.blocked.COST_UNAVAILABLE).toBe(1);
    const gapped = decision(5, {
      structuralStop: 90,
      targetPrice: 110,
      costEvidence: {
        ...decision(5).costEvidence!, validFromMs: BASE + 6 * STEP, validUntilMs: BASE + 7 * STEP,
      },
      costCoverage: [{
        ...decision(5).costEvidence!, validFromMs: BASE + 6 * STEP, validUntilMs: BASE + 7 * STEP,
      }],
    });
    expect(run({ decisions: [gapped, decision(9)] }).thresholds[0].aggregateOos.blocked.COST_UNAVAILABLE).toBe(1);
  });

  it('독립 fold sizing을 합산 PnL 수익률로 잘못 표시하지 않고 기하 합성한다', () => {
    const result = run();
    const aggregate = result.thresholds[0].aggregateOos.metrics;
    const folds = result.thresholds[0].folds.map(fold => fold.oos.metrics.netReturnPct! / 100);
    expect(aggregate.netReturnPct).toBeCloseTo(((1 + folds[0]) * (1 + folds[1]) - 1) * 100, 10);
    expect(aggregate.equityCurve).toHaveLength(2);
  });

  it('aggregate OOS drawdown은 fold 종료값이 아니라 rebased intra-fold curve의 peak-to-trough를 사용한다', () => {
    const metrics = run().thresholds[0].aggregateOos.metrics;
    let peak = 1_000;
    let drawdown = 0;
    for (const point of metrics.equityCurve) {
      peak = Math.max(peak, point.equityUsd);
      drawdown = Math.max(drawdown, (peak - point.equityUsd) / peak * 100);
    }
    expect(metrics.maxDrawdownPct).toBeCloseTo(drawdown, 10);
  });
});
