/** Pure Strategy Arbiter for Regime-Aware Strategy Ensemble v2. */
import type { MarketRegime } from './regimeEngineV2';
import type { StrategyId, StrategySignal } from './strategySignalV2';

export const STRATEGY_ARBITER_CONFIG_VERSION = 'strategy-arbiter/v1' as const;

export interface StrategyArbiterConfig {
  version: typeof STRATEGY_ARBITER_CONFIG_VERSION;
  minConfidence: number;
  minimumNetEdgeBps: number;
  minimumNetRR: number;
  minimumScoreSeparation: number;
  confidenceWeight: number;
  netEdgeWeight: number;
  netRRWeight: number;
  netEdgeScoreCapBps: number;
  netRRScoreCap: number;
}

export const DEFAULT_STRATEGY_ARBITER_CONFIG: StrategyArbiterConfig = Object.freeze({
  version: STRATEGY_ARBITER_CONFIG_VERSION,
  minConfidence: 70,
  minimumNetEdgeBps: 0,
  minimumNetRR: 1.5,
  minimumScoreSeparation: 5,
  confidenceWeight: 0.4,
  netEdgeWeight: 0.3,
  netRRWeight: 0.3,
  netEdgeScoreCapBps: 500,
  netRRScoreCap: 4,
});

export type StrategyArbiterAction = 'SELECT' | 'NO_TRADE' | 'REJECT';

export interface StrategyArbiterRejectedCandidate {
  signalId: string;
  strategyId: StrategyId;
  reasons: string[];
}

export interface StrategyArbiterDecision {
  configVersion: typeof STRATEGY_ARBITER_CONFIG_VERSION | 'INVALID';
  decisionId: string;
  symbol: string;
  regime: MarketRegime;
  sourceCandleCloseTime: number;
  action: StrategyArbiterAction;
  selectedSignal: StrategySignal | null;
  selectedScore: number | null;
  consideredSignalIds: string[];
  rejectedCandidates: StrategyArbiterRejectedCandidate[];
  reasons: string[];
  warnings: string[];
}

export interface StrategyArbiterInput {
  symbol: string;
  regime: MarketRegime;
  sourceCandleCloseTime: number;
  candidates: StrategySignal[];
}

const REGIME_STRATEGY: Partial<Record<MarketRegime, StrategyId>> = Object.freeze({
  TREND_UP: 'TREND_PULLBACK',
  TREND_DOWN: 'TREND_PULLBACK',
  BREAKOUT_READY: 'VOLATILITY_BREAKOUT',
  RANGE: 'RANGE_MEAN_REVERSION',
});

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));
const round = (value: number): number => Number(value.toPrecision(12));
const normalizedSymbol = (symbol: string): string => symbol.trim().toUpperCase();

export function validateStrategyArbiterConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['arbiter config 객체 필요'];
  const record = value as Record<string, unknown>;
  const numeric = ['minConfidence', 'minimumNetEdgeBps', 'minimumNetRR',
    'minimumScoreSeparation', 'confidenceWeight', 'netEdgeWeight', 'netRRWeight',
    'netEdgeScoreCapBps', 'netRRScoreCap'] as const;
  const expected = ['version', ...numeric] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 config 필드: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`config 필드 누락: ${key}`);
  }
  if (record.version !== STRATEGY_ARBITER_CONFIG_VERSION) issues.push('지원하지 않는 config version');
  for (const key of numeric) {
    if (!finite(record[key]) || (record[key] as number) < 0) issues.push(`${key} 범위 오류`);
  }
  if (finite(record.minConfidence) && record.minConfidence > 100) issues.push('minConfidence 범위 오류');
  if (finite(record.minimumScoreSeparation) && record.minimumScoreSeparation > 100) {
    issues.push('minimumScoreSeparation 범위 오류');
  }
  if (finite(record.netEdgeScoreCapBps) && record.netEdgeScoreCapBps <= 0) issues.push('netEdgeScoreCapBps 범위 오류');
  if (finite(record.netRRScoreCap) && record.netRRScoreCap <= 0) issues.push('netRRScoreCap 범위 오류');
  const weights = [record.confidenceWeight, record.netEdgeWeight, record.netRRWeight];
  if (weights.every(finite)) {
    const total = (weights as number[]).reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(total - 1) > 1e-9) issues.push('arbiter score weight 합은 1이어야 함');
  }
  return issues;
}

function decisionId(input: StrategyArbiterInput): string {
  return [normalizedSymbol(input.symbol), 'STRATEGY_ARBITER', input.regime, input.sourceCandleCloseTime].join(':');
}

function baseDecision(
  input: StrategyArbiterInput,
  action: StrategyArbiterAction,
  configVersion: StrategyArbiterDecision['configVersion'],
  reasons: string[],
  warnings: string[] = [],
): StrategyArbiterDecision {
  return {
    configVersion,
    decisionId: decisionId(input),
    symbol: normalizedSymbol(input.symbol),
    regime: input.regime,
    sourceCandleCloseTime: input.sourceCandleCloseTime,
    action,
    selectedSignal: null,
    selectedScore: null,
    consideredSignalIds: [],
    rejectedCandidates: [],
    reasons,
    warnings,
  };
}

function candidateScore(signal: StrategySignal, config: StrategyArbiterConfig): number {
  const confidence = clamp(signal.confidence, 0, 100);
  const netEdge = clamp((signal.netExpectedEdgeBps ?? 0) / config.netEdgeScoreCapBps * 100, 0, 100);
  const netRR = clamp((signal.expectedNetRR ?? 0) / config.netRRScoreCap * 100, 0, 100);
  return round(confidence * config.confidenceWeight
    + netEdge * config.netEdgeWeight
    + netRR * config.netRRWeight);
}

function sameSignal(left: StrategySignal, right: StrategySignal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Selects at most one advisory signal. This function cannot persist, size, authorize, or execute.
 * Risk Engine and PAPER/LIVE Execution Gate retain final authority.
 */
export function arbitrateStrategySignals(
  input: StrategyArbiterInput,
  configInput: unknown = DEFAULT_STRATEGY_ARBITER_CONFIG,
): StrategyArbiterDecision {
  const configIssues = validateStrategyArbiterConfig(configInput);
  if (configIssues.length > 0) return baseDecision(input, 'REJECT', 'INVALID', ['config INVALID'], configIssues);
  const config = configInput as StrategyArbiterConfig;
  if (!input.symbol.trim() || !finite(input.sourceCandleCloseTime) || input.sourceCandleCloseTime <= 0
    || !Array.isArray(input.candidates)) {
    return baseDecision(input, 'REJECT', config.version, ['입력값 INVALID']);
  }

  const decision = baseDecision(input, 'NO_TRADE', config.version, []);
  const symbol = normalizedSymbol(input.symbol);
  const unique = new Map<string, StrategySignal>();
  for (const candidate of input.candidates) {
    if (candidate.schemaVersion !== 'strategy-signal/v2') {
      return { ...decision, action: 'REJECT', reasons: ['지원하지 않는 Signal schema version'] };
    }
    if (normalizedSymbol(candidate.symbol) !== symbol
      || candidate.sourceCandleCloseTime !== input.sourceCandleCloseTime) {
      return { ...decision, action: 'REJECT', reasons: ['종목 또는 완료 캔들 시각 불일치 — fail-closed'] };
    }
    const existing = unique.get(candidate.signalId);
    if (existing && !sameSignal(existing, candidate)) {
      return { ...decision, action: 'REJECT', reasons: ['동일 Signal ID의 내용 충돌 — fail-closed'] };
    }
    if (existing) decision.warnings.push(`중복 Signal ID 제거: ${candidate.signalId}`);
    else unique.set(candidate.signalId, candidate);
  }
  decision.consideredSignalIds = [...unique.keys()].sort();

  const uniqueCandidates = [...unique.values()];
  if (uniqueCandidates.some(candidate => candidate.dataQuality === 'INVALID')) {
    return { ...decision, action: 'REJECT', reasons: ['Data Quality INVALID — fail-closed'] };
  }
  const expectedStrategy = REGIME_STRATEGY[input.regime];
  if (!expectedStrategy) {
    return { ...decision, reasons: [`${input.regime} Regime에서는 신규 전략 비활성 — NO TRADE`] };
  }

  const eligible: StrategySignal[] = [];
  for (const candidate of uniqueCandidates) {
    const reasons: string[] = [];
    if (candidate.direction === 'NONE') reasons.push('활성 방향 없음');
    if (candidate.regime !== input.regime) reasons.push('현재 Regime과 Signal Regime 불일치');
    if (candidate.strategyId !== expectedStrategy) reasons.push('현재 Regime에서 전략 비활성');
    if (candidate.dataQuality !== 'GOOD') reasons.push('Data Quality GOOD 아님');
    if (!finite(candidate.confidence) || candidate.confidence < config.minConfidence) reasons.push('최소 confidence 미달');
    if (candidate.structuralStop === null || !finite(candidate.structuralStop)
      || candidate.stopDistancePct === null || !finite(candidate.stopDistancePct)
      || candidate.stopDistancePct <= 0) reasons.push('명확한 Structural Stop 없음');
    if (candidate.netExpectedEdgeBps === null || !finite(candidate.netExpectedEdgeBps)
      || candidate.netExpectedEdgeBps <= config.minimumNetEdgeBps) reasons.push('최소 Net Edge 미달');
    if (candidate.expectedNetRR === null || !finite(candidate.expectedNetRR)
      || candidate.expectedNetRR < config.minimumNetRR) reasons.push('최소 Net R:R 미달');
    if (reasons.length > 0) {
      decision.rejectedCandidates.push({
        signalId: candidate.signalId,
        strategyId: candidate.strategyId,
        reasons,
      });
    } else eligible.push(candidate);
  }
  if (eligible.length === 0) {
    return { ...decision, reasons: ['Regime·품질·비용·구조 기준을 충족한 전략 없음 — NO TRADE'] };
  }

  const directions = new Set(eligible.map(candidate => candidate.direction));
  if (directions.size > 1) {
    return { ...decision, reasons: ['반대 방향 전략 신호 충돌 — NO TRADE'] };
  }

  const ranked = eligible.map(signal => ({ signal, score: candidateScore(signal, config) }))
    .sort((left, right) => right.score - left.score
      || (right.signal.netExpectedEdgeBps ?? 0) - (left.signal.netExpectedEdgeBps ?? 0)
      || (right.signal.expectedNetRR ?? 0) - (left.signal.expectedNetRR ?? 0)
      || right.signal.confidence - left.signal.confidence
      || left.signal.signalId.localeCompare(right.signal.signalId));
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < config.minimumScoreSeparation) {
    return { ...decision, reasons: ['상위 전략 점수 차이 부족 — NO TRADE'] };
  }

  return {
    ...decision,
    action: 'SELECT',
    selectedSignal: ranked[0].signal,
    selectedScore: ranked[0].score,
    reasons: [
      `${input.regime} Regime과 ${ranked[0].signal.strategyId} 일치`,
      'Data Quality·Structural Stop·Net Edge·Net R:R 기준 충족',
      'Strategy Arbiter가 단일 후보 선택 — Risk Engine 최종 판단 필요',
    ],
  };
}
