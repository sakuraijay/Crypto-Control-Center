/**
 * CLOSE settlement judge fixtures only — no RPC, HTTP, signing, prepare, or
 * submit calls. All EventEmitter logs are locally ABI-encoded.
 */

import { describe, expect, it } from 'vitest';
import { pad } from 'viem';
import {
  evaluateCloseSettlement,
  type CloseSettlementBinding,
  type CloseSettlementObservation,
} from '../lib/closeSettlementEvidence';
import { WETH_ARBITRUM } from '../lib/relayFeeQuote';
import { mkEventLog1, mkEventLog2 } from './helpers/eventLog2Fixture';

const usd = (n: number): bigint => BigInt(Math.round(n * 1_000_000)) * 10n ** 24n;
const ACCOUNT = `0x${'11'.repeat(20)}`;
const MARKET = `0x${'22'.repeat(20)}`;
const COLLATERAL = `0x${'33'.repeat(20)}`;
const EMITTER = `0x${'44'.repeat(20)}`;
const POSITION_KEY = `0x${'55'.repeat(32)}`;
const ORDER_KEY = `0x${'66'.repeat(32)}`;
const OTHER_ORDER_KEY = `0x${'77'.repeat(32)}`;
const TX = `0x${'88'.repeat(32)}`;
const BLOCK = 100n;

function binding(overrides: Partial<CloseSettlementBinding> = {}): CloseSettlementBinding {
  return {
    tradeId: 'settlement:close:intent:close:d1',
    intentId: 'intent:close:d1',
    relayTaskId: 'relay-1',
    accountAddress: ACCOUNT,
    marketAddress: MARKET,
    collateralTokenAddress: COLLATERAL,
    positionKey: POSITION_KEY,
    isLong: true,
    preCloseSizeUsd30: usd(100),
    requestedReductionUsd30: usd(100),
    expectedOrderKey: ORDER_KEY,
    expectedTxHash: TX,
    expectedEmitterAddress: EMITTER,
    expectedBlockNumber: BLOCK,
    ...overrides,
  };
}

function logs(args: {
  requested?: bigint;
  postSize?: bigint;
  emitter?: string;
  includeBasePnl?: boolean;
  includeExecutionFee?: boolean;
  oracleMaxPrice?: bigint;
} = {}) {
  const requested = args.requested ?? usd(100);
  const postSize = args.postSize ?? 0n;
  const emitter = args.emitter ?? EMITTER;
  const terminal = mkEventLog2({
    name: 'OrderExecuted',
    orderKey: ORDER_KEY,
    emitter,
    account: ACCOUNT,
    txHash: TX,
    blockNumber: BLOCK.toString(),
  });
  const decrease = mkEventLog1({
    name: 'PositionDecrease',
    topic1: pad(ACCOUNT as `0x${string}`, { size: 32 }),
    emitter,
    txHash: TX,
    blockNumber: BLOCK.toString(),
    fields: {
      addressItems: [
        { key: 'account', value: ACCOUNT as `0x${string}` },
        { key: 'market', value: MARKET as `0x${string}` },
        { key: 'collateralToken', value: COLLATERAL as `0x${string}` },
      ],
      uintItems: [
        { key: 'sizeInUsd', value: postSize },
        { key: 'sizeDeltaUsd', value: requested },
      ],
      intItems: [
        ...(args.includeBasePnl === false ? [] : [{ key: 'basePnlUsd', value: usd(10) }]),
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
    emitter,
    txHash: TX,
    blockNumber: BLOCK.toString(),
    fields: {
      addressItems: [
        { key: 'market', value: MARKET as `0x${string}` },
        { key: 'collateralToken', value: COLLATERAL as `0x${string}` },
      ],
      uintItems: [
        { key: 'collateralTokenPrice.min', value: 10n ** 24n }, // USDC $1
        { key: 'tradeSizeUsd', value: requested },
        { key: 'fundingFeeAmount', value: 500_000n }, // $0.50
        { key: 'borrowingFeeUsd', value: usd(0.3) },
        { key: 'positionFeeAmount', value: 1_000_000n }, // $1.00
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
    emitter,
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
    emitter,
    txHash: TX,
    blockNumber: BLOCK.toString(),
    fields: {
      addressItems: [{ key: 'token', value: WETH_ARBITRUM }],
      uintItems: [
        { key: 'minPrice', value: 3_000n * 10n ** 12n },
        { key: 'maxPrice', value: args.oracleMaxPrice ?? 3_000n * 10n ** 12n },
      ],
    },
  });
  return args.includeExecutionFee === false
    ? [terminal, decrease, fees, oracle]
    : [terminal, decrease, fees, keeper, oracle];
}

function observation(overrides: Partial<CloseSettlementObservation> = {}): CloseSettlementObservation {
  return {
    receiptStatus: 'success',
    receiptTxHash: TX,
    receiptBlockNumber: BLOCK,
    receiptLogs: logs(),
    latestBlockNumber: 115n,
    receiptBlockTimestampMs: Date.UTC(2026, 7, 20, 1, 2, 3),
    postClosePositions: [],
    ...overrides,
  };
}

describe('evaluateCloseSettlement', () => {
  it('settles a full close only with exact terminal, financial, finality, and absence evidence', () => {
    const result = evaluateCloseSettlement(binding(), observation());
    expect(result).toMatchObject({
      ok: true,
      settlement: {
        grossPnlUsd: 10,
        positionFeeUsd: 1,
        executionFeeUsd: 0.3,
        priceImpactUsd: 0.2,
        fundingFeeUsd: 0.5,
        borrowingFeeUsd: 0.3,
        evidenceTxHash: TX,
        postCloseSizeUsd30: '0',
        confirmations: 15,
      },
    });
  });

  it('settles a partial close only when exact post-size decreased by requested delta', () => {
    const b = binding({ requestedReductionUsd30: usd(40) });
    const o = observation({
      receiptLogs: logs({ requested: usd(40), postSize: usd(60) }),
      postClosePositions: [{
        positionKey: POSITION_KEY,
        accountAddress: ACCOUNT,
        marketAddress: MARKET,
        collateralTokenAddress: COLLATERAL,
        isLong: true,
        sizeUsd30: usd(60),
      }],
    });
    const result = evaluateCloseSettlement(b, o);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settlement.postCloseSizeUsd30).toBe(usd(60).toString());
  });

  it.each([
    ['reverted receipt', observation({ receiptStatus: 'reverted' })],
    ['insufficient finality', observation({ latestBlockNumber: 114n })],
    ['receipt tx mismatch', observation({ receiptTxHash: `0x${'99'.repeat(32)}` })],
    ['receipt block mismatch', observation({ receiptBlockNumber: 101n })],
    ['missing execution fee USD', observation({ receiptLogs: logs({ includeExecutionFee: false }) })],
    ['non-singleton execution-fee oracle price', observation({
      receiptLogs: logs({ oracleMaxPrice: 3_001n * 10n ** 12n }),
    })],
    ['missing required PnL field', observation({ receiptLogs: logs({ includeBasePnl: false }) })],
    ['missing/decode evidence', observation({ receiptLogs: [] })],
  ])('keeps UNSETTLED for %s', (_label, o) => {
    expect(evaluateCloseSettlement(binding(), o).ok).toBe(false);
  });

  it('rejects forged emitter evidence', () => {
    const forged = `0x${'aa'.repeat(20)}`;
    const result = evaluateCloseSettlement(binding(), observation({ receiptLogs: logs({ emitter: forged }) }));
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects ambiguous/multiple terminal order keys', () => {
    const extra = mkEventLog2({
      name: 'OrderExecuted',
      orderKey: OTHER_ORDER_KEY,
      emitter: EMITTER,
      account: ACCOUNT,
      txHash: TX,
      blockNumber: BLOCK.toString(),
    });
    const result = evaluateCloseSettlement(binding(), observation({ receiptLogs: [...logs(), extra] }));
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects full close when exact position still has a non-zero balance', () => {
    const result = evaluateCloseSettlement(binding(), observation({
      postClosePositions: [{
        positionKey: POSITION_KEY,
        accountAddress: ACCOUNT,
        marketAddress: MARKET,
        collateralTokenAddress: COLLATERAL,
        isLong: true,
        sizeUsd30: 1n,
      }],
    }));
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects partial close position mismatch', () => {
    const b = binding({ requestedReductionUsd30: usd(40) });
    const result = evaluateCloseSettlement(b, observation({
      receiptLogs: logs({ requested: usd(40), postSize: usd(60) }),
      postClosePositions: [{
        positionKey: POSITION_KEY,
        accountAddress: ACCOUNT,
        marketAddress: MARKET,
        collateralTokenAddress: COLLATERAL,
        isLong: true,
        sizeUsd30: usd(59),
      }],
    }));
    expect(result).toMatchObject({ ok: false });
  });
});