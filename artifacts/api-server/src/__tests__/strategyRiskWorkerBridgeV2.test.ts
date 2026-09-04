import { describe, expect, it } from 'vitest';
import type { RiskEvaluationResult } from '../lib/riskStateMachine';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import {
  buildStrategyRiskWorkerAdvisory,
  STRATEGY_RISK_WORKER_BRIDGE_VERSION,
} from '../intel/strategyRiskWorkerBridgeV2';
import { buildCandleStrategyShadowEvidence } from '../intel/candleStrategyShadowEvidenceV2';
import type { CandleSignalToRisk } from '../intel/candleSignalContract';

const NOW = 1_900_000;
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
  const candle = {
    schemaVersion: 'candle-signal/v1', symbol: base.symbol, evaluatedAtMs: base.evaluatedAt,
    direction: base.action, dataQuality: {
      status: 'GOOD',
      frameCloseTimesMs: { '15m': base.sourceCandleCloseTime, '1h': NOW - 2, '4h': NOW - 3 },
    },
  } as CandleSignalToRisk;
  return {
    ...base,
    candleSignalEvidence: buildCandleStrategyShadowEvidence({
      candleSignal: candle,
      v2Regime: { configVersion: 'regime-engine/v2', symbol: base.symbol, calculatedAt: base.sourceCandleCloseTime } as never,
      shadowRecord: base,
    })!,
  };
};
const envelope = (records: StrategyShadowRecord[] = [record()]) =>
  buildStrategyShadowWorkerEnvelope({
    cycleNumber: 7, generatedAt: NOW, expectedSymbols: ['BTC'], records,
    existingAi: {
      decisionId: 'decision-7', action: 'NO_TRADE', confidence: 0,
      primarySymbol: null, createdAt: new Date(NOW).toISOString(),
    },
    notEvaluatedReason: records.length === 0 ? 'read 없음' : undefined,
  });
const risk = (overrides: Partial<RiskEvaluationResult> = {}): RiskEvaluationResult => ({
  state: 'NORMAL', entryAllowed: true, blockReasons: [], actions: [],
  sizeFactor: 1, maxLeverage: 3,
  locks: {
    dailyLockReason: null, dailyLockState: null, weeklyLockReason: null,
    hardStopReason: null, unresolvedReason: null, protectedProfitFloorUsd: null,
    profitReductionDone: false, defensiveActive: false, defensiveEntriesUsed: 0,
  },
  ...overrides,
});

describe('Strategy Risk Worker read-only advisory bridge', () => {
  it('eligible SHADOW record를 ALLOW로 투영하되 모든 mutation 권한은 false다', () => {
    const value = buildStrategyRiskWorkerAdvisory({ shadowEnvelope: envelope(), riskEvaluation: risk() });
    expect(value).toMatchObject({
      schemaVersion: STRATEGY_RISK_WORKER_BRIDGE_VERSION, status: 'EVALUATED',
      summary: { allow: 1, reduce: 0, reject: 0 }, authority: 'ADVISORY_ONLY',
      executionAuthorized: false, approvalCreationAllowed: false,
      paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
    });
  });

  it('Defensive sizeFactor는 REDUCE로만 투영한다', () => {
    const value = buildStrategyRiskWorkerAdvisory({
      shadowEnvelope: envelope(),
      riskEvaluation: risk({ state: 'DEFENSIVE', sizeFactor: 0.5, maxLeverage: 2 }),
    });
    expect(value.summary).toEqual({ allow: 0, reduce: 1, reject: 0 });
    expect(value.decisions[0]).toMatchObject({ action: 'REDUCE', sizeFactor: 0.5, maxLeverage: 2 });
  });

  it('Risk veto와 HARD_STOP은 REJECT로 보존한다', () => {
    const value = buildStrategyRiskWorkerAdvisory({
      shadowEnvelope: envelope(),
      riskEvaluation: risk({ state: 'HARD_STOPPED', entryAllowed: false, blockReasons: ['HWM hard stop'] }),
    });
    expect(value.summary).toEqual({ allow: 0, reduce: 0, reject: 1 });
    expect(value.decisions[0].reasons).toContain('HWM hard stop');
  });

  it('Risk 평가나 SHADOW record가 없으면 NOT_EVALUATED를 유지한다', () => {
    expect(buildStrategyRiskWorkerAdvisory({
      shadowEnvelope: envelope(), riskEvaluation: null,
    })).toMatchObject({ status: 'NOT_EVALUATED', summary: { reject: 1 } });
    expect(buildStrategyRiskWorkerAdvisory({
      shadowEnvelope: envelope([]), riskEvaluation: risk(),
    })).toMatchObject({ status: 'NOT_EVALUATED', decisions: [] });
  });

  it('권한 변조 envelope를 부분 채택하지 않고 BLOCKED 처리한다', () => {
    const unsafe = { ...envelope(), executionAuthorized: true } as unknown as ReturnType<typeof envelope>;
    const value = buildStrategyRiskWorkerAdvisory({ shadowEnvelope: unsafe, riskEvaluation: risk() });
    expect(value).toMatchObject({ schemaVersion: 'INVALID', status: 'BLOCKED', decisions: [] });
  });

  it('입력을 변경하지 않고 결정론적 결과를 반환한다', () => {
    const shadowEnvelope = envelope();
    const riskEvaluation = risk({ sizeFactor: 0.5 });
    const before = JSON.stringify({ shadowEnvelope, riskEvaluation });
    expect(buildStrategyRiskWorkerAdvisory({ shadowEnvelope, riskEvaluation }))
      .toEqual(buildStrategyRiskWorkerAdvisory({ shadowEnvelope, riskEvaluation }));
    expect(JSON.stringify({ shadowEnvelope, riskEvaluation })).toBe(before);
  });
});
