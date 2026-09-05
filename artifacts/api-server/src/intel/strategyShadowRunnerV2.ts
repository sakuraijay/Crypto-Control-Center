/**
 * Pure MTF Strategy Ensemble SHADOW runner.
 *
 * The caller supplies already-read candle frames, cost evidence and prior advisory
 * state. This module performs no network, DB, worker, Risk, signer or execution I/O.
 */
import {
  buildMultiTimeframeCandleSet,
  type CandleFrameInput,
  type StrategyTimeframe,
} from './candleFoundationV2';
import { extractLatestCandleFeatures } from './candlePatternFeatures';
import { computeCandleTechnicalSnapshot } from './candleTechnicalFeaturesV2';
import { computeMarketStructure } from './marketStructureV2';
import { evaluateRangeMeanReversion } from './rangeMeanReversionStrategyV2';
import { evaluateRegime, type RegimeDecision, type RegimeState } from './regimeEngineV2';
import {
  evaluateSignalEligibility,
  type SignalEligibilityDecision,
  type SignalHistoryEvent,
  type SignalLifecycleRecord,
} from './signalLifecycleV2';
import { arbitrateStrategySignals, type StrategyArbiterDecision } from './strategyArbiterV2';
import {
  buildStrategyShadowRecord,
  DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS,
  type ExistingAiDecisionSnapshot,
  type StrategyShadowFeatureFlags,
  type StrategyShadowRecord,
} from './strategyShadowAdapterV2';
import type { StrategyDataQuality, StrategySignal } from './strategySignalV2';
import { evaluateTrendPullback } from './trendPullbackStrategyV2';
import { evaluateVolatilityBreakout } from './volatilityBreakoutStrategyV2';
import { evaluateCandleSignal } from './candleSignalCore';
import type { CandleSignalToRisk } from './candleSignalContract';
import {
  buildCandleStrategyShadowEvidence,
  type CandleStrategyShadowEvidence,
} from './candleStrategyShadowEvidenceV2';
import {
  evaluateStrategyNetEdgeResearch,
  type StrategyNetEdgeCostEvidence,
  type StrategyNetEdgeResearchResult,
} from './strategyNetEdgeResearchGateV1';

export const STRATEGY_SHADOW_RUNNER_VERSION = 'strategy-shadow-runner/v1' as const;

export interface StrategyShadowRunnerConfig {
  version: typeof STRATEGY_SHADOW_RUNNER_VERSION;
  momentumLookback1hCandles: number;
}

export const DEFAULT_STRATEGY_SHADOW_RUNNER_CONFIG: StrategyShadowRunnerConfig = Object.freeze({
  version: STRATEGY_SHADOW_RUNNER_VERSION,
  momentumLookback1hCandles: 4,
});

export interface StrategyShadowRunnerInput {
  symbol: string;
  evaluatedAt: number;
  frames: Partial<Record<StrategyTimeframe, CandleFrameInput>>;
  expectedCostsBps: number | null;
  netEdgeCostEvidence?: StrategyNetEdgeCostEvidence | null;
  previousRegime: RegimeState | null;
  lifecycleRecords: SignalLifecycleRecord[];
  historyEvents: SignalHistoryEvent[];
  existingAi: ExistingAiDecisionSnapshot | null;
  featureFlags?: StrategyShadowFeatureFlags;
}

export interface StrategyShadowRunnerResult {
  schemaVersion: typeof STRATEGY_SHADOW_RUNNER_VERSION | 'INVALID';
  status: 'EVALUATED' | 'NOT_EVALUATED';
  symbol: string;
  sourceCandleCloseTime: number | null;
  dataQuality: StrategyDataQuality;
  regime: RegimeDecision | null;
  candidates: StrategySignal[];
  arbiter: StrategyArbiterDecision | null;
  eligibility: SignalEligibilityDecision | null;
  record: StrategyShadowRecord | null;
  candleSignal?: CandleSignalToRisk | null;
  candleSignalEvidence?: CandleStrategyShadowEvidence | null;
  netEdgeResearch?: StrategyNetEdgeResearchResult | null;
  reasons: string[];
  warnings: string[];
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
  riskAuthority: 'NOT_EVALUATED';
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

export function validateStrategyShadowRunnerConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['runner config 객체 필요'];
  const record = value as Record<string, unknown>;
  const expected = ['version', 'momentumLookback1hCandles'] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 runner config 필드: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`runner config 필드 누락: ${key}`);
  }
  if (record.version !== STRATEGY_SHADOW_RUNNER_VERSION) issues.push('지원하지 않는 runner config version');
  if (!finite(record.momentumLookback1hCandles)
    || !Number.isInteger(record.momentumLookback1hCandles)
    || record.momentumLookback1hCandles < 1
    || record.momentumLookback1hCandles > 48) {
    issues.push('momentumLookback1hCandles 정수 범위 오류');
  }
  return issues;
}

function notEvaluated(
  input: StrategyShadowRunnerInput,
  reasons: string[],
  warnings: string[] = [],
  invalid = false,
): StrategyShadowRunnerResult {
  return {
    schemaVersion: invalid ? 'INVALID' : STRATEGY_SHADOW_RUNNER_VERSION,
    status: 'NOT_EVALUATED',
    symbol: typeof input.symbol === 'string' ? normalizeSymbol(input.symbol) : '',
    sourceCandleCloseTime: null,
    dataQuality: 'INVALID',
    regime: null,
    candidates: [],
    arbiter: null,
    eligibility: null,
    record: null,
    candleSignal: null,
    candleSignalEvidence: null,
    netEdgeResearch: null,
    reasons,
    warnings,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}

function momentumPct(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const current = closes.at(-1)!;
  const previous = closes.at(-(lookback + 1))!;
  if (!finite(current) || !finite(previous) || current <= 0 || previous <= 0) return null;
  return Number((((current - previous) / previous) * 100).toPrecision(12));
}

/**
 * Evaluates exactly one symbol into at most one advisory SHADOW record.
 * Missing, stale or malformed evidence yields no record and cannot be promoted to a signal.
 */
export function runStrategyShadowSymbol(
  input: StrategyShadowRunnerInput,
  configInput: unknown = DEFAULT_STRATEGY_SHADOW_RUNNER_CONFIG,
): StrategyShadowRunnerResult {
  const configIssues = validateStrategyShadowRunnerConfig(configInput);
  if (configIssues.length > 0) return notEvaluated(input, ['runner config INVALID — fail-closed'], configIssues, true);
  const config = configInput as StrategyShadowRunnerConfig;
  if (typeof input.symbol !== 'string' || !input.symbol.trim()
    || !finite(input.evaluatedAt) || input.evaluatedAt <= 0
    || typeof input.frames !== 'object' || input.frames === null
    || !Array.isArray(input.lifecycleRecords) || !Array.isArray(input.historyEvents)
    || (input.expectedCostsBps !== null
      && (!finite(input.expectedCostsBps) || input.expectedCostsBps < 0))) {
    return notEvaluated(input, ['runner 입력 INVALID — fail-closed'], [], true);
  }
  const symbol = normalizeSymbol(input.symbol);
  if (input.previousRegime !== null && normalizeSymbol(input.previousRegime.symbol) !== symbol) {
    return notEvaluated(input, ['이전 Regime 종목 불일치 — fail-closed']);
  }

  const foundation = buildMultiTimeframeCandleSet(symbol, input.frames, input.evaluatedAt);
  if (!foundation.tradeAllowed || foundation.quality === 'INVALID') {
    return notEvaluated(input, ['MTF candle foundation 미충족 — 가짜 record 생성 금지'], foundation.issues);
  }
  const candleSignal = evaluateCandleSignal({
    symbol,
    frames: input.frames,
    evaluatedAtMs: input.evaluatedAt,
  });
  if (candleSignal.dataQuality.status === 'INVALID') {
    return {
      ...notEvaluated(input, ['Candle Signal 완료봉 evidence 미충족 — fail-closed'],
        candleSignal.dataQuality.flags),
      candleSignal,
    };
  }
  const frame15m = foundation.frames['15m'];
  const frame1h = foundation.frames['1h'];
  const frame4h = foundation.frames['4h'];
  if (!frame15m || !frame1h || !frame4h || frame15m.latestCloseTimeMs === null) {
    return notEvaluated(input, ['필수 완료 캔들 frame 누락 — fail-closed']);
  }

  const pattern15m = extractLatestCandleFeatures(frame15m.candles);
  const technical15m = computeCandleTechnicalSnapshot(frame15m.candles);
  const technical1h = computeCandleTechnicalSnapshot(frame1h.candles);
  const structure15m = computeMarketStructure(frame15m.candles);
  const structure1h = computeMarketStructure(frame1h.candles);
  const evidence = [pattern15m, technical15m, technical1h, structure15m, structure1h];
  if (evidence.some(item => item.quality === 'INVALID')) {
    return notEvaluated(input, ['MTF feature/structure INVALID — fail-closed'],
      evidence.flatMap(item => item.issues));
  }

  const sourceCandleCloseTime = frame15m.latestCloseTimeMs;
  const entryPrice = frame15m.candles.at(-1)!.c;
  const momentum = momentumPct(frame1h.candles.map(candle => candle.c), config.momentumLookback1hCandles);
  const regime = evaluateRegime({
    symbol,
    sourceCandleCloseTime,
    currentClose: entryPrice,
    momentumPct: momentum,
    technical: technical1h,
    structure: structure1h,
  }, input.previousRegime);
  if (regime.configVersion === 'INVALID' || regime.regime === 'UNKNOWN') {
    return notEvaluated(input, ['Regime evidence 평가 불가 — record 생성 금지'],
      [...regime.reasons, ...regime.warnings]);
  }

  const quality: StrategyDataQuality = foundation.quality === 'GOOD'
    && evidence.every(item => item.quality === 'GOOD') ? 'GOOD' : 'DEGRADED';
  const common = {
    symbol,
    sourceCandleCloseTime,
    evaluatedAt: input.evaluatedAt,
    entryPrice,
    expectedCostsBps: input.expectedCostsBps,
    dataQuality: quality,
    regime,
    structure1h,
    structure15m,
    pattern15m,
  };
  const candidates: StrategySignal[] = [
    evaluateTrendPullback({ ...common, atr15m: technical15m.atr.absolute }),
    evaluateVolatilityBreakout({ ...common, technical15m }),
    evaluateRangeMeanReversion({ ...common, technical15m }),
  ];
  const arbiter = arbitrateStrategySignals({
    symbol,
    regime: regime.regime,
    sourceCandleCloseTime,
    candidates,
  });
  const eligibility = arbiter.action === 'SELECT' && arbiter.selectedSignal !== null
    ? evaluateSignalEligibility(arbiter.selectedSignal, input.lifecycleRecords, input.historyEvents)
    : null;
  const netEdgeResearch = arbiter.action === 'SELECT' && arbiter.selectedSignal !== null
    ? evaluateStrategyNetEdgeResearch({
      signal: arbiter.selectedSignal,
      costEvidence: input.netEdgeCostEvidence ?? null,
      eligibility,
      evaluatedAt: input.evaluatedAt,
    })
    : null;
  const baseRecord = buildStrategyShadowRecord({
    symbol,
    evaluatedAt: input.evaluatedAt,
    arbiter,
    eligibility,
    existingAi: input.existingAi,
    netEdgeResearch,
  }, input.featureFlags ?? DEFAULT_STRATEGY_SHADOW_FEATURE_FLAGS);
  const candleSignalEvidence = buildCandleStrategyShadowEvidence({
    candleSignal,
    v2Regime: regime,
    shadowRecord: baseRecord,
  });
  if (candleSignalEvidence === null) {
    return {
      ...notEvaluated(input, ['Candle Signal과 v2 Ensemble identity/timestamp 결속 실패 — fail-closed']),
      candleSignal,
    };
  }
  const record: StrategyShadowRecord = { ...baseRecord, candleSignalEvidence };

  return {
    schemaVersion: STRATEGY_SHADOW_RUNNER_VERSION,
    status: 'EVALUATED',
    symbol,
    sourceCandleCloseTime,
    dataQuality: quality,
    regime,
    candidates,
    arbiter,
    eligibility,
    record,
    candleSignal,
    candleSignalEvidence,
    netEdgeResearch,
    reasons: ['완료된 15m/1h/4h candle evidence로 SHADOW record 계산'],
    warnings: foundation.issues,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}
