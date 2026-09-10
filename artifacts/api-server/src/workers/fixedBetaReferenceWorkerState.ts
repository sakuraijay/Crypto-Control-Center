import { FIXED_BETA_REFERENCE_STATE_KEYS } from './fixedBetaReferenceContract';
import {
  advanceFixedBetaReferenceSnapshotV1,
  restoreFixedBetaReferenceSnapshotV1,
  type FixedBetaReferenceMetricsV1,
  type FixedBetaReferenceSnapshotV1,
} from './fixedBetaReferenceState';

/**
 * Canonical worker_state row identity for the isolated Fixed Beta reference.
 *
 * This adapter is deliberately pure: it does not import @workspace/db and cannot
 * mutate Production state. It only validates/serializes the row a later worker
 * integration may persist after the protected Production-mutation gate is handled.
 */
export const FIXED_BETA_REFERENCE_WORKER_STATE_KEY = FIXED_BETA_REFERENCE_STATE_KEYS.active;

export interface FixedBetaReferenceWorkerStateRowV1 {
  key: typeof FIXED_BETA_REFERENCE_WORKER_STATE_KEY;
  value: string;
}

type FixedBetaReferenceWorkerStateFailureReason =
  | 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID'
  | 'FIXED_BETA_REFERENCE_WORKER_STATE_KEY_INVALID'
  | 'FIXED_BETA_REFERENCE_WORKER_STATE_VALUE_INVALID'
  | 'FIXED_BETA_REFERENCE_PERSISTED_STATE_INVALID';

export type FixedBetaReferenceWorkerStateResult =
  | {
      ok: true;
      row: FixedBetaReferenceWorkerStateRowV1;
      snapshot: FixedBetaReferenceSnapshotV1;
      metrics: FixedBetaReferenceMetricsV1;
      authoritativeHistoricalHardStopPresent: boolean;
      productionStateMutationAuthorized: false;
      betaExecutionAuthorized: false;
      blockNewEntries: false;
    }
  | {
      ok: false;
      reason: FixedBetaReferenceWorkerStateFailureReason;
      blockNewEntries: true;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bindAuthoritativeHistoricalHardStop(
  rawSnapshot: unknown,
  authoritativeHistoricalHardStopPresent: unknown,
): FixedBetaReferenceWorkerStateResult {
  if (typeof authoritativeHistoricalHardStopPresent !== 'boolean') {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID',
      blockNewEntries: true,
    };
  }

  const restored = restoreFixedBetaReferenceSnapshotV1(rawSnapshot);
  if (!restored.ok) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_PERSISTED_STATE_INVALID',
      blockNewEntries: true,
    };
  }

  // Re-run through the state transition so the authoritative Risk Engine HARD_STOP
  // can only strengthen the snapshot. A locally persisted true value also remains
  // sticky if the current authoritative read is false.
  const rebound = advanceFixedBetaReferenceSnapshotV1(restored.snapshot, {
    currentRiskEquityUsd: restored.snapshot.currentRiskEquityUsd,
    dailyPeriodKey: restored.snapshot.dailyPeriodKey,
    weeklyPeriodKey: restored.snapshot.weeklyPeriodKey,
    historicalHardStopPresent: authoritativeHistoricalHardStopPresent,
  });
  if (!rebound.ok) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_PERSISTED_STATE_INVALID',
      blockNewEntries: true,
    };
  }

  return {
    ok: true,
    row: {
      key: FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
      value: JSON.stringify(rebound.snapshot),
    },
    snapshot: rebound.snapshot,
    metrics: rebound.metrics,
    authoritativeHistoricalHardStopPresent,
    productionStateMutationAuthorized: false,
    betaExecutionAuthorized: false,
    blockNewEntries: false,
  };
}

/**
 * Prepare a canonical worker_state row from a validated Fixed Beta snapshot.
 *
 * This does not write the row. Every preparation requires a fresh authoritative
 * historical HARD_STOP observation from the canonical Risk Engine state so a stale
 * local Fixed Beta snapshot cannot weaken the final risk authority.
 */
export function prepareFixedBetaReferenceWorkerStateRowV1(
  rawSnapshot: unknown,
  authoritativeHistoricalHardStopPresent: unknown,
): FixedBetaReferenceWorkerStateResult {
  return bindAuthoritativeHistoricalHardStop(
    rawSnapshot,
    authoritativeHistoricalHardStopPresent,
  );
}

/**
 * Restore a Fixed Beta snapshot from a worker_state-like row and immediately bind
 * it to the caller-supplied authoritative historical HARD_STOP observation.
 *
 * Extra DB metadata fields are tolerated, but the key and value must be canonical.
 * Legacy PAPER/HWM/baseline keys therefore cannot be mistaken for Fixed Beta state.
 */
export function restoreFixedBetaReferenceWorkerStateRowV1(
  rawRow: unknown,
  authoritativeHistoricalHardStopPresent: unknown,
): FixedBetaReferenceWorkerStateResult {
  if (!isPlainObject(rawRow) || rawRow.key !== FIXED_BETA_REFERENCE_WORKER_STATE_KEY) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_KEY_INVALID',
      blockNewEntries: true,
    };
  }
  if (typeof rawRow.value !== 'string') {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_VALUE_INVALID',
      blockNewEntries: true,
    };
  }

  return bindAuthoritativeHistoricalHardStop(
    rawRow.value,
    authoritativeHistoricalHardStopPresent,
  );
}
