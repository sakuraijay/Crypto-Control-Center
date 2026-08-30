import type { Server } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runMigrations: vi.fn<() => Promise<void>>(),
  loadEmergencyStopFromDb: vi.fn<() => Promise<boolean>>(),
  reconcileOnRestart: vi.fn<() => Promise<boolean>>(),
  workerStart: vi.fn<() => Promise<void>>(),
  workerStop: vi.fn<() => void>(),
  markReady: vi.fn(),
  startRpcHealthMonitor: vi.fn(),
  startPeriodicIntentReconciliation: vi.fn(),
  startPeriodicGmxApiReconciliation: vi.fn(),
  startPaperRuntimeReadinessScheduler: vi.fn(),
}));

vi.mock('../app', () => ({ default: vi.fn() }));
vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@workspace/db', () => ({
  runMigrations: mocks.runMigrations,
}));
vi.mock('../workers/internalExecutor', () => ({
  startRpcHealthMonitor: mocks.startRpcHealthMonitor,
}));
vi.mock('../workers/aiWorker', () => ({
  workerManager: {
    start: mocks.workerStart,
    stop: mocks.workerStop,
  },
}));
vi.mock('../lib/delegatedSigner', () => ({
  initializeDelegatedSigner: vi.fn(async () => {}),
  isDelegatedSignerEnabled: vi.fn(() => false),
  isManualCanarySignerRestoreAllowed: vi.fn(() => ({ allowed: false, missing: [] })),
  isSignerStorageAccessAllowed: vi.fn(() => ({ allowed: false, missing: [] })),
  restoreExistingManualCanarySigner: vi.fn(async () => {}),
}));
vi.mock('../workers/liveTestExecutor', () => ({
  reconcileOnRestart: mocks.reconcileOnRestart,
  loadEmergencyStopFromDb: mocks.loadEmergencyStopFromDb,
  refreshStopExecutionCapability: vi.fn(async () => {}),
  startPeriodicIntentReconciliation: mocks.startPeriodicIntentReconciliation,
  stopPeriodicIntentReconciliation: vi.fn(),
}));
vi.mock('../lib/staticSite', () => ({
  resolveStaticDir: vi.fn(() => '/tmp/static'),
  assertStaticDirReady: vi.fn(),
  attachStaticServing: vi.fn(),
}));
vi.mock('../lib/readiness', () => ({
  markReady: mocks.markReady,
}));
vi.mock('../lib/gmxApiStatusReconciler', () => ({
  reconcileGmxApiTasksOnStartup: vi.fn(async () => {}),
  startPeriodicGmxApiReconciliation: mocks.startPeriodicGmxApiReconciliation,
  stopPeriodicGmxApiReconciliation: vi.fn(),
}));
vi.mock('../lib/tradeSettlement', () => ({
  reconcileLiveSettlements: vi.fn(async () => ({
    unsettledCount: 0,
    settledNow: 0,
    incomplete: false,
    reasons: [],
  })),
}));
vi.mock('../lib/productionCloseSettlementFetcher', () => ({
  createProductionCloseSettlementFetcher: vi.fn(() => vi.fn()),
}));
vi.mock('../lib/gmxApiPrepareStartup', () => ({
  reconcileGmxPrepareStagesOnStartup: vi.fn(async () => {}),
}));
vi.mock('../lib/relayActivationStatus', () => ({
  runStartupRelayReconciliation: vi.fn(async () => ({ complete: false, reasons: [] })),
  isRelayReadonlyNetworkEnabled: vi.fn(() => false),
}));
vi.mock('../lib/executionIntents', () => ({
  countBlockingIntentsOrNull: vi.fn(async () => 0),
}));
vi.mock('../lib/relayLifecycle', () => ({
  countOpenRelayTasksOrNull: vi.fn(async () => 0),
}));
vi.mock('../lib/relayNonce', () => ({
  countUnboundNoncesOrNull: vi.fn(async () => 0),
}));
vi.mock('../lib/revokeSession', () => ({
  getActiveRevokeSession: vi.fn(async () => null),
}));
vi.mock('../lib/devWebProxy', () => ({
  attachDevWebProxy: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('../lib/paperRuntimeReadiness', () => ({
  startPaperRuntimeReadinessScheduler: mocks.startPaperRuntimeReadinessScheduler,
  stopPaperRuntimeReadinessScheduler: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startWith(isShuttingDown: () => boolean = () => false): Promise<void> {
  const { startServer } = await import('../startup');
  startServer({
    httpServer: {} as Server,
    setDelegate: vi.fn(),
    isShuttingDown,
  });
}

describe('startup.ts Worker safety barrier wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.WORKER_ENGINE_MODE = 'PAPER';
    mocks.runMigrations.mockResolvedValue();
    mocks.loadEmergencyStopFromDb.mockResolvedValue(true);
    mocks.reconcileOnRestart.mockResolvedValue(true);
    mocks.workerStart.mockResolvedValue();
  });

  it('cold-start에서 emergency-stop 복원과 reconciliation 완료 전 Worker를 시작하지 않는다', async () => {
    const restore = deferred<boolean>();
    const reconciliation = deferred<boolean>();
    mocks.loadEmergencyStopFromDb.mockImplementationOnce(() => restore.promise);
    mocks.reconcileOnRestart.mockImplementationOnce(() => reconciliation.promise);

    await startWith();
    await vi.waitFor(() => expect(mocks.loadEmergencyStopFromDb).toHaveBeenCalledTimes(1));
    expect(mocks.reconcileOnRestart).not.toHaveBeenCalled();
    expect(mocks.workerStart).not.toHaveBeenCalled();

    restore.resolve(true);
    await vi.waitFor(() => expect(mocks.reconcileOnRestart).toHaveBeenCalledTimes(1));
    expect(mocks.workerStart).not.toHaveBeenCalled();

    reconciliation.resolve(true);
    await vi.waitFor(() => expect(mocks.workerStart).toHaveBeenCalledTimes(1));
    expect(mocks.loadEmergencyStopFromDb.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.reconcileOnRestart.mock.invocationCallOrder[0]);
    expect(mocks.reconcileOnRestart.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.workerStart.mock.invocationCallOrder[0]);
  });

  it('손상된 복원 상태가 false를 반환하면 Worker를 시작하지 않는다', async () => {
    mocks.loadEmergencyStopFromDb.mockResolvedValueOnce(false);

    await startWith();
    await vi.waitFor(() => expect(mocks.loadEmergencyStopFromDb).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.startPeriodicIntentReconciliation).toHaveBeenCalledTimes(1));

    expect(mocks.reconcileOnRestart).not.toHaveBeenCalled();
    expect(mocks.workerStart).not.toHaveBeenCalled();
    expect(mocks.workerStop).not.toHaveBeenCalled();
  });

  it('restart reconciliation이 실패하면 Worker를 시작하지 않는다', async () => {
    mocks.reconcileOnRestart.mockResolvedValueOnce(false);

    await startWith();
    await vi.waitFor(() => expect(mocks.reconcileOnRestart).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.startPeriodicIntentReconciliation).toHaveBeenCalledTimes(1));

    expect(mocks.workerStart).not.toHaveBeenCalled();
    expect(mocks.workerStop).not.toHaveBeenCalled();
  });

  it('migration 이후 shutdown이 시작되면 Worker를 시작하지 않는다', async () => {
    let shutdownChecks = 0;
    const isShuttingDown = vi.fn(() => {
      shutdownChecks += 1;
      return shutdownChecks >= 2;
    });

    await startWith(isShuttingDown);
    await vi.waitFor(() => expect(isShuttingDown).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.startPeriodicIntentReconciliation).toHaveBeenCalledTimes(1));

    expect(mocks.loadEmergencyStopFromDb).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileOnRestart).toHaveBeenCalledTimes(1);
    expect(mocks.workerStart).not.toHaveBeenCalled();
    expect(mocks.workerStop).not.toHaveBeenCalled();
  });
});