/**
 * Task #140 composed regression:
 * finalized OPEN reconciliation → real confirmed-OPEN handoff →
 * real durable protection lifecycle → OPEN terminal transition.
 *
 * DB, status/receipt reads, and submit are in-memory boundaries. No network,
 * signing, authorization, or real order submission is reachable from this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Condition =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'in'; column: string; values: unknown[] }
  | { kind: 'and'; conditions: Condition[] };

const state = vi.hoisted(() => {
  const column = (name: string) => ({ __column: name });
  const protectionOrdersTable = {
    __table: 'protections',
    id: column('id'),
    parentOpenIntentId: column('parentOpenIntentId'),
    positionKey: column('positionKey'),
    purpose: column('purpose'),
    symbol: column('symbol'),
    marketAddress: column('marketAddress'),
    isLong: column('isLong'),
    sizeDeltaUsd: column('sizeDeltaUsd'),
    triggerPriceUsd: column('triggerPriceUsd'),
    acceptablePriceUsd: column('acceptablePriceUsd'),
    dayKey: column('dayKey'),
    status: column('status'),
    requestId: column('requestId'),
    orderKey: column('orderKey'),
    typedDataDigest: column('typedDataDigest'),
    evidence: column('evidence'),
    error: column('error'),
    submitAttempts: column('submitAttempts'),
    updatedAt: column('updatedAt'),
  };
  const relayTasksTable = {
    __table: 'relay',
    id: column('id'),
    status: column('status'),
    transportGen: column('transportGen'),
  };
  return {
    protectionOrdersTable,
    relayTasksTable,
    protections: new Map<string, Row>(),
    relayTasks: new Map<string, Row>(),
    protectionStatusHistory: [] as string[],
    relayStatusHistory: [] as string[],
    relayTransitionFailures: 0,
    resolvedIntents: new Map<string, string>(),
  };
});

function matches(row: Row, condition?: Condition): boolean {
  if (!condition) return true;
  if (condition.kind === 'eq') return row[condition.column] === condition.value;
  if (condition.kind === 'in') return condition.values.includes(row[condition.column]);
  return condition.conditions.every((part) => matches(row, part));
}

vi.mock('drizzle-orm', () => ({
  eq: (column: { __column: string }, value: unknown): Condition => ({
    kind: 'eq',
    column: column.__column,
    value,
  }),
  inArray: (column: { __column: string }, values: unknown[]): Condition => ({
    kind: 'in',
    column: column.__column,
    values,
  }),
  and: (...conditions: Condition[]): Condition => ({ kind: 'and', conditions }),
  sql: () => ({ __increment: true }),
}));

vi.mock('@workspace/db', () => {
  function rowsFor(table: { __table: string }): Row[] {
    return table.__table === 'protections'
      ? [...state.protections.values()]
      : [...state.relayTasks.values()];
  }

  return {
    protectionOrdersTable: state.protectionOrdersTable,
    relayTasksTable: state.relayTasksTable,
    db: {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: (condition: Condition) => {
            const rows = rowsFor(table).filter((row) => matches(row, condition));
            return {
              then: <TResult1 = Row[], TResult2 = never>(
                onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) => Promise.resolve(rows).then(onfulfilled, onrejected),
              limit: async (count: number) => rows.slice(0, count),
            };
          },
        }),
      }),
      insert: (table: { __table: string }) => ({
        values: async (value: Row) => {
          if (table.__table !== 'protections') throw new Error('unexpected relay insert');
          const id = String(value.id);
          if (state.protections.has(id)) throw new Error('duplicate');
          for (const row of state.protections.values()) {
            if (row.positionKey === value.positionKey
                && row.purpose === value.purpose
                && !['EXECUTED', 'CANCELLED'].includes(String(row.status))) {
              throw new Error('unique active protection');
            }
          }
          state.protections.set(id, {
            requestId: null,
            orderKey: null,
            typedDataDigest: null,
            evidence: null,
            error: null,
            submitAttempts: 0,
            updatedAt: new Date(),
            ...value,
          });
          state.protectionStatusHistory.push(String(value.status));
        },
      }),
      update: (table: { __table: string }) => ({
        set: (patch: Row) => ({
          where: (condition: Condition) => {
            let applied: Row[] | null = null;
            const execute = (): Row[] => {
              if (applied) return applied;
              applied = rowsFor(table).filter((row) => matches(row, condition));
              for (const row of applied) {
                for (const [key, value] of Object.entries(patch)) {
                  row[key] = value && typeof value === 'object' && '__increment' in value
                    ? Number(row[key] ?? 0) + 1
                    : value;
                }
                if (table.__table === 'protections' && typeof patch.status === 'string') {
                  state.protectionStatusHistory.push(patch.status);
                }
              }
              return applied;
            };
            return {
              then: <TResult1 = Row[], TResult2 = never>(
                onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) => Promise.resolve(execute()).then(onfulfilled, onrejected),
              returning: async () => execute().map((row) => ({ id: row.id })),
            };
          },
        }),
      }),
    },
  };
});

const transitionRelayTask = vi.hoisted(() => vi.fn(async (input: {
  taskId: string;
  from: string;
  to: string;
  patch?: Row;
}) => {
  if (state.relayTransitionFailures > 0) {
    state.relayTransitionFailures -= 1;
    return { ok: false, reason: 'simulated terminal CAS loss' };
  }
  const row = state.relayTasks.get(input.taskId);
  if (!row || row.status !== input.from) return { ok: false, reason: 'status mismatch' };
  Object.assign(row, input.patch ?? {}, { status: input.to });
  state.relayStatusHistory.push(input.to);
  return { ok: true };
}));

vi.mock('../lib/relayLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/relayLifecycle')>();
  return { ...actual, transitionRelayTask };
});

const resolveIntentTerminal = vi.hoisted(() => vi.fn(async (
  intentId: string,
  status: string,
) => {
  state.resolvedIntents.set(intentId, status);
  return true;
}));

vi.mock('../lib/executionIntents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/executionIntents')>();
  return { ...actual, resolveIntentTerminal };
});

const eventState = vi.hoisted(() => ({
  resolution: null as null | {
    kind: 'executed';
    txHash: string;
    blockNumber: string;
    emitterAddress: string;
  },
}));

vi.mock('../lib/gmxOrderEvents', () => ({
  classifyOrderResolutionLogs: vi.fn(() => eventState.resolution),
  extractOrderKeyFromReceiptLogs: vi.fn(() => ({ ok: false, reason: 'not_found' })),
  resolveGmxEventEmitterAddress: vi.fn(() => ({ ok: true, address: EMITTER })),
}));
vi.mock('../lib/intentReconciler', () => ({
  createViemOnchainClient: vi.fn(() => { throw new Error('network forbidden in integration test'); }),
}));
vi.mock('../lib/profitProtection', () => ({
  manilaDayKey: vi.fn(() => '2026-08-30'),
}));

import {
  reconcileGmxApiTasks,
  setConfirmedOpenHandoff,
  type ConfirmedOpenHandoffInput,
} from '../lib/gmxApiStatusReconciler';
import { runConfirmedOpenStopHandoff } from '../lib/confirmedOpenStopHandoff';
import {
  createInitialStopAfterOpenConfirmed,
  recordInitialStopHandoffFailure,
  runEmergencyClose,
  setProtectionSubmitFn,
  type ProtectionSubmitOutcome,
  type ProtectionSubmitRequest,
} from '../workers/protectionExecutor';
import { getProtection } from '../lib/protectionOrders';
import type { GmxApiTransport } from '../lib/gmxApiTransport';

const INTENT_ID = 'intent:open:ai/9dc4036f-9083-4670-b28a-e69dfce5fdc3';
const TASK_ID = 'task-open-1';
const ORDER_KEY = `0x${'a'.repeat(64)}`;
const TX_HASH = `0x${'b'.repeat(64)}`;
const POSITION_KEY = `0x${'c'.repeat(64)}`;
const MARKET = `0x${'d'.repeat(40)}`;
const COLLATERAL = `0x${'6'.repeat(40)}`;
const EMITTER = `0x${'e'.repeat(40)}`;
const NOW = new Date('2026-08-30T12:00:00.000Z');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function seedRelayTask(): void {
  state.relayTasks.set(TASK_ID, {
    id: TASK_ID,
    kind: 'OPEN',
    status: 'TASK_ACCEPTED',
    transportGen: 'GMX_API_V2',
    gmxRequestId: 'request-open-1',
    relayTaskId: null,
    intentId: INTENT_ID,
    gmxExecutionTxHash: null,
    gmxOrderKeys: null,
    txHash: null,
  });
}

function makeTransport(): GmxApiTransport & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    readonlyEnabled: true,
    submissionEnabled: false,
    peers: ['https://fixture.invalid'],
    calls,
    async postJson(path: string, body: unknown) {
      calls.push({ path, body });
      return {
        ok: true,
        peerHost: 'fixture.invalid',
        data: {
          status: 'executed',
          requestId: 'request-open-1',
          executionTxHash: TX_HASH,
          orderKeys: [ORDER_KEY],
        },
      } as never;
    },
    async getJson() { throw new Error('unexpected GET'); },
  } as never;
}

function makeOnchain() {
  return {
    getChainId: vi.fn(async () => 42161),
    getTransactionReceipt: vi.fn(async () => ({
      status: 'success',
      blockNumber: '100',
      logs: [],
    })),
    getOrderResolutionLogs: vi.fn(async () => []),
    getLatestBlockNumber: vi.fn(async () => 115n),
  } as never;
}

function wireRealHandoff(options: {
  collateralToken?: string;
  actionBudgetReady?: boolean;
} = {}): void {
  setConfirmedOpenHandoff((evidence: ConfirmedOpenHandoffInput) =>
    runConfirmedOpenStopHandoff(evidence, {
      now: () => NOW,
      finalityDepth: 15,
      expectedCollateralToken: COLLATERAL,
      loadIntent: vi.fn(async () => ({
        id: INTENT_ID,
        orderType: 'open',
        symbol: 'ETH',
        isLong: true,
      })),
      marketAddressForSymbol: vi.fn(() => MARKET),
      fetchPositions: vi.fn(async () => [{
        positionKey: POSITION_KEY,
        marketAddress: MARKET,
        collateralToken: options.collateralToken ?? COLLATERAL,
        isLong: true,
        sizeUsd: 42.5,
      }]),
      loadStopPlan: vi.fn(async () => ({
        ok: true,
        plan: {
          status: 'PENDING',
          triggerPriceUsd: 2_970,
          acceptablePriceUsd: 2_955.15,
          marketAddress: MARKET,
          symbol: 'ETH',
          isLong: true,
        },
      })),
      decimalsReady: vi.fn(async () => true),
      executionCostReady: vi.fn(() => true),
      actionBudgetReady: vi.fn(async () => options.actionBudgetReady ?? true),
      signerBindingReady: vi.fn(async () => true),
      createInitialStop: createInitialStopAfterOpenConfirmed,
      recordStopFailure: recordInitialStopHandoffFailure,
      runEmergencyClose: (open, reason, now) => runEmergencyClose({
        parentOpenIntentId: open.parentOpenIntentId,
        sourceOpenTaskId: open.sourceOpenTaskId,
        positionKey: open.positionKey,
        symbol: open.symbol,
        marketAddress: open.marketAddress,
        isLong: open.isLong,
        fullSizeUsd: open.confirmedSizeUsd,
        reason,
        ...(open.manualCanary ? { manualCanary: true as const } : {}),
        now,
      }),
    }));
}

async function reconcile(transport = makeTransport()) {
  const summary = await reconcileGmxApiTasks({
    transport,
    onchain: makeOnchain(),
    nowMs: () => NOW.getTime(),
  });
  return { summary, transport };
}

beforeEach(() => {
  state.protections.clear();
  state.relayTasks.clear();
  state.protectionStatusHistory.length = 0;
  state.relayStatusHistory.length = 0;
  state.relayTransitionFailures = 0;
  state.resolvedIntents.clear();
  transitionRelayTask.mockClear();
  resolveIntentTerminal.mockClear();
  setConfirmedOpenHandoff(null);
  setProtectionSubmitFn(null);
  seedRelayTask();
  eventState.resolution = {
    kind: 'executed',
    txHash: TX_HASH,
    blockNumber: '100',
    emitterAddress: EMITTER,
  };
});

describe('finalized OPEN → real initial-stop protection composition', () => {
  it('initial stop durable 처리 완료 전에는 OPEN을 terminal-confirmed하지 않고 exact binding 후에만 해소한다', async () => {
    const pendingSubmit = deferred<ProtectionSubmitOutcome>();
    const submit = vi.fn((request: ProtectionSubmitRequest) => pendingSubmit.promise);
    setProtectionSubmitFn(submit);
    wireRealHandoff();

    const run = reconcile();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      parentOpenIntentId: INTENT_ID,
      sourceOpenTaskId: TASK_ID,
      positionKey: POSITION_KEY,
      purpose: 'INITIAL_STOP',
      symbol: 'ETH',
      marketAddress: MARKET,
      isLong: true,
      sizeDeltaUsd: 42.5,
      triggerPriceUsd: 2_970,
      acceptablePriceUsd: 2_955.15,
    }));
    expect((await getProtection(`prot:${INTENT_ID}:INITIAL_STOP`))?.status).toBe('SUBMITTING');
    expect(state.relayTasks.get(TASK_ID)?.status).toBe('TASK_ACCEPTED');
    expect(resolveIntentTerminal).not.toHaveBeenCalled();

    pendingSubmit.resolve({
      status: 'ACCEPTED',
      requestId: 'stop-request-1',
      typedDataDigest: 'fixture-digest',
    });
    const { summary, transport } = await run;

    expect(summary.transitioned).toBe(1);
    expect(state.protectionStatusHistory).toEqual([
      'PLANNED', 'PREPARED', 'SUBMITTING', 'SUBMITTED',
    ]);
    expect((await getProtection(`prot:${INTENT_ID}:INITIAL_STOP`))).toMatchObject({
      parentOpenIntentId: INTENT_ID,
      positionKey: POSITION_KEY,
      purpose: 'INITIAL_STOP',
      status: 'SUBMITTED',
      submitAttempts: 1,
      requestId: 'stop-request-1',
    });
    expect(state.relayTasks.get(TASK_ID)).toMatchObject({
      status: 'CONFIRMED',
      txHash: TX_HASH,
      orderKey: ORDER_KEY,
    });
    expect(state.resolvedIntents.get(INTENT_ID)).toBe('CONFIRMED');
    expect(transport.submissionEnabled).toBe(false);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.path).toContain('status');
  });

  it('authoritative position 증거가 불일치하면 OPEN과 intent를 차단 상태로 유지하고 protection 제출을 생성하지 않는다', async () => {
    const submit = vi.fn();
    setProtectionSubmitFn(submit as never);
    wireRealHandoff({ collateralToken: `0x${'7'.repeat(40)}` });

    const { summary, transport } = await reconcile();

    expect(summary.transitioned).toBe(0);
    expect(state.relayTasks.get(TASK_ID)?.status).toBe('TASK_ACCEPTED');
    expect(state.resolvedIntents.has(INTENT_ID)).toBe(false);
    expect(state.protections.size).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(transport.submissionEnabled).toBe(false);
    expect(transport.calls).toHaveLength(1);
  });

  it('stop/emergency 결과 불명과 terminal CAS 재시도에도 protection과 close를 각각 한 번만 시도한다', async () => {
    const submit = vi.fn(async (
      _request: ProtectionSubmitRequest,
    ): Promise<ProtectionSubmitOutcome> => ({
      status: 'UNRESOLVED',
      reason: 'fixture ambiguous outcome',
    }));
    setProtectionSubmitFn(submit);
    wireRealHandoff();
    state.relayTransitionFailures = 1;

    const first = await reconcile();
    expect(first.summary.transitioned).toBe(0);
    expect(state.relayTasks.get(TASK_ID)?.status).toBe('TASK_ACCEPTED');
    expect(state.resolvedIntents.has(INTENT_ID)).toBe(false);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls.map(([request]) => request.purpose)).toEqual([
      'INITIAL_STOP', 'EMERGENCY_CLOSE',
    ]);
    expect((await getProtection(`prot:${INTENT_ID}:INITIAL_STOP`))).toMatchObject({
      status: 'UNRESOLVED',
      submitAttempts: 1,
    });
    expect((await getProtection(`prot:${INTENT_ID}:EMERGENCY_CLOSE`))).toMatchObject({
      status: 'UNRESOLVED',
      submitAttempts: 1,
    });

    const second = await reconcile();
    expect(second.summary.transitioned).toBe(1);
    expect(state.relayTasks.get(TASK_ID)?.status).toBe('CONFIRMED');
    expect(state.resolvedIntents.get(INTENT_ID)).toBe('CONFIRMED');
    expect(state.protections.size).toBe(2);
    expect(submit).toHaveBeenCalledTimes(2);

    const third = await reconcile();
    expect(third.summary.scanned).toBe(0);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(state.protections.size).toBe(2);
  });
});