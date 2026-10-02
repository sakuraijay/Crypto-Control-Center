/**
 * Production CLOSE settlement collector composition.
 *
 * Uses the real production fetcher, CLOSE evidence evaluator, settlement
 * reconciler, and durable settlement writer with in-memory DB/RPC/PositionReader
 * boundaries. No HTTP, RPC, signing, preparation, submission, or order creation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pad } from 'viem';
import { WETH_ARBITRUM } from '../lib/relayFeeQuote';
import { mkEventLog1, mkEventLog2 } from './helpers/eventLog2Fixture';

type Row = Record<string, unknown>;
type Condition =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'not-null'; column: string }
  | { kind: 'and' | 'or'; conditions: Condition[] };

const state = vi.hoisted(() => {
  const column = (name: string) => ({ __column: name });
  const table = (name: string, columns: string[]) => Object.assign(
    { __table: name },
    Object.fromEntries(columns.map((name) => [name, column(name)])),
  );
  return {
    tradesTable: table('trades', [
      'id', 'symbol', 'action', 'testMode', 'settlementStatus',
      'settlementIntentId', 'settlementAccount', 'settlementMarketAddress',
      'settlementCollateralToken', 'settlementPositionKey', 'preCloseSizeUsd30',
      'requestedReductionUsd30', 'evidenceTxHash',
    ]),
    executionIntentsTable: table('intents', ['id']),
    relayTasksTable: table('tasks', ['id', 'intentId']),
    trades: new Map<string, Row>(),
    intents: new Map<string, Row>(),
    tasks: new Map<string, Row>(),
    positions: [] as Row[] | null,
    receipt: null as null | Row,
    latestBlock: 115n,
    blockTimestamp: 1_788_163_323n,
    rpcCalls: {
      receipt: vi.fn(),
      latestBlock: vi.fn(),
      block: vi.fn(),
    },
    positionCalls: vi.fn(),
    transactionCount: 0,
    updateCount: 0,
  };
});

function matches(row: Row, condition?: Condition): boolean {
  if (!condition) return true;
  if (condition.kind === 'eq') return row[condition.column] === condition.value;
  if (condition.kind === 'not-null') return row[condition.column] !== null
    && row[condition.column] !== undefined;
  return condition.kind === 'and'
    ? condition.conditions.every((part) => matches(row, part))
    : condition.conditions.some((part) => matches(row, part));
}

vi.mock('drizzle-orm', () => ({
  eq: (column: { __column: string }, value: unknown): Condition => ({
    kind: 'eq',
    column: column.__column,
    value,
  }),
  isNotNull: (column: { __column: string }): Condition => ({
    kind: 'not-null',
    column: column.__column,
  }),
  and: (...conditions: Condition[]): Condition => ({ kind: 'and', conditions }),
  or: (...conditions: Condition[]): Condition => ({ kind: 'or', conditions }),
}));

vi.mock('@workspace/db', () => {
  function storeFor(table: { __table: string }): Map<string, Row> {
    if (table.__table === 'trades') return state.trades;
    if (table.__table === 'intents') return state.intents;
    return state.tasks;
  }

  const db = {
    select: () => ({
      from: (table: { __table: string }) => ({
        where: (condition: Condition) => {
          const rows = [...storeFor(table).values()].filter((row) => matches(row, condition));
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
    update: (table: { __table: string }) => ({
      set: (patch: Row) => ({
        where: (condition: Condition) => ({
          returning: async () => {
            const rows = [...storeFor(table).values()].filter((row) => matches(row, condition));
            for (const row of rows) Object.assign(row, patch);
            if (rows.length > 0) state.updateCount += 1;
            return rows.map((row) => ({ id: row.id }));
          },
        }),
      }),
    }),
    transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
      state.transactionCount += 1;
      return run(db);
    },
  };

  return {
    db,
    tradesTable: state.tradesTable,
    executionIntentsTable: state.executionIntentsTable,
    relayTasksTable: state.relayTasksTable,
  };
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    http: vi.fn(() => ({ kind: 'fixture-http' })),
    createPublicClient: vi.fn(() => ({
      getTransactionReceipt: async () => {
        state.rpcCalls.receipt();
        if (!state.receipt) throw new Error('receipt unavailable');
        return state.receipt;
      },
      getBlockNumber: async () => {
        state.rpcCalls.latestBlock();
        return state.latestBlock;
      },
      getBlock: async () => {
        state.rpcCalls.block();
        return { timestamp: state.blockTimestamp };
      },
    })),
  };
});

vi.mock('../routes/gmx', () => ({
  fetchServerOpenPositions: async () => {
    state.positionCalls();
    return state.positions;
  },
}));

import { createProductionCloseSettlementFetcher } from '../lib/productionCloseSettlementFetcher';
import { pnlForTargets, reconcileLiveSettlements } from '../lib/tradeSettlement';

const savedReadonly = process.env.GMX_API_READONLY_ENABLED;
const savedRpc = process.env.GMX_RPC_URL;

const usd = (n: number): bigint => BigInt(Math.round(n * 1_000_000)) * 10n ** 24n;
const TRADE_ID = 'settlement:close:intent:close:composed';
const INTENT_ID = 'intent:close:composed';
const TASK_ID = 'relay-close-composed';
const ACCOUNT = `0x${'11'.repeat(20)}`;
const MARKET = `0x${'22'.repeat(20)}`;
const COLLATERAL = `0x${'33'.repeat(20)}`;
const EMITTER = `0x${'44'.repeat(20)}`;
const POSITION_KEY = `0x${'55'.repeat(32)}`;
const ORDER_KEY = `0x${'66'.repeat(32)}`;
const TX = `0x${'88'.repeat(32)}`;
const BLOCK = 100n;

function settlementLogs() {
  const terminal = mkEventLog2({
    name: 'OrderExecuted',
    orderKey: ORDER_KEY,
    emitter: EMITTER,
    account: ACCOUNT,
    txHash: TX,
    blockNumber: BLOCK.toString(),
  });
  const decrease = mkEventLog1({
    name: 'PositionDecrease',
    topic1: pad(ACCOUNT as `0x${string}`, { size: 32 }),
    emitter: EMITTER,
    txHash: TX,
    blockNumber: BLOCK.toString(),
    fields: {
      addressItems: [
        { key: 'account', value: ACCOUNT as `0x${string}` },
        { key: 'market', value: MARKET as `0x${string}` },
        { key: 'collateralToken', value: COLLATERAL as `0x${string}` },
      ],
      uintItems: [
        { key: 'sizeInUsd', value: 0n },
        { key: 'sizeDeltaUsd', value: usd(100) },
      ],
      intItems: [
        { key: 'basePnlUsd', value: usd(10) },
        { key: 'priceImpactUsd', value: -usd(0.2) },
      ],
      boolItems: [{ key: 'isLong', value: true }],
      bytes32Items: [
        { key: 'orderKey', value: ORDER_KEY as `0x${string}` },
        { key: 'positionKey', value: POSITION_KEY as `0x${string}` },
      ],
    },
  });
  const fees = mkEventLog1({
    name: 'PositionFeesCollected',
    topic1: POSITION_KEY,
    emitter: EMITTER,
    txHash: TX,
    blockNumber: BLOCK.toString(),
    fields: {
      addressItems: [
        { key: 'market', value: MARKET as `0x${string}` },
        { key: 'collateralToken', value: COLLATERAL as `0x${string}` },
      ],
      uintItems: [
        { key: 'collateralTokenPrice.min', value: 10n ** 24n },
        { key: 'tradeSizeUsd', value: usd(100) },
        { key: 'fundingFeeAmount', value: 500_000n },
        { key: 'borrowingFeeUsd', value: usd(0.3) },
        { key: 'positionFeeAmount', value: 1_000_000n },
      ],
      boolItems: [{ key: 'isIncrease', value: false }],
      bytes32Items: [
        { key: 'orderKey', value: ORDER_KEY as `0x${string}` },
        { key: 'positionKey', value: POSITION_KEY as `0x${string}` },
      ],
    },
  });
  const keeper = mkEventLog1({
    name: 'KeeperExecutionFee',
    topic1: pad(ACCOUNT as `0x${string}`, { size: 32 }),
    emitter: EMITTER,
    txHash: TX,
    blockNumber: BLOCK.toString(),
    fields: {
      addressItems: [{ key: 'keeper', value: ACCOUNT as `0x${string}` }],
      uintItems: [{ key: 'executionFeeAmount', value: 100_000_000_000_000n }],
    },
  });
  const oracle = mkEventLog1({
    name: 'OraclePriceUpdate',
    topic1: pad(WETH_ARBITRUM, { size: 32 }),
    emitter: EMITTER,
    txHash: TX,
    blockNumber: BLOCK.toString(),
    fields: {
      addressItems: [{ key: 'token', value: WETH_ARBITRUM }],
      uintItems: [
        { key: 'minPrice', value: 3_000n * 10n ** 12n },
        { key: 'maxPrice', value: 3_000n * 10n ** 12n },
      ],
    },
  });
  return [terminal, decrease, fees, keeper, oracle];
}

function seedExactClose(): void {
  state.trades.set(TRADE_ID, {
    id: TRADE_ID,
    symbol: 'BTC',
    action: 'CLOSE',
    testMode: true,
    settlementStatus: 'UNSETTLED',
    settlementIntentId: INTENT_ID,
    settlementAccount: ACCOUNT.toLowerCase(),
    settlementMarketAddress: MARKET.toLowerCase(),
    settlementCollateralToken: COLLATERAL.toLowerCase(),
    settlementPositionKey: POSITION_KEY,
    preCloseSizeUsd30: usd(100).toString(),
    requestedReductionUsd30: usd(100).toString(),
    pnl: '10',
    evidenceTxHash: null,
  });
  state.intents.set(INTENT_ID, {
    id: INTENT_ID,
    orderType: 'close',
    status: 'CONFIRMED',
    receiptStatus: 'success',
    closeSettlementTradeId: TRADE_ID,
    orderKey: ORDER_KEY,
    resolutionTxHash: TX,
    resolutionBlock: BLOCK.toString(),
    orderEmitterAddress: EMITTER,
    closeAccount: ACCOUNT.toLowerCase(),
    closeMarketAddress: MARKET.toLowerCase(),
    closeCollateralToken: COLLATERAL.toLowerCase(),
    closePositionKey: POSITION_KEY,
    closePreSizeUsd30: usd(100).toString(),
    closeRequestedReductionUsd30: usd(100).toString(),
    isLong: true,
  });
  state.tasks.set(TASK_ID, {
    id: TASK_ID,
    kind: 'CLOSE',
    status: 'CONFIRMED',
    intentId: INTENT_ID,
    gmxApiStatus: 'executed',
    gmxExecutionTxHash: TX,
    gmxOrderKeys: JSON.stringify([ORDER_KEY]),
  });
  state.receipt = {
    status: 'success',
    transactionHash: TX,
    blockNumber: BLOCK,
    logs: settlementLogs(),
  };
  state.positions = [];
}

beforeEach(() => {
  process.env.GMX_API_READONLY_ENABLED = 'true';
  process.env.GMX_RPC_URL = 'https://fixture.invalid';
  state.trades.clear();
  state.intents.clear();
  state.tasks.clear();
  state.positions = [];
  state.receipt = null;
  state.latestBlock = 115n;
  state.transactionCount = 0;
  state.updateCount = 0;
  state.rpcCalls.receipt.mockClear();
  state.rpcCalls.latestBlock.mockClear();
  state.rpcCalls.block.mockClear();
  state.positionCalls.mockClear();
});

afterEach(() => {
  if (savedReadonly === undefined) delete process.env.GMX_API_READONLY_ENABLED;
  else process.env.GMX_API_READONLY_ENABLED = savedReadonly;
  if (savedRpc === undefined) delete process.env.GMX_RPC_URL;
  else process.env.GMX_RPC_URL = savedRpc;
});

describe('production CLOSE settlement collector — read-only fail-closed gates', () => {
  it('readonly network disabled: DB/RPC work is not attempted and trade stays unsettled', async () => {
    process.env.GMX_API_READONLY_ENABLED = 'false';
    delete process.env.GMX_RPC_URL;
    const result = await createProductionCloseSettlementFetcher().fetchEvidence?.({
      tradeId: TRADE_ID,
      symbol: 'BTC',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'GMX_API_READONLY_ENABLED!=true — 정산 read-only 네트워크 비활성',
    });
    expect(state.rpcCalls.receipt).not.toHaveBeenCalled();
  });

  it('readonly enabled but RPC missing: no fallback endpoint or estimated evidence is used', async () => {
    delete process.env.GMX_RPC_URL;
    const result = await createProductionCloseSettlementFetcher().fetchEvidence?.({
      tradeId: TRADE_ID,
      symbol: 'BTC',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'GMX_RPC_URL 미설정 — read-only 정산 증거 조회 불가',
    });
    expect(state.rpcCalls.receipt).not.toHaveBeenCalled();
  });
});

describe('production CLOSE settlement collector → durable reconciliation', () => {
  it('exact receipt/readback settles once, then replay is a no-op', async () => {
    seedExactClose();
    const before = pnlForTargets([{
      pnl: Number(state.trades.get(TRADE_ID)?.pnl),
      settlementStatus: String(state.trades.get(TRADE_ID)?.settlementStatus),
    }]);
    expect(before).toEqual({ profitEligibleUsd: 0, lossAwareUsd: 0 });

    const first = await reconcileLiveSettlements(createProductionCloseSettlementFetcher());
    expect(first).toEqual({
      ok: true,
      unsettledCount: 1,
      settledNow: 1,
      incomplete: false,
      reasons: [],
    });
    expect(state.rpcCalls.receipt).toHaveBeenCalledTimes(1);
    expect(state.rpcCalls.latestBlock).toHaveBeenCalledTimes(1);
    expect(state.rpcCalls.block).toHaveBeenCalledTimes(1);
    expect(state.positionCalls).toHaveBeenCalledTimes(1);
    expect(state.transactionCount).toBe(1);
    expect(state.updateCount).toBe(1);
    expect(state.trades.get(TRADE_ID)).toMatchObject({
      settlementStatus: 'SETTLED',
      evidenceTxHash: TX,
      settlementIntentId: INTENT_ID,
      settlementRelayTaskId: TASK_ID,
      settlementOrderKey: ORDER_KEY,
      settlementEmitterAddress: EMITTER,
      settlementBlockNumber: BLOCK.toString(),
      settlementLatestBlock: '115',
      settlementConfirmations: 15,
      grossPnlUsd: '10',
      positionFeeUsd: '1',
      executionFeeUsd: '0.3',
      priceImpactUsd: '0.2',
      fundingFeeUsd: '0.5',
      borrowingFeeUsd: '0.3',
      netPnlUsd: '7.7',
      pnl: '7.7',
    });
    expect(pnlForTargets([{
      pnl: Number(state.trades.get(TRADE_ID)?.pnl),
      settlementStatus: String(state.trades.get(TRADE_ID)?.settlementStatus),
    }])).toEqual({ profitEligibleUsd: 7.7, lossAwareUsd: 0 });

    const second = await reconcileLiveSettlements(createProductionCloseSettlementFetcher());
    expect(second).toEqual({
      ok: true,
      unsettledCount: 0,
      settledNow: 0,
      incomplete: false,
      reasons: [],
    });
    expect(state.rpcCalls.receipt).toHaveBeenCalledTimes(1);
    expect(state.positionCalls).toHaveBeenCalledTimes(1);
    expect(state.transactionCount).toBe(1);
    expect(state.updateCount).toBe(1);
  });

  it('authoritative post-close mismatch remains UNSETTLED and profit-ineligible', async () => {
    seedExactClose();
    state.positions = [{
      positionKey: POSITION_KEY,
      accountAddress: ACCOUNT,
      marketAddress: MARKET,
      collateralToken: COLLATERAL,
      isLong: true,
      sizeUsd30: '1',
    }];

    const result = await reconcileLiveSettlements(createProductionCloseSettlementFetcher());
    expect(result).toMatchObject({
      ok: false,
      unsettledCount: 1,
      settledNow: 0,
      incomplete: true,
    });
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('LIVE_SETTLEMENT_INCOMPLETE');
    expect(state.trades.get(TRADE_ID)).toMatchObject({
      settlementStatus: 'UNSETTLED',
      evidenceTxHash: null,
      pnl: '10',
    });
    expect(state.transactionCount).toBe(0);
    expect(state.updateCount).toBe(0);
    expect(pnlForTargets([{
      pnl: Number(state.trades.get(TRADE_ID)?.pnl),
      settlementStatus: String(state.trades.get(TRADE_ID)?.settlementStatus),
    }])).toEqual({ profitEligibleUsd: 0, lossAwareUsd: 0 });
  });
});