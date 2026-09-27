import { beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

const rows = new Map<string, string>();
const writeCalls: string[] = [];

vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async (key: string) => rows.has(key) ? [{ value: rows.get(key)! }] : []),
      })),
    })),
    insert: vi.fn(() => { writeCalls.push('insert'); throw new Error('write forbidden'); }),
    update: vi.fn(() => { writeCalls.push('update'); throw new Error('write forbidden'); }),
  },
  workerStateTable: { key: 'key' },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((_col, value) => value) }));

import {
  __resetDelegatedSignerForTests,
  encryptSensitiveHex,
  getSignerAddress,
  isManualCanarySignerRestoreAllowed,
  isSignerInitialized,
  restoreExistingManualCanarySigner,
} from '../lib/delegatedSigner';

const PRIVATE_KEY = `0x${'11'.repeat(32)}` as `0x${string}`;
const ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

function safeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GMX_API_READONLY_ENABLED: 'true',
    GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
    DELEGATED_SIGNER_ENABLED: 'true',
    WORKER_ENGINE_MODE: 'PAPER',
    AUTO_WORKER_LIVE_ENABLED: 'false',
    LIVE_TEST_EXECUTION_LOCKED: 'false',
    SESSION_SECRET: 'manual-canary-restore-test-secret-32chars',
  };
}

beforeEach(() => {
  rows.clear();
  writeCalls.length = 0;
  __resetDelegatedSignerForTests();
  vi.stubEnv('SESSION_SECRET', 'manual-canary-restore-test-secret-32chars');
});

describe('Manual Canary restore-existing signer', () => {
  it('PAPER + AUTO LIVE disabled posture does not depend on legacy relay flags', () => {
    const env = safeEnv();
    delete env.GMX_RELAY_SUBMISSION_ENABLED;
    delete env.GMX_RELAY_NETWORK_ENABLED;
    delete env.GMX_RELAY_MODE;
    expect(isManualCanarySignerRestoreAllowed(env)).toEqual({ allowed: true, missing: [] });
    expect(isManualCanarySignerRestoreAllowed({ ...env, AUTO_WORKER_LIVE_ENABLED: 'true' }).allowed).toBe(false);
  });

  it('restores only an existing signer bound to the stored public address and performs zero writes', async () => {
    rows.set('delegatedSignerEncryptedKey', encryptSensitiveHex(PRIVATE_KEY));
    rows.set('delegatedSignerMeta', JSON.stringify({ createdAt: '2026-08-19T00:00:00.000Z' }));
    rows.set('delegatedSignerPublicAddress', ADDRESS);
    await restoreExistingManualCanarySigner(safeEnv(), ADDRESS);
    expect(isSignerInitialized()).toBe(true);
    expect(getSignerAddress()?.toLowerCase()).toBe(ADDRESS.toLowerCase());
    expect(writeCalls).toEqual([]);
  });

  it('fails closed for absent or mismatched records without creating/replacing keys', async () => {
    await expect(restoreExistingManualCanarySigner(safeEnv(), ADDRESS)).rejects.toThrow(/신규 생성 금지/);
    expect(writeCalls).toEqual([]);
    rows.set('delegatedSignerEncryptedKey', encryptSensitiveHex(PRIVATE_KEY));
    rows.set('delegatedSignerMeta', JSON.stringify({ createdAt: '2026-08-19T00:00:00.000Z' }));
    rows.set('delegatedSignerPublicAddress', `0x${'22'.repeat(20)}`);
    await expect(restoreExistingManualCanarySigner(safeEnv(), ADDRESS)).rejects.toThrow(/결속 실패/);
    expect(isSignerInitialized()).toBe(false);
    expect(writeCalls).toEqual([]);
  });
});