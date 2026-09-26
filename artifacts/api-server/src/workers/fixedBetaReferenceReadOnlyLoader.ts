import {
  FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
  restoreFixedBetaReferenceWorkerStateRowV1,
  type FixedBetaReferenceWorkerStateResult,
} from './fixedBetaReferenceWorkerState';

/**
 * Narrow read-only seam between the 24/7 worker and worker_state.
 *
 * This module deliberately has no @workspace/db import and exposes no write API.
 * The caller may supply a DB-backed reader later, but the loader can only request
 * the one isolated Fixed Beta key and can never bootstrap, upsert, or mutate it.
 */
export type FixedBetaReferenceWorkerStateReaderV1 = (
  key: typeof FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
) => Promise<unknown | null | undefined>;

type FixedBetaReferenceReadOnlyLoadFailureReason =
  | 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID'
  | 'FIXED_BETA_REFERENCE_WORKER_STATE_NOT_FOUND'
  | 'FIXED_BETA_REFERENCE_WORKER_STATE_READ_FAILED';

export type FixedBetaReferenceReadOnlyLoadResultV1 =
  | FixedBetaReferenceWorkerStateResult
  | {
      ok: false;
      reason: FixedBetaReferenceReadOnlyLoadFailureReason;
      blockNewEntries: true;
    };

/**
 * Load an already-existing isolated Fixed Beta reference row without creating it.
 *
 * Missing state, read failures, malformed state, or missing authoritative
 * HARD_STOP evidence all fail closed. In particular, this function never treats
 * an absent row as permission to initialize a 400-USDC Beta epoch: the protected
 * Production bootstrap remains a separate owner-gated action.
 */
export async function loadFixedBetaReferenceWorkerStateReadOnlyV1(
  readWorkerStateRow: FixedBetaReferenceWorkerStateReaderV1,
  authoritativeHistoricalHardStopPresent: unknown,
): Promise<FixedBetaReferenceReadOnlyLoadResultV1> {
  if (typeof authoritativeHistoricalHardStopPresent !== 'boolean') {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID',
      blockNewEntries: true,
    };
  }

  let row: unknown | null | undefined;
  try {
    row = await readWorkerStateRow(FIXED_BETA_REFERENCE_WORKER_STATE_KEY);
  } catch {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_READ_FAILED',
      blockNewEntries: true,
    };
  }

  if (row === null || row === undefined) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_WORKER_STATE_NOT_FOUND',
      blockNewEntries: true,
    };
  }

  return restoreFixedBetaReferenceWorkerStateRowV1(
    row,
    authoritativeHistoricalHardStopPresent,
  );
}
