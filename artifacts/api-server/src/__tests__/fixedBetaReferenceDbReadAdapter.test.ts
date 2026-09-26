import { describe, expect, it, vi } from 'vitest';
import { FIXED_BETA_REFERENCE_WORKER_STATE_KEY } from '../workers/fixedBetaReferenceWorkerState';
import { createFixedBetaReferenceWorkerStateDbReaderV1 } from '../workers/fixedBetaReferenceDbReadAdapter';

describe('fixed beta DB read adapter', () => {
  it('queries only the canonical isolated Fixed Beta key and returns one row', async () => {
    const selectByKey = vi.fn(async (key: string) => [{
      key,
      value: '{"schemaVersion":1}',
    }]);
    const reader = createFixedBetaReferenceWorkerStateDbReaderV1(selectByKey);

    const row = await reader(FIXED_BETA_REFERENCE_WORKER_STATE_KEY);

    expect(selectByKey).toHaveBeenCalledTimes(1);
    expect(selectByKey).toHaveBeenCalledWith('fixed_beta_reference_active_v1');
    expect(row).toEqual({
      key: FIXED_BETA_REFERENCE_WORKER_STATE_KEY,
      value: '{"schemaVersion":1}',
    });
  });

  it('returns null for an absent isolated row without bootstrapping state', async () => {
    const selectByKey = vi.fn(async () => []);
    const reader = createFixedBetaReferenceWorkerStateDbReaderV1(selectByKey);

    await expect(reader(FIXED_BETA_REFERENCE_WORKER_STATE_KEY)).resolves.toBeNull();
    expect(selectByKey).toHaveBeenCalledTimes(1);
  });

  it('fails closed when storage returns an ambiguous duplicate row set', async () => {
    const selectByKey = vi.fn(async (key: string) => [
      { key, value: 'a' },
      { key, value: 'b' },
    ]);
    const reader = createFixedBetaReferenceWorkerStateDbReaderV1(selectByKey);

    await expect(reader(FIXED_BETA_REFERENCE_WORKER_STATE_KEY))
      .rejects.toThrow('FIXED_BETA_REFERENCE_DB_ROW_AMBIGUOUS');
  });

  it('rejects Standard Active worker_state keys before querying storage', async () => {
    const selectByKey = vi.fn(async () => []);
    const reader = createFixedBetaReferenceWorkerStateDbReaderV1(selectByKey);

    await expect(reader('equityHwm' as typeof FIXED_BETA_REFERENCE_WORKER_STATE_KEY))
      .rejects.toThrow('FIXED_BETA_REFERENCE_DB_KEY_NOT_CANONICAL');
    expect(selectByKey).not.toHaveBeenCalled();
  });
});
