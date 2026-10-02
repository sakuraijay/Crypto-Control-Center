import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
} from './fixedBetaReferenceWorkerState';
import type { FixedBetaReferenceWorkerStateReaderV1 } from './fixedBetaReferenceReadOnlyLoader';

export interface FixedBetaReferenceWorkerStateDbRowV1 {
  key: unknown;
  value: unknown;
}

export type FixedBetaReferenceWorkerStateSelectByKeyV1 = (
  key: string,
) => Promise<readonly FixedBetaReferenceWorkerStateDbRowV1[]>;

/**
 * Build the narrow DB reader consumed by the existing read-only Fixed Beta loader.
 *
 * The reader is intentionally restricted to the isolated Fixed Beta worker_state
 * identity. Legacy Standard Active keys (equityHwm, equity baselines, risk state)
 * are rejected before any DB query can run. Duplicate rows also fail closed.
 */
export function createFixedBetaReferenceWorkerStateDbReaderV1(
  selectByKey: FixedBetaReferenceWorkerStateSelectByKeyV1,
): FixedBetaReferenceWorkerStateReaderV1 {
  return async (key) => {
    if (key !== FIXED_BETA_REFERENCE_WORKER_STATE_KEY) {
      throw new Error('FIXED_BETA_REFERENCE_DB_KEY_NOT_CANONICAL');
    }

    const rows = await selectByKey(key);
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new Error('FIXED_BETA_REFERENCE_DB_ROW_AMBIGUOUS');
    }

    return {
      key: rows[0].key,
      value: rows[0].value,
    };
  };
}

async function selectFixedBetaReferenceWorkerStateByKeyV1(
  key: string,
): Promise<readonly FixedBetaReferenceWorkerStateDbRowV1[]> {
  return db
    .select({
      key: workerStateTable.key,
      value: workerStateTable.value,
    })
    .from(workerStateTable)
    .where(eq(workerStateTable.key, key))
    .limit(2);
}

/**
 * Production-capable READ-ONLY adapter for the existing Fixed Beta loader.
 *
 * This module exposes no insert/update/delete/upsert API and therefore cannot
 * bootstrap or mutate the protected Fixed Beta Production reference state.
 */
export const readFixedBetaReferenceWorkerStateFromDbV1 =
  createFixedBetaReferenceWorkerStateDbReaderV1(
    selectFixedBetaReferenceWorkerStateByKeyV1,
  );
