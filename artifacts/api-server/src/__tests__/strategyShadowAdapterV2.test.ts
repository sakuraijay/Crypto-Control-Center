import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_LIFECYCLE_CONFIG, type SignalEligibilityDecision } from '../intel/signalLifecycleV2';
import { type StrategyArbiterDecision } from '../intel/strategyArbiterV2';
import {
  buildStrategyShadowRecord,
  DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS,
  STRATEGY_SHADOW_ADAPTER_VERSION,
  validateStrategyShadowFeatureFlags,
  type ExistingAiDecisionSnapshot,
  type StrategyShadowAdapterInput,
} from '../intel/strategyShadowAdapterV2';
import type { StrategySignal } from '../intel/strategySignalV2';

const CLOSE = 1_800_000_000_000;

const signal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  schemaVersion: 'strategy-signal/v2', signalId: `BTC:TREND_PULLBACK:LONG:15m:${CLOSE}`,
  strategyId: 'TREND_PULLBACK', symbol: 'BTC', regime: 'TREND_UP', direction: 'LONG',
  confidence: 82, entryZoneLow: 99, entryZoneHigh: 101, proposedEntryPrice: 100,
  structuralStop: 97, stopDistancePct: 3, invalidationPrice: 97,
  targets: [{ price: 106, expectedR: 2, allocationPct: 100 }], grossExpectedEdgeBps: 600,
  expectedCostsBps: 100, netExpectedEdgeBps: 500, expectedNetRR: 2,
  higherTimeframeTrend: 'UP', marketStructure: 'HH_HL', confirmationPattern: 'BULLISH_REJECTION',
  sourceTimeframes: ['15m', '1h'], sourceCandleCloseTime: CLOSE, dataQuality: 'GOOD',
  volumeConfirmation: null, reasons: [], warnings: [], ...overrides,
});

const arbiter = (overrides: Partial<StrategyArbiterDecision> = {}): StrategyArbiterDecision => ({
  configVersion: 'strategy-arbiter/v1', decisionId: `BTC:STRATEGY_ARBITER:TREND_UP:${CLOSE}`,
  symbol: 'BTC', regime: 'TREND_UP', sourceCandleCloseTime: CLOSE, action: 'SELECT',
  selectedSignal: signal(), selectedScore: 84, consideredSignalIds: [signal().signalId],
  rejectedCandidates: [], reasons: ['selected'], warnings: [], ...overrides,
});

const eligibility = (overrides: Partial<SignalEligibilityDecision> = {}): SignalEligibilityDecision => ({
  configVersion: DEFAULT_SIGNAL_LIFECYCLE_CONFIG.version, signalId: signal().signalId,
  eligible: true, codes: ['ELIGIBLE'], blockedUntilCandleCloseTime: null,
  strategyConsecutiveLosses: 0, symbolConsecutiveLosses: 0,
  reasons: ['cooldown 통과'], warnings: [], ...overrides,
});

const existing = (overrides: Partial<ExistingAiDecisionSnapshot> = {}): ExistingAiDecisionSnapshot => ({
  decisionId: 'existing-41', action: 'NO_TRADE', confidence: 0,
  reasons: ['existing AI no trade'], sourceCandleCloseTime: CLOSE, ...overrides,
});

const input = (overrides: Partial<StrategyShadowAdapterInput> = {}): StrategyShadowAdapterInput => ({
  symbol: 'BTC', evaluatedAt: CLOSE + 1, arbiter: arbiter(), eligibility: eligibility(),
  existingAi: existing(), ...overrides,
});

describe('Strategy Shadow Adapter v2', () => {
  it('기본 flag는 신규 Ensemble SHADOW만 허용하고 PAPER 실행은 금지한다', () => {
    expect(DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS).toMatchObject({
      shadowModeEnabled: true, paperExecutionEnabled: false,
      relativeStrengthEnabled: false, gmxContextFilterEnabled: false,
    });
    expect(validateStrategyShadowFeatureFlags(DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS)).toEqual([]);
  });

  it('LONG 후보를 execution 권한 없는 SHADOW record로 만든다', () => {
    const result = buildStrategyShadowRecord(input());
    expect(result).toMatchObject({ schemaVersion: STRATEGY_SHADOW_ADAPTER_VERSION, mode: 'SHADOW_ONLY',
      action: 'LONG', direction: 'LONG', comparison: 'ENSEMBLE_ONLY', strategyId: 'TREND_PULLBACK',
      executionAuthorized: false, paperPositionMutationAllowed: false, riskAuthority: 'NOT_EVALUATED' });
  });

  it('동일 방향의 기존 AI와 AGREE_DIRECTION으로 비교한다', () => {
    const result = buildStrategyShadowRecord(input({ existingAi: existing({ action: 'LONG', confidence: 75 }) }));
    expect(result.comparison).toBe('AGREE_DIRECTION');
  });

  it('반대 방향 기존 AI와 DIRECTION_CONFLICT로 비교한다', () => {
    const result = buildStrategyShadowRecord(input({ existingAi: existing({ action: 'SHORT' }) }));
    expect(result.comparison).toBe('DIRECTION_CONFLICT');
  });

  it('Arbiter NO_TRADE와 기존 NO_TRADE의 합의를 기록한다', () => {
    const result = buildStrategyShadowRecord(input({
      arbiter: arbiter({ action: 'NO_TRADE', selectedSignal: null, selectedScore: null, reasons: ['conflict'] }),
      eligibility: null,
    }));
    expect(result).toMatchObject({ action: 'NO_TRADE', direction: 'NONE', comparison: 'AGREE_NO_TRADE' });
  });

  it('Arbiter REJECT를 SHADOW에서도 fail-closed로 유지한다', () => {
    const result = buildStrategyShadowRecord(input({
      arbiter: arbiter({ action: 'REJECT', selectedSignal: null, selectedScore: null, reasons: ['invalid'] }),
      eligibility: null,
    }));
    expect(result.action).toBe('REJECTED');
    expect(result.comparison).toBe('UNAVAILABLE');
  });

  it('lifecycle cooldown 차단은 NO_TRADE 사유로 설명한다', () => {
    const result = buildStrategyShadowRecord(input({ eligibility: eligibility({
      eligible: false, codes: ['STOP_LOSS_COOLDOWN'], blockedUntilCandleCloseTime: CLOSE + 2,
      reasons: ['Stop Loss cooldown'],
    }) }));
    expect(result.action).toBe('NO_TRADE');
    expect(result.reasons.join(' ')).toContain('Stop Loss cooldown');
  });

  it('lifecycle evidence 누락과 Signal ID 불일치는 REJECT한다', () => {
    expect(buildStrategyShadowRecord(input({ eligibility: null })).action).toBe('REJECTED');
    expect(buildStrategyShadowRecord(input({ eligibility: eligibility({ signalId: 'other' }) })).action).toBe('REJECTED');
  });

  it('선택 전략 feature flag가 꺼지면 NO_TRADE한다', () => {
    const flags = { ...DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS, trendPullbackEnabled: false };
    expect(buildStrategyShadowRecord(input(), flags).action).toBe('NO_TRADE');
  });

  it('Ensemble 비활성은 DISABLED로 명시한다', () => {
    const flags = { ...DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS, strategyEnsembleEnabled: false };
    expect(buildStrategyShadowRecord(input(), flags).action).toBe('DISABLED');
  });

  it('PAPER 실행 flag 또는 SHADOW off 설정을 거부한다', () => {
    const paper = { ...DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS, paperExecutionEnabled: true };
    const notShadow = { ...DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS, shadowModeEnabled: false };
    expect(buildStrategyShadowRecord(input(), paper).action).toBe('REJECTED');
    expect(buildStrategyShadowRecord(input(), notShadow).action).toBe('REJECTED');
  });

  it('config version·누락·추가 필드를 strict fail-closed 처리한다', () => {
    expect(buildStrategyShadowRecord(input(), { ...DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS, version: 'future' }).schemaVersion).toBe('INVALID');
    const { shadowModeEnabled: _removed, ...missing } = DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS;
    expect(validateStrategyShadowFeatureFlags(missing).join(' ')).toContain('shadowModeEnabled');
    expect(validateStrategyShadowFeatureFlags({ ...DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS, extra: true }).join(' ')).toContain('extra');
  });

  it('종목·시각·기존 AI confidence 입력 오류를 REJECT한다', () => {
    expect(buildStrategyShadowRecord(input({ symbol: 'ETH' })).action).toBe('REJECTED');
    expect(buildStrategyShadowRecord(input({ evaluatedAt: CLOSE - 1 })).action).toBe('REJECTED');
    expect(buildStrategyShadowRecord(input({ existingAi: existing({ confidence: 101 }) })).action).toBe('REJECTED');
  });

  it('동일 완료봉 입력은 결정론적 record ID를 만든다', () => {
    const first = buildStrategyShadowRecord(input());
    const second = buildStrategyShadowRecord(input({ evaluatedAt: CLOSE + 500 }));
    expect(first.shadowRecordId).toBe(`BTC:STRATEGY_SHADOW:TREND_UP:${CLOSE}`);
    expect(second.shadowRecordId).toBe(first.shadowRecordId);
  });
});
