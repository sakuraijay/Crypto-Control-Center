import type { SignalLifecycleSnapshotV2 } from '../intel/signalLifecycleSnapshotV2';
import type { RegimeState } from '../intel/regimeEngineV2';
import type { StrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
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
  /** Last accepted completed-candle analysis. Duplicate one-minute worker ticks
   * must not erase the reasons from the most recent meaningful 15-minute batch. */
  lastMeaningfulAnalysis: {
    evaluatedAt: number;
    status: 'PARTIAL' | 'EVALUATED';
    expectedSymbols?: string[];
    latestBatchSymbols: string[];
    records: Array<Pick<StrategyShadowRecord, 'symbol' | 'evaluatedAt' | 'sourceCandleCloseTime' | 'regime'
      | 'action' | 'strategyId' | 'direction' | 'confidence' | 'lifecycleEligible' | 'reasons'>>;
  } | null;
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

function restoreLastMeaningfulAnalysis(
  raw: unknown,
  restoredAt: number,
  allowedSymbols: readonly string[],
): { ok: true; value: VirtualPaper400StrategyContinuityState['lastMeaningfulAnalysis'] }
  | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const analysis = object(raw);
  if (!analysis || !finiteInteger(analysis.evaluatedAt) || analysis.evaluatedAt <= 0
    || analysis.evaluatedAt > restoredAt
    || !['PARTIAL', 'EVALUATED'].includes(String(analysis.status))
    || !Array.isArray(analysis.records) || analysis.records.length === 0) return { ok: false };
  const allowed = new Set(allowedSymbols.map(symbol => symbol.trim().toUpperCase()));
  // Historical v2 records were produced by the fixed three-symbol runtime.
  // New EVALUATED/PARTIAL status describes its scheduled batch, not the entire
  // (now dynamic) universe. Preserve old evidence; do not reset regime/cursors.
  const rawExpected = analysis.expectedSymbols ?? ['BTC', 'ETH', 'SOL'];
  if (!Array.isArray(rawExpected) || !rawExpected.length) return { ok: false };
  const expected = rawExpected.map(s => typeof s === 'string' ? s.trim().toUpperCase() : '');
  if (new Set(expected).size !== expected.length || expected.some(s => !allowed.has(s))) return { ok: false };
  const latestBatchSymbols = analysis.latestBatchSymbols === undefined
    ? (analysis.records as unknown[]).map(value => object(value)?.symbol)
    : analysis.latestBatchSymbols;
  if (!Array.isArray(latestBatchSymbols)) return { ok: false };
  const normalizedLatestBatchSymbols = latestBatchSymbols.map(symbol =>
    typeof symbol === 'string' ? symbol.trim().toUpperCase() : '');
  if (!normalizedLatestBatchSymbols.length
    || new Set(normalizedLatestBatchSymbols).size !== normalizedLatestBatchSymbols.length
    || normalizedLatestBatchSymbols.some(symbol => !allowed.has(symbol))) return { ok: false };
  const seen = new Set<string>();
  const records: NonNullable<VirtualPaper400StrategyContinuityState['lastMeaningfulAnalysis']>['records'] = [];
  for (const rawRecord of analysis.records) {
    const record = object(rawRecord);
    const symbol = typeof record?.symbol === 'string' ? record.symbol.trim().toUpperCase() : '';
    const evaluatedAt = record?.evaluatedAt === undefined ? analysis.evaluatedAt : record.evaluatedAt;
    if (!record || !allowed.has(symbol) || seen.has(symbol)
      || !finiteInteger(evaluatedAt) || evaluatedAt <= 0 || evaluatedAt > analysis.evaluatedAt
      || !finiteInteger(record.sourceCandleCloseTime) || record.sourceCandleCloseTime <= 0
      || record.sourceCandleCloseTime > evaluatedAt
      || !['TREND_UP', 'TREND_DOWN', 'RANGE', 'BREAKOUT_READY', 'HIGH_VOLATILITY',
        'TRANSITION', 'UNKNOWN'].includes(String(record.regime))
      || !['LONG', 'SHORT', 'NO_TRADE', 'REJECTED', 'DISABLED'].includes(String(record.action))
      || (record.strategyId !== null && !['TREND_PULLBACK', 'VOLATILITY_BREAKOUT',
        'RANGE_MEAN_REVERSION'].includes(String(record.strategyId)))
      || !['LONG', 'SHORT', 'NONE'].includes(String(record.direction))
      || (record.confidence !== null && (typeof record.confidence !== 'number'
        || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 100))
      || (record.lifecycleEligible !== null && typeof record.lifecycleEligible !== 'boolean')
      || !Array.isArray(record.reasons) || record.reasons.some(reason => typeof reason !== 'string')) {
      return { ok: false };
    }
    seen.add(symbol);
    records.push({
      symbol,
      evaluatedAt,
      sourceCandleCloseTime: record.sourceCandleCloseTime,
      regime: record.regime as StrategyShadowRecord['regime'],
      action: record.action as StrategyShadowRecord['action'],
      strategyId: record.strategyId as StrategyShadowRecord['strategyId'],
      direction: record.direction as StrategyShadowRecord['direction'],
      confidence: record.confidence as number | null,
      lifecycleEligible: record.lifecycleEligible as boolean | null,
      reasons: [...record.reasons] as string[],
    });
  }
  if ((analysis.status === 'EVALUATED' && normalizedLatestBatchSymbols.length !== expected.length)
    || (analysis.status === 'PARTIAL' && normalizedLatestBatchSymbols.length >= expected.length)
    || normalizedLatestBatchSymbols.some(symbol => !expected.includes(symbol))
    || normalizedLatestBatchSymbols.some(symbol => !seen.has(symbol))) return { ok: false };
  return { ok: true, value: {
    evaluatedAt: analysis.evaluatedAt,
    status: analysis.status as 'PARTIAL' | 'EVALUATED',
    expectedSymbols: expected,
    latestBatchSymbols: normalizedLatestBatchSymbols,
    records,
  } };
}

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
      lastMeaningfulAnalysis: null,
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
  const lastMeaningfulAnalysis = restoreLastMeaningfulAnalysis(
    state.lastMeaningfulAnalysis, restoredAt, allowedSymbols,
  );
  if (!lastMeaningfulAnalysis.ok) {
    return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
      previousRegimes: null, reason: 'STRATEGY_CONTINUITY_ANALYSIS_INVALID' };
  }
  const normalizedState = {
    ...(state as unknown as VirtualPaper400StrategyContinuityState),
    lastSourceCandleCloseTimeBySymbol,
    lastMeaningfulAnalysis: lastMeaningfulAnalysis.value,
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
  let lastMeaningfulAnalysis = previous.state.lastMeaningfulAnalysis;
  if (['PARTIAL', 'EVALUATED'].includes(envelope.status) && envelope.records.length > 0) {
    type AnalysisRecord = NonNullable<VirtualPaper400StrategyContinuityState['lastMeaningfulAnalysis']>['records'][number];
    const records = new Map<string, AnalysisRecord>();
    for (const record of previous.state.lastMeaningfulAnalysis?.records ?? []) {
      records.set(record.symbol, { ...record, reasons: [...record.reasons] });
    }
    for (const record of envelope.records) {
      const symbol = record.symbol.trim().toUpperCase();
      records.set(symbol, {
        symbol,
        evaluatedAt: capturedAt,
        sourceCandleCloseTime: record.sourceCandleCloseTime,
        regime: record.regime,
        action: record.action,
        strategyId: record.strategyId,
        direction: record.direction,
        confidence: record.confidence,
        lifecycleEligible: record.lifecycleEligible,
        reasons: [...record.reasons],
      });
    }
    lastMeaningfulAnalysis = {
      evaluatedAt: capturedAt,
      status: envelope.status as 'PARTIAL' | 'EVALUATED',
      expectedSymbols: [...envelope.expectedSymbols],
      latestBatchSymbols: envelope.records.map(record => record.symbol.trim().toUpperCase()).sort(),
      records: [...records.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    };
  }
  return {
    schemaVersion: VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION,
    sessionId,
    updatedAt: capturedAt,
    lastEnvelopeStatus: envelope.status,
    lastSourceCandleCloseTimeBySymbol: { ...previous.state.lastSourceCandleCloseTimeBySymbol },
    lastMeaningfulAnalysis,
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
    lastMeaningfulAnalysis: restored.state.lastMeaningfulAnalysis,
    lifecycleRecords: restored.lifecycleSnapshot.records.length,
    historyEvents: restored.lifecycleSnapshot.historyEvents.length,
    regimes: Object.values(restored.previousRegimes).map(state => ({
      symbol: state.symbol, regime: state.regime, heldCandles: state.heldCandles,
      pendingRegime: state.pendingRegime, pendingCount: state.pendingCount,
      sinceCandleCloseTime: state.sinceCandleCloseTime,
    })).sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}
