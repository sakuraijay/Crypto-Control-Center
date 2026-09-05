import { describe, expect, it } from 'vitest';
import { buildSignalLifecycleSnapshot } from '../intel/signalLifecycleSnapshotV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import {
  advanceStrategyShadowLifecycleSnapshot,
  restoreStrategyShadowLifecycleFromDecisionFullJson,
} from '../intel/strategyShadowLifecycleRuntimeV2';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import { buildCandleStrategyShadowEvidence } from '../intel/candleStrategyShadowEvidenceV2';
import type { CandleSignalToRisk } from '../intel/candleSignalContract';
import { buildTestNetEdgeResearch } from './helpers/strategyNetEdgeResearchFixture';

const NOW = 1_800_000_000_000;
const CLOSE = NOW - 15 * 60_000;
const empty = () => buildSignalLifecycleSnapshot([], [], NOW - 1)!;
const record = (overrides: Partial<StrategyShadowRecord> = {}): StrategyShadowRecord => {
  const base: StrategyShadowRecord = {
  schemaVersion: 'strategy-shadow-adapter/v1',
  shadowRecordId: `BTC:STRATEGY_SHADOW:TREND_UP:${CLOSE}`,
  mode: 'SHADOW_ONLY', symbol: 'BTC', evaluatedAt: NOW - 1,
  sourceCandleCloseTime: CLOSE, regime: 'TREND_UP', action: 'LONG',
  comparison: 'ENSEMBLE_ONLY', strategyId: 'TREND_PULLBACK',
  signalId: `BTC:TREND_PULLBACK:LONG:15m:${CLOSE}`, direction: 'LONG',
  confidence: 80, selectedScore: 80, entryPrice: 100, structuralStop: 98,
  expectedNetEdgeBps: 200, expectedNetRR: 2, lifecycleEligible: true,
  existingAi: null, reasons: [], warnings: [], executionAuthorized: false,
    paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED', ...overrides,
  };
  if (base.action !== 'LONG' && base.action !== 'SHORT') return { ...base, netEdgeResearch: null };
  const withNetEdge: StrategyShadowRecord = {
    ...base,
    netEdgeResearch: buildTestNetEdgeResearch(base),
  };
  const candle = {
    schemaVersion: 'candle-signal/v1', symbol: base.symbol, evaluatedAtMs: base.evaluatedAt,
    direction: base.action, dataQuality: {
      status: 'GOOD',
      frameCloseTimesMs: { '15m': base.sourceCandleCloseTime, '1h': CLOSE - 1, '4h': CLOSE - 2 },
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
const envelope = (records: StrategyShadowRecord[], snapshot = empty()) =>
  buildStrategyShadowWorkerEnvelope({
    cycleNumber: 10, generatedAt: NOW, expectedSymbols: ['BTC'], records,
    lifecycleSnapshot: snapshot,
    existingAi: { decisionId: 'decision-10', action: 'NO_TRADE', confidence: 0,
      primarySymbol: 'BTC', createdAt: new Date(NOW - 1).toISOString() },
    notEvaluatedReason: records.length === 0 ? '테스트 미평가' : undefined,
  });

describe('Strategy SHADOW lifecycle runtime persistence v2', () => {
  it('snapshot 필드가 없는 legacy decision은 빈 기준선으로 안전하게 승격한다', () => {
    const restored = restoreStrategyShadowLifecycleFromDecisionFullJson(
      JSON.stringify({ strategyEnsembleShadow: { schemaVersion: 'strategy-shadow-worker-envelope/v1' } }), NOW);
    expect(restored.status).toBe('EMPTY_LEGACY');
    expect(restored.snapshot?.records).toEqual([]);
  });

  it('기존 fullJson의 canonical snapshot을 재시작 상태로 복원한다', () => {
    const previous = empty();
    const restored = restoreStrategyShadowLifecycleFromDecisionFullJson(JSON.stringify({
      strategyEnsembleShadow: { lifecycleSnapshot: previous },
    }), NOW);
    expect(restored.status).toBe('RESTORED');
    expect(restored.snapshot).toEqual(previous);
  });

  it('필드가 존재한 뒤 null·손상 snapshot은 빈 상태로 우회하지 않고 BLOCKED한다', () => {
    for (const lifecycleSnapshot of [null, { schemaVersion: 'future' }]) {
      const restored = restoreStrategyShadowLifecycleFromDecisionFullJson({
        strategyEnsembleShadow: { lifecycleSnapshot },
      }, NOW);
      expect(restored.status).toBe('BLOCKED');
      expect(restored.snapshot).toBeNull();
    }
  });

  it('lifecycle-eligible SHADOW 후보만 GENERATED record로 durable snapshot에 추가한다', () => {
    const advanced = advanceStrategyShadowLifecycleSnapshot(empty(), envelope([record()]), NOW);
    expect(advanced?.records).toHaveLength(1);
    expect(advanced?.records[0]).toMatchObject({
      signalId: `BTC:TREND_PULLBACK:LONG:15m:${CLOSE}`,
      status: 'GENERATED', direction: 'LONG', strategyId: 'TREND_PULLBACK',
    });
  });

  it('NO_TRADE 또는 lifecycle 차단 record는 처리 완료 Signal로 만들지 않는다', () => {
    const blocked = record({ action: 'NO_TRADE', direction: 'NONE', lifecycleEligible: false });
    const advanced = advanceStrategyShadowLifecycleSnapshot(empty(), envelope([blocked]), NOW);
    expect(advanced?.records).toEqual([]);
  });

  it('동일 Signal/완료봉을 다시 추가하려는 ambiguous advance는 fail-closed한다', () => {
    const first = advanceStrategyShadowLifecycleSnapshot(empty(), envelope([record()]), NOW)!;
    expect(advanceStrategyShadowLifecycleSnapshot(first, envelope([record()], first), NOW + 1)).toBeNull();
  });

  it('unsafe authority literal을 가진 envelope는 snapshot을 전진시키지 않는다', () => {
    const unsafe = { ...envelope([record()]), executionAuthorized: true } as never;
    expect(advanceStrategyShadowLifecycleSnapshot(empty(), unsafe, NOW)).toBeNull();
  });

  it('decision 자체가 손상 JSON이면 legacy empty로 우회하지 않는다', () => {
    const restored = restoreStrategyShadowLifecycleFromDecisionFullJson('{broken', NOW);
    expect(restored.status).toBe('BLOCKED');
    expect(restored.snapshot).toBeNull();
  });
});
