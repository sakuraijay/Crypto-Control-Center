/**
 * Pure SHADOW-only adapter for Regime-Aware Strategy Ensemble v2.
 *
 * This module compares the advisory ensemble result with the existing AI decision.
 * It cannot persist state, size a position, authorize risk, or mutate PAPER/LIVE state.
 */
import type { SignalEligibilityDecision } from './signalLifecycleV2';
import type { StrategyArbiterDecision } from './strategyArbiterV2';
import type { StrategyDirection, StrategyId } from './strategySignalV2';

export const STRATEGY_SHADOW_ADAPTER_VERSION = 'strategy-shadow-adapter/v1' as const;

export interface StrategyShadowFeatureFlags {
  version: typeof STRATEGY_SHADOW_ADAPTER_VERSION;
  regimeEngineEnabled: boolean;
  strategyEnsembleEnabled: boolean;
  trendPullbackEnabled: boolean;
  volatilityBreakoutEnabled: boolean;
  rangeMeanReversionEnabled: boolean;
  relativeStrengthEnabled: boolean;
  gmxContextFilterEnabled: boolean;
  shadowModeEnabled: boolean;
  paperExecutionEnabled: boolean;
}

export const DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS: StrategyShadowFeatureFlags = Object.freeze({
  version: STRATEGY_SHADOW_ADAPTER_VERSION,
  regimeEngineEnabled: true,
  strategyEnsembleEnabled: true,
  trendPullbackEnabled: true,
  volatilityBreakoutEnabled: true,
  rangeMeanReversionEnabled: true,
  relativeStrengthEnabled: false,
  gmxContextFilterEnabled: false,
  shadowModeEnabled: true,
  paperExecutionEnabled: false,
});

export type ExistingAiAction = 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNAVAILABLE';

export interface ExistingAiDecisionSnapshot {
  decisionId: string | null;
  action: ExistingAiAction;
  confidence: number | null;
  reasons: string[];
  sourceCandleCloseTime: number | null;
}

export interface StrategyShadowAdapterInput {
  symbol: string;
  evaluatedAt: number;
  arbiter: StrategyArbiterDecision;
  eligibility: SignalEligibilityDecision | null;
  existingAi: ExistingAiDecisionSnapshot | null;
}

export type StrategyShadowAction = 'LONG' | 'SHORT' | 'NO_TRADE' | 'REJECTED' | 'DISABLED';
export type StrategyShadowComparison = 'AGREE_DIRECTION' | 'AGREE_NO_TRADE'
  | 'ENSEMBLE_ONLY' | 'EXISTING_AI_ONLY' | 'DIRECTION_CONFLICT' | 'UNAVAILABLE';

export interface StrategyShadowRecord {
  schemaVersion: typeof STRATEGY_SHADOW_ADAPTER_VERSION | 'INVALID';
  shadowRecordId: string;
  mode: 'SHADOW_ONLY';
  symbol: string;
  evaluatedAt: number;
  sourceCandleCloseTime: number;
  regime: StrategyArbiterDecision['regime'];
  action: StrategyShadowAction;
  comparison: StrategyShadowComparison;
  strategyId: StrategyId | null;
  signalId: string | null;
  direction: StrategyDirection;
  confidence: number | null;
  selectedScore: number | null;
  entryPrice: number | null;
  structuralStop: number | null;
  expectedNetEdgeBps: number | null;
  expectedNetRR: number | null;
  lifecycleEligible: boolean | null;
  existingAi: ExistingAiDecisionSnapshot | null;
  reasons: string[];
  warnings: string[];
  executionAuthorized: false;
  paperPositionMutationAllowed: false;
  riskAuthority: 'NOT_EVALUATED';
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

export function validateStrategyShadowFeatureFlags(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['shadow feature flags 객체 필요'];
  const record = value as Record<string, unknown>;
  const booleans = ['regimeEngineEnabled', 'strategyEnsembleEnabled', 'trendPullbackEnabled',
    'volatilityBreakoutEnabled', 'rangeMeanReversionEnabled', 'relativeStrengthEnabled',
    'gmxContextFilterEnabled', 'shadowModeEnabled', 'paperExecutionEnabled'] as const;
  const expected = ['version', ...booleans] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 feature flag: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`feature flag 누락: ${key}`);
  }
  if (record.version !== STRATEGY_SHADOW_ADAPTER_VERSION) issues.push('지원하지 않는 feature flag version');
  for (const key of booleans) {
    if (typeof record[key] !== 'boolean') issues.push(`${key} boolean 필요`);
  }
  return issues;
}

function validateExistingAi(value: ExistingAiDecisionSnapshot | null): string[] {
  if (value === null) return [];
  const issues: string[] = [];
  if (value.decisionId !== null && (typeof value.decisionId !== 'string' || !value.decisionId.trim())) {
    issues.push('existing AI decisionId INVALID');
  }
  if (!['LONG', 'SHORT', 'NO_TRADE', 'UNAVAILABLE'].includes(value.action)) {
    issues.push('existing AI action INVALID');
  }
  if (value.confidence !== null && (!finite(value.confidence) || value.confidence < 0 || value.confidence > 100)) {
    issues.push('existing AI confidence INVALID');
  }
  if (!Array.isArray(value.reasons) || value.reasons.some(reason => typeof reason !== 'string')) {
    issues.push('existing AI reasons INVALID');
  }
  if (value.sourceCandleCloseTime !== null
    && (!finite(value.sourceCandleCloseTime) || value.sourceCandleCloseTime <= 0)) {
    issues.push('existing AI source candle INVALID');
  }
  return issues;
}

function strategyEnabled(strategyId: StrategyId, flags: StrategyShadowFeatureFlags): boolean {
  if (strategyId === 'TREND_PULLBACK') return flags.trendPullbackEnabled;
  if (strategyId === 'VOLATILITY_BREAKOUT') return flags.volatilityBreakoutEnabled;
  return flags.rangeMeanReversionEnabled;
}

function comparison(action: StrategyShadowAction, existing: ExistingAiDecisionSnapshot | null): StrategyShadowComparison {
  if (existing === null || existing.action === 'UNAVAILABLE' || action === 'REJECTED' || action === 'DISABLED') {
    return 'UNAVAILABLE';
  }
  if (action === 'NO_TRADE') return existing.action === 'NO_TRADE' ? 'AGREE_NO_TRADE' : 'EXISTING_AI_ONLY';
  if (existing.action === 'NO_TRADE') return 'ENSEMBLE_ONLY';
  return existing.action === action ? 'AGREE_DIRECTION' : 'DIRECTION_CONFLICT';
}

function recordId(symbol: string, arbiter: StrategyArbiterDecision): string {
  return [normalizeSymbol(symbol), 'STRATEGY_SHADOW', arbiter.regime, arbiter.sourceCandleCloseTime].join(':');
}

function baseRecord(
  input: StrategyShadowAdapterInput,
  action: StrategyShadowAction,
  schemaVersion: StrategyShadowRecord['schemaVersion'],
  reasons: string[],
  warnings: string[] = [],
): StrategyShadowRecord {
  const selected = input.arbiter.selectedSignal;
  return {
    schemaVersion,
    shadowRecordId: recordId(input.symbol, input.arbiter),
    mode: 'SHADOW_ONLY',
    symbol: normalizeSymbol(input.symbol),
    evaluatedAt: input.evaluatedAt,
    sourceCandleCloseTime: input.arbiter.sourceCandleCloseTime,
    regime: input.arbiter.regime,
    action,
    comparison: comparison(action, input.existingAi),
    strategyId: selected?.strategyId ?? null,
    signalId: selected?.signalId ?? null,
    direction: action === 'LONG' || action === 'SHORT' ? action : 'NONE',
    confidence: selected?.confidence ?? null,
    selectedScore: input.arbiter.selectedScore,
    entryPrice: selected?.proposedEntryPrice ?? null,
    structuralStop: selected?.structuralStop ?? null,
    expectedNetEdgeBps: selected?.netExpectedEdgeBps ?? null,
    expectedNetRR: selected?.expectedNetRR ?? null,
    lifecycleEligible: input.eligibility?.eligible ?? null,
    existingAi: input.existingAi,
    reasons,
    warnings,
    executionAuthorized: false,
    paperPositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}

/**
 * Builds an explainable comparison record only. Any execution-capable flag makes the
 * adapter reject the input, so a future caller cannot silently repurpose this boundary.
 */
export function buildStrategyShadowRecord(
  input: StrategyShadowAdapterInput,
  flagsInput: unknown = DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS,
): StrategyShadowRecord {
  const flagIssues = validateStrategyShadowFeatureFlags(flagsInput);
  if (flagIssues.length > 0) return baseRecord(input, 'REJECTED', 'INVALID', ['feature flags INVALID — fail-closed'], flagIssues);
  const flags = flagsInput as StrategyShadowFeatureFlags;
  const inputIssues = validateExistingAi(input.existingAi);
  if (!input.symbol.trim() || normalizeSymbol(input.arbiter.symbol) !== normalizeSymbol(input.symbol)
    || !finite(input.evaluatedAt) || input.evaluatedAt < input.arbiter.sourceCandleCloseTime
    || !finite(input.arbiter.sourceCandleCloseTime) || input.arbiter.sourceCandleCloseTime <= 0) {
    inputIssues.push('shadow adapter 입력 또는 시각 INVALID');
  }
  if (inputIssues.length > 0) return baseRecord(input, 'REJECTED', flags.version, ['입력 INVALID — fail-closed'], inputIssues);
  if (!flags.shadowModeEnabled || flags.paperExecutionEnabled) {
    return baseRecord(input, 'REJECTED', flags.version,
      ['SHADOW_ONLY 경계 위반 — 실행 가능 설정 거부']);
  }
  if (!flags.regimeEngineEnabled || !flags.strategyEnsembleEnabled) {
    return baseRecord(input, 'DISABLED', flags.version,
      ['Regime Engine 또는 Strategy Ensemble feature flag 비활성']);
  }
  if (input.arbiter.action === 'REJECT') {
    return baseRecord(input, 'REJECTED', flags.version,
      ['Strategy Arbiter fail-closed REJECT', ...input.arbiter.reasons], input.arbiter.warnings);
  }
  if (input.arbiter.action === 'NO_TRADE') {
    return baseRecord(input, 'NO_TRADE', flags.version,
      ['Strategy Arbiter NO TRADE', ...input.arbiter.reasons], input.arbiter.warnings);
  }

  const selected = input.arbiter.selectedSignal;
  if (selected === null || input.arbiter.selectedScore === null || selected.direction === 'NONE') {
    return baseRecord(input, 'REJECTED', flags.version,
      ['Arbiter SELECT 결과의 Signal 또는 score 누락 — fail-closed']);
  }
  if (!strategyEnabled(selected.strategyId, flags)) {
    return baseRecord(input, 'NO_TRADE', flags.version,
      [`${selected.strategyId} feature flag 비활성 — NO TRADE`]);
  }
  if (selected.symbol !== normalizeSymbol(input.symbol)
    || selected.sourceCandleCloseTime !== input.arbiter.sourceCandleCloseTime) {
    return baseRecord(input, 'REJECTED', flags.version,
      ['선택 Signal과 Arbiter 종목 또는 완료 캔들 불일치 — fail-closed']);
  }
  if (input.eligibility === null || input.eligibility.signalId !== selected.signalId
    || input.eligibility.configVersion === 'INVALID') {
    return baseRecord(input, 'REJECTED', flags.version,
      ['Signal lifecycle evidence 누락 또는 불일치 — fail-closed']);
  }
  if (!input.eligibility.eligible) {
    return baseRecord(input, 'NO_TRADE', flags.version,
      ['Signal lifecycle/cooldown 차단 — NO TRADE', ...input.eligibility.reasons], input.eligibility.warnings);
  }
  return baseRecord(input, selected.direction, flags.version, [
    `${selected.strategyId} ${selected.direction} 후보를 SHADOW 비교 대상으로 채택`,
    'Arbiter·Signal lifecycle 통과 — Risk 판단과 주문 권한은 부여하지 않음',
  ], [...input.arbiter.warnings, ...input.eligibility.warnings]);
}
