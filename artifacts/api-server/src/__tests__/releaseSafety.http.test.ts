import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  dbEvidence: vi.fn(),
  executor: vi.fn(),
  activeRevoke: vi.fn(),
  relayFlags: vi.fn(),
  validateManifest: vi.fn(),
  stop: vi.fn(),
  gmxStatus: vi.fn(),
}));

vi.mock('../lib/releaseIdentity', () => ({ getReleaseIdentity: mocks.identity }));
vi.mock('../lib/runtimeSafetyEvidence', () => ({
  readRuntimeDbSafetyEvidence: mocks.dbEvidence,
}));
vi.mock('../workers/internalExecutor', () => ({ getExecutorStatus: mocks.executor }));
vi.mock('../lib/revokeSession', () => ({ getActiveRevokeSession: mocks.activeRevoke }));
vi.mock('../lib/relayActivationStatus', () => ({ deriveRelayEnvFlags: mocks.relayFlags }));
vi.mock('../lib/gmxDeploymentManifest', () => ({
  validateEnvAgainstManifest: mocks.validateManifest,
}));
vi.mock('../lib/stopExecutionCapabilityState', () => ({
  getStopExecutionCapability: mocks.stop,
}));
vi.mock('../routes/gmxapi', () => ({
  buildGmxApiStatusSnapshot: mocks.gmxStatus,
}));

import releaseRouter from '../routes/release';

const identity = {
  schemaVersion: 1,
  releaseSha: 'a'.repeat(40),
  productTree: 'b'.repeat(40),
  buildId: 'c'.repeat(64),
  builtAt: '2026-08-28T10:00:00.000Z',
  workspaceSource: { headSha: 'a'.repeat(40), productTree: 'b'.repeat(40) },
  configuredSafetyFlags: {
    engineMode: 'PAPER',
    autoWorkerLiveEnabled: false,
    liveTestExecutionLocked: true,
    delegatedSignerEnabled: false,
    gmxOrderSubmissionEnabled: false,
    relaySubmissionEnabled: false,
    relaySubmitNetworkEnabled: false,
    relayMode: 'DISABLED',
  },
  safetyContract: {
    version: 'post-publish-safety/v1',
    confirmedOpenInitialStop: {
      version: 'confirmed-open-initial-stop/v1',
      sha256: 'd'.repeat(64),
      files: ['confirmedOpenStopHandoff.test.ts'],
    },
  },
  topology: { processCount: 1, port: 8080, owner: 'api-server' },
  webAssets: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockReturnValue(identity);
  mocks.executor.mockReturnValue({
    ready: true,
    engineMode: 'PAPER',
    liveExecutionLocked: true,
    liveTestMode: false,
    startedAt: '2026-08-28T10:00:00.000Z',
    uptimeSeconds: 90,
    workerRunning: false,
    cycleCount: 1,
    schedulerHeartbeatAt: '2026-08-28T10:01:30.000Z',
    lastDecisionAt: '2026-08-28T10:01:00.000Z',
    lastSchedulerCycleOutcome: 'SUCCESS',
    lastCycleAt: '2026-08-28T10:01:00.000Z',
    lastCycleResult: { cycleNumber: 1 },
    gmxConnected: true,
    networkChainId: 42161,
    rpcConfigured: true,
    serverPaperExec: { openPositions: [], pendingClose: null, unresolved: null },
    settlementReconcile: { unsettledCount: 0, incomplete: false },
  });
  mocks.activeRevoke.mockResolvedValue(null);
  mocks.validateManifest.mockReturnValue({ ok: true });
  mocks.relayFlags.mockReturnValue({
    relaySubmitNetworkEnabled: false,
    relaySubmissionEnabled: false,
    relayMode: 'DISABLED',
    delegatedSignerEnabled: false,
  });
  mocks.stop.mockReturnValue({ available: false, reasons: ['locked'], evaluatedAt: null });
  mocks.gmxStatus.mockResolvedValue({
    readyForControlledCanary: false,
    publicReadiness: {
      boundary: 'SANITIZED_READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
      observedAt: '2026-08-28T10:01:30.000Z',
      costs: {
        BTC: {
          symbol: 'BTC',
          direction: 'LONG',
          exactNotionalUsd: 20,
          holdingHours: 1,
          effectiveRoundTripCostUsd: 0.31,
          observedAt: '2026-08-28T10:01:29.000Z',
          ageMs: 1_000,
          fresh: true,
          capUsd: 0.4,
          withinCap: true,
          blockerIds: [],
        },
        ETH: {
          symbol: 'ETH',
          direction: 'LONG',
          exactNotionalUsd: 20,
          holdingHours: 1,
          effectiveRoundTripCostUsd: 0.41,
          observedAt: '2026-08-28T10:01:29.000Z',
          ageMs: 1_000,
          fresh: true,
          capUsd: 0.4,
          withinCap: false,
          blockerIds: ['PUBLIC_COST_ETH_CAP_EXCEEDED'],
        },
      },
      canary: {
        ready: false,
        blockerIds: [
          'PUBLIC_CANARY_PAPER_MODE',
          'PUBLIC_COST_ETH_CAP_EXCEEDED',
          'PUBLIC_STOP_CAPABILITY_UNAVAILABLE',
        ],
      },
      stop: {
        ready: false,
        evaluatedAt: null,
        blockerIds: ['PUBLIC_STOP_CAPABILITY_UNAVAILABLE'],
      },
    },
  });
  mocks.dbEvidence.mockResolvedValue({
    observedAt: '2026-08-28T10:01:00.000Z',
    complete: true,
    pendingApprovalCount: 0,
    openPositionCount: 0,
    blockingIntentCount: 0,
    openRelayTaskCount: 0,
    blockingProtectionCount: 0,
    unsettledTradeCount: 0,
    duplicateDecisionClaimCount24h: 0,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('read-only release attestation routes', () => {
  function app() {
    const instance = express();
    instance.use('/api', releaseRouter);
    return instance;
  }

  it('returns sanitized immutable build identity without credentials', async () => {
    const response = await request(app()).get('/api/release/identity');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, identity });
    expect(JSON.stringify(response.body)).not.toMatch(/privateKey|DATABASE_URL|RPC_URL|SESSION_SECRET/);
  });

  it('returns runtime locks and null-preserving DB evidence without invoking writes', async () => {
    const response = await request(app()).get('/api/release/safety');
    expect(response.status).toBe(200);
    expect(response.body.runtime).toMatchObject({
      engineMode: 'PAPER',
      liveExecutionLocked: true,
      liveTestMode: false,
      schedulerHeartbeatAt: '2026-08-28T10:01:30.000Z',
      lastDecisionAt: '2026-08-28T10:01:00.000Z',
      lastCycleOutcome: 'SUCCESS',
      lastCycleHasError: false,
      activeRevoke: false,
      stopExecution: { available: false },
    });
    expect(response.body.database).toMatchObject({ complete: true, blockingIntentCount: 0 });
    expect(response.body.publicReadiness).toMatchObject({
      boundary: 'SANITIZED_READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
      costs: {
        BTC: {
          exactNotionalUsd: 20,
          effectiveRoundTripCostUsd: 0.31,
          fresh: true,
          capUsd: 0.4,
          withinCap: true,
          blockerIds: [],
        },
        ETH: {
          exactNotionalUsd: 20,
          effectiveRoundTripCostUsd: 0.41,
          fresh: true,
          capUsd: 0.4,
          withinCap: false,
          blockerIds: ['PUBLIC_COST_ETH_CAP_EXCEEDED'],
        },
      },
      canary: {
        ready: false,
        blockerIds: expect.arrayContaining([
          'PUBLIC_CANARY_PAPER_MODE',
          'PUBLIC_COST_ETH_CAP_EXCEEDED',
          'PUBLIC_STOP_CAPABILITY_UNAVAILABLE',
        ]),
      },
      stop: {
        ready: false,
        blockerIds: ['PUBLIC_STOP_CAPABILITY_UNAVAILABLE'],
      },
    });
    expect(response.body.operationalDiagnostics).toMatchObject({
      schemaVersion: 2,
      flags: {
        liveTestExecutionLocked: {
          configured: true,
          buildObserved: true,
          approvedTarget: false,
          effective: true,
          status: 'DRIFT',
        },
        delegatedSignerEnabled: {
          configured: false,
          buildObserved: false,
          approvedTarget: true,
          effective: false,
          status: 'DRIFT',
        },
      },
      provenance: { status: 'MATCH' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /privateKey|DATABASE_URL|RPC_URL|SESSION_SECRET|positionId|tradeId|lastCycleResult|pid|nodeEnv/,
    );
    expect(mocks.dbEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.gmxStatus).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('nulls unavailable or stale cost values and exposes only stable blocker IDs', async () => {
    const current = await mocks.gmxStatus();
    mocks.gmxStatus.mockResolvedValue({
      ...current,
      publicReadiness: {
        ...current.publicReadiness,
        costs: {
          BTC: {
            ...current.publicReadiness.costs.BTC,
            effectiveRoundTripCostUsd: null,
            observedAt: null,
            fresh: false,
            withinCap: null,
            blockerIds: ['PUBLIC_COST_BTC_UNAVAILABLE'],
          },
          ETH: {
            ...current.publicReadiness.costs.ETH,
            effectiveRoundTripCostUsd: null,
            fresh: false,
            withinCap: null,
            blockerIds: ['PUBLIC_COST_ETH_STALE'],
          },
        },
      },
    });

    const response = await request(app()).get('/api/release/safety');

    expect(response.status).toBe(200);
    expect(response.body.publicReadiness.costs.BTC).toMatchObject({
      effectiveRoundTripCostUsd: null,
      observedAt: null,
      fresh: false,
      withinCap: null,
      blockerIds: ['PUBLIC_COST_BTC_UNAVAILABLE'],
    });
    expect(response.body.publicReadiness.costs.ETH).toMatchObject({
      effectiveRoundTripCostUsd: null,
      fresh: false,
      withinCap: null,
      blockerIds: ['PUBLIC_COST_ETH_STALE'],
    });
  });

  it.each([
    ['eligible', true],
    ['blocked', false],
  ] as const)('preserves authenticated %s Canary readiness parity', async (_case, ready) => {
    const current = await mocks.gmxStatus();
    const detailedStatus = {
      ...current,
      readyForControlledCanary: ready,
      publicReadiness: {
        ...current.publicReadiness,
        canary: {
          ready,
          blockerIds: ready ? [] : ['PUBLIC_CANARY_DETAILED_READINESS_BLOCKED'],
        },
      },
    };
    mocks.gmxStatus.mockResolvedValue(detailedStatus);

    const response = await request(app()).get('/api/release/safety');

    expect(response.status).toBe(200);
    expect(response.body.publicReadiness.canary.ready).toBe(ready);
    expect(response.body.publicReadiness.canary.ready).toBe(
      detailedStatus.readyForControlledCanary,
    );
  });

  it('keeps build-time observations distinct from current runtime and reports source provenance drift', async () => {
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'true');
    vi.stubEnv('GMX_API_ORDER_SUBMISSION_ENABLED', 'true');
    vi.stubEnv('LIVE_TEST_EXECUTION_LOCKED', 'false');
    mocks.identity.mockReturnValue({
      ...identity,
      workspaceSource: {
        ...identity.workspaceSource,
        productTree: 'e'.repeat(40),
      },
    });
    mocks.executor.mockReturnValue({
      ...mocks.executor(),
      liveExecutionLocked: false,
    });
    mocks.relayFlags.mockReturnValue({
      relaySubmitNetworkEnabled: false,
      relaySubmissionEnabled: false,
      relayMode: 'DISABLED',
      delegatedSignerEnabled: true,
    });

    const response = await request(app()).get('/api/release/safety');

    expect(response.status).toBe(200);
    expect(response.body.identity).toMatchObject({
      builtAt: '2026-08-28T10:00:00.000Z',
      configuredSafetyFlags: {
        delegatedSignerEnabled: false,
        liveTestExecutionLocked: true,
      },
    });
    expect(response.body.runtime).toMatchObject({
      liveExecutionLocked: false,
    });
    expect(response.body.operationalDiagnostics.flags).toMatchObject({
      delegatedSignerEnabled: {
        buildObserved: false,
        approvedTarget: true,
        effective: true,
        status: 'MATCH',
        buildObservationStatus: 'DRIFT',
      },
      liveTestExecutionLocked: {
        buildObserved: true,
        approvedTarget: false,
        effective: false,
        status: 'MATCH',
        buildObservationStatus: 'DRIFT',
      },
    });
    expect(response.body.operationalDiagnostics.provenance).toMatchObject({
      status: 'DRIFT',
      sameCommit: true,
      sameProductTree: false,
    });
  });

  it('fails closed when build identity is unavailable', async () => {
    mocks.identity.mockReturnValue(null);
    const response = await request(app()).get('/api/release/safety');
    expect(response.status).toBe(503);
    expect(mocks.dbEvidence).not.toHaveBeenCalled();
  });

  it('preserves unavailable revoke, relay, and DB evidence instead of claiming safe zero', async () => {
    mocks.activeRevoke.mockRejectedValue(new Error('db down'));
    mocks.relayFlags.mockImplementation(() => { throw new Error('bad env'); });
    mocks.dbEvidence.mockResolvedValue({
      observedAt: '2026-08-28T10:01:00.000Z',
      complete: false,
      pendingApprovalCount: null,
      openPositionCount: null,
      blockingIntentCount: null,
      openRelayTaskCount: null,
      blockingProtectionCount: null,
      unsettledTradeCount: null,
      duplicateDecisionClaimCount24h: null,
    });
    const response = await request(app()).get('/api/release/safety');
    expect(response.status).toBe(200);
    expect(response.body.runtime.activeRevoke).toBeNull();
    expect(response.body.runtime.relayFlags).toBeNull();
    expect(response.body.database.complete).toBe(false);
    expect(response.body.database.unsettledTradeCount).toBeNull();
  });
});