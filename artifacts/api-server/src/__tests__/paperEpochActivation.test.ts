import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setPaperEpochActivationRuntimeForTests, activatePaperEpoch, validatePaperEpochActivationBody,
} from '../lib/paperEpochActivation';
import { initialRiskEngineState } from '../lib/riskEngineState';
import {
  buildActivePaperEpoch,
  buildPaperEpochBinding,
} from '../lib/paperEpochState';

const safeEnv: NodeJS.ProcessEnv = {
  WORKER_ENGINE_MODE: 'PAPER',
  AUTO_WORKER_LIVE_ENABLED: 'false',
  GMX_RELAY_SUBMISSION_ENABLED: 'false',
  GMX_RELAY_NETWORK_ENABLED: 'false',
  GMX_RELAY_MODE: 'DISABLED',
  DELEGATED_SIGNER_ENABLED: 'true',
  GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
  LIVE_TEST_EXECUTION_LOCKED: 'false',
};

afterEach(() => __setPaperEpochActivationRuntimeForTests(null));

function emptyPaperStatus() {
  return {
    openPosition: null,
    openPositions: [],
    pendingClose: null,
    unresolved: null,
    lastTickAt: null,
    lastTickStale: false,
    lastOpenAttempt: null,
    lastCloseAction: null,
  } as never;
}

type TxHarnessOptions = {
  selectResults: unknown[][];
  updateResult?: unknown[];
  auditInsertResult?: unknown[];
};

function makeTxHarness(options: TxHarnessOptions) {
  const selectResults = [...options.selectResults];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const inserts: Array<{
    table: unknown;
    value: Record<string, unknown>;
    conflict: 'nothing' | 'update' | null;
  }> = [];

  function query(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'offset', 'orderBy']) {
      chain[method] = () => chain;
    }
    chain.then = (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return chain;
  }

  const tx = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => query(selectResults.shift() ?? [])),
    update: vi.fn((table: unknown) => {
      const record = { table, value: undefined as unknown };
      updates.push(record);
      const chain = query(options.updateResult ?? [{ id: 'strategy-1' }]);
      chain.set = (value: unknown) => {
        record.value = value;
        return chain;
      };
      chain.where = () => chain;
      chain.returning = () => chain;
      return chain;
    }),
    insert: vi.fn((table: unknown) => {
      const record = {
        table,
        value: {} as Record<string, unknown>,
        conflict: null as 'nothing' | 'update' | null,
      };
      inserts.push(record);
      const insertIndex = inserts.length - 1;
      const chain = query(insertIndex === 0 ? (options.auditInsertResult ?? [{ key: 'audit' }]) : []);
      chain.values = (value: Record<string, unknown>) => {
        record.value = value;
        return chain;
      };
      chain.onConflictDoNothing = () => {
        record.conflict = 'nothing';
        return chain;
      };
      chain.onConflictDoUpdate = () => {
        record.conflict = 'update';
        return chain;
      };
      chain.returning = () => chain;
      return chain;
    }),
  };

  return { tx, updates, inserts };
}

function installTransactionRuntime(
  harness: ReturnType<typeof makeTxHarness>,
  now = new Date('2026-09-03T19:00:00.000Z'),
) {
  const events: string[] = [];
  const apply = vi.fn((..._args: unknown[]) => { events.push('memory'); });
  const release = vi.fn();
  const runTransaction = vi.fn(async (work: (tx: never) => Promise<unknown>) => {
    events.push('transaction-start');
    const result = await work(harness.tx as never);
    events.push('transaction-commit');
    return result;
  });
  __setPaperEpochActivationRuntimeForTests({
    getServerPaperStatus: emptyPaperStatus,
    applyPaperEpochInMemory: apply,
    isPaperEpochActivationHeld: () => false,
    isWorkerCycleInProgress: () => false,
    tryAcquirePaperEpochActivationLock: () => true,
    releasePaperEpochActivationLock: release,
    now: () => now,
    runTransaction: runTransaction as never,
  });
  return { apply, events, release, runTransaction };
}

describe('PAPER epoch activation request contract', () => {
  it('accepts only the exact approved $1,000 payload', () => {
    expect(validatePaperEpochActivationBody({
      approved: true, activeCapitalUsd: 1000, idempotencyKey: 'epoch-001',
    })).toBeNull();
    for (const body of [
      {}, { approved: false, activeCapitalUsd: 1000, idempotencyKey: 'x' },
      { approved: true, activeCapitalUsd: 999, idempotencyKey: 'x' },
      { approved: true, activeCapitalUsd: 1000, idempotencyKey: '' },
      { approved: true, activeCapitalUsd: 1000, idempotencyKey: 'x', extra: true },
      { approved: true, activeCapitalUsd: 1000, idempotencyKey: 'space key' },
    ]) expect(validatePaperEpochActivationBody(body)).toBe('INVALID_BODY');
  });

  it('rejects boundary drift before opening a transaction', async () => {
    const runTransaction = vi.fn();
    __setPaperEpochActivationRuntimeForTests({ runTransaction: runTransaction as never });
    const result = await activatePaperEpoch('no-tx', {
      WORKER_ENGINE_MODE: 'LIVE',
      AUTO_WORKER_LIVE_ENABLED: 'false',
      GMX_RELAY_SUBMISSION_ENABLED: 'false',
      GMX_RELAY_NETWORK_ENABLED: 'false',
      GMX_RELAY_MODE: 'DISABLED',
      DELEGATED_SIGNER_ENABLED: 'true',
      GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
      LIVE_TEST_EXECUTION_LOCKED: 'false',
    });
    expect(result).toEqual({ status: 'BLOCKED', blockers: ['WORKER_ENGINE_MODE_DRIFT'] });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['GMX_RELAY_SUBMISSION_ENABLED', { GMX_RELAY_SUBMISSION_ENABLED: undefined }],
    ['GMX_RELAY_NETWORK_ENABLED', { GMX_RELAY_NETWORK_ENABLED: undefined }],
    ['GMX_RELAY_MODE', { GMX_RELAY_MODE: undefined }],
    ['GMX_RELAY_MODE', { GMX_RELAY_MODE: 'UNKNOWN' }],
  ] as const)('requires explicit disabled Relay boundary for %s', async (key, override) => {
    const runTransaction = vi.fn();
    __setPaperEpochActivationRuntimeForTests({ runTransaction: runTransaction as never });
    const result = await activatePaperEpoch('strict-relay', {
      ...safeEnv,
      ...override,
    });
    expect(result).toEqual({
      status: 'BLOCKED',
      blockers: [`${key}_DRIFT`],
    });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('returns BUSY before a transaction when activation or worker is busy', async () => {
    const acquire = vi.fn(() => true);
    __setPaperEpochActivationRuntimeForTests({
      isPaperEpochActivationHeld: () => true,
      isWorkerCycleInProgress: () => false,
      tryAcquirePaperEpochActivationLock: acquire,
    });
    await expect(activatePaperEpoch('busy', safeEnv)).resolves.toEqual({
      status: 'BUSY', retryable: true,
    });
    expect(acquire).not.toHaveBeenCalled();

    __setPaperEpochActivationRuntimeForTests({
      isPaperEpochActivationHeld: () => false,
      isWorkerCycleInProgress: () => true,
      tryAcquirePaperEpochActivationLock: acquire,
    });
    await expect(activatePaperEpoch('worker-busy', safeEnv)).resolves.toEqual({
      status: 'BUSY', retryable: true,
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each(['pendingClose', 'unresolved'] as const)(
    'blocks in-memory server PAPER %s before a transaction',
    async (field) => {
      const acquire = vi.fn(() => true);
      const release = vi.fn();
      const runTransaction = vi.fn();
      __setPaperEpochActivationRuntimeForTests({
        isPaperEpochActivationHeld: () => false,
        isWorkerCycleInProgress: () => false,
        tryAcquirePaperEpochActivationLock: acquire,
        releasePaperEpochActivationLock: release,
        runTransaction: runTransaction as never,
        getServerPaperStatus: () => ({
          openPosition: null, openPositions: [], pendingClose: field === 'pendingClose' ? {} as never : null,
          unresolved: field === 'unresolved' ? {} as never : null,
          lastTickAt: null, lastTickStale: false, lastOpenAttempt: null, lastCloseAction: null,
        }),
      });
      await expect(activatePaperEpoch(`memory-${field}`, safeEnv)).resolves.toEqual({
        status: 'BLOCKED', blockers: ['SERVER_PAPER_NOT_QUIESCENT'],
      });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(runTransaction).not.toHaveBeenCalled();
    },
  );
});

describe('PAPER epoch activation transaction', () => {
  const emptyCounts: unknown[][] = [[], [], [], [], [], []];
  const previousRiskRaw = JSON.stringify({
    riskOperatingState: 'HARD_STOPPED',
    locks: { hardStopReason: 'historical trigger' },
    dailyEntryCount: 4,
    consecutiveLossCount: 3,
  });
  const previousDailyRaw = JSON.stringify({
    periodStart: '2026-09-03T00:00:00.000Z',
    equity: 24.5,
    recordedAt: '2026-09-03T18:00:00.000Z',
  });
  const previousWeeklyRaw = JSON.stringify({
    periodStart: '2026-08-31T00:00:00.000Z',
    equity: 24.5,
    recordedAt: '2026-09-03T18:00:00.000Z',
  });
  const stateRows = [
    { key: 'paperEpochActiveV1', value: '{"epochId":"legacy-epoch"}' },
    { key: 'equityHwm', value: '1000' },
    { key: 'equityBaselineDaily', value: previousDailyRaw },
    { key: 'equityBaselineWeekly', value: previousWeeklyRaw },
    { key: 'riskEngineStateV1', value: previousRiskRaw },
  ];
  const configRows = [{
    id: 'strategy-1',
    limits: { tradingCapital: 24.5, reserveCashPct: 20, maxDrawdownPercent: 8 },
  }];

  it.each([
    ['OPEN', 0, [{ id: 'open-1' }]],
    ['APPROVALS', 1, [{ id: 'approval-1' }]],
    ['INTENTS', 2, [{ id: 'intent-1' }]],
    ['PROTECTIONS', 3, [{ id: 'protection-1' }]],
    ['UNSETTLED', 4, [{ id: 'trade-1' }]],
    ['RELAY', 5, [{ id: 'relay-1', status: 'SUBMITTED' }]],
  ] as const)('blocks non-zero %s before durable writes', async (name, index, rows) => {
    const counts = emptyCounts.map((value) => [...value]);
    counts[index] = [...rows];
    const harness = makeTxHarness({ selectResults: [[], ...counts] });
    const { apply } = installTransactionRuntime(harness);

    await expect(activatePaperEpoch(`blocked-${name}`, safeEnv)).resolves.toEqual({
      status: 'BLOCKED',
      blockers: [`${name}_NON_ZERO`],
    });
    expect(harness.updates).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('fails closed on a transaction error without a memory handoff', async () => {
    const apply = vi.fn();
    const release = vi.fn();
    __setPaperEpochActivationRuntimeForTests({
      getServerPaperStatus: emptyPaperStatus,
      applyPaperEpochInMemory: apply,
      isPaperEpochActivationHeld: () => false,
      isWorkerCycleInProgress: () => false,
      tryAcquirePaperEpochActivationLock: () => true,
      releasePaperEpochActivationLock: release,
      runTransaction: vi.fn(async () => { throw new Error('rollback'); }) as never,
    });

    await expect(activatePaperEpoch('rollback', safeEnv)).resolves.toEqual({
      status: 'BLOCKED',
      blockers: ['ACTIVATION_FAILED_CLOSED'],
    });
    expect(apply).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('atomically writes the exact epoch values and preserves prior evidence', async () => {
    const harness = makeTxHarness({
      selectResults: [[], ...emptyCounts, stateRows, configRows],
    });
    const { apply, events } = installTransactionRuntime(harness);

    const result = await activatePaperEpoch('approved-1000', safeEnv);
    expect(result).toEqual({
      status: 'APPLIED',
      epochId: 'paper-1788462000000-approved-1000',
    });
    expect(events).toEqual(['transaction-start', 'transaction-commit', 'memory']);
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0].value).toMatchObject({
      limits: {
        tradingCapital: 1000,
        reserveCashPct: 20,
        maxDrawdownPercent: 8,
      },
    });

    expect(harness.inserts).toHaveLength(6);
    const auditWrite = harness.inserts[0];
    expect(auditWrite.conflict).toBe('nothing');
    expect(auditWrite.value.key).toBe('paperEpochActivation:approved-1000');
    const audit = JSON.parse(String(auditWrite.value.value));
    expect(audit.before).toMatchObject({
      activeEpoch: '{"epochId":"legacy-epoch"}',
      risk: previousRiskRaw,
      daily: previousDailyRaw,
      weekly: previousWeeklyRaw,
      limits: configRows[0].limits,
    });
    expect(audit.after).toMatchObject({
      limits: {
        tradingCapital: 1000,
        reserveCashPct: 20,
        maxDrawdownPercent: 8,
      },
      equityHwm: 1000,
      daily: { equity: 1000 },
      weekly: { equity: 1000 },
      risk: {
        riskOperatingState: 'NORMAL',
        startOfDayEquityUsd: 1000,
        startOfWeekEquityUsd: 1000,
      },
    });
    expect(audit.zeroStateCounts).toEqual({
      open: 0,
      approvals: 0,
      intents: 0,
      protections: 0,
      unsettled: 0,
      relay: 0,
    });

    const stateWrites = new Map(
      harness.inserts.slice(1).map((write) => [write.value.key, write.value.value]),
    );
    expect(stateWrites.get('equityHwm')).toBe('1000');
    expect(JSON.parse(String(stateWrites.get('equityBaselineDaily'))).equity).toBe(1000);
    expect(JSON.parse(String(stateWrites.get('equityBaselineWeekly'))).equity).toBe(1000);
    expect(JSON.parse(String(stateWrites.get('riskEngineStateV1'))).riskOperatingState).toBe('NORMAL');
    expect(JSON.parse(String(stateWrites.get('paperEpochActiveV1')))).toMatchObject({
      activeCapitalUsd: 1000,
      equityHwmUsd: 1000,
      dailyBaselineUsd: 1000,
      weeklyBaselineUsd: 1000,
      engineMode: 'PAPER',
      executionAuthorized: false,
      relaySubmissionEnabled: false,
      relaySubmitNetworkEnabled: false,
      relayMode: 'DISABLED',
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing config update row', [], [{ key: 'audit' }]],
    ['conflicting immutable audit', [{ id: 'strategy-1' }], []],
  ])('rolls back when %s is detected', async (_name, updateResult, auditInsertResult) => {
    const harness = makeTxHarness({
      selectResults: [[], ...emptyCounts, stateRows, configRows],
      updateResult,
      auditInsertResult,
    });
    const { apply } = installTransactionRuntime(harness);

    await expect(activatePaperEpoch('write-conflict', safeEnv)).resolves.toEqual({
      status: 'BLOCKED',
      blockers: ['ACTIVATION_FAILED_CLOSED'],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('replays only the currently active immutable epoch without writes', async () => {
    const startedAt = new Date('2026-09-03T19:00:00.000Z');
    const evolvedAt = new Date('2026-09-03T19:30:00.000Z');
    const epochId = 'paper-1788462000000-approved-1000';
    const initialRisk = initialRiskEngineState(startedAt, 1000);
    const initialLimits = { tradingCapital: 1000, reserveCashPct: 20 };
    const initialDaily = {
      periodStart: '2026-09-03T00:00:00.000Z',
      equity: 1000,
      recordedAt: startedAt.toISOString(),
    };
    const initialWeekly = {
      periodStart: '2026-08-31T00:00:00.000Z',
      equity: 1000,
      recordedAt: startedAt.toISOString(),
    };
    const currentRisk = {
      ...initialRisk,
      riskOperatingState: 'DAILY_LOCKED' as const,
      startOfDayEquityUsd: 1025,
      lastUpdatedAt: evolvedAt.toISOString(),
    };
    const currentLimits = { tradingCapital: 1000, reserveCashPct: 21 };
    const currentDaily = { ...initialDaily, equity: 1025, recordedAt: evolvedAt.toISOString() };
    const currentWeekly = { ...initialWeekly, recordedAt: evolvedAt.toISOString() };
    const active = buildActivePaperEpoch('approved-1000', startedAt);
    const binding = buildPaperEpochBinding(
      active,
      initialLimits,
      initialDaily,
      initialWeekly,
      initialRisk,
    );
    const audit = {
      schemaVersion: 1,
      idempotencyKey: 'approved-1000',
      epochId,
      appliedAt: startedAt.toISOString(),
      appliedAtMs: startedAt.getTime(),
      before: {
        activeEpoch: null,
        equityHwm: '1000',
        daily: null,
        weekly: null,
        risk: null,
        limits: { tradingCapital: 24.5, reserveCashPct: 20 },
      },
      after: {
        activeEpoch: active,
        limits: initialLimits,
        equityHwm: 1000,
        daily: initialDaily,
        weekly: initialWeekly,
        risk: initialRisk,
      },
      zeroStateCounts: {
        open: 0,
        approvals: 0,
        intents: 0,
        protections: 0,
        unsettled: 0,
        relay: 0,
      },
      binding,
    };
    const replayState = [
      { key: 'paperEpochActiveV1', value: JSON.stringify(active) },
      { key: 'equityHwm', value: '1025' },
      { key: 'riskEngineStateV1', value: JSON.stringify(currentRisk) },
      { key: 'equityBaselineDaily', value: JSON.stringify(currentDaily) },
      { key: 'equityBaselineWeekly', value: JSON.stringify(currentWeekly) },
    ];
    const harness = makeTxHarness({
      selectResults: [
        [{ key: 'paperEpochActivation:approved-1000', value: JSON.stringify(audit) }],
        replayState,
        [{ id: 'strategy-1', limits: currentLimits }],
      ],
    });
    const { apply } = installTransactionRuntime(harness, new Date('2026-09-03T20:00:00.000Z'));

    await expect(activatePaperEpoch('approved-1000', safeEnv)).resolves.toEqual({
      status: 'ALREADY_APPLIED',
      epochId,
    });
    expect(harness.updates).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][2]).toBe(startedAt.getTime());
    expect(apply.mock.calls[0][3]).toEqual(currentDaily);
    expect(apply.mock.calls[0][5]).toEqual(currentLimits);
    expect(apply.mock.calls[0][6]).toEqual(currentRisk);
    expect(apply.mock.calls[0][7]).toBe(1025);
    expect(apply.mock.calls[0][8]).toBe(false);
  });

  it('fails closed when an idempotency key points to an archived or corrupt epoch', async () => {
    const harness = makeTxHarness({
      selectResults: [
        [{ key: 'paperEpochActivation:old-key', value: JSON.stringify({
          idempotencyKey: 'old-key',
          epochId: 'paper-old',
        }) }],
        [{
          key: 'paperEpochActiveV1',
          value: JSON.stringify({
            epochId: 'paper-new',
            activeCapitalUsd: 1000,
          }),
        }],
        [{ id: 'strategy-1', limits: { tradingCapital: 1000 } }],
      ],
    });
    const { apply } = installTransactionRuntime(harness);

    await expect(activatePaperEpoch('old-key', safeEnv)).resolves.toEqual({
      status: 'BLOCKED',
      blockers: ['ACTIVATION_FAILED_CLOSED'],
    });
    expect(harness.updates).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
  });
});