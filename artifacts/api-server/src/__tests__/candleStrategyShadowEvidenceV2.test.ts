import { describe, expect, it } from 'vitest';
import type { Candle } from '../intel/types';
import type { CandleFrameInput, StrategyTimeframe } from '../intel/candleFoundationV2';
import {
  buildCandleStrategyShadowEvidence,
  validateCandleStrategyShadowEvidence,
} from '../intel/candleStrategyShadowEvidenceV2';
import { runStrategyShadowSymbol } from '../intel/strategyShadowRunnerV2';
import { adaptStrategySignalToRisk } from '../intel/strategyRiskAdapterV2';
import type { RiskEvaluationResult } from '../lib/riskStateMachine';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import { buildSignalLifecycleSnapshot } from '../intel/signalLifecycleSnapshotV2';
import { restoreStrategyShadowLifecycleFromDecisionFullJson } from '../intel/strategyShadowLifecycleRuntimeV2';

const CLOSE = 1_800_000_000_000;
const NOW = CLOSE + 10_000;
const STEP: Record<StrategyTimeframe, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

function candles(timeframe: StrategyTimeframe): Candle[] {
  const step = STEP[timeframe];
  const first = CLOSE - step - 239 * step;
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

function frame(timeframe: StrategyTimeframe): CandleFrameInput {
  return {
    symbol: 'BTC',
    timeframe,
    source: 'gmx-official-api',
    fetchedAtMs: NOW,
    candles: candles(timeframe),
  };
}

function run(frames = {
  '15m': frame('15m'),
  '1h': frame('1h'),
  '4h': frame('4h'),
}) {
  return runStrategyShadowSymbol({
    symbol: 'BTC',
    evaluatedAt: NOW,
    frames,
    expectedCostsBps: 10,
    previousRegime: null,
    lifecycleRecords: [],
    historyEvents: [],
    existingAi: null,
  });
}

const allowingRisk: RiskEvaluationResult = {
  state: 'NORMAL',
  entryAllowed: true,
  blockReasons: [],
  actions: [],
  sizeFactor: 1,
  maxLeverage: 3,
  locks: {
    dailyLockReason: null,
    dailyLockState: null,
    weeklyLockReason: null,
    hardStopReason: null,
    unresolvedReason: null,
    protectedProfitFloorUsd: null,
    profitReductionDone: false,
    defensiveActive: false,
    defensiveEntriesUsed: 0,
  },
};

describe('completed Candle Signal → v2 Regime/Ensemble SHADOW binding', () => {
  it('binds the same fixture and produces a deterministic replay fingerprint', () => {
    const first = run();
    const replay = run();
    expect(first.status).toBe('EVALUATED');
    expect(first.candleSignalEvidence).toEqual(replay.candleSignalEvidence);
    expect(first.candleSignalEvidence).toMatchObject({
      mode: 'SHADOW_ONLY',
      symbol: 'BTC',
      evaluatedAt: NOW,
      sourceCandleCloseTime: CLOSE,
      authority: 'EVIDENCE_ONLY',
      executionAuthorized: false,
      approvalCreationAllowed: false,
      sizingAllowed: false,
      orderCreationAllowed: false,
      relayAllowed: false,
      paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
    });
    expect(first.candleSignalEvidence!.v2Regime.configVersion).toBe('regime-engine/v2');
    expect(first.candleSignalEvidence!.replayFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('excludes an open/future candle and cannot look ahead', () => {
    const baseline = run();
    const frames = { '15m': frame('15m'), '1h': frame('1h'), '4h': frame('4h') };
    frames['15m'].candles = [...frames['15m'].candles!, {
      t: CLOSE,
      o: 1,
      h: 1_000_000,
      l: 0.01,
      c: 999_999,
      v: 1_000_000,
    }];
    const withOpenCandle = run(frames);
    expect(withOpenCandle.sourceCandleCloseTime).toBe(CLOSE);
    expect(withOpenCandle.candleSignal!.dataQuality.excludedOpenCandles['15m']).toBe(1);
    expect(withOpenCandle.candleSignal!.frameFeatures)
      .toEqual(baseline.candleSignal!.frameFeatures);
    expect(withOpenCandle.regime).toEqual(baseline.regime);
    expect(withOpenCandle.record!.action).toBe(baseline.record!.action);
  });

  it('fails closed for stale frames and tampered source/timestamp fingerprints', () => {
    const stale = { '15m': frame('15m'), '1h': frame('1h'), '4h': frame('4h') };
    stale['1h'].candles = stale['1h'].candles!.slice(0, -1);
    expect(run(stale)).toMatchObject({
      status: 'NOT_EVALUATED',
      record: null,
      executionAuthorized: false,
    });

    const result = run();
    const record = result.record!;
    const evidence = result.candleSignalEvidence!;
    const tampered = { ...evidence, replayFingerprint: '0'.repeat(64) };
    expect(validateCandleStrategyShadowEvidence(tampered, record).join(' '))
      .toContain('fingerprint INVALID');
    const mutations = [
      { ...evidence, symbol: 'ETH' },
      { ...evidence, evaluatedAt: evidence.evaluatedAt + 1 },
      { ...evidence, sourceCandleCloseTime: evidence.sourceCandleCloseTime + 1 },
      { ...evidence, frameCloseTimesMs: { ...evidence.frameCloseTimesMs, '1h': evidence.frameCloseTimesMs['1h'] - 1 } },
      { ...evidence, reasons: ['tampered'] },
      { ...evidence, authority: 'ADVISORY_ONLY' as never },
      { ...evidence, executionAuthorized: true as never },
      { ...evidence, approvalCreationAllowed: true as never },
      { ...evidence, sizingAllowed: true as never },
      { ...evidence, orderCreationAllowed: true as never },
      { ...evidence, relayAllowed: true as never },
      { ...evidence, paperPositionMutationAllowed: true as never },
      { ...evidence, livePositionMutationAllowed: true as never },
    ];
    for (const mutation of mutations) {
      expect(validateCandleStrategyShadowEvidence(mutation, record)).not.toEqual([]);
    }
    expect(validateCandleStrategyShadowEvidence({}, record).join(' '))
      .toContain('malformed');
  });

  it('blocks tampered or duplicate evidence in the SHADOW envelope and restores its lifecycle snapshot', () => {
    const result = run();
    const snapshot = buildSignalLifecycleSnapshot([], [], NOW)!;
    const envelopeInput = {
      cycleNumber: 1,
      generatedAt: NOW,
      expectedSymbols: ['BTC'],
      records: [result.record!],
      lifecycleSnapshot: snapshot,
      existingAi: {
        decisionId: 'test-only-candle-shadow',
        action: 'NO_TRADE' as const,
        confidence: 0,
        primarySymbol: null,
        createdAt: new Date(NOW - 1).toISOString(),
      },
    };
    const envelope = buildStrategyShadowWorkerEnvelope(envelopeInput);
    expect(envelope.status).toBe('EVALUATED');
    expect(restoreStrategyShadowLifecycleFromDecisionFullJson(JSON.stringify({
      strategyEnsembleShadow: envelope,
    }), NOW).snapshot).toEqual(snapshot);
    expect(buildStrategyShadowWorkerEnvelope({
      ...envelopeInput,
      records: [{ ...result.record!, candleSignalEvidence: {
        ...result.candleSignalEvidence!,
        replayFingerprint: 'f'.repeat(64),
      } }],
    }).status).toBe('BLOCKED');
    expect(buildStrategyShadowWorkerEnvelope({
      ...envelopeInput,
      records: [result.record!, result.record!],
    }).status).toBe('BLOCKED');
    expect(buildStrategyShadowWorkerEnvelope({
      ...envelopeInput,
      records: [{
        ...result.record!,
        action: 'LONG',
        direction: 'LONG',
        candleSignalEvidence: undefined,
      }],
    }).status).toBe('BLOCKED');
  });

  it('Candle/Ensemble conflict vetoes an otherwise allowing test-only Risk/PAPER candidate', () => {
    const result = run();
    expect(result.candleSignal!.direction).toBe('LONG');
    const candidate = {
      ...result.record!,
      action: 'SHORT' as const,
      direction: 'SHORT' as const,
      strategyId: 'TREND_PULLBACK' as const,
      signalId: 'test-only-conflict',
      lifecycleEligible: true,
      entryPrice: 100,
      structuralStop: 102,
      expectedNetEdgeBps: 100,
      expectedNetRR: 2,
      candleSignalEvidence: undefined,
    };
    const conflict = buildCandleStrategyShadowEvidence({
      candleSignal: result.candleSignal!,
      v2Regime: result.regime!,
      shadowRecord: candidate,
    })!;
    const advisory = adaptStrategySignalToRisk({
      shadowRecord: { ...candidate, candleSignalEvidence: conflict },
      riskEvaluation: allowingRisk,
    });
    expect(conflict.disposition).toBe('DIRECTION_CONFLICT');
    expect(advisory).toMatchObject({
      action: 'REJECT',
      sizeFactor: 0,
      maxLeverage: 0,
      executionAuthorized: false,
      paperPositionMutationAllowed: false,
    });
  });
});