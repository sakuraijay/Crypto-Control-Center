/**
 * Pure, versioned restart codec for advisory Strategy Ensemble lifecycle state.
 *
 * This module performs no DB, network, worker, Risk, signer or execution I/O.
 * Malformed or ambiguous state restores to an empty fail-closed result instead
 * of silently dropping the evidence that prevents duplicate processing.
 */
import type { MarketRegime } from './regimeEngineV2';
import {
  SIGNAL_LIFECYCLE_CONFIG_VERSION,
  type SignalHistoryEvent,
  type SignalHistoryEventKind,
  type SignalLifecycleRecord,
  type SignalLifecycleStatus,
} from './signalLifecycleV2';
import type { StrategyDirection, StrategyId } from './strategySignalV2';

export const SIGNAL_LIFECYCLE_SNAPSHOT_VERSION = 'signal-lifecycle-snapshot/v1' as const;
const MAX_SNAPSHOT_ITEMS = 10_000;

export interface SignalLifecycleSnapshotV2 {
  schemaVersion: typeof SIGNAL_LIFECYCLE_SNAPSHOT_VERSION;
  configVersion: typeof SIGNAL_LIFECYCLE_CONFIG_VERSION;
  capturedAt: number;
  records: SignalLifecycleRecord[];
  historyEvents: SignalHistoryEvent[];
}

export type SignalLifecycleRestoreResult =
  | { ok: true; snapshot: SignalLifecycleSnapshotV2; warnings: string[] }
  | { ok: false; snapshot: null; records: []; historyEvents: []; reason: string };

const STATUSES = new Set<SignalLifecycleStatus>([
  'GENERATED', 'APPROVED', 'REDUCED', 'REJECTED', 'EXECUTED', 'EXPIRED', 'INVALIDATED',
]);
const STRATEGIES = new Set<StrategyId>([
  'TREND_PULLBACK', 'VOLATILITY_BREAKOUT', 'RANGE_MEAN_REVERSION',
]);
const DIRECTIONS = new Set<Exclude<StrategyDirection, 'NONE'>>(['LONG', 'SHORT']);
const EVENT_KINDS = new Set<SignalHistoryEventKind>([
  'STOP_LOSS', 'FAILED_BREAKOUT', 'TRADE_WIN', 'TRADE_LOSS', 'REGIME_CHANGE', 'DIRECTION_EXIT',
]);
const REGIMES = new Set<MarketRegime>([
  'TREND_UP', 'TREND_DOWN', 'RANGE', 'BREAKOUT_READY', 'HIGH_VOLATILITY',
  'TRANSITION', 'UNKNOWN',
]);
const SNAPSHOT_KEYS = new Set(['schemaVersion', 'configVersion', 'capturedAt', 'records', 'historyEvents']);
const RECORD_KEYS = new Set([
  'configVersion', 'signalId', 'symbol', 'strategyId', 'direction', 'sourceCandleCloseTime',
  'status', 'generatedAt', 'updatedAt', 'reason',
]);
const EVENT_KEYS = new Set([
  'eventId', 'kind', 'symbol', 'strategyId', 'direction', 'sourceCandleCloseTime',
  'regimeFrom', 'regimeTo',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
const positiveInteger = (value: unknown): value is number => finiteInteger(value) && value > 0;
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();
const hasOnlyKeys = (value: Record<string, unknown>, allowed: Set<string>): boolean =>
  Object.keys(value).every(key => allowed.has(key));
const nullableRegime = (value: unknown): value is MarketRegime | null | undefined =>
  value === undefined || value === null || REGIMES.has(value as MarketRegime);

function invalid(reason: string): SignalLifecycleRestoreResult {
  return { ok: false, snapshot: null, records: [], historyEvents: [], reason };
}

function parseRecord(value: unknown, capturedAt: number): SignalLifecycleRecord | null {
  if (!isObject(value) || !hasOnlyKeys(value, RECORD_KEYS)
    || value.configVersion !== SIGNAL_LIFECYCLE_CONFIG_VERSION
    || !nonEmpty(value.signalId) || !nonEmpty(value.symbol)
    || !STRATEGIES.has(value.strategyId as StrategyId)
    || !DIRECTIONS.has(value.direction as Exclude<StrategyDirection, 'NONE'>)
    || !STATUSES.has(value.status as SignalLifecycleStatus)
    || !positiveInteger(value.sourceCandleCloseTime)
    || !finiteInteger(value.generatedAt) || !finiteInteger(value.updatedAt)
    || value.sourceCandleCloseTime > value.generatedAt
    || value.generatedAt > value.updatedAt || value.updatedAt > capturedAt
    || !(value.reason === null || typeof value.reason === 'string')) return null;
  return {
    configVersion: SIGNAL_LIFECYCLE_CONFIG_VERSION,
    signalId: value.signalId.trim(),
    symbol: normalizeSymbol(value.symbol),
    strategyId: value.strategyId as StrategyId,
    direction: value.direction as Exclude<StrategyDirection, 'NONE'>,
    sourceCandleCloseTime: value.sourceCandleCloseTime,
    status: value.status as SignalLifecycleStatus,
    generatedAt: value.generatedAt,
    updatedAt: value.updatedAt,
    reason: value.reason as string | null,
  };
}

function parseEvent(value: unknown, capturedAt: number): SignalHistoryEvent | null {
  if (!isObject(value) || !hasOnlyKeys(value, EVENT_KEYS)
    || !nonEmpty(value.eventId) || !nonEmpty(value.symbol)
    || !EVENT_KINDS.has(value.kind as SignalHistoryEventKind)
    || !(value.strategyId === null || STRATEGIES.has(value.strategyId as StrategyId))
    || !(value.direction === null
      || DIRECTIONS.has(value.direction as Exclude<StrategyDirection, 'NONE'>))
    || !positiveInteger(value.sourceCandleCloseTime)
    || value.sourceCandleCloseTime > capturedAt
    || !nullableRegime(value.regimeFrom) || !nullableRegime(value.regimeTo)) return null;
  const parsed: SignalHistoryEvent = {
    eventId: value.eventId.trim(),
    kind: value.kind as SignalHistoryEventKind,
    symbol: normalizeSymbol(value.symbol),
    strategyId: value.strategyId as StrategyId | null,
    direction: value.direction as Exclude<StrategyDirection, 'NONE'> | null,
    sourceCandleCloseTime: value.sourceCandleCloseTime,
  };
  if (Object.prototype.hasOwnProperty.call(value, 'regimeFrom')) {
    parsed.regimeFrom = value.regimeFrom as MarketRegime | null;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'regimeTo')) {
    parsed.regimeTo = value.regimeTo as MarketRegime | null;
  }
  return parsed;
}

/** Strictly restore an object or JSON string. Invalid state is never partially accepted. */
export function restoreSignalLifecycleSnapshot(
  input: unknown,
  restoredAt: number,
): SignalLifecycleRestoreResult {
  if (!finiteInteger(restoredAt) || restoredAt <= 0) return invalid('복원 시각 INVALID — fail-closed');
  let value: unknown = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); }
    catch { return invalid('snapshot JSON 파싱 실패 — fail-closed'); }
  }
  if (!isObject(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)
    || value.schemaVersion !== SIGNAL_LIFECYCLE_SNAPSHOT_VERSION
    || value.configVersion !== SIGNAL_LIFECYCLE_CONFIG_VERSION
    || !positiveInteger(value.capturedAt) || value.capturedAt > restoredAt
    || !Array.isArray(value.records) || !Array.isArray(value.historyEvents)) {
    return invalid('snapshot schema/version/시각 INVALID — fail-closed');
  }
  if (value.records.length > MAX_SNAPSHOT_ITEMS || value.historyEvents.length > MAX_SNAPSHOT_ITEMS) {
    return invalid('snapshot 항목 상한 초과 — fail-closed');
  }
  const records = value.records.map(item => parseRecord(item, value.capturedAt as number));
  if (records.some(item => item === null)) return invalid('lifecycle record INVALID — fail-closed');
  const historyEvents = value.historyEvents.map(item => parseEvent(item, value.capturedAt as number));
  if (historyEvents.some(item => item === null)) return invalid('history event INVALID — fail-closed');

  const parsedRecords = records as SignalLifecycleRecord[];
  const parsedEvents = historyEvents as SignalHistoryEvent[];
  const signalIds = new Set<string>();
  const signalCandleKeys = new Set<string>();
  for (const record of parsedRecords) {
    const candleKey = [record.symbol, record.strategyId, record.direction,
      record.sourceCandleCloseTime].join(':');
    if (signalIds.has(record.signalId) || signalCandleKeys.has(candleKey)) {
      return invalid('중복 Signal ID 또는 동일 완료봉 Signal 충돌 — fail-closed');
    }
    signalIds.add(record.signalId);
    signalCandleKeys.add(candleKey);
  }
  const eventIds = new Set<string>();
  for (const event of parsedEvents) {
    if (eventIds.has(event.eventId)) return invalid('중복 History event ID — fail-closed');
    eventIds.add(event.eventId);
  }

  parsedRecords.sort((left, right) => left.sourceCandleCloseTime - right.sourceCandleCloseTime
    || left.signalId.localeCompare(right.signalId));
  parsedEvents.sort((left, right) => left.sourceCandleCloseTime - right.sourceCandleCloseTime
    || left.eventId.localeCompare(right.eventId));
  return {
    ok: true,
    warnings: [],
    snapshot: {
      schemaVersion: SIGNAL_LIFECYCLE_SNAPSHOT_VERSION,
      configVersion: SIGNAL_LIFECYCLE_CONFIG_VERSION,
      capturedAt: value.capturedAt as number,
      records: parsedRecords,
      historyEvents: parsedEvents,
    },
  };
}

/** Build a canonical snapshot only when the complete state passes the same restore contract. */
export function buildSignalLifecycleSnapshot(
  records: SignalLifecycleRecord[],
  historyEvents: SignalHistoryEvent[],
  capturedAt: number,
): SignalLifecycleSnapshotV2 | null {
  const candidate = {
    schemaVersion: SIGNAL_LIFECYCLE_SNAPSHOT_VERSION,
    configVersion: SIGNAL_LIFECYCLE_CONFIG_VERSION,
    capturedAt,
    records,
    historyEvents,
  };
  const restored = restoreSignalLifecycleSnapshot(candidate, capturedAt);
  return restored.ok ? restored.snapshot : null;
}

export function serializeSignalLifecycleSnapshot(snapshot: SignalLifecycleSnapshotV2): string | null {
  const restored = restoreSignalLifecycleSnapshot(snapshot, snapshot.capturedAt);
  return restored.ok ? JSON.stringify(restored.snapshot) : null;
}
