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
  'virtual-paper-400-strategy-continuity/v1' as const;

export interface VirtualPaper400StrategyContinuityState {
  schemaVersion: typeof VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION;
  sessionId: string;
  updatedAt: number;
  lastEnvelopeStatus: StrategyShadowWorkerEnvelope['status'];
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
  if (!state || state.schemaVersion !== VIRTUAL_PAPER_400_STRATEGY_CONTINUITY_VERSION
    || state.sessionId !== sessionId || !finiteInteger(state.updatedAt)
    || state.updatedAt <= 0 || state.updatedAt > restoredAt
    || !['NOT_EVALUATED', 'PARTIAL', 'EVALUATED', 'BLOCKED'].includes(String(state.lastEnvelopeStatus))
    || !shadow || !Object.prototype.hasOwnProperty.call(shadow, 'lifecycleSnapshot')
    || !Object.prototype.hasOwnProperty.call(shadow, 'regimeSnapshot')) {
    return { status: 'BLOCKED', state: null, lifecycleSnapshot: null,
      previousRegimes: null, reason: 'STRATEGY_CONTINUITY_STATE_INVALID' };
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
  return {
    status: 'RESTORED',
    state: state as unknown as VirtualPaper400StrategyContinuityState,
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
    strategyEnsembleShadow: { lifecycleSnapshot, regimeSnapshot },
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
    lifecycleRecords: restored.lifecycleSnapshot.records.length,
    historyEvents: restored.lifecycleSnapshot.historyEvents.length,
    regimes: Object.values(restored.previousRegimes).map(state => ({
      symbol: state.symbol, regime: state.regime, heldCandles: state.heldCandles,
      pendingRegime: state.pendingRegime, pendingCount: state.pendingCount,
      sinceCandleCloseTime: state.sinceCandleCloseTime,
    })).sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}
