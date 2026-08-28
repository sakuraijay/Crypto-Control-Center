/**
 * serverPaperExecutor — 서버 권위 PAPER 체결·관리·정산 (Task #111).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 보안 원칙 (절대 변경 금지)
 * ──────────────────────────────────────────────────────────────────────────────
 * ❌ LIVE/GMX 주문 제출·서명·relay·delegated signer 경로 import 0회 (구조적 차단)
 * ✅ DB(trades/worker_state) + 캐시된 실제 GMX 시세만 사용 — PAPER 시뮬레이션 전용
 *
 * 원칙:
 *  - OPEN은 실제 GMX 시세(신선) + PAPER_GMX_ESTIMATE 비용 결속(신선, rate 포함)이
 *    모두 유효할 때만 — 비용 누락/stale/null/0 대체/합성 가격 전부 fail-closed NO_TRADE
 *  - 서버 관리 포지션은 managed_by='SERVER' — 클라이언트 POST가 덮어쓸 수 없다
 *  - idempotency:
 *      · OPEN: open_decision_id UNIQUE (결정당 1회) + SERVER 단일 미청산 UNIQUE
 *      · FULL CLOSE: closes_trade_id UNIQUE(FULL) 선삽입 claim → close_time 조건부 UPDATE
 *        (중간 실패 시 다음 틱이 conflict→repair 경로로 자가 치유)
 *      · REDUCE70: worker_state durable 예약 (동일 포지션 1회, 재시작 내구)
 *  - 정산: net = gross − 진입비용 − 청산비용 − funding − borrowing (보유시간 누적)
 *    비용 계산 실패 시 net=null (0 대체 금지 — gated PnL이 이익 미반영 처리)
 *  - CASH/CLOSE_ALL 청산 요청은 worker_state에 영속 — 재시작 후에도 완료까지 재시도
 */

import { db, tradesTable, workerStateTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getPaperCostBinding } from "../lib/paperCostCache";
import { accrueHoldingCostsFromEntryRates, computePaperNetPnl } from "../lib/holdingCosts";
import { computeStopTrigger } from "../lib/stopLossPlan";
import { computeReduction, GMX_MIN_POSITION_NOTIONAL_USD, canExecuteReduction, buildProfitProtectKey, manilaDayKey, type ProfitProtectRecord } from "../lib/profitProtection";
import { RISK_POLICY } from "../lib/riskPolicy";
import { isAppliedRiskProfileSnapshot } from "../lib/riskProfiles";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ── 상수 ──────────────────────────────────────────────────────────────────────

/** OPEN 시 허용되는 최대 가격 나이 — 초과 시 진입 거부 (합성/stale 가격 금지) */
export const MAX_ENTRY_PRICE_AGE_MS = 60_000;
/** 관리 틱(SL/TP/청산)에서 허용되는 최대 가격 나이 — 초과 시 해당 틱 스킵 */
export const MAX_MANAGE_PRICE_AGE_MS = 90_000;
/** 서버 관리 거래의 strategy 표기 */
export const SERVER_PAPER_STRATEGY = "SERVER_WORKER_AI";
/** worker_state — 미완료 청산 요청 영속 키 */
export const PENDING_CLOSE_KEY = "serverPaperPendingClose";
/** worker_state — REDUCE70 durable 예약 키 prefix */
export const REDUCE70_KEY_PREFIX = "serverPaperReduce70:";

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface PriceQuote { priceUsd: number; ageMs: number }

function isUsableQuoteAge(ageMs: number, maxAgeMs: number): boolean {
  return fin(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
}
export type PriceLookup = (symbol: string) => PriceQuote | null;

export interface ServerPaperOpenArgs {
  decisionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  sizeUsd: number;
  leverage: number;
  quote: PriceQuote | null;
  /** 엔진 제안 TP — 유효(양수·이익 방향)할 때만 채택, 아니면 null(TP 없음) */
  tpPriceUsd: number | null;
  /** 현재 미청산 포지션 수 (모든 출처) */
  openPositionCount: number;
  /** 적용 프로필 동시 포지션 상한. 서버 절대 상한 2와 교차한다. */
  maxConcurrentPositions?: number;
  /** 결정/주문 감사용 불변 프로필 스냅샷 */
  riskProfileSnapshot: import("./serverTypes").AppliedRiskProfileSnapshot;
  /** Manila 거래일 신규 진입 횟수 — 일일 3회 최종 게이트 */
  entriesManilaDay: number;
  nowMs?: number;
}

export type ServerPaperOpenResult =
  | { ok: true; tradeId: string; stopPriceUsd: number; tpPriceUsd: number | null }
  | { ok: false; reason: string };

export interface ServerPaperCloseArgs {
  openTradeId: string;
  reason: string;
  kind: "FULL" | "REDUCE70";
  quote: PriceQuote | null;
  nowMs?: number;
}

export type ServerPaperCloseResult =
  | { ok: true; closeTradeId: string; closedSizeUsd: number; grossPnlUsd: number; netPnlEstimatedUsd: number | null }
  | { ok: false; reason: string; alreadyClosed?: boolean };

export interface ServerPaperOpenPositionView {
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  sizeInUsd: number;
  entryPriceUsd: number;
  leverage: number;
  stopPriceUsd: number | null;
  tpPriceUsd: number | null;
  openedAt: string;
  unrealizedPnlUsd: number | null;
}

export interface ServerPaperExecStatus {
  openPosition: ServerPaperOpenPositionView | null;
  openPositions: ServerPaperOpenPositionView[];
  pendingClose: { reason: string; requestedAt: string } | null;
  lastTickAt: string | null;
  /** 마지막 틱에서 가격 stale로 관리가 스킵됐는지 (관측용) */
  lastTickStale: boolean;
  lastOpenAttempt: { at: string; ok: boolean; reason: string | null; tradeId: string | null } | null;
  lastCloseAction: { at: string; kind: string; reason: string; ok: boolean; detail: string | null } | null;
  /** 자가 치유 불가한 불일치 관측 시 사유 (신규 진입 차단) */
  unresolved: string | null;
}

// ── 모듈 상태 (관측용 — 권위 상태는 전부 DB) ─────────────────────────────────

const state: ServerPaperExecStatus = {
  openPosition: null,
  openPositions: [],
  pendingClose: null,
  lastTickAt: null,
  lastTickStale: false,
  lastOpenAttempt: null,
  lastCloseAction: null,
  unresolved: null,
};

/** 관리 틱 singleflight */
let tickInFlight = false;

export function getServerPaperStatus(): ServerPaperExecStatus {
  return { ...state, openPositions: [...state.openPositions] };
}

export function __resetServerPaperStateForTests(): void {
  state.openPosition = null;
  state.openPositions = [];
  state.pendingClose = null;
  state.lastTickAt = null;
  state.lastTickStale = false;
  state.lastOpenAttempt = null;
  state.lastCloseAction = null;
  state.unresolved = null;
  tickInFlight = false;
  pendingClosePersistFailed = false;
  pendingCloseLoadFailed = false;
  startupReconcileFailed = false;
  storedDirFetcher = null;
}

// ── worker_state helpers ──────────────────────────────────────────────────────

async function readWorkerState(
  key: string,
  shouldContinue: () => boolean = () => true,
): Promise<string | null> {
  if (!shouldContinue()) throw new Error("lifecycle stopped");
  const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, key));
  if (!shouldContinue()) throw new Error("lifecycle stopped");
  return rows[0]?.value ?? null;
}

async function writeWorkerState(
  key: string,
  value: string,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!shouldContinue()) throw new Error("lifecycle stopped");
  const now = new Date();
  const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, key));
  if (!shouldContinue()) throw new Error("lifecycle stopped");
  if (rows.length > 0) {
    await db.update(workerStateTable).set({ value, updatedAt: now }).where(eq(workerStateTable.key, key));
  } else {
    await db.insert(workerStateTable).values({ key, value, updatedAt: now });
  }
  if (!shouldContinue()) throw new Error("lifecycle stopped");
}

async function deleteWorkerState(
  key: string,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!shouldContinue()) return;
  await db.delete(workerStateTable).where(eq(workerStateTable.key, key));
}

// ── DB 조회 ───────────────────────────────────────────────────────────────────

type TradeRow = typeof tradesTable.$inferSelect;

/** 서버 관리 미청산 OPEN 행 조회 (권위 = DB, 재시작 복구 경로) */
export async function loadServerOpenRows(): Promise<TradeRow[]> {
  const rows = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.managedBy, "SERVER"), eq(tradesTable.action, "OPEN"), eq(tradesTable.closeTime, 0)));
  return rows;
}

function toView(row: TradeRow, quote: PriceQuote | null): ServerPaperOpenPositionView {
  const sizeInUsd = parseFloat(row.sizeInUsd ?? row.size ?? "0") || 0;
  const entry = parseFloat(row.price ?? "0") || 0;
  const side = row.side === "SHORT" ? "SHORT" : "LONG";
  let unrealized: number | null = null;
  if (
    quote
    && fin(quote.priceUsd)
    && isUsableQuoteAge(quote.ageMs, MAX_MANAGE_PRICE_AGE_MS)
    && entry > 0
    && quote.priceUsd > 0
    && sizeInUsd > 0
  ) {
    const dir = side === "LONG" ? 1 : -1;
    unrealized = ((quote.priceUsd - entry) / entry) * sizeInUsd * dir;
  }
  return {
    tradeId: row.id,
    symbol: row.symbol,
    side,
    sizeInUsd,
    entryPriceUsd: entry,
    leverage: parseFloat(row.leverage ?? "1") || 1,
    stopPriceUsd: row.stopPriceUsd != null ? parseFloat(row.stopPriceUsd) : null,
    tpPriceUsd: row.takeProfitPriceUsd != null ? parseFloat(row.takeProfitPriceUsd) : null,
    openedAt: new Date(row.timestamp as unknown as string | Date).toISOString(),
    unrealizedPnlUsd: unrealized,
  };
}

// ── OPEN ──────────────────────────────────────────────────────────────────────

/**
 * 서버 권위 PAPER OPEN — 모든 게이트 통과 시에만 durable 기록.
 * 어떤 실패든 {ok:false} + 사유 반환 = NO_TRADE (부분 기록 없음).
 */
export async function openServerPaperPosition(
  args: ServerPaperOpenArgs,
  shouldContinue: () => boolean = () => true,
): Promise<ServerPaperOpenResult> {
  const nowMs = args.nowMs ?? Date.now();
  const record = (r: ServerPaperOpenResult): ServerPaperOpenResult => {
    if (shouldContinue()) {
      state.lastOpenAttempt = {
        at: new Date(nowMs).toISOString(),
        ok: r.ok,
        reason: r.ok ? null : r.reason,
        tradeId: r.ok ? r.tradeId : null,
      };
    }
    return r;
  };
  const stopped = (): ServerPaperOpenResult =>
    ({ ok: false, reason: "lifecycle stopped — OPEN no-op" });

  if (!shouldContinue()) return stopped();
  if (state.unresolved) return record({ ok: false, reason: `UNRESOLVED 상태 — 신규 진입 차단: ${state.unresolved}` });
  if (!args.decisionId) return record({ ok: false, reason: "decisionId 없음 — idempotency 불가, 진입 거부" });
  if (!isAppliedRiskProfileSnapshot(args.riskProfileSnapshot)) {
    return record({ ok: false, reason: "위험 프로필 감사 스냅샷 없음/손상 — 진입 거부" });
  }

  // ── 최종 서버 게이트 (RiskEngine 상류 통과와 별개로 재검증) ────────────────
  const maxConcurrentPositions = Math.max(
    1,
    Math.min(
      Number.isFinite(args.maxConcurrentPositions)
        ? Math.floor(args.maxConcurrentPositions as number)
        : RISK_POLICY.maxConcurrentPositions,
      RISK_POLICY.maxProfileConcurrentPositions,
    ),
  );
  if (args.openPositionCount >= maxConcurrentPositions) {
    return record({ ok: false, reason: `동시 포지션 한도 (${args.openPositionCount}/${maxConcurrentPositions}) — 진입 거부` });
  }
  if (args.entriesManilaDay >= RISK_POLICY.maxDailyEntries) {
    return record({ ok: false, reason: `Manila 일일 진입 한도 (${args.entriesManilaDay}/${RISK_POLICY.maxDailyEntries}) — 진입 거부` });
  }
  if (!fin(args.sizeUsd) || args.sizeUsd < GMX_MIN_POSITION_NOTIONAL_USD) {
    return record({ ok: false, reason: `sizeUsd 비정상 (${args.sizeUsd}) — 진입 거부` });
  }
  if (!fin(args.leverage) || args.leverage < 1 || args.leverage > RISK_POLICY.baseMaxLeverage) {
    return record({ ok: false, reason: `leverage 비정상 (${args.leverage}) — 최대 ${RISK_POLICY.baseMaxLeverage}x, 진입 거부` });
  }

  // ── 실제 GMX 시세 신선도 (합성/0 가격 금지) ────────────────────────────────
  const q = args.quote;
  if (!q || !fin(q.priceUsd) || q.priceUsd <= 0) {
    return record({ ok: false, reason: "NO_TRADE: 실시세 없음 — 합성 가격 대체 금지" });
  }
  if (!isUsableQuoteAge(q.ageMs, MAX_ENTRY_PRICE_AGE_MS)) {
    return record({ ok: false, reason: `NO_TRADE: 시세 age 비정상/stale (${q.ageMs})` });
  }

  // ── 비용 결속 (fail-closed — rate 포함 필수, 없으면 청산 정산 불가) ────────
  const binding = getPaperCostBinding(args.symbol, nowMs);
  if (!binding) {
    return record({ ok: false, reason: "NO_TRADE: PAPER_GMX_ESTIMATE 비용 스냅샷 부재/stale — 비용 불명 진입 금지" });
  }
  if (binding.fundingRatePerHourFraction == null || binding.borrowingRatePerHourFraction == null) {
    return record({ ok: false, reason: "NO_TRADE: funding/borrowing rate 누락 — 보유비용 정산 불가, 진입 금지" });
  }
  if (!fin(binding.estEntryCostUsd) || binding.estEntryCostUsd < 0
    || !fin(binding.estExitCostUsd) || binding.estExitCostUsd < 0) {
    return record({ ok: false, reason: "NO_TRADE: 진입/청산 추정비용 비정상 — 진입 금지" });
  }

  // ── SL/TP 계산 (진입 전 계약 — stop 없으면 OPEN 금지) ─────────────────────
  const isLong = args.side === "LONG";
  const stop = computeStopTrigger({ entryPriceUsd: q.priceUsd, isLong });
  if (!stop.ok) return record({ ok: false, reason: `NO_TRADE: ${stop.reason}` });

  let tp: number | null = null;
  if (args.tpPriceUsd != null && fin(args.tpPriceUsd) && args.tpPriceUsd > 0) {
    const profitSide = isLong ? args.tpPriceUsd > q.priceUsd : args.tpPriceUsd < q.priceUsd;
    if (profitSide) tp = args.tpPriceUsd;
    // 이익 방향이 아니면 TP 미설정 (0/엉뚱한 값 저장 금지)
  }

  const existingRows = await loadServerOpenRows();
  if (!shouldContinue()) return stopped();
  if (existingRows.some(row => row.symbol.toUpperCase() === args.symbol.toUpperCase())) {
    return record({ ok: false, reason: `${args.symbol} 기존 포지션 중복 — 동일 심볼 추가 진입/물타기 금지` });
  }
  const usedSlots = new Set(existingRows.map(row => row.paperPositionSlot).filter((slot): slot is number => slot != null));
  const paperPositionSlot = [1, 2].find(slot => !usedSlots.has(slot));
  if (!paperPositionSlot || existingRows.length >= maxConcurrentPositions) {
    return record({ ok: false, reason: `서버 PAPER 슬롯 한도 (${existingRows.length}/${maxConcurrentPositions}) — 진입 거부` });
  }

  const tradeId = crypto.randomUUID();
  try {
    if (!shouldContinue()) return stopped();
    const inserted = await db.insert(tradesTable).values({
      id: tradeId,
      symbol: args.symbol,
      side: args.side,
      action: "OPEN",
      size: String(args.sizeUsd),
      price: String(q.priceUsd),
      pnl: "0",
      strategy: SERVER_PAPER_STRATEGY,
      timestamp: new Date(nowMs),
      closeTime: 0,
      sizeInUsd: String(args.sizeUsd),
      collateralToken: "USDC",
      leverage: String(args.leverage),
      collateralUsd: String(args.sizeUsd / args.leverage),
      testMode: false,
      settlementStatus: "PAPER_ESTIMATED",
      costSource: binding.costSource,
      estEntryCostUsd: String(binding.estEntryCostUsd),
      estExitCostUsd: String(binding.estExitCostUsd),
      fundingRatePerHour: String(binding.fundingRatePerHourFraction),
      borrowingRatePerHour: String(binding.borrowingRatePerHourFraction),
      costFetchedAt: new Date(binding.costFetchedAt),
      managedBy: "SERVER",
      openDecisionId: args.decisionId,
      stopPriceUsd: String(stop.plan.triggerPriceUsd),
      takeProfitPriceUsd: tp != null ? String(tp) : null,
      riskProfileSnapshot: args.riskProfileSnapshot,
      paperPositionSlot,
    }).onConflictDoNothing({ target: tradesTable.id }).returning({ id: tradesTable.id });
    if (!shouldContinue()) return stopped();

    if (!inserted || inserted.length === 0) {
      return record({ ok: false, reason: "OPEN 중복 (id conflict) — no-op" });
    }
  } catch (err) {
    if (!shouldContinue()) return stopped();
    // UNIQUE(open_decision_id / SERVER 단일 미청산) 위반 → 중복 진입 시도, no-op
    const msg = (err as Error).message ?? String(err);
    if (/unique|duplicate/i.test(msg)) {
      return record({ ok: false, reason: "OPEN 중복 차단 (unique index) — no-op" });
    }
    return record({ ok: false, reason: `OPEN 저장 실패 — 진입 미기록 (NO_TRADE): ${msg}` });
  }

  console.info(`[ServerPaper] OPEN ${args.symbol} ${args.side} $${args.sizeUsd.toFixed(2)} @${q.priceUsd} lev=${args.leverage}x stop=${stop.plan.triggerPriceUsd.toFixed(4)} tp=${tp ?? "없음"} (decision=${args.decisionId})`);
  return record({ ok: true, tradeId, stopPriceUsd: stop.plan.triggerPriceUsd, tpPriceUsd: tp });
}

// ── CLOSE (FULL / REDUCE70) ───────────────────────────────────────────────────

/**
 * 서버 권위 PAPER CLOSE — durable/idempotent.
 * FULL: CLOSE 행 선삽입(UNIQUE claim) → OPEN 행 close_time 조건부 UPDATE(repair 겸용).
 * REDUCE70: 호출 측에서 worker_state 예약 확보 후 호출 (reduceServerPaper70 사용 권장).
 */
export async function closeServerPaperPosition(
  args: ServerPaperCloseArgs,
  shouldContinue: () => boolean = () => true,
): Promise<ServerPaperCloseResult> {
  const nowMs = args.nowMs ?? Date.now();
  const record = (kind: string, reason: string, ok: boolean, detail: string | null) => {
    if (shouldContinue()) {
      state.lastCloseAction = { at: new Date(nowMs).toISOString(), kind, reason, ok, detail };
    }
  };
  const stopped = (): ServerPaperCloseResult =>
    ({ ok: false, reason: "lifecycle stopped — CLOSE no-op" });

  // OPEN 행 로드
  if (!shouldContinue()) return stopped();
  const rows = await db.select().from(tradesTable).where(eq(tradesTable.id, args.openTradeId));
  if (!shouldContinue()) return stopped();
  const openRow = rows[0];
  if (!openRow) { record(args.kind, args.reason, false, "OPEN 행 없음"); return { ok: false, reason: "OPEN 행 없음" }; }
  if (openRow.managedBy !== "SERVER") { record(args.kind, args.reason, false, "서버 관리 행 아님"); return { ok: false, reason: "서버 관리 행 아님 — 거부" }; }
  if (openRow.closeTime && openRow.closeTime > 0) {
    record(args.kind, args.reason, true, "이미 청산됨 (no-op)");
    return { ok: false, reason: "이미 청산됨", alreadyClosed: true };
  }

  // 시세 신선도 — stale이면 청산 보류 (합성 가격 정산 금지, 다음 틱 재시도)
  const q = args.quote;
  if (
    !q
    || !fin(q.priceUsd)
    || q.priceUsd <= 0
    || !isUsableQuoteAge(q.ageMs, MAX_MANAGE_PRICE_AGE_MS)
  ) {
    record(args.kind, args.reason, false, "시세 stale/부재 — 청산 보류");
    return { ok: false, reason: "시세 stale/부재 — 청산 보류 (다음 틱 재시도)" };
  }

  const openSize = parseFloat(openRow.sizeInUsd ?? openRow.size ?? "0") || 0;
  const entry = parseFloat(openRow.price ?? "0") || 0;
  if (openSize <= 0 || entry <= 0) {
    record(args.kind, args.reason, false, "OPEN 행 size/entry 비정상");
    return { ok: false, reason: "OPEN 행 size/entry 비정상 — 청산 불가" };
  }
  const isLong = openRow.side !== "SHORT";
  const dir = isLong ? 1 : -1;

  // 청산 크기 결정
  let closedSize = openSize;
  let remaining = 0;
  if (args.kind === "REDUCE70") {
    const plan = computeReduction({ openSizeUsd: openSize, minPositionNotionalUsd: GMX_MIN_POSITION_NOTIONAL_USD });
    if (!plan.ok) { record(args.kind, args.reason, false, plan.reason); return { ok: false, reason: plan.reason }; }
    if (plan.fullClose) { closedSize = openSize; remaining = 0; }
    else { closedSize = plan.reduceSizeUsd; remaining = plan.remainingSizeUsd; }
  }
  const effectiveKind: "FULL" | "REDUCE70" = args.kind === "REDUCE70" && remaining > 0 ? "REDUCE70" : "FULL";

  // gross PnL (청산분)
  const grossPnl = ((q.priceUsd - entry) / entry) * closedSize * dir;

  // ── 비용 정산 (실패 시 net=null — 0 대체 금지, 청산 자체는 진행) ───────────
  const fraction = closedSize / openSize;
  let netEst: number | null = null;
  let holdingUsd: number | null = null;
  const entryCostFull = openRow.estEntryCostUsd != null ? parseFloat(openRow.estEntryCostUsd) : NaN;
  const exitCostFull = openRow.estExitCostUsd != null ? parseFloat(openRow.estExitCostUsd) : NaN;
  if (openRow.costSource === "PAPER_GMX_ESTIMATE" && fin(entryCostFull) && fin(exitCostFull)) {
    const holding = accrueHoldingCostsFromEntryRates({
      notionalUsd: closedSize,
      openedAtMs: new Date(openRow.timestamp as unknown as string | Date).getTime(),
      closedAtMs: nowMs,
      fundingRatePerHourFraction: openRow.fundingRatePerHour != null ? parseFloat(openRow.fundingRatePerHour) : null,
      borrowingRatePerHourFraction: openRow.borrowingRatePerHour != null ? parseFloat(openRow.borrowingRatePerHour) : null,
    });
    if (holding.ok) {
      const net = computePaperNetPnl({
        simulatedGrossPnlUsd: grossPnl,
        estimatedEntryCostsUsd: entryCostFull * fraction,
        estimatedExitCostsUsd: exitCostFull * fraction,
        elapsedHoldingFundingUsd: holding.fundingUsd,
        elapsedHoldingBorrowingUsd: holding.borrowingUsd,
      });
      if (net.ok) { netEst = net.netPnlUsd; holdingUsd = holding.totalUsd; }
    }
  }

  const closeId = crypto.randomUUID();
  try {
    // 1) CLOSE 행 선삽입 — FULL은 closes_trade_id UNIQUE가 중복 청산을 차단
    if (!shouldContinue()) return stopped();
    const inserted = await db.insert(tradesTable).values({
      id: closeId,
      symbol: openRow.symbol,
      side: openRow.side,
      action: "CLOSE",
      size: String(closedSize),
      price: String(q.priceUsd),
      pnl: String(grossPnl),
      strategy: SERVER_PAPER_STRATEGY,
      timestamp: new Date(nowMs),
      closeTime: nowMs,
      sizeInUsd: String(closedSize),
      collateralToken: openRow.collateralToken ?? "USDC",
      leverage: openRow.leverage,
      testMode: false,
      settlementStatus: "PAPER_ESTIMATED",
      costSource: netEst != null ? "PAPER_GMX_ESTIMATE" : null,
      estEntryCostUsd: netEst != null ? String(entryCostFull * fraction) : null,
      estExitCostUsd: netEst != null ? String(exitCostFull * fraction) : null,
      estHoldingCostUsd: holdingUsd != null ? String(holdingUsd) : null,
      fundingRatePerHour: openRow.fundingRatePerHour,
      borrowingRatePerHour: openRow.borrowingRatePerHour,
      costFetchedAt: openRow.costFetchedAt,
      netPnlEstimatedUsd: netEst != null ? String(netEst) : null,
      managedBy: "SERVER",
      closesTradeId: openRow.id,
      closeKind: effectiveKind,
      closeReason: args.reason,
      riskProfileSnapshot: openRow.riskProfileSnapshot,
    }).onConflictDoNothing({ target: tradesTable.id }).returning({ id: tradesTable.id });
    if (!shouldContinue()) return stopped();
    void inserted;
  } catch (err) {
    if (!shouldContinue()) return stopped();
    const msg = (err as Error).message ?? String(err);
    if (!/unique|duplicate/i.test(msg)) {
      record(effectiveKind, args.reason, false, `CLOSE 저장 실패: ${msg}`);
      return { ok: false, reason: `CLOSE 저장 실패 — 청산 미기록: ${msg}` };
    }
    // FULL UNIQUE conflict → 이전 시도가 CLOSE 행을 이미 삽입 — repair 경로로 진행
    console.warn(`[ServerPaper] CLOSE claim conflict (open=${openRow.id}) — repair 경로 진행`);
  }

  // 2) OPEN 행 확정 (조건부 UPDATE — 여기 실패해도 다음 틱 repair)
  if (!shouldContinue()) return stopped();
  if (effectiveKind === "FULL") {
    await db.update(tradesTable)
      .set({ closeTime: nowMs })
      .where(and(eq(tradesTable.id, openRow.id), eq(tradesTable.closeTime, 0)));
  } else {
    // REDUCE70: 잔여 size로 축소 + 잔여 비율만큼 비용 결속도 축소 (이후 FULL 정산 정합)
    const remainFraction = remaining / openSize;
    await db.update(tradesTable)
      .set({
        sizeInUsd: String(remaining),
        size: String(remaining),
        estEntryCostUsd: fin(entryCostFull) ? String(entryCostFull * remainFraction) : openRow.estEntryCostUsd,
        estExitCostUsd: fin(exitCostFull) ? String(exitCostFull * remainFraction) : openRow.estExitCostUsd,
      })
      .where(and(eq(tradesTable.id, openRow.id), eq(tradesTable.sizeInUsd, openRow.sizeInUsd ?? ""), eq(tradesTable.closeTime, 0)));
  }
  if (!shouldContinue()) return stopped();

  record(effectiveKind, args.reason, true, `closed $${closedSize.toFixed(2)} gross=${grossPnl.toFixed(2)} net=${netEst != null ? netEst.toFixed(2) : "불명"}`);
  console.info(`[ServerPaper] CLOSE(${effectiveKind}) ${openRow.symbol} $${closedSize.toFixed(2)} @${q.priceUsd} reason=${args.reason} gross=$${grossPnl.toFixed(2)} net=${netEst != null ? `$${netEst.toFixed(2)}` : "불명(비용 계산 실패)"}`);
  return { ok: true, closeTradeId: closeId, closedSizeUsd: closedSize, grossPnlUsd: grossPnl, netPnlEstimatedUsd: netEst };
}

// ── REDUCE70 (durable 1회 예약) ───────────────────────────────────────────────

export async function reduceServerPaper70(args: {
  openRow: TradeRow;
  quote: PriceQuote | null;
  nowMs?: number;
  shouldContinue?: () => boolean;
}): Promise<ServerPaperCloseResult> {
  const shouldContinue = args.shouldContinue ?? (() => true);
  const stopped = (): ServerPaperCloseResult =>
    ({ ok: false, reason: "lifecycle stopped — REDUCE70 no-op" });
  if (!shouldContinue()) return stopped();
  const nowMs = args.nowMs ?? Date.now();
  const dayKey = manilaDayKey(new Date(nowMs));
  const positionKey = `${args.openRow.symbol}:${args.openRow.side}:${args.openRow.id}`;
  const idemKey = buildProfitProtectKey(dayKey, positionKey);
  const stateKey = `${REDUCE70_KEY_PREFIX}${idemKey}`;

  // durable 예약 확인 — 기록이 있으면 상태 불문 재실행 금지
  let existing: ProfitProtectRecord | null = null;
  try {
    const raw = await readWorkerState(stateKey, shouldContinue);
    if (!shouldContinue()) return stopped();
    existing = raw ? JSON.parse(raw) as ProfitProtectRecord : null;
  } catch {
    if (!shouldContinue()) return stopped();
    return { ok: false, reason: "REDUCE70 예약 조회 실패 — fail-closed, 축소 보류" };
  }
  const gate = canExecuteReduction(existing);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  // 예약 선기록 (SUBMITTED) — 실행 전 durable
  const rec: ProfitProtectRecord = {
    idempotencyKey: idemKey, positionKey, dayKey,
    reduceSizeUsd: 0, fullClose: false, status: "SUBMITTED", orderKey: null,
    createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(),
  };
  try {
    await writeWorkerState(stateKey, JSON.stringify(rec), shouldContinue);
    if (!shouldContinue()) return stopped();
  } catch {
    if (!shouldContinue()) return stopped();
    return { ok: false, reason: "REDUCE70 예약 기록 실패 — fail-closed, 축소 보류" };
  }

  const result = await closeServerPaperPosition({
    openTradeId: args.openRow.id, reason: "PROFIT_PROTECT_REDUCE70", kind: "REDUCE70", quote: args.quote, nowMs,
  }, shouldContinue);
  if (!shouldContinue()) return stopped();
  rec.status = result.ok ? "CONFIRMED" : "FAILED";
  rec.reduceSizeUsd = result.ok ? result.closedSizeUsd : 0;
  rec.updatedAt = new Date().toISOString();
  try { await writeWorkerState(stateKey, JSON.stringify(rec), shouldContinue); }
  catch {
    if (shouldContinue()) {
      console.error("[ServerPaper] REDUCE70 예약 상태 갱신 실패 — 기록은 SUBMITTED 유지 (재실행 차단됨)");
    }
  }
  return result;
}

// ── CASH/CLOSE_ALL 요청 (영속 — 재시작 후에도 완료까지 재시도) ────────────────

/** 영속 실패 시 true — 틱마다 재시도해야 하는 플래그 */
let pendingClosePersistFailed = false;

export async function requestServerPaperCloseAll(
  reason: string,
  nowMs = Date.now(),
  shouldContinue: () => boolean = () => true,
): Promise<{ persisted: boolean }> {
  if (!shouldContinue()) return { persisted: false };
  const pending = { reason, requestedAt: new Date(nowMs).toISOString() };
  state.pendingClose = pending;
  try {
    await writeWorkerState(PENDING_CLOSE_KEY, JSON.stringify(pending), shouldContinue);
    if (!shouldContinue()) return { persisted: false };
    pendingClosePersistFailed = false;
    return { persisted: true };
  } catch (err) {
    if (!shouldContinue()) return { persisted: false };
    // fail-closed: 영속 확인 전에는 성공으로 취급하지 않는다. 메모리 요청은 유지하되
    // unresolved로 신규 진입을 차단하고, 틱마다 영속을 재시도한다.
    pendingClosePersistFailed = true;
    state.unresolved = "pendingClose 영속 실패 — 재시작 시 유실 위험, 재시도 중";
    console.error("[ServerPaper] pendingClose 영속 실패 (fail-closed):", (err as Error).message);
    return { persisted: false };
  }
}

/** startup read 실패 시 true — durable 상태 불명 → 신규 진입 차단 + 틱마다 재시도 */
let pendingCloseLoadFailed = false;

export async function loadPendingCloseFromDb(
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!shouldContinue()) return;
  try {
    const raw = await readWorkerState(PENDING_CLOSE_KEY, shouldContinue);
    if (!shouldContinue()) return;
    state.pendingClose = raw ? JSON.parse(raw) as { reason: string; requestedAt: string } : null;
    pendingCloseLoadFailed = false;
    if (state.unresolved?.includes("pendingClose 로드 실패")) state.unresolved = null;
  } catch (err) {
    if (!shouldContinue()) return;
    // durable-state-unknown: DB에 close-all 의도가 있는지 알 수 없다 — fail-closed.
    // 신규 진입은 unresolved로 차단되고, 틱마다 읽기를 재시도한다.
    pendingCloseLoadFailed = true;
    state.unresolved = "pendingClose 로드 실패 — durable 상태 불명, 신규 진입 차단 (재시도 중)";
    console.error("[ServerPaper] pendingClose 로드 실패 (fail-closed):", (err as Error).message);
  }
}

// ── startup close-intent reconciliation ──────────────────────────────────────
// write-failure → crash 시나리오 복구: pendingClose 영속에 실패한 채 크래시하면
// DB에 pendingClose 행이 없다. 그러나 그 의도를 낳은 CASH/NO_TRADE 결정은 같은
// 사이클의 persistDecision으로 durable하다. 재시작 시 마지막 영속 결정이 flat을
// 지시하고 서버 미청산 포지션이 있으면 close-all을 재수립한다. 판정 실패는
// fail-closed(unresolved + 틱 재시도).

let startupReconcileFailed = false;
let storedDirFetcher: (() => Promise<string | null>) | null = null;

export async function reconcileStartupCloseIntent(
  fetchLastDecisionDirection: () => Promise<string | null>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!shouldContinue()) return;
  storedDirFetcher = fetchLastDecisionDirection;
  try {
    if (!state.pendingClose) {
      const open = await loadServerOpenRows();
      if (!shouldContinue()) return;
      if (open.length > 0) {
        const dir = await fetchLastDecisionDirection();
        if (!shouldContinue()) return;
        if (dir === "CASH" || dir === "NO_TRADE" || dir === "CLOSE") {
          await requestServerPaperCloseAll(
            "STARTUP_RECONCILE",
            Date.now(),
            shouldContinue,
          );
          if (!shouldContinue()) return;
        }
      }
    }
    if (!shouldContinue()) return;
    startupReconcileFailed = false;
    if (state.unresolved?.includes("reconciliation 실패")) state.unresolved = null;
  } catch (err) {
    if (!shouldContinue()) return;
    startupReconcileFailed = true;
    state.unresolved = "startup close-intent reconciliation 실패 — durable 상태 불명, 신규 진입 차단 (재시도 중)";
    console.error("[ServerPaper] startup reconciliation 실패 (fail-closed):", (err as Error).message);
  }
}

// ── 관리 틱 (SL/TP/pendingClose — 재시작 복구는 DB 재조회로 자동) ─────────────

export async function manageServerPaperTick(
  getQuote: PriceLookup,
  nowMs = Date.now(),
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (tickInFlight || !shouldContinue()) return;
  tickInFlight = true;
  try {
    if (!shouldContinue()) return;
    state.lastTickAt = new Date(nowMs).toISOString();
    state.lastTickStale = false;

    // startup read 실패분 재시도 — durable 상태 불명 동안 unresolved 유지
    if (pendingCloseLoadFailed) {
      await loadPendingCloseFromDb(shouldContinue);
      if (!shouldContinue()) return;
    }

    // startup reconciliation 실패분 재시도 (durable 상태 불명 → 신규 진입 차단 유지)
    if (startupReconcileFailed && storedDirFetcher) {
      await reconcileStartupCloseIntent(storedDirFetcher, shouldContinue);
      if (!shouldContinue()) return;
    }

    // pendingClose 영속 재시도 (요청 시점 실패분 — 성공 전에는 unresolved 유지)
    if (pendingClosePersistFailed && state.pendingClose) {
      try {
        if (!shouldContinue()) return;
        await writeWorkerState(
          PENDING_CLOSE_KEY,
          JSON.stringify(state.pendingClose),
          shouldContinue,
        );
        if (!shouldContinue()) return;
        pendingClosePersistFailed = false;
        state.unresolved = null;
      } catch { /* 다음 틱 재시도 — unresolved 유지 */ }
    }

    if (!shouldContinue()) return;
    const openRows = await loadServerOpenRows();
    if (!shouldContinue()) return;
    if (openRows.length === 0) {
      state.openPosition = null;
      state.openPositions = [];
      if (state.pendingClose) {
        if (!shouldContinue()) return;
        state.pendingClose = null;
        await deleteWorkerState(PENDING_CLOSE_KEY, shouldContinue).catch(() => {});
        if (!shouldContinue()) return;
      }
      return;
    }

    state.openPositions = openRows.map(row => toView(row, getQuote(row.symbol)));
    state.openPosition = state.openPositions[0] ?? null;
    for (const row of openRows) {
      if (!shouldContinue()) return;
      const quote = getQuote(row.symbol);

      if (
        !quote
        || !fin(quote.priceUsd)
        || quote.priceUsd <= 0
        || !isUsableQuoteAge(quote.ageMs, MAX_MANAGE_PRICE_AGE_MS)
      ) {
        state.lastTickStale = true; // stale — 이번 틱 관리 스킵 (합성 가격 금지)
        continue;
      }

      // 1) pendingClose (CASH 전환·RiskEngine CLOSE_ALL) — 최우선 전량 청산
      if (state.pendingClose) {
        if (!shouldContinue()) return;
        await closeServerPaperPosition(
          { openTradeId: row.id, reason: state.pendingClose.reason, kind: "FULL", quote, nowMs },
          shouldContinue,
        );
        if (!shouldContinue()) return;
        continue;
      }

      // 2) SL / TP 터치 판정
      const isLong = row.side !== "SHORT";
      const stop = row.stopPriceUsd != null ? parseFloat(row.stopPriceUsd) : NaN;
      const tp = row.takeProfitPriceUsd != null ? parseFloat(row.takeProfitPriceUsd) : NaN;
      const stopHit = fin(stop) && (isLong ? quote.priceUsd <= stop : quote.priceUsd >= stop);
      const tpHit = fin(tp) && (isLong ? quote.priceUsd >= tp : quote.priceUsd <= tp);
      if (stopHit) {
        if (!shouldContinue()) return;
        await closeServerPaperPosition(
          { openTradeId: row.id, reason: "STOP_LOSS", kind: "FULL", quote, nowMs },
          shouldContinue,
        );
        if (!shouldContinue()) return;
      } else if (tpHit) {
        if (!shouldContinue()) return;
        await closeServerPaperPosition(
          { openTradeId: row.id, reason: "TAKE_PROFIT", kind: "FULL", quote, nowMs },
          shouldContinue,
        );
        if (!shouldContinue()) return;
      }
    }

    // 청산 후 재조회 — 전량 청산 완료 시 pendingClose 해제
    if (state.pendingClose) {
      if (!shouldContinue()) return;
      const remaining = await loadServerOpenRows();
      if (!shouldContinue()) return;
      if (remaining.length === 0) {
        state.pendingClose = null;
        state.openPosition = null;
        state.openPositions = [];
        await deleteWorkerState(PENDING_CLOSE_KEY, shouldContinue).catch(() => {});
        if (!shouldContinue()) return;
      }
    } else {
      if (!shouldContinue()) return;
      const remaining = await loadServerOpenRows();
      if (!shouldContinue()) return;
      state.openPositions = remaining.map(row => toView(row, getQuote(row.symbol)));
      state.openPosition = state.openPositions[0] ?? null;
    }
  } catch (err) {
    if (shouldContinue()) {
      console.error("[ServerPaper] 관리 틱 오류:", (err as Error).message);
    }
  } finally {
    tickInFlight = false;
  }
}
