/**
 * tradeSettlement — 실제 정산 PnL 기록 (6H-2 §5).
 *
 *  - trades에 gross/각 fee/net/settlementStatus/settledAt/evidenceTxHash 저장
 *  - "추정 PnL"과 "실제 정산 PnL"을 명확히 구분:
 *      UNSETTLED 이익 → +5%/+10% 목표 산정에 미반영
 *      추정 손실     → 즉시 손실 gate에 반영 (보수적 비대칭)
 *  - 동일 evidenceTxHash 이중 정산 금지 (DB unique partial index + 사전 확인)
 *  - CI/db-free 규칙: @workspace/db는 반드시 지연 import
 */

import { EVIDENCE_CONFIRMATION_DEPTH } from './protectionEvidence';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 정산 상태 (6H-2A §3·§5):
 *  - UNSETTLED: LIVE 체결 후 온체인 증거 정산 전 — 이익 목표 미반영
 *  - SETTLED: 온체인 증거 기반 실제 정산 완료 (pnl = 실제 순 PnL)
 *  - PAPER_ESTIMATED: PAPER 시뮬 — 추정 순 PnL(netPnlEstimatedUsd)만 이익 적격.
 * ('PAPER_ZERO_FEE'는 폐기된 legacy 값 — 과거 행에만 잔존, 이익 적격 아님)
 */
export type SettlementStatus = 'UNSETTLED' | 'SETTLED' | 'PAPER_ESTIMATED';

export const LIVE_SETTLEMENT_INCOMPLETE = 'LIVE_SETTLEMENT_INCOMPLETE';

export interface SettlementInput {
  tradeId: string;
  grossPnlUsd: number;
  positionFeeUsd: number;
  executionFeeUsd: number;
  priceImpactUsd: number;   // 부호 있음 — 양수 = 불리
  fundingFeeUsd: number;
  borrowingFeeUsd: number;
  evidenceTxHash: string;
  settledAt: Date;
  /** 사전 추정 순 PnL — 실제와의 차이 감사 기록용 (없으면 null) */
  estimatedNetPnlUsd?: number | null;
  intentId?: string;
  relayTaskId?: string;
  orderKey?: string;
  emitterAddress?: string;
  resolutionBlock?: string;
  latestBlock?: string;
  confirmations?: number;
  evidenceBasis?: string;
}

export type SettlementResult =
  | { ok: true; netPnlUsd: number; estimateDeltaUsd: number | null }
  | { ok: false; reason: string };

/** 순 PnL 계산 — 검증 포함 (음수 fee/NaN 거부) */
export function computeNetPnl(input: Omit<SettlementInput, 'tradeId' | 'evidenceTxHash' | 'settledAt'>):
  { ok: true; netPnlUsd: number } | { ok: false; reason: string } {
  const fees = {
    positionFeeUsd: input.positionFeeUsd, executionFeeUsd: input.executionFeeUsd,
    fundingFeeUsd: input.fundingFeeUsd, borrowingFeeUsd: input.borrowingFeeUsd,
  };
  for (const [k, v] of Object.entries(fees)) {
    if (!fin(v) || v < 0) return { ok: false, reason: `${k} 음수/NaN — 정산 거부` };
  }
  if (!fin(input.grossPnlUsd) || !fin(input.priceImpactUsd)) {
    return { ok: false, reason: 'grossPnl/priceImpact NaN — 정산 거부' };
  }
  const netPnlUsd = input.grossPnlUsd
    - input.positionFeeUsd - input.executionFeeUsd
    - input.priceImpactUsd - input.fundingFeeUsd - input.borrowingFeeUsd;
  if (!fin(netPnlUsd)) return { ok: false, reason: 'net PnL 계산 불가 — 정산 거부' };
  return { ok: true, netPnlUsd };
}

/**
 * 정산 기록 — 동일 evidenceTxHash 이중 정산 금지, 이미 SETTLED인 trade 재정산 금지.
 * DB 실패 → ok:false (호출자는 UNSETTLED 유지 = fail-closed).
 */
export async function recordTradeSettlement(input: SettlementInput): Promise<SettlementResult> {
  const net = computeNetPnl(input);
  if (!net.ok) return net;
  if (!input.evidenceTxHash || !/^0x[0-9a-fA-F]{64}$/.test(input.evidenceTxHash)) {
    return { ok: false, reason: 'evidenceTxHash 형식 비정상 — 온체인 증거 없이 SETTLED 전환 금지' };
  }
  if (!input.intentId || !input.relayTaskId
      || !input.orderKey || !/^0x[0-9a-fA-F]{64}$/.test(input.orderKey)
      || !input.emitterAddress || !/^0x[0-9a-fA-F]{40}$/.test(input.emitterAddress)
      || !input.resolutionBlock || !input.latestBlock
      || !Number.isSafeInteger(input.confirmations)
      || (input.confirmations as number) < EVIDENCE_CONFIRMATION_DEPTH
      || !input.evidenceBasis) {
    return { ok: false, reason: '검증된 CLOSE linkage/finality metadata 부재 — SETTLED 전환 금지' };
  }
  const intentId = input.intentId;
  const relayTaskId = input.relayTaskId;
  const orderKey = input.orderKey;
  const emitterAddress = input.emitterAddress;
  const resolutionBlockText = input.resolutionBlock;
  const latestBlockText = input.latestBlock;
  const confirmations = input.confirmations as number;
  const evidenceBasis = input.evidenceBasis;
  try {
    const resolutionBlock = BigInt(resolutionBlockText);
    const latestBlock = BigInt(latestBlockText);
    const depth = latestBlock - resolutionBlock;
    if (depth < BigInt(EVIDENCE_CONFIRMATION_DEPTH)
        || Number(depth) !== confirmations) {
      return { ok: false, reason: 'CLOSE finality block/confirmation 결속 불일치' };
    }
  } catch {
    return { ok: false, reason: 'CLOSE finality block 디코딩 실패' };
  }

  try {
    const { db, tradesTable, executionIntentsTable, relayTasksTable } = await import('@workspace/db');
    const { eq, and, isNotNull } = await import('drizzle-orm');

    return await db.transaction(async (tx) => {
      const tradeRows = await tx.select().from(tradesTable)
        .where(eq(tradesTable.id, input.tradeId)).limit(2);
      if (tradeRows.length !== 1) {
        return { ok: false as const, reason: 'CLOSE trade 단일 행 결속 실패' };
      }
      const trade = tradeRows[0];
      if (trade.action !== 'CLOSE' || trade.testMode !== true
          || trade.settlementStatus !== 'UNSETTLED'
          || trade.settlementIntentId !== intentId
          || !trade.settlementAccount || !trade.settlementMarketAddress
          || !trade.settlementCollateralToken || !trade.settlementPositionKey
          || !trade.preCloseSizeUsd30 || !trade.requestedReductionUsd30) {
        return { ok: false as const, reason: 'UNSETTLED LIVE CLOSE durable binding 불일치' };
      }

      const intentRows = await tx.select().from(executionIntentsTable)
        .where(eq(executionIntentsTable.id, intentId)).limit(2);
      if (intentRows.length !== 1) {
        return { ok: false as const, reason: 'CLOSE intent 단일 행 결속 실패' };
      }
      const intent = intentRows[0];
      if (intent.orderType !== 'close' || intent.status !== 'CONFIRMED'
          || intent.receiptStatus !== 'success'
          || intent.closeSettlementTradeId !== trade.id
          || intent.orderKey?.toLowerCase() !== orderKey.toLowerCase()
          || intent.resolutionTxHash?.toLowerCase() !== input.evidenceTxHash.toLowerCase()
          || intent.resolutionBlock !== resolutionBlockText
          || intent.orderEmitterAddress?.toLowerCase() !== emitterAddress.toLowerCase()
          || intent.closeAccount?.toLowerCase() !== trade.settlementAccount.toLowerCase()
          || intent.closeMarketAddress?.toLowerCase() !== trade.settlementMarketAddress.toLowerCase()
          || intent.closeCollateralToken?.toLowerCase() !== trade.settlementCollateralToken.toLowerCase()
          || intent.closePositionKey?.toLowerCase() !== trade.settlementPositionKey.toLowerCase()
          || intent.closePreSizeUsd30 !== trade.preCloseSizeUsd30
          || intent.closeRequestedReductionUsd30 !== trade.requestedReductionUsd30) {
        return { ok: false as const, reason: 'CLOSE trade ↔ confirmed intent 증거 결속 불일치' };
      }

      const taskRows = await tx.select().from(relayTasksTable)
        .where(eq(relayTasksTable.id, relayTaskId)).limit(2);
      if (taskRows.length !== 1) {
        return { ok: false as const, reason: 'CLOSE relay task 단일 행 결속 실패' };
      }
      const task = taskRows[0];
      let taskOrderKeys: unknown = null;
      try {
        taskOrderKeys = task.gmxOrderKeys ? JSON.parse(task.gmxOrderKeys) : null;
      } catch {
        taskOrderKeys = null;
      }
      if (task.kind !== 'CLOSE' || task.status !== 'CONFIRMED'
          || task.intentId !== intentId
          || task.gmxExecutionTxHash?.toLowerCase() !== input.evidenceTxHash.toLowerCase()
          || !Array.isArray(taskOrderKeys) || taskOrderKeys.length !== 1
          || typeof taskOrderKeys[0] !== 'string'
          || taskOrderKeys[0].toLowerCase() !== orderKey.toLowerCase()) {
        return { ok: false as const, reason: 'CLOSE relay task terminal 증거 결속 불일치' };
      }

      const dup = await tx.select({ id: tradesTable.id }).from(tradesTable)
        .where(eq(tradesTable.evidenceTxHash, input.evidenceTxHash)).limit(1);
      if (dup.length > 0 && dup[0].id !== input.tradeId) {
        return { ok: false as const, reason: `evidenceTxHash 이미 다른 trade(${dup[0].id})에 정산됨 — 이중 정산 금지` };
      }

      const updated = await tx.update(tradesTable)
        .set({
          grossPnlUsd: String(input.grossPnlUsd),
          positionFeeUsd: String(input.positionFeeUsd),
          executionFeeUsd: String(input.executionFeeUsd),
          priceImpactUsd: String(input.priceImpactUsd),
          fundingFeeUsd: String(input.fundingFeeUsd),
          borrowingFeeUsd: String(input.borrowingFeeUsd),
          netPnlUsd: String(net.netPnlUsd),
          pnl: String(net.netPnlUsd),
          settlementStatus: 'SETTLED',
          settledAt: input.settledAt,
          evidenceTxHash: input.evidenceTxHash,
          settlementRelayTaskId: relayTaskId,
          settlementOrderKey: orderKey,
          settlementEmitterAddress: emitterAddress,
          settlementBlockNumber: resolutionBlockText,
          settlementLatestBlock: latestBlockText,
          settlementConfirmations: confirmations,
          settlementEvidenceBasis: evidenceBasis,
          settlementEvidenceAt: input.settledAt,
        })
        .where(and(
          eq(tradesTable.id, input.tradeId),
          eq(tradesTable.action, 'CLOSE'),
          eq(tradesTable.testMode, true),
          eq(tradesTable.settlementStatus, 'UNSETTLED'),
          eq(tradesTable.settlementIntentId, intentId),
          isNotNull(tradesTable.preCloseSizeUsd30),
          isNotNull(tradesTable.requestedReductionUsd30),
        ))
        .returning({ id: tradesTable.id });
      if (updated.length === 0) {
        return { ok: false as const, reason: `trade ${input.tradeId} 미존재/경합/이미 정산됨 — 재정산 금지` };
      }

      const delta = fin(input.estimatedNetPnlUsd)
        ? net.netPnlUsd - (input.estimatedNetPnlUsd as number)
        : null;
      if (delta !== null && Math.abs(delta) > 0.005) {
        console.warn(`[Settlement] trade=${input.tradeId} 추정-실제 순PnL 차이 $${delta.toFixed(4)} (추정 $${(input.estimatedNetPnlUsd as number).toFixed(4)} → 실제 $${net.netPnlUsd.toFixed(4)})`);
      }
      return { ok: true as const, netPnlUsd: net.netPnlUsd, estimateDeltaUsd: delta };
    });
  } catch {
    return { ok: false, reason: '정산 저장 실패 — UNSETTLED 유지 (fail-closed)' };
  }
}

/**
 * 목표/손실 gate용 보수적 PnL 선별 (6H-2A §3·§5):
 *  - SETTLED: pnl(=실제 순 PnL) 그대로 반영
 *  - PAPER_ESTIMATED: netPnlEstimatedUsd(추정 순)가 있으면 그 값 사용 —
 *    이익도 손실도 net 기준. net이 없으면(비용 불명) 이익은 미반영,
 *    gross 손실만 반영 (0 대체 금지 · 보수적 비대칭)
 *  - UNSETTLED / legacy PAPER_ZERO_FEE: 이익 미반영, 손실은 즉시 반영
 */
export function pnlForTargets(rows: {
  pnl: number;
  settlementStatus: string | null;
  netPnlEstimatedUsd?: number | null;
}[]): {
  profitEligibleUsd: number;
  lossAwareUsd: number;
} {
  let profit = 0, loss = 0;
  for (const r of rows) {
    if (!fin(r.pnl)) continue;
    const st = r.settlementStatus ?? 'UNSETTLED';
    let effective: number | null = null; // null = 이익 부적격 (손실만 gross로)
    if (st === 'SETTLED') {
      effective = r.pnl;
    } else if (st === 'PAPER_ESTIMATED' && fin(r.netPnlEstimatedUsd)) {
      effective = r.netPnlEstimatedUsd as number;
    }
    if (effective !== null) {
      if (effective >= 0) profit += effective;
      else loss += effective;
    } else if (r.pnl < 0) {
      loss += r.pnl;
    }
  }
  return { profitEligibleUsd: profit, lossAwareUsd: loss };
}

// ── LIVE 정산 reconciliation (6H-2A §5) ─────────────────────────────────────

export type SettlementEvidence = {
  grossPnlUsd: number; positionFeeUsd: number; executionFeeUsd: number;
  priceImpactUsd: number; fundingFeeUsd: number; borrowingFeeUsd: number;
  evidenceTxHash: string; settledAt: Date;
  intentId: string; relayTaskId: string; orderKey: string; emitterAddress: string;
  resolutionBlock: string; latestBlock: string; confirmations: number;
  evidenceBasis: string;
};

export type SettlementEvidenceFetchResult =
  | SettlementEvidence
  | { ok: true; evidence: SettlementEvidence }
  | { ok: false; reason: string }
  | null;

/** 정산 증거 조회 fetcher — production은 read-only RPC/API/PositionReader만 사용 */
export interface SettlementEvidenceFetcher {
  /** trade에 대한 온체인 정산 증거 전체 확보 시도 — 부분 확보 금지 */
  fetchEvidence?: (args: { tradeId: string; symbol: string }) => Promise<SettlementEvidenceFetchResult>;
}

export interface ReconcileResult {
  ok: boolean;
  /** 조회 대상이었던 UNSETTLED LIVE 거래 수 */
  unsettledCount: number;
  settledNow: number;
  /** 전부 정산하지 못함 → LIVE_SETTLEMENT_INCOMPLETE (신규 LIVE 진입 차단 사유) */
  incomplete: boolean;
  reasons: string[];
}

/**
 * UNSETTLED LIVE(test_mode=true) 거래 전수 → 증거 수집 → SETTLED 전환 시도.
 * 실패해도 예외를 던지지 않음 (Worker 생존) — 대신 incomplete=true를 반환하며,
 * 호출자는 incomplete 동안 신규 LIVE 진입을 차단해야 한다 (fail-closed).
 */
export async function reconcileLiveSettlements(fetcher: SettlementEvidenceFetcher): Promise<ReconcileResult> {
  const reasons: string[] = [];
  try {
    const { db, tradesTable } = await import('@workspace/db');
    const { eq, and, or } = await import('drizzle-orm');
    const rows = await db.select({
      id: tradesTable.id, symbol: tradesTable.symbol,
    }).from(tradesTable)
      .where(and(
        eq(tradesTable.testMode, true),
        eq(tradesTable.settlementStatus, 'UNSETTLED'),
        or(eq(tradesTable.action, 'CLOSE'), eq(tradesTable.action, 'CLOSE_ALL')),
      ));
    const unsettledCount = rows.length;
    if (unsettledCount === 0) return { ok: true, unsettledCount: 0, settledNow: 0, incomplete: false, reasons: [] };

    if (!fetcher.fetchEvidence) {
      return {
        ok: false, unsettledCount, settledNow: 0, incomplete: true,
        reasons: [`${LIVE_SETTLEMENT_INCOMPLETE}: 정산 증거 조회 경로 미구성 — UNSETTLED ${unsettledCount}건 유지`],
      };
    }
    let settledNow = 0;
    for (const row of rows) {
      try {
        const fetched = await fetcher.fetchEvidence({ tradeId: row.id, symbol: row.symbol });
        if (!fetched) {
          reasons.push(`${LIVE_SETTLEMENT_INCOMPLETE}: trade=${row.id} 증거 미확보`);
          continue;
        }
        if ('ok' in fetched && fetched.ok === false) {
          reasons.push(`${LIVE_SETTLEMENT_INCOMPLETE}: trade=${row.id} ${fetched.reason}`);
          continue;
        }
        const ev = 'ok' in fetched ? fetched.evidence : fetched;
        const rec = await recordTradeSettlement({ tradeId: row.id, ...ev });
        if (rec.ok) settledNow++;
        else reasons.push(`${LIVE_SETTLEMENT_INCOMPLETE}: trade=${row.id} ${rec.reason}`);
      } catch (err) {
        reasons.push(`${LIVE_SETTLEMENT_INCOMPLETE}: trade=${row.id} 조회 실패 — ${(err as Error).message}`);
      }
    }
    const incomplete = settledNow < unsettledCount;
    return { ok: !incomplete, unsettledCount, settledNow, incomplete, reasons };
  } catch (err) {
    return {
      ok: false, unsettledCount: -1, settledNow: 0, incomplete: true,
      reasons: [`${LIVE_SETTLEMENT_INCOMPLETE}: DB 조회 실패 — ${(err as Error).message}`],
    };
  }
}
