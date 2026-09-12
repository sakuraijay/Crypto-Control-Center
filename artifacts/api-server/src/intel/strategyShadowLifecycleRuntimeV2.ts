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

export const STRATEGY_SHADOW_LIFECYCLE_MAX_RECORDS = 512;
export const STRATEGY_SHADOW_LIFECYCLE_MAX_HISTORY_EVENTS = 1_024;

export type StrategyShadowLifecycleRestoreResult =
  | { status: 'EMPTY_LEGACY' | 'RESTORED'; snapshot: SignalLifecycleSnapshotV2; reason: string }
  | { status: 'BLOCKED'; snapshot: null; reason: string };

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const finiteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);

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
