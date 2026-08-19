import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

type SessionRow = {
  status: string;
  expiresAt: string;
  deadline: string;
};

const mocks = vi.hoisted(() => ({
  signerKeys: [] as Array<{ key: string }>,
  approvalSessions: [] as SessionRow[],
  strategyConfigs: [] as Array<{ limits: unknown }>,
  selectError: null as Error | null,
  selectSpy: vi.fn(),
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
  deleteSpy: vi.fn(),
}));

vi.mock('@workspace/db', () => {
  const workerStateTable = { key: {} };
  const subaccountApprovalSessionsTable = {
    status: {},
    expiresAt: {},
    deadline: {},
    purpose: {},
  };
  const strategyConfigTable = { limits: {} };

  function resultFor(table: unknown): unknown {
    if (table === workerStateTable) return mocks.signerKeys;
    if (table === subaccountApprovalSessionsTable) return mocks.approvalSessions;
    if (table === strategyConfigTable) return mocks.strategyConfigs;
    return [];
  }

  function select() {
    mocks.selectSpy();
    let table: unknown;
    const chain: Record<string, unknown> = {
      from(value: unknown) {
        table = value;
        return chain;
      },
      where() {
        return chain;
      },
      limit() {
        return chain;
      },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        if (mocks.selectError) return Promise.reject(mocks.selectError).then(resolve, reject);
        return Promise.resolve(resultFor(table)).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    db: {
      select,
      insert: mocks.insertSpy,
      update: mocks.updateSpy,
      delete: mocks.deleteSpy,
    },
    workerStateTable,
    subaccountApprovalSessionsTable,
    strategyConfigTable,
    tradesTable: {},
    aiDecisionsTable: {},
    liveApprovalsTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

import app from '../app';
import { __resetDelegatedSignerForTests } from '../lib/delegatedSigner';

const PIN = 'test-pin-123456';
const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

describe('authenticated signer readiness snapshot', () => {
  beforeEach(() => {
    mocks.signerKeys = [
      { key: 'delegatedSignerEncryptedKey' },
      { key: 'delegatedSignerMeta' },
      { key: 'delegatedSignerPublicAddress' },
    ];
    mocks.approvalSessions = [
      {
        status: 'OWNER_SIGNATURE_READY',
        expiresAt: (nowSeconds - 1n).toString(),
        deadline: (nowSeconds - 1n).toString(),
      },
      {
        status: 'INVALIDATED',
        expiresAt: (nowSeconds - 1n).toString(),
        deadline: (nowSeconds - 1n).toString(),
      },
    ];
    mocks.strategyConfigs = [{ limits: { liveTestMode: true } }];
    mocks.selectError = null;
    mocks.selectSpy.mockClear();
    mocks.insertSpy.mockClear();
    mocks.updateSpy.mockClear();
    mocks.deleteSpy.mockClear();
    __resetDelegatedSignerForTests();
    vi.stubEnv('OPERATOR_MASTER_PIN', PIN);
    vi.stubEnv('WORKER_ENGINE_MODE', 'LIVE');
    vi.stubEnv('LIVE_TEST_EXECUTION_LOCKED', 'true');
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'true');
    vi.stubEnv('GMX_API_ORDER_SUBMISSION_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetDelegatedSignerForTests();
  });

  it('rejects unauthenticated access', async () => {
    const missing = await request(app).get('/api/executor/signer/readiness');
    const invalid = await request(app)
      .get('/api/executor/signer/readiness')
      .set('x-operator-pin', 'wrong-pin');

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(mocks.selectSpy).not.toHaveBeenCalled();
    expect(mocks.insertSpy).not.toHaveBeenCalled();
    expect(mocks.updateSpy).not.toHaveBeenCalled();
    expect(mocks.deleteSpy).not.toHaveBeenCalled();
  });

  it('returns a sanitized, fail-closed local snapshot with SELECT-only DB access', async () => {
    const signerStateBefore = structuredClone(mocks.signerKeys);
    const sessionsBefore = structuredClone(mocks.approvalSessions);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await request(app)
      .get('/api/executor/signer/readiness')
      .set('x-operator-pin', PIN);

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.readiness).toMatchObject({
      effectiveWorkerMode: 'LIVE',
      liveExecutionLocked: true,
      delegatedSignerEnabled: true,
      submitFlagEnabled: true,
      liveTestMode: true,
      signerRecordsPresent: {
        encryptedSigner: true,
        metadata: true,
        publicSigner: true,
      },
      runtimeSignerInitialized: false,
      staleOwnerSignatureReadySessionCount: 1,
      invalidatedSessionCount: 1,
      actualSubmitPossible: false,
      failClosed: true,
    });
    expect(result.body.readiness.blockedReasons).toContain('LIVE_EXECUTION_LOCKED');
    expect(result.body.readiness.blockedReasons).toContain(
      'READONLY_SNAPSHOT_CANNOT_VERIFY_CANONICAL_AUTHORIZATION',
    );
    expect(mocks.selectSpy).toHaveBeenCalledTimes(3);
    expect(mocks.insertSpy).not.toHaveBeenCalled();
    expect(mocks.updateSpy).not.toHaveBeenCalled();
    expect(mocks.deleteSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.signerKeys).toEqual(signerStateBefore);
    expect(mocks.approvalSessions).toEqual(sessionsBefore);

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(PIN);
    expect(serialized.toLowerCase()).not.toContain('privatekey');
    expect(serialized.toLowerCase()).not.toContain('encryptedsignature');
    expect(serialized.toLowerCase()).not.toContain('typeddatadigest');
    fetchSpy.mockRestore();
  });

  it('fails closed for absent records and restrictive flag combinations', async () => {
    mocks.signerKeys = [];
    mocks.approvalSessions = [];
    mocks.strategyConfigs = [{ limits: { liveTestMode: false } }];
    vi.stubEnv('WORKER_ENGINE_MODE', 'PAPER');
    vi.stubEnv('LIVE_TEST_EXECUTION_LOCKED', 'true');
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'false');
    vi.stubEnv('GMX_API_ORDER_SUBMISSION_ENABLED', 'false');

    const result = await request(app)
      .get('/api/executor/signer/readiness')
      .set('x-operator-pin', PIN);

    expect(result.status).toBe(200);
    expect(result.body.readiness).toMatchObject({
      effectiveWorkerMode: 'PAPER',
      liveExecutionLocked: true,
      delegatedSignerEnabled: false,
      submitFlagEnabled: false,
      liveTestMode: false,
      signerRecordsPresent: {
        encryptedSigner: false,
        metadata: false,
        publicSigner: false,
      },
      actualSubmitPossible: false,
      failClosed: true,
    });
    expect(result.body.readiness.blockedReasons).toEqual(expect.arrayContaining([
      'WORKER_NOT_LIVE',
      'LIVE_EXECUTION_LOCKED',
      'DELEGATED_SIGNER_DISABLED',
      'ORDER_SUBMISSION_DISABLED',
      'LIVE_TEST_MODE_DISABLED',
      'ENCRYPTED_SIGNER_RECORD_MISSING',
      'SIGNER_METADATA_RECORD_MISSING',
      'PUBLIC_SIGNER_RECORD_MISSING',
    ]));
  });

  it('returns a sanitized 503 fail-closed response when a DB SELECT fails', async () => {
    mocks.selectError = new Error('database connection detail must not escape');

    const result = await request(app)
      .get('/api/executor/signer/readiness')
      .set('x-operator-pin', PIN);

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      ok: false,
      readiness: {
        actualSubmitPossible: false,
        failClosed: true,
        blockedReasons: ['READINESS_SNAPSHOT_UNAVAILABLE'],
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('database connection detail');
    expect(mocks.insertSpy).not.toHaveBeenCalled();
    expect(mocks.updateSpy).not.toHaveBeenCalled();
    expect(mocks.deleteSpy).not.toHaveBeenCalled();
  });
});