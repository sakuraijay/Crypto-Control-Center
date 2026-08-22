/** Pure signal lifecycle and completed-candle cooldown policy for Strategy Ensemble v2. */
import type { MarketRegime } from './regimeEngineV2';
import type { StrategyDirection, StrategyId, StrategySignal } from './strategySignalV2';

export const SIGNAL_LIFECYCLE_CONFIG_VERSION = 'signal-lifecycle/v1' as const;

export type SignalLifecycleStatus = 'GENERATED' | 'APPROVED' | 'REDUCED' | 'REJECTED'
  | 'EXECUTED' | 'EXPIRED' | 'INVALIDATED';

export interface SignalLifecycleConfig {
  version: typeof SIGNAL_LIFECYCLE_CONFIG_VERSION;
  candleDurationMs: number;
  stopLossCooldownCandles: number;
  failedBreakoutCooldownCandles: number;
  strategyLossStreakThreshold: number;
  strategyLossCooldownCandles: number;
  symbolLossStreakThreshold: number;
  symbolLossCooldownCandles: number;
  regimeChangeCooldownCandles: number;
  directionFlipCooldownCandles: number;
}

export const DEFAULT_SIGNAL_LIFECYCLE_CONFIG: SignalLifecycleConfig = Object.freeze({
  version: SIGNAL_LIFECYCLE_CONFIG_VERSION,
  candleDurationMs: 15 * 60 * 1_000,
  stopLossCooldownCandles: 3,
  failedBreakoutCooldownCandles: 3,
  strategyLossStreakThreshold: 2,
  strategyLossCooldownCandles: 2,
  symbolLossStreakThreshold: 3,
  symbolLossCooldownCandles: 3,
  regimeChangeCooldownCandles: 1,
  directionFlipCooldownCandles: 2,
});

export interface SignalLifecycleRecord {
  configVersion: typeof SIGNAL_LIFECYCLE_CONFIG_VERSION;
  signalId: string;
  symbol: string;
  strategyId: StrategyId;
  direction: Exclude<StrategyDirection, 'NONE'>;
  sourceCandleCloseTime: number;
  status: SignalLifecycleStatus;
  generatedAt: number;
  updatedAt: number;
  reason: string | null;
}

export type SignalHistoryEventKind = 'STOP_LOSS' | 'FAILED_BREAKOUT' | 'TRADE_WIN'
  | 'TRADE_LOSS' | 'REGIME_CHANGE' | 'DIRECTION_EXIT';

export interface SignalHistoryEvent {
  eventId: string;
  kind: SignalHistoryEventKind;
  symbol: string;
  strategyId: StrategyId | null;
  direction: Exclude<StrategyDirection, 'NONE'> | null;
  sourceCandleCloseTime: number;
  regimeFrom?: MarketRegime | null;
  regimeTo?: MarketRegime | null;
}

export type SignalEligibilityCode = 'ELIGIBLE' | 'DUPLICATE_SIGNAL' | 'STOP_LOSS_COOLDOWN'
  | 'FAILED_BREAKOUT_COOLDOWN' | 'STRATEGY_LOSS_COOLDOWN' | 'SYMBOL_LOSS_COOLDOWN'
  | 'REGIME_CHANGE_COOLDOWN' | 'DIRECTION_FLIP_COOLDOWN' | 'INPUT_INVALID';

export interface SignalEligibilityDecision {
  configVersion: typeof SIGNAL_LIFECYCLE_CONFIG_VERSION | 'INVALID';
  signalId: string;
  eligible: boolean;
  codes: SignalEligibilityCode[];
  blockedUntilCandleCloseTime: number | null;
  strategyConsecutiveLosses: number;
  symbolConsecutiveLosses: number;
  reasons: string[];
  warnings: string[];
}

const TRANSITIONS: Readonly<Record<SignalLifecycleStatus, readonly SignalLifecycleStatus[]>> = Object.freeze({
  GENERATED: ['APPROVED', 'REDUCED', 'REJECTED', 'EXPIRED', 'INVALIDATED'],
  APPROVED: ['EXECUTED', 'EXPIRED', 'INVALIDATED'],
  REDUCED: ['EXECUTED', 'EXPIRED', 'INVALIDATED'],
  REJECTED: [],
  EXECUTED: [],
  EXPIRED: [],
  INVALIDATED: [],
});

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();
const isPositiveInteger = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value > 0;
const sameEvent = (left: SignalHistoryEvent, right: SignalHistoryEvent): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const lossKind = (kind: SignalHistoryEventKind): boolean => kind === 'STOP_LOSS' || kind === 'TRADE_LOSS';
const resultKind = (kind: SignalHistoryEventKind): boolean => lossKind(kind) || kind === 'TRADE_WIN';

export function validateSignalLifecycleConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['lifecycle config 객체 필요'];
  const record = value as Record<string, unknown>;
  const numeric = ['candleDurationMs', 'stopLossCooldownCandles', 'failedBreakoutCooldownCandles',
    'strategyLossStreakThreshold', 'strategyLossCooldownCandles', 'symbolLossStreakThreshold',
    'symbolLossCooldownCandles', 'regimeChangeCooldownCandles', 'directionFlipCooldownCandles'] as const;
  const expected = ['version', ...numeric] as const;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!expected.includes(key as typeof expected[number])) issues.push(`알 수 없는 config 필드: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`config 필드 누락: ${key}`);
  }
  if (record.version !== SIGNAL_LIFECYCLE_CONFIG_VERSION) issues.push('지원하지 않는 config version');
  for (const key of numeric) {
    if (!isPositiveInteger(record[key])) issues.push(`${key} 양의 정수 필요`);
  }
  return issues;
}

export function createSignalLifecycleRecord(
  signal: StrategySignal,
  generatedAt: number,
): SignalLifecycleRecord | null {
  if (!signal.signalId.trim() || !signal.symbol.trim() || signal.direction === 'NONE'
    || !finite(signal.sourceCandleCloseTime) || signal.sourceCandleCloseTime <= 0
    || !finite(generatedAt) || generatedAt < signal.sourceCandleCloseTime) return null;
  return {
    configVersion: SIGNAL_LIFECYCLE_CONFIG_VERSION,
    signalId: signal.signalId,
    symbol: normalizeSymbol(signal.symbol),
    strategyId: signal.strategyId,
    direction: signal.direction,
    sourceCandleCloseTime: signal.sourceCandleCloseTime,
    status: 'GENERATED',
    generatedAt,
    updatedAt: generatedAt,
    reason: null,
  };
}

export function transitionSignalLifecycle(
  record: SignalLifecycleRecord,
  nextStatus: SignalLifecycleStatus,
  updatedAt: number,
  reason: string | null = null,
): SignalLifecycleRecord | null {
  const allowed = TRANSITIONS[record.status];
  if (record.configVersion !== SIGNAL_LIFECYCLE_CONFIG_VERSION
    || !finite(updatedAt) || updatedAt < record.updatedAt
    || !Array.isArray(allowed) || !allowed.includes(nextStatus)) return null;
  return { ...record, status: nextStatus, updatedAt, reason };
}

function consecutiveLosses(
  events: SignalHistoryEvent[],
  predicate: (event: SignalHistoryEvent) => boolean,
): { count: number; latestLossClose: number | null } {
  const results = events.filter(event => resultKind(event.kind) && predicate(event))
    .sort((left, right) => right.sourceCandleCloseTime - left.sourceCandleCloseTime);
  let count = 0;
  let latestLossClose: number | null = null;
  for (const event of results) {
    if (!lossKind(event.kind)) break;
    if (latestLossClose === null) latestLossClose = event.sourceCandleCloseTime;
    count += 1;
  }
  return { count, latestLossClose };
}

function cooldownEnd(eventClose: number, candleCount: number, config: SignalLifecycleConfig): number {
  return eventClose + candleCount * config.candleDurationMs;
}

export function evaluateSignalEligibility(
  signal: StrategySignal,
  records: SignalLifecycleRecord[],
  historyInput: SignalHistoryEvent[],
  configInput: unknown = DEFAULT_SIGNAL_LIFECYCLE_CONFIG,
): SignalEligibilityDecision {
  const configIssues = validateSignalLifecycleConfig(configInput);
  const decision: SignalEligibilityDecision = {
    configVersion: configIssues.length > 0 ? 'INVALID' : SIGNAL_LIFECYCLE_CONFIG_VERSION,
    signalId: signal.signalId,
    eligible: false,
    codes: [],
    blockedUntilCandleCloseTime: null,
    strategyConsecutiveLosses: 0,
    symbolConsecutiveLosses: 0,
    reasons: [],
    warnings: configIssues,
  };
  if (configIssues.length > 0) {
    decision.codes.push('INPUT_INVALID');
    decision.reasons.push('config INVALID — fail-closed');
    return decision;
  }
  const config = configInput as SignalLifecycleConfig;
  const symbol = normalizeSymbol(signal.symbol);
  if (!signal.signalId.trim() || !symbol || signal.direction === 'NONE'
    || !finite(signal.sourceCandleCloseTime) || signal.sourceCandleCloseTime <= 0
    || !Array.isArray(records) || !Array.isArray(historyInput)) {
    decision.codes.push('INPUT_INVALID');
    decision.reasons.push('Signal 또는 lifecycle 입력 INVALID — fail-closed');
    return decision;
  }
  if (records.some(record => record.signalId === signal.signalId)) {
    decision.codes.push('DUPLICATE_SIGNAL');
    decision.reasons.push('동일 Signal ID가 이미 처리됨 — 재처리 금지');
  }

  const eventMap = new Map<string, SignalHistoryEvent>();
  for (const event of historyInput) {
    if (!event.eventId.trim() || !event.symbol.trim() || !finite(event.sourceCandleCloseTime)
      || event.sourceCandleCloseTime <= 0 || event.sourceCandleCloseTime > signal.sourceCandleCloseTime) {
      decision.codes.push('INPUT_INVALID');
      decision.reasons.push('History event INVALID 또는 미래 시각 — fail-closed');
      return decision;
    }
    const existing = eventMap.get(event.eventId);
    if (existing && !sameEvent(existing, event)) {
      decision.codes.push('INPUT_INVALID');
      decision.reasons.push('동일 History event ID의 내용 충돌 — fail-closed');
      return decision;
    }
    if (existing) decision.warnings.push(`중복 History event 제거: ${event.eventId}`);
    else eventMap.set(event.eventId, { ...event, symbol: normalizeSymbol(event.symbol) });
  }
  const history = [...eventMap.values()];
  const direction = signal.direction;
  const blockedEnds: number[] = [];
  const block = (code: SignalEligibilityCode, reason: string, end: number): void => {
    if (signal.sourceCandleCloseTime < end) {
      decision.codes.push(code);
      decision.reasons.push(reason);
      blockedEnds.push(end);
    }
  };
  const latest = (predicate: (event: SignalHistoryEvent) => boolean): SignalHistoryEvent | null =>
    history.filter(predicate).sort((left, right) => right.sourceCandleCloseTime - left.sourceCandleCloseTime)[0] ?? null;

  const stopLoss = latest(event => event.kind === 'STOP_LOSS' && event.symbol === symbol
    && event.direction === direction);
  if (stopLoss) block('STOP_LOSS_COOLDOWN', '동일 종목·방향 Stop Loss cooldown',
    cooldownEnd(stopLoss.sourceCandleCloseTime, config.stopLossCooldownCandles, config));

  const failedBreakout = latest(event => event.kind === 'FAILED_BREAKOUT' && event.symbol === symbol
    && event.strategyId === signal.strategyId && event.direction === direction);
  if (failedBreakout) block('FAILED_BREAKOUT_COOLDOWN', '동일 방향 Failed Breakout cooldown',
    cooldownEnd(failedBreakout.sourceCandleCloseTime, config.failedBreakoutCooldownCandles, config));

  const strategyLosses = consecutiveLosses(history, event => event.strategyId === signal.strategyId);
  decision.strategyConsecutiveLosses = strategyLosses.count;
  if (strategyLosses.count >= config.strategyLossStreakThreshold && strategyLosses.latestLossClose !== null) {
    block('STRATEGY_LOSS_COOLDOWN', '동일 전략 연속 손실 cooldown',
      cooldownEnd(strategyLosses.latestLossClose, config.strategyLossCooldownCandles, config));
  }

  const symbolLosses = consecutiveLosses(history, event => event.symbol === symbol);
  decision.symbolConsecutiveLosses = symbolLosses.count;
  if (symbolLosses.count >= config.symbolLossStreakThreshold && symbolLosses.latestLossClose !== null) {
    block('SYMBOL_LOSS_COOLDOWN', '동일 종목 연속 손실 cooldown',
      cooldownEnd(symbolLosses.latestLossClose, config.symbolLossCooldownCandles, config));
  }

  const regimeChange = latest(event => event.kind === 'REGIME_CHANGE' && event.symbol === symbol);
  if (regimeChange) block('REGIME_CHANGE_COOLDOWN', 'Regime 전환 직후 확인봉 대기',
    cooldownEnd(regimeChange.sourceCandleCloseTime, config.regimeChangeCooldownCandles, config));

  const oppositeDirection = direction === 'LONG' ? 'SHORT' : 'LONG';
  const directionExit = latest(event => event.kind === 'DIRECTION_EXIT' && event.symbol === symbol
    && event.direction === oppositeDirection);
  if (directionExit) block('DIRECTION_FLIP_COOLDOWN', '짧은 시간 LONG↔SHORT 반복 전환 cooldown',
    cooldownEnd(directionExit.sourceCandleCloseTime, config.directionFlipCooldownCandles, config));

  decision.blockedUntilCandleCloseTime = blockedEnds.length > 0 ? Math.max(...blockedEnds) : null;
  if (decision.codes.length === 0) {
    decision.eligible = true;
    decision.codes.push('ELIGIBLE');
    decision.reasons.push('중복·Stop·Whipsaw·연속 손실 cooldown 통과');
  }
  return decision;
}
