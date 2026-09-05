import { describe, expect, it } from 'vitest';
import type { StrategyRiskAdapterDecision } from '../intel/strategyRiskAdapterV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import type { StrategyStructuralSizingAdvisory } from '../intel/strategyStructuralSizingV2';
import {
  DEFAULT_STRATEGY_CONFIDENCE_RISK_REDUCTION_POLICY,
  reduceStrategyRiskByConfidence,
  STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION,
  validateStrategyConfidenceRiskReductionPolicy,
} from '../intel/strategyConfidenceRiskReductionV2';

const shadow = (confidence = 70): StrategyShadowRecord => ({
  schemaVersion: 'strategy-shadow-adapter/v1', shadowRecordId: 'BTC:SHADOW:1',
  mode: 'SHADOW_ONLY', symbol: 'BTC', evaluatedAt: 2, sourceCandleCloseTime: 1,
  regime: 'TREND_UP', action: 'LONG', comparison: 'ENSEMBLE_ONLY',
  strategyId: 'TREND_PULLBACK', signalId: 'signal-1', direction: 'LONG', confidence,
  selectedScore: 75, entryPrice: 100, structuralStop: 98, expectedNetEdgeBps: 100,
  expectedNetRR: 2, lifecycleEligible: true, existingAi: null, reasons: [], warnings: [],
  executionAuthorized: false, paperPositionMutationAllowed: false,
  riskAuthority: 'NOT_EVALUATED',
});
const risk = (action: 'ALLOW' | 'REDUCE' | 'REJECT' = 'ALLOW'): StrategyRiskAdapterDecision => ({
  schemaVersion: 'strategy-risk-adapter/v1', decisionId: 'BTC:SHADOW:1:RISK_ADAPTER',
  signalId: 'signal-1', symbol: 'BTC', action, direction: action === 'REJECT' ? 'NONE' : 'LONG',
  sizeFactor: action === 'REDUCE' ? 0.8 : action === 'ALLOW' ? 1 : 0,
  maxLeverage: action === 'REJECT' ? 0 : 3, riskState: 'NORMAL', reasons: [], warnings: [],
  authority: 'ADVISORY_ONLY', executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});
const sizing = (factor = 1): StrategyStructuralSizingAdvisory => ({
  schemaVersion: 'strategy-structural-sizing/v1', advisoryId: 'BTC:SHADOW:1:STRUCTURAL_SIZING',
  signalId: 'signal-1', symbol: 'BTC', status: 'SIZED', direction: 'LONG',
  entryPrice: 100, structuralStop: 98, stopDistanceFraction: 0.02,
  riskSizeFactor: factor, allowedLeverage: 3, allowedRiskUsd: 7.5,
  effectiveStopLossFraction: 0.024, maxNotionalBeforeRiskReductionUsd: 400,
  finalAdvisoryNotionalUsd: 400 * factor, reasons: [], authority: 'ADVISORY_ONLY',
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
});

describe('Strategy confidence downside-only risk reduction', () => {
  it('중간 confidence는 기존 sizing을 선형 축소하며 권한은 모두 false다', () => {
    expect(reduceStrategyRiskByConfidence({
      shadowRecord: shadow(70), riskDecision: risk(), sizingAdvisory: sizing(),
    })).toMatchObject({
      schemaVersion: STRATEGY_CONFIDENCE_RISK_REDUCTION_VERSION,
      status: 'REDUCED', confidenceSizeFactor: 0.75,
      inputNotionalUsd: 400, finalAdvisoryNotionalUsd: 300, allowedLeverage: 3,
      authority: 'ADVISORY_ONLY', executionAuthorized: false,
      approvalCreationAllowed: false, paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
    });
  });

  it('full-size confidence 이상도 기존 sizing·leverage를 늘리지 않는다', () => {
    const result = reduceStrategyRiskByConfidence({
      shadowRecord: shadow(100), riskDecision: risk(), sizingAdvisory: sizing(),
    });
    expect(result).toMatchObject({
      status: 'UNCHANGED', confidenceSizeFactor: 1,
      inputNotionalUsd: 400, finalAdvisoryNotionalUsd: 400, allowedLeverage: 3,
    });
  });

  it('Risk REDUCE 이후 confidence는 추가 축소만 수행한다', () => {
    const result = reduceStrategyRiskByConfidence({
      shadowRecord: shadow(70), riskDecision: risk('REDUCE'), sizingAdvisory: sizing(0.8),
    });
    expect(result).toMatchObject({
      status: 'REDUCED', inputNotionalUsd: 320, finalAdvisoryNotionalUsd: 240,
    });
  });

  it('최소 confidence 미달 또는 Risk veto는 신규 위험 0이다', () => {
    expect(reduceStrategyRiskByConfidence({
      shadowRecord: shadow(59.99), riskDecision: risk(), sizingAdvisory: sizing(),
    })).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
    expect(reduceStrategyRiskByConfidence({
      shadowRecord: shadow(90), riskDecision: risk('REJECT'), sizingAdvisory: sizing(),
    })).toMatchObject({ status: 'REJECTED', finalAdvisoryNotionalUsd: 0 });
  });

  it('identity·direction·권한 변조는 INVALID로 fail-closed한다', () => {
    const badSizing = { ...sizing(), signalId: 'other' };
    expect(reduceStrategyRiskByConfidence({
      shadowRecord: shadow(), riskDecision: risk(), sizingAdvisory: badSizing,
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
    const unsafe = { ...risk(), executionAuthorized: true as never };
    expect(reduceStrategyRiskByConfidence({
      shadowRecord: shadow(), riskDecision: unsafe, sizingAdvisory: sizing(),
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
  });

  it('Risk factor·notional·leverage 확대 또는 불일치는 거부한다', () => {
    expect(reduceStrategyRiskByConfidence({
      shadowRecord: shadow(), riskDecision: risk('REDUCE'), sizingAdvisory: sizing(1),
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
    expect(reduceStrategyRiskByConfidence({
      shadowRecord: shadow(), riskDecision: risk(),
      sizingAdvisory: { ...sizing(), finalAdvisoryNotionalUsd: 401 },
    })).toMatchObject({ schemaVersion: 'INVALID', status: 'REJECTED' });
  });

  it('policy는 versioned·strict이며 입력을 변경하지 않는다', () => {
    expect(validateStrategyConfidenceRiskReductionPolicy(
      DEFAULT_STRATEGY_CONFIDENCE_RISK_REDUCTION_POLICY,
    )).toEqual([]);
    expect(validateStrategyConfidenceRiskReductionPolicy({
      ...DEFAULT_STRATEGY_CONFIDENCE_RISK_REDUCTION_POLICY, minimumSizeFactor: 1.1,
    })).not.toEqual([]);
    expect(validateStrategyConfidenceRiskReductionPolicy({
      ...DEFAULT_STRATEGY_CONFIDENCE_RISK_REDUCTION_POLICY, extra: true,
    })).not.toEqual([]);
    const input = { shadowRecord: shadow(), riskDecision: risk(), sizingAdvisory: sizing() };
    const before = JSON.stringify(input);
    reduceStrategyRiskByConfidence(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
