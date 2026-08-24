/**
 * Pure, read-only Structural Stop sizing advisory for Strategy Ensemble v2.
 *
 * This bridge derives stop distance from existing SHADOW evidence and delegates
 * all arithmetic to the authoritative riskSizing module. It cannot create an
 * approval, persist a position, or mutate PAPER/LIVE execution state.
 */
import { computePositionSize } from '../lib/riskSizing';
import { RISK_POLICY } from '../lib/riskPolicy';
import {
  isAppliedRiskProfileSnapshot,
  type AppliedRiskProfileSnapshot,
} from '../lib/riskProfiles';
import type { StrategyRiskAdapterDecision } from './strategyRiskAdapterV2';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';

export const STRATEGY_STRUCTURAL_SIZING_VERSION = 'strategy-structural-sizing/v1' as const;

export interface StrategyStructuralSizingInput {
  shadowRecord: StrategyShadowRecord;
  riskDecision: StrategyRiskAdapterDecision;
  riskProfile: AppliedRiskProfileSnapshot;
  roundTripFeesFraction: number;
  adverseImpactBufferFraction: number;
  fundingBorrowingBufferFraction: number;
  liquidityCapUsd: number | null;
  tierNotionalCapUsd: number;
}

export interface StrategyStructuralSizingAdvisory {
  schemaVersion: typeof STRATEGY_STRUCTURAL_SIZING_VERSION | 'INVALID';
  advisoryId: string;
  signalId: string | null;
  symbol: string;
  status: 'SIZED' | 'REJECTED';
  direction: 'LONG' | 'SHORT' | 'NONE';
  entryPrice: number | null;
  structuralStop: number | null;
  stopDistanceFraction: number | null;
  riskSizeFactor: number;
  allowedLeverage: number;
  allowedRiskUsd: number;
  effectiveStopLossFraction: number;
  maxNotionalBeforeRiskReductionUsd: number;
  finalAdvisoryNotionalUsd: number;
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function rejected(
  input: StrategyStructuralSizingInput,
  reason: string,
  invalid = false,
): StrategyStructuralSizingAdvisory {
  const record = input.shadowRecord;
  return {
    schemaVersion: invalid ? 'INVALID' : STRATEGY_STRUCTURAL_SIZING_VERSION,
    advisoryId: `${record.shadowRecordId}:STRUCTURAL_SIZING`,
    signalId: record.signalId,
    symbol: record.symbol.trim().toUpperCase(),
    status: 'REJECTED',
    direction: 'NONE',
    entryPrice: finite(record.entryPrice) ? record.entryPrice : null,
    structuralStop: finite(record.structuralStop) ? record.structuralStop : null,
    stopDistanceFraction: null,
    riskSizeFactor: 0,
    allowedLeverage: 0,
    allowedRiskUsd: 0,
    effectiveStopLossFraction: 0,
    maxNotionalBeforeRiskReductionUsd: 0,
    finalAdvisoryNotionalUsd: 0,
    reasons: [reason],
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function authorityBoundaryValid(
  record: StrategyShadowRecord,
  risk: StrategyRiskAdapterDecision,
): boolean {
  return record.schemaVersion === 'strategy-shadow-adapter/v1'
    && record.mode === 'SHADOW_ONLY'
    && record.executionAuthorized === false
    && record.paperPositionMutationAllowed === false
    && record.riskAuthority === 'NOT_EVALUATED'
    && risk.schemaVersion === 'strategy-risk-adapter/v1'
    && risk.authority === 'ADVISORY_ONLY'
    && risk.executionAuthorized === false
    && risk.approvalCreationAllowed === false
    && risk.paperPositionMutationAllowed === false
    && risk.livePositionMutationAllowed === false;
}

/**
 * Produces a sizing number for explainability only. The Risk Adapter may reduce
 * the authoritative sizing result, but this boundary never increases it.
 */
export function buildStrategyStructuralSizingAdvisory(
  input: StrategyStructuralSizingInput,
): StrategyStructuralSizingAdvisory {
  const { shadowRecord: record, riskDecision: risk, riskProfile: profile } = input;
  if (!authorityBoundaryValid(record, risk)) {
    return rejected(input, 'SHADOW/Risk advisory 권한 경계 INVALID — fail-closed', true);
  }
  if (!isAppliedRiskProfileSnapshot(profile)) {
    return rejected(input, '적용 Risk Profile snapshot INVALID — fail-closed', true);
  }
  if (!record.shadowRecordId.trim() || !record.symbol.trim()
    || record.signalId === null || !record.signalId.trim()
    || risk.signalId !== record.signalId
    || risk.symbol.trim().toUpperCase() !== record.symbol.trim().toUpperCase()) {
    return rejected(input, 'Signal identity 불일치 — fail-closed', true);
  }
  if ((record.action !== 'LONG' && record.action !== 'SHORT')
    || record.direction !== record.action
    || risk.direction !== record.direction
    || (risk.action !== 'ALLOW' && risk.action !== 'REDUCE')
    || !finite(risk.sizeFactor) || risk.sizeFactor <= 0 || risk.sizeFactor > 1
    || (risk.action === 'ALLOW' && risk.sizeFactor !== 1)
    || (risk.action === 'REDUCE' && risk.sizeFactor >= 1)
    || !finite(risk.maxLeverage) || risk.maxLeverage <= 0
    || risk.maxLeverage > RISK_POLICY.baseMaxLeverage) {
    return rejected(input, 'Risk 승인 없는 실행 후보 — sizing 거부');
  }
  if (!finite(record.entryPrice) || record.entryPrice <= 0
    || !finite(record.structuralStop) || record.structuralStop <= 0) {
    return rejected(input, 'Entry 또는 Structural Stop 없음 — sizing 거부');
  }
  const directionValid = record.direction === 'LONG'
    ? record.structuralStop < record.entryPrice
    : record.structuralStop > record.entryPrice;
  if (!directionValid) {
    return rejected(input, 'Structural Stop 방향 INVALID — fail-closed', true);
  }

  const stopDistanceFraction = Math.abs(record.entryPrice - record.structuralStop) / record.entryPrice;
  const requestedLeverage = Math.min(risk.maxLeverage, profile.derivedLimits.maxLeverage);
  const profileNotionalCapUsd = Math.min(
    profile.derivedLimits.maxTotalExposureUsd,
    profile.derivedLimits.maxMarginPerTradeUsd * requestedLeverage,
  );
  const sizing = computePositionSize({
    positionSizingCapitalUsd: profile.derivedLimits.allocatedTradingCapitalUsd,
    stopDistanceFraction,
    roundTripFeesFraction: input.roundTripFeesFraction,
    adverseImpactBufferFraction: input.adverseImpactBufferFraction,
    fundingBorrowingBufferFraction: input.fundingBorrowingBufferFraction,
    requestedLeverage,
    liquidityCapUsd: input.liquidityCapUsd,
    tierNotionalCapUsd: Math.min(input.tierNotionalCapUsd, profileNotionalCapUsd),
    riskBudgetPct: profile.derivedLimits.maxRiskPerTradePct,
    defensiveMode: false,
  });
  if (!sizing.ok) return rejected(input, `authoritative sizing 거부: ${sizing.reason}`);

  const finalAdvisoryNotionalUsd = sizing.finalNotionalUsd * risk.sizeFactor;
  if (!finite(finalAdvisoryNotionalUsd) || finalAdvisoryNotionalUsd <= 0
    || finalAdvisoryNotionalUsd > sizing.finalNotionalUsd) {
    return rejected(input, 'Risk 축소 결과 INVALID — fail-closed', true);
  }

  return {
    schemaVersion: STRATEGY_STRUCTURAL_SIZING_VERSION,
    advisoryId: `${record.shadowRecordId}:STRUCTURAL_SIZING`,
    signalId: record.signalId,
    symbol: record.symbol.trim().toUpperCase(),
    status: 'SIZED',
    direction: record.direction,
    entryPrice: record.entryPrice,
    structuralStop: record.structuralStop,
    stopDistanceFraction,
    riskSizeFactor: risk.sizeFactor,
    allowedLeverage: sizing.allowedLeverage,
    allowedRiskUsd: sizing.allowedRiskUsd,
    effectiveStopLossFraction: sizing.effectiveStopLossFraction,
    maxNotionalBeforeRiskReductionUsd: sizing.finalNotionalUsd,
    finalAdvisoryNotionalUsd,
    reasons: [
      'Structural Stop 거리와 authoritative riskSizing 사용',
      risk.action === 'REDUCE' ? 'Risk Adapter sizeFactor로 위험 축소' : 'Risk Adapter 위험 확대 없음',
      '실행·승인·PAPER/LIVE mutation 권한 없음',
    ],
    authority: 'ADVISORY_ONLY',
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}
