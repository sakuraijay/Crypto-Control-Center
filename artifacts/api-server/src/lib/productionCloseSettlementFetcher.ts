/**
 * Production read-only CLOSE settlement fetcher.
 *
 * Network operations are limited to:
 *  - previously accepted GMX status evidence already persisted on relay_tasks,
 *  - Arbitrum RPC receipt/latest-block/block timestamp reads,
 *  - authoritative PositionReader post-close readback.
 *
 * There is no prepare, sign, submit, retry, nonce creation, or order creation.
 */

import { createPublicClient, http, type Hash } from 'viem';
import { arbitrum } from 'viem/chains';
import {
  evaluateCloseSettlement,
  type CloseSettlementBinding,
  type ExactPositionReadback,
} from './closeSettlementEvidence';
import type {
  SettlementEvidenceFetcher,
  SettlementEvidenceFetchResult,
} from './tradeSettlement';
import { mapGmxApiStatus } from './gmxApiOrders';
import type { RawLog } from './gmxOrderEvents';

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function blocker(reason: string): SettlementEvidenceFetchResult {
  return { ok: false, reason };
}

function oneOrderKey(raw: string | null): string | null {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string'
      && HASH_RE.test(parsed[0]) ? parsed[0] : null;
  } catch {
    return null;
  }
}

async function fetchOne(args: { tradeId: string }): Promise<SettlementEvidenceFetchResult> {
  if (process.env.GMX_API_READONLY_ENABLED !== 'true') {
    return blocker('GMX_API_READONLY_ENABLED!=true — 정산 read-only 네트워크 비활성');
  }
  const rpcUrl = process.env.GMX_RPC_URL;
  if (!rpcUrl) return blocker('GMX_RPC_URL 미설정 — read-only 정산 증거 조회 불가');

  try {
    const { db, tradesTable, executionIntentsTable, relayTasksTable } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');

    const trades = await db.select().from(tradesTable)
      .where(eq(tradesTable.id, args.tradeId)).limit(2);
    if (trades.length !== 1) return blocker('CLOSE settlement trade 단일 행 결속 실패');
    const trade = trades[0];
    if (trade.action !== 'CLOSE' || trade.testMode !== true || trade.settlementStatus !== 'UNSETTLED') {
      return blocker('CLOSE settlement trade 상태/모드 불일치');
    }
    if (!trade.settlementIntentId || !trade.settlementAccount
        || !trade.settlementMarketAddress || !trade.settlementCollateralToken
        || !trade.settlementPositionKey || !trade.preCloseSizeUsd30
        || !trade.requestedReductionUsd30) {
      return blocker('durable CLOSE exact binding 필드 부재');
    }

    const intents = await db.select().from(executionIntentsTable)
      .where(eq(executionIntentsTable.id, trade.settlementIntentId)).limit(2);
    if (intents.length !== 1) return blocker('CLOSE execution intent 단일 행 결속 실패');
    const intent = intents[0];
    if (intent.orderType !== 'close' || intent.status !== 'CONFIRMED'
        || intent.receiptStatus !== 'success'
        || intent.closeSettlementTradeId !== trade.id
        || !same(intent.closeAccount, trade.settlementAccount)
        || !same(intent.closeMarketAddress, trade.settlementMarketAddress)
        || !same(intent.closeCollateralToken, trade.settlementCollateralToken)
        || !same(intent.closePositionKey, trade.settlementPositionKey)
        || intent.closePreSizeUsd30 !== trade.preCloseSizeUsd30
        || intent.closeRequestedReductionUsd30 !== trade.requestedReductionUsd30) {
      return blocker('CLOSE trade ↔ intent exact binding/status 불일치');
    }
    if (!intent.orderKey || !intent.resolutionTxHash || !intent.resolutionBlock
        || !intent.orderEmitterAddress
        || !HASH_RE.test(intent.orderKey) || !HASH_RE.test(intent.resolutionTxHash)
        || !ADDRESS_RE.test(intent.orderEmitterAddress)) {
      return blocker('intent terminal tx/order/emitter/block 증거 부재');
    }

    const tasks = await db.select().from(relayTasksTable)
      .where(eq(relayTasksTable.intentId, intent.id)).limit(3);
    if (tasks.length !== 1) return blocker(`CLOSE relay task ${tasks.length}건 — 정확히 1건 필요`);
    const task = tasks[0];
    const taskOrderKey = oneOrderKey(task.gmxOrderKeys);
    if (task.kind !== 'CLOSE' || task.status !== 'CONFIRMED'
        || !task.gmxApiStatus || mapGmxApiStatus(task.gmxApiStatus).action !== 'confirm_pending_onchain'
        || !task.gmxExecutionTxHash || !taskOrderKey
        || !same(task.gmxExecutionTxHash, intent.resolutionTxHash)
        || !same(taskOrderKey, intent.orderKey)) {
      return blocker('official GMX status / relay task terminal binding 불일치');
    }

    let preCloseSizeUsd30: bigint;
    let requestedReductionUsd30: bigint;
    let expectedBlockNumber: bigint;
    try {
      preCloseSizeUsd30 = BigInt(trade.preCloseSizeUsd30);
      requestedReductionUsd30 = BigInt(trade.requestedReductionUsd30);
      expectedBlockNumber = BigInt(intent.resolutionBlock);
    } catch {
      return blocker('CLOSE exact size/block 정수 디코딩 실패');
    }

    const client = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl, { timeout: 8_000 }),
    });
    const receipt = await client.getTransactionReceipt({ hash: intent.resolutionTxHash as Hash });
    const [latestBlockNumber, block, positions] = await Promise.all([
      client.getBlockNumber(),
      client.getBlock({ blockNumber: receipt.blockNumber }),
      import('../routes/gmx').then((m) => m.fetchServerOpenPositions()),
    ]);
    if (positions === null) return blocker('authoritative post-close PositionReader 조회 실패');

    const binding: CloseSettlementBinding = {
      tradeId: trade.id,
      intentId: intent.id,
      relayTaskId: task.id,
      accountAddress: trade.settlementAccount,
      marketAddress: trade.settlementMarketAddress,
      collateralTokenAddress: trade.settlementCollateralToken,
      positionKey: trade.settlementPositionKey,
      isLong: intent.isLong,
      preCloseSizeUsd30,
      requestedReductionUsd30,
      expectedOrderKey: intent.orderKey,
      expectedTxHash: intent.resolutionTxHash,
      expectedEmitterAddress: intent.orderEmitterAddress,
      expectedBlockNumber,
    };
    const postClosePositions: ExactPositionReadback[] = positions.map((p) => ({
      positionKey: p.positionKey,
      accountAddress: p.accountAddress,
      marketAddress: p.marketAddress,
      collateralTokenAddress: p.collateralToken,
      isLong: p.isLong,
      sizeUsd30: BigInt(p.sizeUsd30),
    }));
    const verdict = evaluateCloseSettlement(binding, {
      receiptStatus: receipt.status,
      receiptTxHash: receipt.transactionHash,
      receiptBlockNumber: receipt.blockNumber,
      receiptLogs: receipt.logs as unknown as RawLog[],
      latestBlockNumber,
      receiptBlockTimestampMs: Number(block.timestamp) * 1_000,
      postClosePositions,
    });
    if (!verdict.ok) return blocker(verdict.reason);
    return {
      ok: true,
      evidence: {
        grossPnlUsd: verdict.settlement.grossPnlUsd,
        positionFeeUsd: verdict.settlement.positionFeeUsd,
        executionFeeUsd: verdict.settlement.executionFeeUsd,
        priceImpactUsd: verdict.settlement.priceImpactUsd,
        fundingFeeUsd: verdict.settlement.fundingFeeUsd,
        borrowingFeeUsd: verdict.settlement.borrowingFeeUsd,
        evidenceTxHash: verdict.settlement.evidenceTxHash,
        settledAt: verdict.settlement.settledAt,
        intentId: intent.id,
        relayTaskId: task.id,
        orderKey: verdict.settlement.orderKey,
        emitterAddress: verdict.settlement.emitterAddress,
        resolutionBlock: verdict.settlement.resolutionBlock,
        latestBlock: verdict.settlement.latestBlock,
        confirmations: verdict.settlement.confirmations,
        evidenceBasis: verdict.settlement.evidenceBasis,
      },
    };
  } catch {
    return blocker('정산 read-only DB/RPC/decode 조회 실패 — UNSETTLED 유지');
  }
}

export function createProductionCloseSettlementFetcher(): SettlementEvidenceFetcher {
  return {
    fetchEvidence: ({ tradeId }) => fetchOne({ tradeId }),
  };
}