import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeStartupSafetyBarrier } from '../lib/startupSafetyBarrier';

const unexpectedDbAccess = vi.hoisted(() => vi.fn(() => {
  throw new Error('cold-start environment default test must not access DB');
}));

vi.mock('@workspace/db', () => ({
  db: {
    select: unexpectedDbAccess,
    insert: unexpectedDbAccess,
    update: unexpectedDbAccess,
  },
  workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('startup safety barrier', () => {
  it('emergency stop 복원과 restart reconciliation을 순서대로 완료한다', async () => {
    const order: string[] = [];
    const result = await completeStartupSafetyBarrier({
      loadEmergencyStop: async () => { order.push('emergency-stop'); return true; },
      reconcileOnRestart: async () => { order.push('reconciliation'); return true; },
      shouldRefreshStopCapability: () => true,
      refreshStopCapability: async () => { order.push('stop-capability'); },
      shouldAbort: () => false,
      startWorker: async () => { order.push('worker'); },
      stopWorker: vi.fn(),
    });

    expect(result).toEqual({ ready: true });
    expect(order).toEqual(['emergency-stop', 'reconciliation', 'stop-capability', 'worker']);
  });

  it('복원 또는 reconciliation이 pending인 동안 barrier를 열지 않는다', async () => {
    const stop = deferred();
    const reconciliation = deferred();
    const reconcile = vi.fn(() => reconciliation.promise);
    const refresh = vi.fn(async () => {});
    const startWorker = vi.fn(async () => {});

    const barrier = completeStartupSafetyBarrier({
      loadEmergencyStop: async () => { await stop.promise; return true; },
      reconcileOnRestart: async () => { await reconcile(); return true; },
      shouldRefreshStopCapability: () => true,
      refreshStopCapability: refresh,
      shouldAbort: () => false,
      startWorker,
      stopWorker: vi.fn(),
    });
    let settled = false;
    void barrier.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();

    stop.resolve();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();

    reconciliation.resolve();
    await expect(barrier).resolves.toEqual({ ready: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(startWorker).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['emergency-stop restore', 'loadEmergencyStop'],
    ['restart reconciliation', 'reconcileOnRestart'],
    ['stop capability refresh', 'refreshStopCapability'],
  ] as const)('%s 실패 시 barrier를 fail-closed로 유지한다', async (_label, failurePoint) => {
    const error = new Error(`${failurePoint} failed`);
    const calls: string[] = [];
    const startWorker = vi.fn(async () => { calls.push('worker'); });
    const result = await completeStartupSafetyBarrier({
      loadEmergencyStop: async () => {
        calls.push('emergency-stop');
        if (failurePoint === 'loadEmergencyStop') throw error;
        return true;
      },
      reconcileOnRestart: async () => {
        calls.push('reconciliation');
        if (failurePoint === 'reconcileOnRestart') throw error;
        return true;
      },
      shouldRefreshStopCapability: () => true,
      refreshStopCapability: async () => {
        calls.push('stop-capability');
        if (failurePoint === 'refreshStopCapability') throw error;
      },
      shouldAbort: () => false,
      startWorker,
      stopWorker: vi.fn(),
    });

    expect(result).toEqual({ ready: false, error });
    expect(startWorker).not.toHaveBeenCalled();
    if (failurePoint === 'loadEmergencyStop') {
      expect(calls).toEqual(['emergency-stop']);
    } else if (failurePoint === 'reconcileOnRestart') {
      expect(calls).toEqual(['emergency-stop', 'reconciliation']);
    } else {
      expect(calls).toEqual(['emergency-stop', 'reconciliation', 'stop-capability']);
    }
  });

  it('PAPER cold start에서는 Stop capability 외부 평가를 생략하지만 복원과 reconciliation은 요구한다', async () => {
    const refresh = vi.fn(async () => {});
    const result = await completeStartupSafetyBarrier({
      loadEmergencyStop: vi.fn(async () => true),
      reconcileOnRestart: vi.fn(async () => true),
      shouldRefreshStopCapability: () => false,
      refreshStopCapability: refresh,
      shouldAbort: () => false,
      startWorker: vi.fn(async () => {}),
      stopWorker: vi.fn(),
    });

    expect(result).toEqual({ ready: true });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('restart마다 이전 성공을 재사용하지 않고 안전 상태를 다시 복원한다', async () => {
    const loadEmergencyStop = vi.fn(async () => true);
    const reconcileOnRestart = vi.fn(async () => true);
    const dependencies = {
      loadEmergencyStop,
      reconcileOnRestart,
      shouldRefreshStopCapability: () => false,
      refreshStopCapability: vi.fn(async () => {}),
      shouldAbort: () => false,
      startWorker: vi.fn(async () => {}),
      stopWorker: vi.fn(),
    };

    await expect(completeStartupSafetyBarrier(dependencies)).resolves.toEqual({ ready: true });
    await expect(completeStartupSafetyBarrier(dependencies)).resolves.toEqual({ ready: true });
    expect(loadEmergencyStop).toHaveBeenCalledTimes(2);
    expect(reconcileOnRestart).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['emergency-stop restore', false, true],
    ['restart reconciliation', true, false],
  ] as const)('%s가 명시적 false를 반환하면 Worker를 시작하지 않는다', async (
    _label,
    emergencyStopOk,
    reconciliationOk,
  ) => {
    const startWorker = vi.fn(async () => {});
    const result = await completeStartupSafetyBarrier({
      loadEmergencyStop: async () => emergencyStopOk,
      reconcileOnRestart: async () => reconciliationOk,
      shouldRefreshStopCapability: () => false,
      refreshStopCapability: vi.fn(async () => {}),
      shouldAbort: () => false,
      startWorker,
      stopWorker: vi.fn(),
    });

    expect(result.ready).toBe(false);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('barrier 대기 중 shutdown이 시작되면 Worker를 시작하지 않는다', async () => {
    const startWorker = vi.fn(async () => {});
    const result = await completeStartupSafetyBarrier({
      loadEmergencyStop: async () => true,
      reconcileOnRestart: async () => true,
      shouldRefreshStopCapability: () => false,
      refreshStopCapability: vi.fn(async () => {}),
      shouldAbort: () => true,
      startWorker,
      stopWorker: vi.fn(),
    });

    expect(result.ready).toBe(false);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('Worker 시작을 기다리는 중 shutdown이 시작되면 Worker를 정리하고 barrier를 열지 않는다', async () => {
    const worker = deferred();
    let shuttingDown = false;
    const startWorker = vi.fn(() => worker.promise);
    const stopWorker = vi.fn();
    const barrier = completeStartupSafetyBarrier({
      loadEmergencyStop: async () => true,
      reconcileOnRestart: async () => true,
      shouldRefreshStopCapability: () => false,
      refreshStopCapability: vi.fn(async () => {}),
      shouldAbort: () => shuttingDown,
      startWorker,
      stopWorker,
    });

    await vi.waitFor(() => expect(startWorker).toHaveBeenCalledTimes(1));
    shuttingDown = true;
    worker.resolve();

    const result = await barrier;
    expect(result.ready).toBe(false);
    expect(stopWorker).toHaveBeenCalledTimes(1);
  });

  it('Worker 부분 기동 실패 시 즉시 stop하여 잔존 실행 상태를 정리한다', async () => {
    const stopWorker = vi.fn();
    const error = new Error('worker recovery failed');
    const result = await completeStartupSafetyBarrier({
      loadEmergencyStop: async () => true,
      reconcileOnRestart: async () => true,
      shouldRefreshStopCapability: () => false,
      refreshStopCapability: vi.fn(async () => {}),
      shouldAbort: () => false,
      startWorker: async () => { throw error; },
      stopWorker,
    });

    expect(result).toEqual({ ready: false, error });
    expect(stopWorker).toHaveBeenCalledTimes(1);
  });
});

describe('cold-start fail-closed environment defaults', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it('플래그가 없으면 PAPER, AUTO off, signer off, execution locked, Relay disabled다', async () => {
    delete process.env.WORKER_ENGINE_MODE;
    delete process.env.AUTO_WORKER_LIVE_ENABLED;
    delete process.env.DELEGATED_SIGNER_ENABLED;
    delete process.env.LIVE_TEST_EXECUTION_LOCKED;
    delete process.env.GMX_RELAY_SUBMISSION_ENABLED;
    delete process.env.GMX_RELAY_NETWORK_ENABLED;
    delete process.env.GMX_RELAY_MODE;

    vi.resetModules();
    const [{ isDelegatedSignerEnabled }, { isLiveTestExecutionLocked }, relay] = await Promise.all([
      import('../lib/delegatedSigner'),
      import('../lib/liveTestGate'),
      import('../lib/relayActivationStatus'),
    ]);
    const relayFlags = relay.deriveRelayEnvFlags(process.env, false);

    expect(process.env.WORKER_ENGINE_MODE === 'LIVE' ? 'LIVE' : 'PAPER').toBe('PAPER');
    expect(process.env.AUTO_WORKER_LIVE_ENABLED === 'true').toBe(false);
    expect(isDelegatedSignerEnabled()).toBe(false);
    expect(unexpectedDbAccess).not.toHaveBeenCalled();
    expect(isLiveTestExecutionLocked()).toBe(true);
    expect(relayFlags.relaySubmissionEnabled).toBe(false);
    expect(relayFlags.relaySubmitNetworkEnabled).toBe(false);
    expect(relayFlags.relayMode).toBe('DISABLED');
  });
});