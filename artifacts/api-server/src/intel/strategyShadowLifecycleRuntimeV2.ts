/**
 * Pure adapter between persisted AI decision fullJson and SHADOW lifecycle state.
 * It performs no DB, worker, Risk, signer or execution I/O.
 */
import {
  buildSignalLifecycleSnapshot,
  restoreSignalLifecycleSnapshot,
  type SignalLifecycleSnapshotV2,
} from './signalLifecycleSnapshotV2';
import type { SignalLifecycleRecord } from './signalLifecycleV2';
import type { StrategyShadowWorkerEnvelope } from './strategyShadowWorkerEnvelopeV2';
import { validateCandleStrategyShadowEvidence } from './candleStrategyShadowEvidenceV2';
import type { MarketRegime, RegimeDecision, RegimeState } from './regimeEngineV2';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';

export const STRATEGY_SHADOW_LIFECYCLE_MAX_RECORDS = 512;
export const STRATEGY_SHADOW_LIFECYCLE_MAX_HISTORY_EVENTS = 1_024;

export type StrategyShadowLifecycleRestoreResult =
  | { status: 'EMPTY_LEGACY' | 'RESTORED'; snapshot: SignalLifecycleSnapshotV2; reason: string }
  | { status: 'BLOCKED'; snapshot: null; reason: string };

export const STRATEGY_REGIME_SNAPSHOT_VERSION = 'strategy-regime-snapshot/v1' as const;
export interface StrategyRegimeSnapshotV1 {
  schemaVersion: typeof STRATEGY_REGIME_SNAPSHOT_VERSION;
  capturedAt: number;
  states: RegimeState[];
}
export type StrategyRegimeRestoreResult =
  | { status: 'EMPTY_LEGACY' | 'RESTORED'; previousRegimes: Record<string, RegimeState>; snapshot: StrategyRegimeSnapshotV1; reason: string }
  | { status: 'BLOCKED'; previousRegimes: null; snapshot: null; reason: string };

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const finiteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
const REGIMES = new Set<MarketRegime>([
  'TREND_UP', 'TREND_DOWN', 'RANGE', 'BREAKOUT_READY', 'HIGH_VOLATILITY',
  'TRANSITION', 'UNKNOWN',
]);
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

function validatedRegimeState(value: unknown, capturedAt: number): RegimeState | null {
  const state = object(value);
  if (!state || typeof state.symbol !== 'string' || !normalizeSymbol(state.symbol)
    || !REGIMES.has(state.regime as MarketRegime)
    || typeof state.confidence !== 'number' || !Number.isFinite(state.confidence)
    || state.confidence < 0 || state.confidence > 100
    || !finiteInteger(state.sinceCandleCloseTime) || state.sinceCandleCloseTime <= 0
    || state.sinceCandleCloseTime > capturedAt
    || !finiteInteger(state.heldCandles) || state.heldCandles < 1
    || !finiteInteger(state.pendingCount) || state.pendingCount < 0
    || (state.pendingRegime !== null && !REGIMES.has(state.pendingRegime as MarketRegime))
    || (state.pendingRegime === null) !== (state.pendingCount === 0)) return null;
  return {
    symbol: normalizeSymbol(state.symbol),
    regime: state.regime as MarketRegime,
    confidence: state.confidence,
    sinceCandleCloseTime: state.sinceCandleCloseTime,
    heldCandles: state.heldCandles,
    pendingRegime: state.pendingRegime as MarketRegime | null,
    pendingCount: state.pendingCount,
  };
}

function snapshotFromStates(
  values: readonly unknown[],
  capturedAt: number,
): StrategyRegimeSnapshotV1 | null {
  if (!finiteInteger(capturedAt) || capturedAt <= 0) return null;
  const states: RegimeState[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const state = validatedRegimeState(value, capturedAt);
    if (!state || seen.has(state.symbol)) return null;
    seen.add(state.symbol);
    states.push(state);
  }
  states.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { schemaVersion: STRATEGY_REGIME_SNAPSHOT_VERSION, capturedAt, states };
}

function mapFromSnapshot(snapshot: StrategyRegimeSnapshotV1): Record<string, RegimeState> {
  return Object.fromEntries(snapshot.states.map(state => [state.symbol, state]));
}

export function validateStrategyPreviousRegimes(
  value: unknown,
  capturedAt: number,
  allowedSymbols: readonly string[],
): Record<string, RegimeState> | null {
  const source = object(value);
  if (!source) return null;
  const allowed = new Set(allowedSymbols.map(normalizeSymbol));
  const states: RegimeState[] = [];
  for (const [rawSymbol, rawState] of Object.entries(source)) {
    const symbol = normalizeSymbol(rawSymbol);
    const state = validatedRegimeState(rawState, capturedAt);
    if (!symbol || !allowed.has(symbol) || !state || state.symbol !== symbol) return null;
    states.push(state);
  }
  const snapshot = snapshotFromStates(states, capturedAt);
  return snapshot ? mapFromSnapshot(snapshot) : null;
}

function stateFromRecord(record: StrategyShadowRecord, capturedAt: number): RegimeState | null {
  if (!record.candleSignalEvidence
    || validateCandleStrategyShadowEvidence(record.candleSignalEvidence, record).length > 0) return null;
  const decision = record.candleSignalEvidence.v2Regime as RegimeDecision;
  if (decision.configVersion !== 'regime-engine/v2'
    || decision.calculatedAt !== record.sourceCandleCloseTime
    || decision.calculatedAt > capturedAt) return null;
  return validatedRegimeState(decision, capturedAt);
}

/**
 * Restores only the explicit SHADOW regime snapshot. A persisted snapshot
 * survives NOT_EVALUATED cycles; legacy decisions start from an empty baseline.
 */
export function restoreStrategyShadowRegimesFromDecisionFullJson(
  fullJson: unknown,
  restoredAt: number,
): StrategyRegimeRestoreResult {
  if (!finiteInteger(restoredAt) || restoredAt <= 0) {
    return { status: 'BLOCKED', previousRegimes: null, snapshot: null, reason: 'Regime 복원 시각 INVALID — fail-closed' };
  }
  if (fullJson === null || fullJson === undefined || fullJson === '') {
    const snapshot = snapshotFromStates([], restoredAt)!;
    return { status: 'EMPTY_LEGACY', previousRegimes: {}, snapshot, reason: '이전 decision 없음 — 빈 regime 기준선' };
  }
  let parsed: unknown = fullJson;
  if (typeof fullJson === 'string') {
    try { parsed = JSON.parse(fullJson); }
    catch { return { status: 'BLOCKED', previousRegimes: null, snapshot: null, reason: '이전 decision JSON 손상 — regime fail-closed' }; }
  }
  const decision = object(parsed);
  const shadow = decision ? object(decision.strategyEnsembleShadow) : null;
  if (!decision) return { status: 'BLOCKED', previousRegimes: null, snapshot: null, reason: '이전 decision 객체 INVALID — regime fail-closed' };
  if (!shadow) {
    const snapshot = snapshotFromStates([], restoredAt)!;
    return { status: 'EMPTY_LEGACY', previousRegimes: {}, snapshot, reason: 'legacy decision — 빈 regime 기준선' };
  }
  if (Object.prototype.hasOwnProperty.call(shadow, 'regimeSnapshot')) {
    const raw = object(shadow.regimeSnapshot);
    const capturedAt = raw?.capturedAt;
    const values = raw?.states;
    const snapshot = raw?.schemaVersion === STRATEGY_REGIME_SNAPSHOT_VERSION
      && finiteInteger(capturedAt) && capturedAt <= restoredAt && Array.isArray(values)
      ? snapshotFromStates(values, capturedAt) : null;
    return snapshot
      ? { status: 'RESTORED', previousRegimes: mapFromSnapshot(snapshot), snapshot, reason: '이전 SHADOW regime snapshot 복원' }
      : { status: 'BLOCKED', previousRegimes: null, snapshot: null, reason: 'Regime snapshot 복원 거부 — fail-closed' };
  }
  // Absence of the explicit field is legacy, even if records exist. We do not
  // infer durable state from an older envelope whose persistence contract did
  // not promise hysteresis continuity.
  const snapshot = snapshotFromStates([], restoredAt)!;
  return { status: 'EMPTY_LEGACY', previousRegimes: {}, snapshot, reason: 'legacy decision — 빈 regime 기준선' };
}

/** Advances only from fingerprint-validated evidence and preserves missing symbols. */
export function advanceStrategyShadowRegimeSnapshot(
  previous: Readonly<Record<string, RegimeState>>,
  envelope: StrategyShadowWorkerEnvelope,
  capturedAt: number,
): StrategyRegimeSnapshotV1 | null {
  const previousSnapshot = snapshotFromStates(Object.values(previous), capturedAt);
  if (!previousSnapshot || envelope.schemaVersion !== 'strategy-shadow-worker-envelope/v1'
    || envelope.mode !== 'SHADOW_ONLY' || envelope.generatedAt > capturedAt
    || envelope.executionAuthorized !== false || envelope.approvalCreationAllowed !== false
    || envelope.paperPositionMutationAllowed !== false || envelope.livePositionMutationAllowed !== false
    || envelope.riskAuthority !== 'NOT_EVALUATED') return null;
  const next = mapFromSnapshot(previousSnapshot);
  const expected = new Set(envelope.expectedSymbols.map(normalizeSymbol));
  const seen = new Set<string>();
  for (const record of envelope.records) {
    const state = stateFromRecord(record, capturedAt);
    if (!state || !expected.has(state.symbol) || seen.has(state.symbol)) return null;
    seen.add(state.symbol);
    next[state.symbol] = state;
  }
  return snapshotFromStates(Object.values(next), capturedAt);
}

/**
 * Legacy decisions without the new field establish an empty baseline. Once the
 * field exists, malformed/null state blocks restoration rather than erasing replay evidence.
 */
export function restoreStrategyShadowLifecycleFromDecisionFullJson(
  fullJson: unknown,
  restoredAt: number,
): StrategyShadowLifecycleRestoreResult {
  if (!finiteInteger(restoredAt) || restoredAt <= 0) {
    return { status: 'BLOCKED', snapshot: null, reason: 'Lifecycle 복원 시각 INVALID — fail-closed' };
  }
  if (fullJson === null || fullJson === undefined || fullJson === '') {
    const snapshot = buildSignalLifecycleSnapshot([], [], restoredAt);
    return snapshot
      ? { status: 'EMPTY_LEGACY', snapshot, reason: '이전 decision 없음 — 빈 SHADOW lifecycle 기준선' }
      : { status: 'BLOCKED', snapshot: null, reason: '빈 lifecycle 기준선 생성 실패' };
  }
  let parsed: unknown = fullJson;
  if (typeof fullJson === 'string') {
    try { parsed = JSON.parse(fullJson); }
    catch { return { status: 'BLOCKED', snapshot: null, reason: '이전 decision JSON 손상 — fail-closed' }; }
  }
  const decision = object(parsed);
  if (!decision) return { status: 'BLOCKED', snapshot: null, reason: '이전 decision 객체 INVALID — fail-closed' };
  const shadow = object(decision.strategyEnsembleShadow);
  if (!shadow || !Object.prototype.hasOwnProperty.call(shadow, 'lifecycleSnapshot')) {
    const snapshot = buildSignalLifecycleSnapshot([], [], restoredAt);
    return snapshot
      ? { status: 'EMPTY_LEGACY', snapshot, reason: 'legacy decision — 빈 SHADOW lifecycle 기준선' }
      : { status: 'BLOCKED', snapshot: null, reason: 'legacy lifecycle 기준선 생성 실패' };
  }
  const restored = restoreSignalLifecycleSnapshot(shadow.lifecycleSnapshot, restoredAt);
  return restored.ok
    ? { status: 'RESTORED', snapshot: restored.snapshot, reason: '이전 SHADOW lifecycle snapshot 복원' }
    : { status: 'BLOCKED', snapshot: null, reason: `Lifecycle snapshot 복원 거부: ${restored.reason}` };
}

/**
 * Adds only advisory, lifecycle-eligible LONG/SHORT candidates to the next snapshot.
 * NO_TRADE/blocked/unsafe records cannot manufacture processed-signal evidence.
 */
export function advanceStrategyShadowLifecycleSnapshot(
  previous: SignalLifecycleSnapshotV2,
  envelope: StrategyShadowWorkerEnvelope,
  capturedAt: number,
): SignalLifecycleSnapshotV2 | null {
  const restored = restoreSignalLifecycleSnapshot(previous, capturedAt);
  if (!restored.ok
    || envelope.schemaVersion !== 'strategy-shadow-worker-envelope/v1'
    || envelope.mode !== 'SHADOW_ONLY'
    || envelope.executionAuthorized !== false
    || envelope.approvalCreationAllowed !== false
    || envelope.paperPositionMutationAllowed !== false
    || envelope.livePositionMutationAllowed !== false
    || envelope.riskAuthority !== 'NOT_EVALUATED'
    || !finiteInteger(capturedAt) || capturedAt <= 0
    || envelope.generatedAt > capturedAt) return null;

  const additions: SignalLifecycleRecord[] = [];
  for (const record of envelope.records) {
    if (record.lifecycleEligible !== true || (record.action !== 'LONG' && record.action !== 'SHORT')) continue;
    if (!record.signalId || !record.strategyId
      || record.direction !== record.action
      || !finiteInteger(record.sourceCandleCloseTime) || record.sourceCandleCloseTime <= 0
      || !finiteInteger(record.evaluatedAt)
      || record.evaluatedAt < record.sourceCandleCloseTime || record.evaluatedAt > capturedAt) return null;
    additions.push({
      configVersion: 'signal-lifecycle/v1',
      signalId: record.signalId,
      symbol: record.symbol.trim().toUpperCase(),
      strategyId: record.strategyId,
      direction: record.action,
      sourceCandleCloseTime: record.sourceCandleCloseTime,
      status: 'GENERATED',
      generatedAt: record.evaluatedAt,
      updatedAt: record.evaluatedAt,
      reason: 'SHADOW lifecycle continuity evidence — execution authority 없음',
    });
  }
  return buildSignalLifecycleSnapshot(
    [...restored.snapshot.records, ...additions].slice(-STRATEGY_SHADOW_LIFECYCLE_MAX_RECORDS),
    restored.snapshot.historyEvents.slice(-STRATEGY_SHADOW_LIFECYCLE_MAX_HISTORY_EVENTS),
    capturedAt,
  );
}
