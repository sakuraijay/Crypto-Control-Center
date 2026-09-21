import type { SignalLifecycleSnapshotV2 } from '../intel/signalLifecycleSnapshotV2';
import type { RegimeState } from '../intel/regimeEngineV2';
import type { StrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import {
  advanceStrategyShadowLifecycleSnapshot,
  advanceStrategyShadowRegimeSnapshot,
  restoreStrategyShadowLifecycleFromDecisionFullJson,
  restoreStrategyShadowRegimesFromDecisionFullJson,
  validateStrategyPreviousRegimes,
  type StrategyRegimeSnapshotV1,
} from '../intel/strategyShadowLifecycleRuntimeV2';

export const VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION =
  'virtual-paper-400-strategy-continuity/v2' as const;
const LEGACY_VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION =
  'virtual-paper-400-strategy-continuity/v1' as const;

export interface VirtualPaper400StrategyContinuityState {
  schemaVersion: typeof VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION;
  sessionId: string;
  updatedAt: number;
  lastEnvelopeStatus: StrategyShadowWorkerEnvelope['status'];
  lastSourceCandleCloseTimeBySymbol: Record<string, number>;
  strategyEnsembleShadow: {
    lifecycleSnapshot: SignalLifecycleSnapshotV2;
    regimeSnapshot: StrategyRegimeSnapshotV1;
  };
}

export type VirtualPaper400StrategyContinuityRestore =
  | { status: 'MISSING' | 'RESTORED'; state: VirtualPaper400StrategyContinuityState;
      lifecycleSnapshot: SignalLifecycleSnapshotV2; previousRegimes: Record<string, RegimeState> }
  | { status: 'BLOCKED'; state: null; lifecycleSnapshot: null; previousRegimes: null; reason: string };

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const finiteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);

export function virtualPaper400StrategyContinuityKey(sessionId: string): string {
  return `virtual_paper_400_strategy_continuity_v1:${sessionId}`;
}

function initialState(
  sessionId: string,
  restoredAt: number,
  allowedSymbols: readonly string[],
): VirtualPaper400StrategyContinuityRestore {
  const lifecycle = restoreStrategyShadowLifecycleFromDecisionFullJson(null, restoredAt);
  const regimes = restoreStrategyShadowRegimesFromDecisionFullJson(null, restoredAt);
  if (lifecycle.status === 'BLOCKED' || regimes.status === 'BLOCKED') {
    return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
      previousRegimes: null, reason: 'STRATEGY_CONTINUITY_INITIALIZATION_FAILED' };
  }
  const validated = validateStrategyPreviousRegimes(regimes.previousRegimes, restoredAt, allowedSymbols);
  if (!validated) return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
    previousRegimes: null, reason: 'STRATEGY_CONTINUITY_SYMBOLS_INVALID' };
  return {
    status: 'MISSING',
    state: {
      schemaVersion: VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION,
      sessionId,
      updatedAt: restoredAt,
      lastEnvelopeStatus: 'NOT_EVALUATED',
      lastSourceCandleCloseTimeBySymbol: {},
      strategyEnsembleShadow: {
        lifecycleSnapshot: lifecycle.snapshot,
        regimeSnapshot: regimes.snapshot,
      },
    },
    lifecycleSnapshot: lifecycle.snapshot,
    previousRegimes: validated,
  };
}

/** Strict session-scoped restore. Invalid durable state never degrades to an empty baseline. */
export function restoreVirtualPaper400StrategyContinuity(
  raw: unknown,
  sessionId: string,
  restoredAt: number,
  allowedSymbols: readonly string[],
): VirtualPaper400StrategyContinuityRestore {
  if (!finiteInteger(restoredAt) || restoredAt <= 0 || !sessionId) {
    return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
      previousRegimes: null, reason: 'STRATEGY_CONTINUITY_RESTORE_INPUT_INVALID' };
  }
  if (raw === null || raw === undefined || raw === '') {
    return initialState(sessionId, restoredAt, allowedSymbols);
  }
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); }
    catch { return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
      previousRegimes: null, reason: 'STRATEGY_CONTINUITY_JSON_INVALID' }; }
  }
  const state = object(parsed);
  const shadow = state ? object(state.strategyEnsembleShadow) : null;
  if (!state || (state.schemaVersion !== VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION
      && state.schemaVersion !== LEGACY_VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION)
    || state.sessionId !== sessionId || !finiteInteger(state.updatedAt)
    || state.updatedAt <= 0 || state.updatedAt > restoredAt
    || !['NOT_EVALUATED', 'PARTIAL', 'EVALUATED', 'BLOCKED'].includes(String(state.lastEnvelopeStatus))
    || !shadow || !Object.prototype.hasOwnProperty.call(shadow, 'lifecycleSnapshot')
    || !Object.prototype.hasOwnProperty.call(shadow, 'regimeSnapshot')) {
    return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
      previousRegimes: null, reason: 'STRATEGY_CONTINUITY_STATE_INVALID' };
  }
  if (state.schemaVersion === LEGACY_VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION) {
    // v1 could count one completed 15-minute candle once per one-minute worker
    // tick. Its derived SHADOW evidence is not safe to reuse. Discard only that
    // evidence and retain a cursor; financial state and protection live elsewhere.
    const migrated = initialState(sessionId, restoredAt, allowedSymbols);
    if (migrated.status === 'BLOCKED') return migrated;
    const boundary = Math.floor((state.updatedAt as number) / (15 * 60_000)) * 15 * 60_000;
    for (const symbol of allowedSymbols) {
      migrated.state.lastSourceCandleCloseTimeBySymbol[symbol.trim().toUpperCase()] = boundary;
    }
    return { ...migrated, status: 'RESTORED' };
  }
  const lifecycle = restoreStrategyShadowLifecycleFromDecisionFullJson(state, restoredAt);
  const regimes = restoreStrategyShadowRegimesFromDecisionFullJson(state, restoredAt);
  if (lifecycle.status === 'BLOCKED' || regimes.status === 'BLOCKED'
    || lifecycle.snapshot.capturedAt > (state.updatedAt as number)
    || regimes.snapshot.capturedAt > (state.updatedAt as number)) {
    return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
      previousRegimes: null, reason: 'STRATEGY_CONTINUITY_SNAPSHOT_INVALID' };
  }
  const validated = validateStrategyPreviousRegimes(regimes.previousRegimes, restoredAt, allowedSymbols);
  if (!validated) return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
    previousRegimes: null, reason: 'STRATEGY_CONTINUITY_SYMBOLS_INVALID' };
  const rawLast = object(state.lastSourceCandleCloseTimeBySymbol);
  const allowed = new Set(allowedSymbols.map(symbol => symbol.trim().toUpperCase()));
  const lastSourceCandleCloseTimeBySymbol: Record<string, number> = {};
  if (rawLast) {
    for (const [rawSymbol, value] of Object.entries(rawLast)) {
      const symbol = rawSymbol.trim().toUpperCase();
      if (!allowed.has(symbol) || !finiteInteger(value) || value <= 0 || value > restoredAt) {
        return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
          previousRegimes: null, reason: 'STRATEGY_CONTINUITY_CANDLE_CURSOR_INVALID' };
      }
      lastSourceCandleCloseTimeBySymbol[symbol] = value;
    }
  } else {
    // One-time migration for the just-introduced v1 state: use the last closed
    // 15-minute boundary at its own durable update time. This prevents the next
    // one-minute worker tick from counting the same completed candle again.
    const boundary = Math.floor((state.updatedAt as number) / (15 * 60_000)) * 15 * 60_000;
    for (const symbol of Object.keys(validated)) lastSourceCandleCloseTimeBySymbol[symbol] = boundary;
  }
  const normalizedState = {
    ...(state as unknown as VirtualPaper400StrategyContinuityState),
    lastSourceCandleCloseTimeBySymbol,
  };
  return {
    status: 'RESTORED',
    state: normalizedState,
    lifecycleSnapshot: lifecycle.snapshot,
    previousRegimes: validated,
  };
}

/** Advances only validated SHADOW evidence; it never grants Risk or execution authority. */
export function advanceVirtualPaper400StrategyContinuity(
  sessionId: string,
  previous: VirtualPaper400StrategyContinuityRestore,
  envelope: StrategyShadowWorkerEnvelope,
  capturedAt: number,
): VirtualPaper400StrategyContinuityState | null {
  if (previous.status === 'BLOCKED') return null;
  const lifecycleSnapshot = advanceStrategyShadowLifecycleSnapshot(
    previous.lifecycleSnapshot, envelope, capturedAt,
  );
  const regimeSnapshot = advanceStrategyShadowRegimeSnapshot(
    previous.previousRegimes, envelope, capturedAt,
  );
  if (!lifecycleSnapshot || !regimeSnapshot) return null;
  return {
    schemaVersion: VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION,
    sessionId,
    updatedAt: capturedAt,
    lastEnvelopeStatus: envelope.status,
    lastSourceCandleCloseTimeBySymbol: { ...previous.state.lastSourceCandleCloseTimeBySymbol },
    strategyEnsembleShadow: { lifecycleSnapshot, regimeSnapshot },
  };
}

/** Drops repeated/out-of-order completed-candle records before they can affect entry or hysteresis. */
export function filterNewVirtualPaper400StrategyRecords(
  previous: VirtualPaper400StrategyContinuityRestore,
  envelope: StrategyShadowWorkerEnvelope,
  evaluatedAt: number,
): { envelope: StrategyShadowWorkerEnvelope; cursors: Record<string, number> } | null {
  if (previous.status === 'BLOCKED') return null;
  const cursors = { ...previous.state.lastSourceCandleCloseTimeBySymbol };
  const records = [] as StrategyShadowWorkerEnvelope['records'];
  for (const record of envelope.records) {
    const symbol = record.symbol.trim().toUpperCase();
    if (!symbol || !finiteInteger(record.sourceCandleCloseTime)
      || record.sourceCandleCloseTime <= 0 || record.sourceCandleCloseTime > evaluatedAt) return null;
    if (record.sourceCandleCloseTime <= (cursors[symbol] ?? 0)) continue;
    records.push(record);
    cursors[symbol] = record.sourceCandleCloseTime;
  }
  if (records.length === envelope.records.length) return { envelope, cursors };
  const evaluatedSymbols = [...new Set(records.map(record => record.symbol.trim().toUpperCase()))].sort();
  const evaluated = new Set(evaluatedSymbols);
  return {
    cursors,
    envelope: {
      ...envelope,
      status: records.length ? 'PARTIAL' : 'NOT_EVALUATED',
      records,
      evaluatedSymbols,
      missingSymbols: envelope.expectedSymbols.filter(symbol => !evaluated.has(symbol)),
      reasons: [...envelope.reasons, '중복/역순 완료봉 record 제외 — hysteresis 재계산 금지'],
      summary: { long: records.filter(row => row.action === 'LONG').length,
        short: records.filter(row => row.action === 'SHORT').length,
        noTrade: records.filter(row => row.action === 'NO_TRADE').length,
        rejected: records.filter(row => row.action === 'REJECTED').length,
        disabled: records.filter(row => row.action === 'DISABLED').length,
        directionConflicts: records.filter(row => row.comparison === 'DIRECTION_CONFLICT').length },
    },
  };
}

export function summarizeVirtualPaper400StrategyContinuity(
  restored: VirtualPaper400StrategyContinuityRestore,
) {
  if (restored.status === 'BLOCKED') return { status: 'BLOCKED' as const, reason: restored.reason };
  return {
    status: restored.status,
    updatedAt: restored.state.updatedAt,
    lastEnvelopeStatus: restored.state.lastEnvelopeStatus,
    lastSourceCandleCloseTimeBySymbol: restored.state.lastSourceCandleCloseTimeBySymbol,
    lifecycleRecords: restored.lifecycleSnapshot.records.length,
    historyEvents: restored.lifecycleSnapshot.historyEvents.length,
    regimes: Object.values(restored.previousRegimes).map(state => ({
      symbol: state.symbol, regime: state.regime, heldCandles: state.heldCandles,
      pendingRegime: state.pendingRegime, pendingCount: state.pendingCount,
      sinceCandleCloseTime: state.sinceCandleCloseTime,
    })).sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}
