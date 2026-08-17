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

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type SettlementStatus = 'UNSETTLED' | 'SETTLED' | 'PAPER_ZERO_FEE';

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
  try {
    const { db, tradesTable } = await import('@workspace/db');
    const { eq, and, ne } = await import('drizzle-orm');

    // 동일 증거 이중 정산 사전 확인 (인덱스가 최종 방어)
    const dup = await db.select({ id: tradesTable.id }).from(tradesTable)
      .where(eq(tradesTable.evidenceTxHash, input.evidenceTxHash)).limit(1);
    if (dup.length > 0 && dup[0].id !== input.tradeId) {
      return { ok: false, reason: `evidenceTxHash 이미 다른 trade(${dup[0].id})에 정산됨 — 이중 정산 금지` };
    }

    // 조건부 UPDATE — 이미 SETTLED면 전환 금지
    const updated = await db.update(tradesTable)
      .set({
        grossPnlUsd: String(input.grossPnlUsd),
        positionFeeUsd: String(input.positionFeeUsd),
        executionFeeUsd: String(input.executionFeeUsd),
        priceImpactUsd: String(input.priceImpactUsd),
        fundingFeeUsd: String(input.fundingFeeUsd),
        borrowingFeeUsd: String(input.borrowingFeeUsd),
        netPnlUsd: String(net.netPnlUsd),
        pnl: String(net.netPnlUsd), // 기존 집계 경로도 실제 순 PnL로 정정
        settlementStatus: 'SETTLED',
        settledAt: input.settledAt,
        evidenceTxHash: input.evidenceTxHash,
      })
      .where(and(eq(tradesTable.id, input.tradeId), ne(tradesTable.settlementStatus, 'SETTLED')))
      .returning({ id: tradesTable.id });
    if (updated.length === 0) {
      return { ok: false, reason: `trade ${input.tradeId} 미존재 또는 이미 SETTLED — 재정산 금지` };
    }

    const delta = fin(input.estimatedNetPnlUsd)
      ? net.netPnlUsd - (input.estimatedNetPnlUsd as number)
      : null;
    if (delta !== null && Math.abs(delta) > 0.005) {
      console.warn(`[Settlement] trade=${input.tradeId} 추정-실제 순PnL 차이 $${delta.toFixed(4)} (추정 $${(input.estimatedNetPnlUsd as number).toFixed(4)} → 실제 $${net.netPnlUsd.toFixed(4)})`);
    }
    return { ok: true, netPnlUsd: net.netPnlUsd, estimateDeltaUsd: delta };
  } catch (err) {
    return { ok: false, reason: `정산 저장 실패 — UNSETTLED 유지 (fail-closed): ${(err as Error).message}` };
  }
}

/**
 * 목표/손실 gate용 보수적 PnL 선별 (§5):
 *  - 이익: SETTLED 또는 PAPER_ZERO_FEE만 반영 (UNSETTLED 이익 미반영)
 *  - 손실: 상태 무관 즉시 반영
 */
export function pnlForTargets(rows: { pnl: number; settlementStatus: string | null }[]): {
  profitEligibleUsd: number;
  lossAwareUsd: number;
} {
  let profit = 0, loss = 0;
  for (const r of rows) {
    if (!fin(r.pnl)) continue;
    if (r.pnl >= 0) {
      const st = r.settlementStatus ?? 'UNSETTLED';
      if (st === 'SETTLED' || st === 'PAPER_ZERO_FEE') profit += r.pnl;
    } else {
      loss += r.pnl;
    }
  }
  return { profitEligibleUsd: profit, lossAwareUsd: loss };
}
