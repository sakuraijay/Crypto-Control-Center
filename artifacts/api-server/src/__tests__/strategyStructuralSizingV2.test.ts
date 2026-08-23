import { describe, expect, it } from 'vitest';
import type { AppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import type { StrategyRiskAdapterDecision } from '../intel/strategyRiskAdapterV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import {
  buildStrategyStructuralSizingAdvisory,
  STRATEGY_STRUCTURAL_SIZING_VERSION,
} from '../intel/strategyStructuralSizingV2';

const CLOSE = 1_800_000;

const record = (overrides: Partial<StrategyShadowRecord> = {}): StrategyShadowRecord => ({
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
});

const risk = (overrides: Partial<StrategyRiskAdapterDecision> = {}): StrategyRiskAdapterDecision => ({
  schemaVersion: 'strategy-risk-adapter/v1',
  decisionId: `BTC:STRATEGY_SHADOW:TREND_UP:${CLOSE}:RISK_ADAPTER`,
  signalId: 'signal-1', symbol: 'BTC', action: 'ALLOW', direction: 'LONG',
  sizeFactor: 1, maxLeverage: 3, riskState: 'NORMAL', reasons: [], warnings: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false,
  approvalCreationAllowed: false, paperPositionMutationAllowed: false,
  livePositionMutationAllowed: false, ...overrides,
});

const profile = (overrides: Partial<AppliedRiskProfileSnapshot['derivedLimits']> = {}): AppliedRiskProfileSnapshot => ({
  name: 'conservative', version: 'risk-profile/v1', appliedAt: '2026-08-23T10:00:00.000Z',
  derivedLimits: {
    immediateEntryThreshold: 80, maxRiskPerTradePct: 0.75, reserveCashPct: 20,
    maxMarginPerTradeUsd: 334, maxConcurrentPositions: 1, cooldownMinutes: 30,
    maxLeverage: 3, maxTotalExposureUsd: 3_000, allocatedTradingCapitalUsd: 1_000,
    maxRiskPerTradeUsd: 7.5, ...overrides,
  },
});

const input = () => ({
  shadowRecord: record(), riskDecision: risk(), riskProfile: profile(),
  roundTripFeesFraction: 0.002, adverseImpactBufferFraction: 0.001,
  fundingBorrowingBufferFraction: 0.001, liquidityCapUsd: 1_000,
  tierNotionalCapUsd: 500,
});

describe('Strategy Structural Stop sizing advisory', () => {
  it('Structural Stop 거리와 authoritative riskSizing으로 read-only size를 계산한다', () => {
    const result = buildStrategyStructuralSizingAdvisory(input());
    expect(result).toMatchObject({
      schemaVersion: STRATEGY_STRUCTURAL_SIZING_VERSION,
      status: 'SIZED', direction: 'LONG', stopDistanceFraction: 0.02,
      allowedRiskUsd: 7.5, effectiveStopLossFraction: 0.024,
      maxNotionalBeforeRiskReductionUsd: 312.5, finalAdvisoryNotionalUsd: 312.5,
      authority: 'ADVISORY_ONLY', executionAuthorized: false,
      approvalCreationAllowed: false, paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
    });
  });

  it('Risk REDUCE 계수를 적용하되 authoritative size를 절대 확대하지 않는다', () => {
    const value = input();
    value.riskDecision = risk({ action: 'REDUCE', sizeFactor: 0.5, riskState: 'DEFENSIVE' });
    const result = buildStrategyStructuralSizingAdvisory(value);
    expect(result).toMatchObject({
      status: 'SIZED', riskSizeFactor: 0.5,
      maxNotionalBeforeRiskReductionUsd: 312.5, finalAdvisoryNotionalUsd: 156.25,
    });
  });

  it('SHORT은 Entry 위 Stop만 허용한다', () => {
    const value = input();
    value.shadowRecord = record({ action: 'SHORT', direction: 'SHORT', structuralStop: 102 });
    value.riskDecision = risk({ direction: 'SHORT' });
    expect(buildStrategyStructuralSizingAdvisory(value).status).toBe('SIZED');
    value.shadowRecord = record({ action: 'SHORT', direction: 'SHORT', structuralStop: 98 });
    expect(buildStrategyStructuralSizingAdvisory(value)).toMatchObject({
      status: 'REJECTED', schemaVersion: 'INVALID', finalAdvisoryNotionalUsd: 0,
    });
  });

  it('Risk REJECT·identity 불일치·권한 변조는 sizing 0으로 fail-closed한다', () => {
    const unsafe = [
      { riskDecision: risk({ action: 'REJECT', direction: 'NONE', sizeFactor: 0 }) },
      { riskDecision: risk({ signalId: 'different' }) },
      { riskDecision: risk({ executionAuthorized: true as false }) },
    ];
    for (const overrides of unsafe) {
      const result = buildStrategyStructuralSizingAdvisory({ ...input(), ...overrides });
      expect(result).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
    }
  });

  it('비용·유동성 근거가 없으면 기존 riskSizing 사유를 보존해 거부한다', () => {
    expect(buildStrategyStructuralSizingAdvisory({
      ...input(), roundTripFeesFraction: Number.NaN,
    }).reasons[0]).toContain('왕복 수수료 fraction 결측');
    expect(buildStrategyStructuralSizingAdvisory({
      ...input(), liquidityCapUsd: null,
    }).reasons[0]).toContain('시장 유동성/impact 상한 불명');
  });

  it('변조된 적용 프로필 또는 3x 초과 요청은 fail-closed한다', () => {
    expect(buildStrategyStructuralSizingAdvisory({
      ...input(), riskProfile: profile({ maxRiskPerTradeUsd: 100 }),
    }).schemaVersion).toBe('INVALID');
    expect(buildStrategyStructuralSizingAdvisory({
      ...input(), riskDecision: risk({ maxLeverage: 5 }),
    })).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
  });

  it('입력을 변경하지 않고 동일 입력에 결정론적 결과를 반환한다', () => {
    const value = input();
    const before = JSON.stringify(value);
    expect(buildStrategyStructuralSizingAdvisory(value))
      .toEqual(buildStrategyStructuralSizingAdvisory(value));
    expect(JSON.stringify(value)).toBe(before);
  });
});
