import { describe, expect, it } from 'vitest';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import {
  buildStrategyShadowWorkerEnvelope,
  STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION,
  type StrategyShadowWorkerEnvelopeInput,
} from '../intel/strategyShadowWorkerEnvelopeV2';
import { buildCandleStrategyShadowEvidence } from '../intel/candleStrategyShadowEvidenceV2';
import type { CandleSignalToRisk } from '../intel/candleSignalContract';
import {
  STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
  STRATEGY_NET_EDGE_RESEARCH_VERSION,
  type StrategyNetEdgeResearchResult,
} from '../intel/strategyNetEdgeResearchGateV1';

const NOW = 1_800_000_000_000;

const netEdge = (base: StrategyShadowRecord): StrategyNetEdgeResearchResult => {
  const observedAtMs = base.evaluatedAt - 1_000;
  const quote = (direction: 'LONG' | 'SHORT') => ({
    direction,
    market: '0x1111111111111111111111111111111111111111',
    orderType: 'MarketIncrease' as const,
    notionalUsd: 1_000,
    holdingHorizonHours: 12,
    source: 'PAPER_GMX_ESTIMATE' as const,
    blockNumber: null,
    observedAtMs,
    fetchedAtMs: observedAtMs,
    expiresAtMs: observedAtMs + 60_000,
    fundingRatePerHourFraction: 0.3 / 1_000 / 12,
    borrowingRatePerHourFraction: 0.2 / 1_000 / 12,
    positionFee: { usd: 0.5, bps: 5 },
    exitFee: { usd: 0.5, bps: 5 },
    funding: { usd: 0.3, bps: 3 },
    borrowing: { usd: 0.2, bps: 2 },
    priceImpact: { usd: 0.4, bps: 4 },
    network: { usd: 0.1, bps: 1 },
    totalRoundTripCost: { usd: 2, bps: 20 },
  });
  return {
    schemaVersion: STRATEGY_NET_EDGE_RESEARCH_VERSION,
    signalId: base.signalId,
    symbol: base.symbol,
    strategyId: 'TREND_PULLBACK',
    signalConfidence: 80,
    signalDataQuality: 'GOOD',
    sourceTimeframes: ['4h', '1h', '15m'],
    riskBps: 100,
    researchOnly: true,
    researchLabel: 'PAPER_SHADOW_RESEARCH',
    eligible: true,
    policy: {
      strategyId: 'TREND_PULLBACK',
      researchPriority: 1,
      minimumConfidence: 75,
      minimumHoldingHorizonHours: 8,
      turnoverPenaltyBps: 5,
      minimumNetEdgeBps: 25,
      minimumNetEdgeToCostRatio: 1.5,
      minimumExpectedNetRR: 1.5,
    },
    expectedGrossEdge: { usd: 22, bps: 220 },
    expectedRoundTripCost: { usd: 2, bps: 20 },
    turnoverPenalty: { usd: 0.5, bps: 5 },
    expectedNetEdge: { usd: 19.5, bps: 195 },
    breakEvenMoveBps: 25,
    breakEvenMovePct: 0.25,
    minimumRequiredPriceMoveBps: 55,
    minimumRequiredPriceMovePct: 0.55,
    grossEdgeToCostRatio: 11,
    netEdgeToCostRatio: 9.75,
    expectedNetRR: 1.95,
    minimumExpectedNetRR: 1.5,
    holdingHorizonHours: 12,
    cooldownSatisfied: true,
    cooldownCodes: ['ELIGIBLE'],
    costEvidence: {
      schemaVersion: STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
      market: '0x1111111111111111111111111111111111111111',
      notionalUsd: 1_000,
      holdingHorizonHours: 12,
      observedAtMs,
      bidirectionalValidated: true,
      holdingCostsDerivedFromRates: true,
      holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT',
      conservativeBasisDirection: 'LONG',
      directionalQuotes: { LONG: quote('LONG'), SHORT: quote('SHORT') },
    },
    reasons: ['eligible'],
    warnings: [],
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    capitalSizingUsed: false,
    plannedSeedUsed: false,
    strategySignalEconomicsPreserved: true,
    turnoverAdjustedResearchEconomics: true,
    riskAuthority: 'NOT_EVALUATED',
  };
};

const record = (overrides: Partial<StrategyShadowRecord> = {}): StrategyShadowRecord => {
  const base: StrategyShadowRecord = {
  schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: 'BTC:STRATEGY_SHADOW:TREND_UP:1',
  mode: 'SHADOW_ONLY', symbol: 'BTC', evaluatedAt: NOW - 1, sourceCandleCloseTime: NOW - 2,
  regime: 'TREND_UP', action: 'LONG', comparison: 'ENSEMBLE_ONLY', strategyId: 'TREND_PULLBACK',
  signalId: 'BTC:signal', direction: 'LONG', confidence: 80, selectedScore: 82,
  entryPrice: 100, structuralStop: 97, expectedNetEdgeBps: 200, expectedNetRR: 2,
  lifecycleEligible: true, existingAi: null, reasons: [], warnings: [], executionAuthorized: false,
    paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED', ...overrides,
  };
  if (base.action !== 'LONG' && base.action !== 'SHORT') return { ...base, netEdgeResearch: null };
  const withNetEdge: StrategyShadowRecord = { ...base, netEdgeResearch: netEdge(base) };
  const candle = {
    schemaVersion: 'candle-signal/v1', symbol: base.symbol, evaluatedAtMs: base.evaluatedAt,
    direction: base.action, dataQuality: {
      status: 'GOOD',
      frameCloseTimesMs: { '15m': base.sourceCandleCloseTime, '1h': NOW - 3, '4h': NOW - 4 },
    },
  } as CandleSignalToRisk;
  return {
    ...withNetEdge,
    candleSignalEvidence: buildCandleStrategyShadowEvidence({
      candleSignal: candle,
      v2Regime: {
        configVersion: 'regime-engine/v2', symbol: base.symbol, calculatedAt: base.sourceCandleCloseTime,
      } as never,
      shadowRecord: withNetEdge,
    })!,
  };
};

const input = (overrides: Partial<StrategyShadowWorkerEnvelopeInput> = {}): StrategyShadowWorkerEnvelopeInput => ({
  cycleNumber: 41, generatedAt: NOW, expectedSymbols: ['BTC', 'ETH'], records: [],
  existingAi: { decisionId: 'worker-41', action: 'NO_TRADE', confidence: 0,
    primarySymbol: null, createdAt: new Date(NOW - 1).toISOString() },
  notEvaluatedReason: 'MTF Ensemble runner evidence 미연결', ...overrides,
});

describe('Strategy Shadow worker envelope v2', () => {
  it('record 0건은 가짜 신호 대신 명시적 NOT_EVALUATED를 기록한다', () => {
    const result = buildStrategyShadowWorkerEnvelope(input());
    expect(result).toMatchObject({ schemaVersion: STRATEGY_SHADOW_WORKER_ENVELOPE_VERSION,
      status: 'NOT_EVALUATED', mode: 'SHADOW_ONLY', records: [], missingSymbols: ['BTC', 'ETH'] });
    expect(result.reasons.join(' ')).toContain('가짜 Ensemble 신호');
  });

  it('모든 mutation·approval·execution 권한은 literal false다', () => {
    expect(buildStrategyShadowWorkerEnvelope(input())).toMatchObject({
      executionAuthorized: false, approvalCreationAllowed: false,
      paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
      riskAuthority: 'NOT_EVALUATED',
    });
  });

  it('0건인데 사유가 없으면 BLOCKED한다', () => {
    expect(buildStrategyShadowWorkerEnvelope(input({ notEvaluatedReason: ' ' })).status).toBe('BLOCKED');
  });

  it('일부 종목 record만 있으면 PARTIAL과 missingSymbols를 보존한다', () => {
    const result = buildStrategyShadowWorkerEnvelope(input({ records: [record()] }));
    expect(result).toMatchObject({ status: 'PARTIAL', evaluatedSymbols: ['BTC'], missingSymbols: ['ETH'] });
  });

  it('모든 기대 종목 record가 있으면 EVALUATED한다', () => {
    const eth = record({ shadowRecordId: 'ETH:STRATEGY_SHADOW:RANGE:1', symbol: 'ETH',
      regime: 'RANGE', action: 'NO_TRADE', direction: 'NONE' });
    const result = buildStrategyShadowWorkerEnvelope(input({ records: [record(), eth] }));
    expect(result.status).toBe('EVALUATED');
    expect(result.summary).toMatchObject({ long: 1, noTrade: 1 });
  });

  it('방향 충돌을 summary에 계수한다', () => {
    const result = buildStrategyShadowWorkerEnvelope(input({
      expectedSymbols: ['BTC'], records: [record({ comparison: 'DIRECTION_CONFLICT' })],
    }));
    expect(result.summary.directionConflicts).toBe(1);
  });

  it('중복 record ID는 전체 record 채택을 차단한다', () => {
    const result = buildStrategyShadowWorkerEnvelope(input({ records: [record(), record()] }));
    expect(result).toMatchObject({ status: 'BLOCKED', records: [] });
  });

  it('record ID가 달라도 정규화 symbol 중복은 전체 record 채택을 차단한다', () => {
    const duplicateSymbol = record({
      shadowRecordId: 'btc:STRATEGY_SHADOW:RANGE:2',
      symbol: ' btc ',
      action: 'NO_TRADE',
      direction: 'NONE',
    });
    expect(buildStrategyShadowWorkerEnvelope(input({
      expectedSymbols: ['BTC'],
      records: [record({ action: 'NO_TRADE', direction: 'NONE' }), duplicateSymbol],
    })).status).toBe('BLOCKED');
  });

  it('unsafe record 경계를 BLOCKED한다', () => {
    const unsafe = { ...record(), executionAuthorized: true } as unknown as StrategyShadowRecord;
    expect(buildStrategyShadowWorkerEnvelope(input({ records: [unsafe] })).status).toBe('BLOCKED');
  });

  it('actionable record에서 Net-Edge evidence 필드를 삭제하면 BLOCKED한다', () => {
    const missing = { ...record() };
    delete missing.netEdgeResearch;
    expect(buildStrategyShadowWorkerEnvelope(input({
      expectedSymbols: ['BTC'],
      records: [missing],
    })).status).toBe('BLOCKED');
  });

  it('기대하지 않은 종목 record를 BLOCKED한다', () => {
    expect(buildStrategyShadowWorkerEnvelope(input({ records: [record({ symbol: 'SOL' })] })).status).toBe('BLOCKED');
  });

  it('cycle·시각·confidence 입력을 strict 검증한다', () => {
    expect(buildStrategyShadowWorkerEnvelope(input({ cycleNumber: 0 })).schemaVersion).toBe('INVALID');
    expect(buildStrategyShadowWorkerEnvelope(input({ generatedAt: 0 })).status).toBe('BLOCKED');
    expect(buildStrategyShadowWorkerEnvelope(input({ existingAi: {
      ...input().existingAi, confidence: 101,
    } })).status).toBe('BLOCKED');
  });

  it('기존 AI primary symbol은 기대 종목에 포함되어야 한다', () => {
    const result = buildStrategyShadowWorkerEnvelope(input({ existingAi: {
      ...input().existingAi, primarySymbol: 'SOL',
    } }));
    expect(result.status).toBe('BLOCKED');
  });

  it('legacy fixture의 undefined primary symbol도 throw 없이 BLOCKED한다', () => {
    const malformed = { ...input().existingAi, primarySymbol: undefined } as unknown as StrategyShadowWorkerEnvelopeInput['existingAi'];
    expect(() => buildStrategyShadowWorkerEnvelope(input({ existingAi: malformed }))).not.toThrow();
    expect(buildStrategyShadowWorkerEnvelope(input({ existingAi: malformed })).status).toBe('BLOCKED');
  });

  it('envelope ID는 기존 worker decision ID에 결정론적으로 결속된다', () => {
    expect(buildStrategyShadowWorkerEnvelope(input()).envelopeId).toBe('worker-41:STRATEGY_SHADOW');
  });
});
