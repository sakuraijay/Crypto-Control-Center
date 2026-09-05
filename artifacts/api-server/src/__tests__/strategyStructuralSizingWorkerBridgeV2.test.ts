import { describe, expect, it } from 'vitest';
import type { AppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import type { RiskEvaluationResult } from '../lib/riskStateMachine';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import { buildStrategyRiskWorkerAdvisory } from '../intel/strategyRiskWorkerBridgeV2';
import { buildCandleStrategyShadowEvidence } from '../intel/candleStrategyShadowEvidenceV2';
import type { CandleSignalToRisk } from '../intel/candleSignalContract';
import { buildTestNetEdgeResearch } from './helpers/strategyNetEdgeResearchFixture';
import {
  buildStrategyStructuralSizingWorkerAdvisory,
  STRATEGY_STRUCTURAL_SIZING_WORKER_VERSION,
  type StrategyStructuralSizingWorkerInput,
  type StrategyStructuralSizingMarketContext,
} from '../intel/strategyStructuralSizingWorkerBridgeV2';

const NOW = 2_000_000;
const record = (overrides: Partial<StrategyShadowRecord> = {}): StrategyShadowRecord => {
  const base: StrategyShadowRecord = {
  schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: `BTC:SHADOW:${NOW}`,
  mode: 'SHADOW_ONLY', symbol: 'BTC', evaluatedAt: NOW, sourceCandleCloseTime: NOW - 1,
  regime: 'TREND_UP', action: 'LONG', comparison: 'ENSEMBLE_ONLY',
  strategyId: 'TREND_PULLBACK', signalId: 'signal-1', direction: 'LONG', confidence: 80,
  selectedScore: 75, entryPrice: 100, structuralStop: 98, expectedNetEdgeBps: 100,
  expectedNetRR: 2, lifecycleEligible: true, existingAi: null, reasons: [], warnings: [],
  executionAuthorized: false, paperPositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED', ...overrides,
  };
  const withNetEdge: StrategyShadowRecord = {
    ...base,
    netEdgeResearch: buildTestNetEdgeResearch(base),
  };
  const candle = {
    schemaVersion: 'candle-signal/v1', symbol: base.symbol, evaluatedAtMs: base.evaluatedAt,
    direction: base.action, dataQuality: {
      status: 'GOOD',
      frameCloseTimesMs: { '15m': base.sourceCandleCloseTime, '1h': NOW - 2, '4h': NOW - 3 },
    },
  } as CandleSignalToRisk;
  return {
    ...withNetEdge,
    candleSignalEvidence: buildCandleStrategyShadowEvidence({
      candleSignal: candle,
      v2Regime: { configVersion: 'regime-engine/v2', symbol: base.symbol, calculatedAt: base.sourceCandleCloseTime } as never,
      shadowRecord: withNetEdge,
    })!,
  };
};
const envelope = (records: StrategyShadowRecord[] = [record()]) =>
  buildStrategyShadowWorkerEnvelope({
    cycleNumber: 8, generatedAt: NOW, expectedSymbols: records.map(value => value.symbol), records,
    existingAi: {
      decisionId: 'decision-8', action: 'NO_TRADE', confidence: 0,
      primarySymbol: null, createdAt: new Date(NOW).toISOString(),
    },
    notEvaluatedReason: records.length === 0 ? 'record 없음' : undefined,
  });
const risk = (overrides: Partial<RiskEvaluationResult> = {}): RiskEvaluationResult => ({
  state: 'NORMAL', entryAllowed: true, blockReasons: [], actions: [],
  sizeFactor: 1, maxLeverage: 3,
  locks: {
    dailyLockReason: null, dailyLockState: null, weeklyLockReason: null,
    hardStopReason: null, unresolvedReason: null, protectedProfitFloorUsd: null,
    profitReductionDone: false, defensiveActive: false, defensiveEntriesUsed: 0,
  }, ...overrides,
});
const profile: AppliedRiskProfileSnapshot = {
  name: 'conservative', version: 'risk-profile/v1', appliedAt: '2026-08-23T11:00:00.000Z',
  derivedLimits: {
    immediateEntryThreshold: 80, maxRiskPerTradePct: 0.25, reserveCashPct: 20,
    maxMarginPerTradeUsd: 334, maxConcurrentPositions: 1, cooldownMinutes: 30,
    maxLeverage: 3, maxTotalExposureUsd: 3_000, allocatedTradingCapitalUsd: 1_000,
    maxRiskPerTradeUsd: 2.5,
  },
};
const context = (overrides: Partial<StrategyStructuralSizingMarketContext> = {}):
StrategyStructuralSizingMarketContext => ({
  source: 'VERIFIED_READ_ONLY', evidenceId: 'cost-liquidity-BTC-1', symbol: 'BTC',
  observedAt: NOW, fresh: true, roundTripFeesFraction: 0.002,
  adverseImpactBufferFraction: 0.001, fundingBorrowingBufferFraction: 0.001,
  liquidityCapUsd: 1_000, tierNotionalCapUsd: 500, ...overrides,
});
const input = (records: StrategyShadowRecord[] = [record()]): StrategyStructuralSizingWorkerInput => {
  const shadowEnvelope = envelope(records);
  return {
    shadowEnvelope,
    riskAdvisory: buildStrategyRiskWorkerAdvisory({ shadowEnvelope, riskEvaluation: risk() }),
    riskProfile: profile,
    marketContextBySymbol: { BTC: context() },
  };
};

describe('Strategy Structural sizing Worker read-only bridge', () => {
  it('검증된 market context만 sizing하고 모든 실행 권한을 false로 유지한다', () => {
    const value = buildStrategyStructuralSizingWorkerAdvisory(input());
    expect(value).toMatchObject({
      schemaVersion: STRATEGY_STRUCTURAL_SIZING_WORKER_VERSION,
      status: 'EVALUATED', summary: { sized: 1, rejected: 0, notEvaluated: 0 },
      authority: 'ADVISORY_ONLY', externalReadStarted: false,
      executionAuthorized: false, approvalCreationAllowed: false,
      paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
    });
    expect(value.sizings[0]).toMatchObject({
      status: 'SIZED', finalAdvisoryNotionalUsd: 104.16666666666667,
    });
  });

  it('fresh context가 없으면 외부 read 없이 0·NOT_EVALUATED를 보존한다', () => {
    const value = input();
    value.marketContextBySymbol = { BTC: null };
    const result = buildStrategyStructuralSizingWorkerAdvisory(value);
    expect(result).toMatchObject({
      status: 'NOT_EVALUATED', summary: { sized: 0, rejected: 0, notEvaluated: 1 },
      externalReadStarted: false,
    });
    expect(result.sizings[0]).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
  });

  it('Risk veto는 market context 없이도 평가된 REJECT로 보존한다', () => {
    const value = input();
    value.riskAdvisory = buildStrategyRiskWorkerAdvisory({
      shadowEnvelope: value.shadowEnvelope,
      riskEvaluation: risk({ state: 'HARD_STOPPED', entryAllowed: false, blockReasons: ['hard stop'] }),
    });
    value.marketContextBySymbol = { BTC: null };
    expect(buildStrategyStructuralSizingWorkerAdvisory(value)).toMatchObject({
      status: 'EVALUATED', summary: { sized: 0, rejected: 1, notEvaluated: 0 },
    });
  });

  it('부분 context만 있으면 PARTIAL이며 나머지 종목은 0이다', () => {
    const eth = record({
      shadowRecordId: `ETH:SHADOW:${NOW}`, symbol: 'ETH', signalId: 'signal-2',
      entryPrice: 200, structuralStop: 196,
    });
    const value = input([record(), eth]);
    value.marketContextBySymbol = { BTC: context() };
    expect(buildStrategyStructuralSizingWorkerAdvisory(value)).toMatchObject({
      status: 'PARTIAL', summary: { sized: 1, rejected: 0, notEvaluated: 1 },
    });
  });

  it('cycle 권한 또는 record/decision 결속 변조는 부분 채택 없이 BLOCKED한다', () => {
    const unsafeCycle = input();
    unsafeCycle.riskAdvisory = { ...unsafeCycle.riskAdvisory, cycleNumber: 9 };
    expect(buildStrategyStructuralSizingWorkerAdvisory(unsafeCycle)).toMatchObject({
      schemaVersion: 'INVALID', status: 'BLOCKED', sizings: [],
    });
    const unsafeDecision = input();
    unsafeDecision.riskAdvisory = {
      ...unsafeDecision.riskAdvisory,
      decisions: [{ ...unsafeDecision.riskAdvisory.decisions[0], signalId: 'other' }],
    };
    expect(buildStrategyStructuralSizingWorkerAdvisory(unsafeDecision)).toMatchObject({
      schemaVersion: 'INVALID', status: 'BLOCKED', sizings: [],
    });
  });

  it('record가 없으면 NOT_EVALUATED이며 입력을 변경하지 않는다', () => {
    expect(buildStrategyStructuralSizingWorkerAdvisory(input([]))).toMatchObject({
      status: 'NOT_EVALUATED', sizings: [],
    });
    const value = input();
    const before = JSON.stringify(value);
    expect(buildStrategyStructuralSizingWorkerAdvisory(value))
      .toEqual(buildStrategyStructuralSizingWorkerAdvisory(value));
    expect(JSON.stringify(value)).toBe(before);
  });
});
