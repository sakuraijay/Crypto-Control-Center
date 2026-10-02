import { describe, expect, it } from 'vitest';
import type { RiskEvaluationResult } from '../lib/riskStateMachine';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import {
  adaptStrategySignalToRisk,
  STRATEGY_RISK_ADAPTER_VERSION,
} from '../intel/strategyRiskAdapterV2';
import { buildCandleStrategyShadowEvidence } from '../intel/candleStrategyShadowEvidenceV2';
import type { CandleSignalToRisk } from '../intel/candleSignalContract';

const CLOSE = 1_800_000;

const record = (overrides: Partial<StrategyShadowRecord> = {}): StrategyShadowRecord => {
  const base: StrategyShadowRecord = {
  schemaVersion: 'strategy-shadow-adapter/v1',
  shadowRecordId: `BTC:STRATEGY_SHADOW:TREND_UP:${CLOSE}`,
  mode: 'SHADOW_ONLY', symbol: 'BTC', evaluatedAt: CLOSE + 1,
  sourceCandleCloseTime: CLOSE, regime: 'TREND_UP', action: 'LONG',
  comparison: 'ENSEMBLE_ONLY', strategyId: 'TREND_PULLBACK', signalId: 'signal-1',
  direction: 'LONG', confidence: 80, selectedScore: 75, entryPrice: 100,
  structuralStop: 98, expectedNetEdgeBps: 120, expectedNetRR: 2,
  lifecycleEligible: true, existingAi: null, reasons: [], warnings: [],
  executionAuthorized: false, paperPositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED', ...overrides,
  };
  const candleDirection = base.action === 'LONG' || base.action === 'SHORT' ? base.action : 'NO_TRADE';
  const candleSignal = {
    schemaVersion: 'candle-signal/v1',
    symbol: base.symbol,
    evaluatedAtMs: base.evaluatedAt,
    direction: candleDirection,
    dataQuality: {
      status: 'GOOD',
      frameCloseTimesMs: { '15m': base.sourceCandleCloseTime, '1h': CLOSE - 1, '4h': CLOSE - 2 },
    },
  } as CandleSignalToRisk;
  const v2Regime = {
    configVersion: 'regime-engine/v2',
    symbol: base.symbol,
    calculatedAt: base.sourceCandleCloseTime,
  } as never;
  const bound = {
    ...base,
    candleSignalEvidence: buildCandleStrategyShadowEvidence({
      candleSignal, v2Regime, shadowRecord: base,
    })!,
  };
  return Object.prototype.hasOwnProperty.call(overrides, 'candleSignalEvidence')
    ? { ...bound, candleSignalEvidence: overrides.candleSignalEvidence }
    : bound;
};

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

describe('Strategy Signal → authoritative Risk advisory adapter', () => {
  it('Risk Engine 정상 허용을 ALLOW로 표시하지만 모든 실행 권한은 false다', () => {
    const result = adaptStrategySignalToRisk({ shadowRecord: record(), riskEvaluation: risk() });
    expect(result).toMatchObject({
      schemaVersion: STRATEGY_RISK_ADAPTER_VERSION,
      action: 'ALLOW', direction: 'LONG', sizeFactor: 1, maxLeverage: 3,
      authority: 'ADVISORY_ONLY', executionAuthorized: false,
      approvalCreationAllowed: false, paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
    });
  });

  it('Risk Engine의 0과 1 사이 sizeFactor는 위험 확대 없이 REDUCE한다', () => {
    const result = adaptStrategySignalToRisk({
      shadowRecord: record({ action: 'SHORT', direction: 'SHORT' }),
      riskEvaluation: risk({ state: 'DEFENSIVE', sizeFactor: 0.5, maxLeverage: 2 }),
    });
    expect(result).toMatchObject({
      action: 'REDUCE', direction: 'SHORT', sizeFactor: 0.5, maxLeverage: 2,
      riskState: 'DEFENSIVE', executionAuthorized: false,
    });
  });

  it('Risk 평가가 없거나 veto이면 항상 REJECT한다', () => {
    expect(adaptStrategySignalToRisk({ shadowRecord: record(), riskEvaluation: null }).action)
      .toBe('REJECT');
    const veto = adaptStrategySignalToRisk({
      shadowRecord: record(),
      riskEvaluation: risk({ entryAllowed: false, blockReasons: ['cost cap'] }),
    });
    expect(veto.action).toBe('REJECT');
    expect(veto.reasons).toContain('cost cap');
  });

  it('CLOSE/CANCEL/REDUCE 강제 조치가 있으면 신규 진입을 REJECT한다', () => {
    const result = adaptStrategySignalToRisk({
      shadowRecord: record(),
      riskEvaluation: risk({ actions: ['CLOSE_ALL_POSITIONS'] }),
    });
    expect(result.action).toBe('REJECT');
    expect(result.sizeFactor).toBe(0);
  });

  it('NO_TRADE·cooldown·권한 변조 SHADOW record를 fail-closed REJECT한다', () => {
    expect(adaptStrategySignalToRisk({
      shadowRecord: record({ action: 'NO_TRADE', direction: 'NONE' }), riskEvaluation: risk(),
    }).action).toBe('REJECT');
    expect(adaptStrategySignalToRisk({
      shadowRecord: record({ lifecycleEligible: false }), riskEvaluation: risk(),
    }).action).toBe('REJECT');
    expect(adaptStrategySignalToRisk({
      shadowRecord: record({ executionAuthorized: true as false }), riskEvaluation: risk(),
    }).action).toBe('REJECT');
  });

  it('executable candidate without Candle evidence is fail-closed, while NO_TRADE remains backward-compatible', () => {
    expect(adaptStrategySignalToRisk({
      shadowRecord: record({ candleSignalEvidence: undefined }), riskEvaluation: risk(),
    }).action).toBe('REJECT');
    expect(adaptStrategySignalToRisk({
      shadowRecord: record({ action: 'NO_TRADE', direction: 'NONE', candleSignalEvidence: undefined }),
      riskEvaluation: risk(),
    }).action).toBe('REJECT');
  });

  it('Structural Stop·Net Edge·R:R가 없으면 실행 후보로 채택하지 않는다', () => {
    for (const unsafe of [
      record({ structuralStop: null }),
      record({ expectedNetEdgeBps: 0 }),
      record({ expectedNetRR: null }),
    ]) {
      expect(adaptStrategySignalToRisk({ shadowRecord: unsafe, riskEvaluation: risk() }).action)
        .toBe('REJECT');
    }
  });

  it('Risk sizeFactor가 1보다 크면 위험 확대 시도로 보고 REJECT한다', () => {
    const result = adaptStrategySignalToRisk({
      shadowRecord: record(), riskEvaluation: risk({ sizeFactor: 1.01 }),
    });
    expect(result).toMatchObject({ action: 'REJECT', schemaVersion: 'INVALID', sizeFactor: 0 });
  });

  it('authoritative 3x 상한을 넘는 Risk 결과와 알 수 없는 상태를 거부한다', () => {
    for (const unsafeRisk of [
      risk({ maxLeverage: 3.01 }),
      risk({ state: 'UNKNOWN' as RiskEvaluationResult['state'] }),
    ]) {
      expect(adaptStrategySignalToRisk({ shadowRecord: record(), riskEvaluation: unsafeRisk }))
        .toMatchObject({ action: 'REJECT', schemaVersion: 'INVALID', maxLeverage: 0 });
    }
  });

  it('입력 객체를 변경하지 않고 동일 입력에 결정론적 결과를 반환한다', () => {
    const shadow = record();
    const evaluation = risk({ sizeFactor: 0.5 });
    const before = JSON.stringify({ shadow, evaluation });
    expect(adaptStrategySignalToRisk({ shadowRecord: shadow, riskEvaluation: evaluation }))
      .toEqual(adaptStrategySignalToRisk({ shadowRecord: shadow, riskEvaluation: evaluation }));
    expect(JSON.stringify({ shadow, evaluation })).toBe(before);
  });
});
