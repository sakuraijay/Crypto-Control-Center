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

/** 정산 증거 조회 fetcher — 주입식 (이번 단계 실제 네트워크 경로 미구성) */
export interface SettlementEvidenceFetcher {
  /** trade에 대한 온체인 정산 증거 전체 확보 시도 — 부분 확보 금지 */
  fetchEvidence?: (args: { tradeId: string; symbol: string }) => Promise<{
    grossPnlUsd: number; positionFeeUsd: number; executionFeeUsd: number;
    priceImpactUsd: number; fundingFeeUsd: number; borrowingFeeUsd: number;
    evidenceTxHash: string; settledAt: Date;
  } | null>;
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
        const ev = await fetcher.fetchEvidence({ tradeId: row.id, symbol: row.symbol });
        if (!ev) {
          reasons.push(`${LIVE_SETTLEMENT_INCOMPLETE}: trade=${row.id} 증거 미확보`);
          continue;
        }
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
