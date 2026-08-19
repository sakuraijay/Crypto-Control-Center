/**
 * Persistent storage routes for paper-trading data.
 * Stores trade history and strategy config in PostgreSQL so data
 * survives browser/app storage clears. No auth — single-user paper trading.
 *
 * GMX V2 note: trades are denominated in sizeInUsd (USD value) rather than
 * a contract-qty "size". The legacy `size` column is kept NOT NULL for schema
 * compatibility; it is populated from sizeInUsd when the legacy field is absent.
 */

import { Router } from "express";
import { db, tradesTable, strategyConfigTable, workerStateTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { getPaperCostBinding } from "../lib/paperCostCache";
import { clampDailyTargetUSDT } from "../lib/riskPolicy";
import { accrueHoldingCostsFromEntryRates, computePaperNetPnl } from "../lib/holdingCosts";

const router = Router();

// ── Trades ────────────────────────────────────────────────────────

/** GET /api/data/trades — return all stored trades, newest first */
router.get("/data/trades", async (_req, res) => {
  try {
    const trades = await db
      .select()
      .from(tradesTable)
      .orderBy(tradesTable.timestamp);
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

/**
 * POST /api/data/trades/batch — upsert an array of trades.
 * Used for the initial bulk sync when the client loads.
 * Accepts both legacy (size) and GMX-native (sizeInUsd, collateralToken,
 * gmxMarketAddress) fields; size is derived from sizeInUsd when absent.
 */
router.post("/data/trades/batch", async (req, res) => {
  try {
    const rows = req.body as Array<{
      id: string; symbol: string; side: string; action: string;
      // GMX-native (preferred)
      sizeInUsd?: number | string;
      collateralToken?: string;
      gmxMarketAddress?: string;
      // Risk fields — persisted so the AI Worker can do accurate risk calculations
      leverage?: number | string;
      collateralUsd?: number | string;
      // Legacy fallback
      size?: number | string;
      price: number | string; pnl?: number | string; strategy?: string;
      timestamp: string; closeTime?: number;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) return res.json({ count: 0 });

    // ── Task #111 — 서버 권위 격리 (batch도 단건 POST와 동일한 fail-closed 가드) ──
    try {
      for (const r of rows) {
        const existing = await db.select().from(tradesTable)
          .where(eq(tradesTable.id, String(r.id ?? ""))).limit(1);
        if (existing[0]?.managedBy === "SERVER") {
          return res.status(409).json({
            ok: false, code: "SERVER_MANAGED_ROW",
            error: "서버 Worker가 관리하는 거래 행 포함 — batch 저장 거부",
          });
        }
        const actionStr = String(r.action ?? "CLOSE");
        if (actionStr === "CLOSE" || actionStr === "CLOSE_ALL") {
          const openServer = await db.select().from(tradesTable)
            .where(and(
              eq(tradesTable.symbol, String(r.symbol ?? "")),
              eq(tradesTable.action, "OPEN"),
              eq(tradesTable.closeTime, 0),
              eq(tradesTable.managedBy, "SERVER"),
            )).limit(1);
          if (openServer.length > 0) {
            return res.status(409).json({
              ok: false, code: "SERVER_MANAGED_POSITION",
              error: "서버 관리 미청산 포지션에 대한 클라이언트 CLOSE 포함 — batch 저장 거부",
            });
          }
        }
      }
    } catch {
      return res.status(503).json({
        ok: false, code: "SERVER_GUARD_UNKNOWN",
        error: "서버 관리 상태 확인 실패 — 안전을 위해 batch 저장을 거부합니다 (재시도 가능)",
      });
    }

    await db
      .insert(tradesTable)
      .values(rows.map(r => ({
        id:               r.id,
        symbol:           r.symbol,
        side:             r.side,
        action:           r.action,
        // size (NOT NULL legacy): derive from sizeInUsd when size is absent
        size:             String(r.sizeInUsd ?? r.size ?? 0),
        price:            String(r.price),
        pnl:              String(r.pnl ?? 0),
        strategy:         r.strategy ?? "Manual",
        timestamp:        new Date(r.timestamp),
        closeTime:        r.closeTime ?? 0,
        // ── GMX V2 fields ─────────────────────────────────────────
        sizeInUsd:        r.sizeInUsd != null ? String(r.sizeInUsd) : null,
        collateralToken:  r.collateralToken ?? "USDC",
        gmxMarketAddress: r.gmxMarketAddress ?? null,
        // ── Risk fields ────────────────────────────────────────────
        leverage:         r.leverage != null ? String(r.leverage) : null,
        collateralUsd:    r.collateralUsd != null ? String(r.collateralUsd) : null,
        // 6H-2A §2·§3: zero-fee 정의 폐기. bulk sync 행은 비용 결속 데이터가 없어
        // cost 필드 null = 비용 불명 → 해당 행의 "이익"은 목표 산정에 미반영.
        settlementStatus: "PAPER_ESTIMATED",
      })))
      .onConflictDoNothing();

    return res.json({ count: rows.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to batch-insert trades" });
  }
});

/**
 * POST /api/data/trades — upsert a single trade.
 * Called when a position is opened or closed.
 * Accepts both legacy (size) and GMX-native (sizeInUsd, collateralToken,
 * gmxMarketAddress) fields; size is derived from sizeInUsd when absent.
 */
router.post("/data/trades", async (req, res) => {
  try {
    const r = req.body;

    // ── Task #111 — 서버 권위 격리: 클라이언트 POST가 서버 관리 상태를 덮어쓸 수 없다 ──
    // 1) 동일 id의 서버 관리 행 upsert 거부
    try {
      const existing = await db.select().from(tradesTable)
        .where(eq(tradesTable.id, String(r.id ?? ""))).limit(1);
      if (existing[0]?.managedBy === "SERVER") {
        return res.status(409).json({
          ok: false, code: "SERVER_MANAGED_ROW",
          error: "서버 Worker가 관리하는 거래 행 — 클라이언트 수정 불가",
        });
      }
      // 2) 서버 관리 미청산 포지션에 대한 클라이언트 CLOSE 거부 (중복 청산 차단)
      const actionStr = String(r.action ?? "CLOSE");
      if (actionStr === "CLOSE" || actionStr === "CLOSE_ALL") {
        const openServer = await db.select().from(tradesTable)
          .where(and(
            eq(tradesTable.symbol, String(r.symbol ?? "")),
            eq(tradesTable.action, "OPEN"),
            eq(tradesTable.closeTime, 0),
            eq(tradesTable.managedBy, "SERVER"),
          )).limit(1);
        if (openServer.length > 0) {
          return res.status(409).json({
            ok: false, code: "SERVER_MANAGED_POSITION",
            error: "해당 심볼의 미청산 포지션은 서버 Worker가 관리 — 서버가 SL/TP/CASH 규칙으로 청산합니다",
          });
        }
      }
    } catch (guardErr) {
      // 격리 판정 실패 = 불확실 → fail-closed (서버 권위 보호 우선)
      return res.status(503).json({
        ok: false, code: "SERVER_GUARD_UNKNOWN",
        error: "서버 관리 상태 확인 실패 — 안전을 위해 저장을 거부합니다 (재시도 가능)",
      });
    }
    const sizeVal        = String(r.sizeInUsd ?? r.size ?? 0);
    const sizeInUsdVal   = r.sizeInUsd != null ? String(r.sizeInUsd) : null;
    const collateral     = r.collateralToken ?? "USDC";
    const marketAddress  = r.gmxMarketAddress ?? null;
    // Risk fields — null-safe; only OPEN trades carry these
    const leverageVal    = r.leverage != null ? String(r.leverage) : null;
    const collateralUsdV = r.collateralUsd != null ? String(r.collateralUsd) : null;
    const testModeVal    = r.testMode === true;           // LIVE TEST MODE flag
    const actionVal      = String(r.action ?? "CLOSE");

    // ── 6H-2A §3·§4 — PAPER 비용 결속 (test_mode 거래는 실제 정산 경로 사용) ──
    // OPEN: 서버의 신선한 PAPER_GMX_ESTIMATE 스냅샷에서 추정 진입/청산 비용+rate 결속.
    //       스냅샷 부재 → cost 필드 null = 비용 불명 (해당 거래 이익은 목표 미반영).
    // CLOSE: 대응 OPEN 행의 비용 결속 + 실제 보유시간으로 추정 순 PnL(ESTIMATED) 계산.
    let costFields: {
      costSource: string | null; estEntryCostUsd: string | null; estExitCostUsd: string | null;
      estHoldingCostUsd: string | null; fundingRatePerHour: string | null;
      borrowingRatePerHour: string | null; costFetchedAt: Date | null;
      netPnlEstimatedUsd: string | null;
    } = {
      costSource: null, estEntryCostUsd: null, estExitCostUsd: null, estHoldingCostUsd: null,
      fundingRatePerHour: null, borrowingRatePerHour: null, costFetchedAt: null, netPnlEstimatedUsd: null,
    };
    if (!testModeVal && actionVal === "OPEN") {
      const b = getPaperCostBinding(String(r.symbol ?? ""));
      if (b) {
        costFields = {
          costSource: b.costSource,
          estEntryCostUsd: String(b.estEntryCostUsd),
          estExitCostUsd: String(b.estExitCostUsd),
          estHoldingCostUsd: null,
          fundingRatePerHour: b.fundingRatePerHourFraction != null ? String(b.fundingRatePerHourFraction) : null,
          borrowingRatePerHour: b.borrowingRatePerHourFraction != null ? String(b.borrowingRatePerHourFraction) : null,
          costFetchedAt: new Date(b.costFetchedAt),
          netPnlEstimatedUsd: null,
        };
      }
    } else if (!testModeVal && (actionVal === "CLOSE" || actionVal === "CLOSE_ALL")) {
      try {
        // 대응 OPEN 행 — 동일 심볼의 가장 최근 OPEN (정책상 동시 포지션 1개)
        const openRows = await db.select().from(tradesTable)
          .where(and(eq(tradesTable.symbol, String(r.symbol ?? "")), eq(tradesTable.action, "OPEN")))
          .orderBy(desc(tradesTable.timestamp)).limit(1);
        const openRow = openRows[0];
        if (openRow?.costSource === "PAPER_GMX_ESTIMATE"
          && openRow.estEntryCostUsd != null && openRow.estExitCostUsd != null) {
          const entryCost = parseFloat(openRow.estEntryCostUsd);
          const exitCost  = parseFloat(openRow.estExitCostUsd);
          const notional  = parseFloat(openRow.sizeInUsd ?? openRow.size ?? "0") || 0;
          const openedAt  = new Date(openRow.timestamp as unknown as string | Date).getTime();
          const closedAt  = typeof r.closeTime === "number" && r.closeTime > 0
            ? r.closeTime : Date.now();
          const holding = accrueHoldingCostsFromEntryRates({
            notionalUsd: notional, openedAtMs: openedAt, closedAtMs: closedAt,
            fundingRatePerHourFraction: openRow.fundingRatePerHour != null ? parseFloat(openRow.fundingRatePerHour) : null,
            borrowingRatePerHourFraction: openRow.borrowingRatePerHour != null ? parseFloat(openRow.borrowingRatePerHour) : null,
          });
          if (holding.ok) {
            const net = computePaperNetPnl({
              simulatedGrossPnlUsd: parseFloat(String(r.pnl ?? 0)) || 0,
              estimatedEntryCostsUsd: entryCost,
              estimatedExitCostsUsd: exitCost,
              elapsedHoldingFundingUsd: holding.fundingUsd,
              elapsedHoldingBorrowingUsd: holding.borrowingUsd,
            });
            if (net.ok) {
              costFields = {
                costSource: "PAPER_GMX_ESTIMATE",
                estEntryCostUsd: String(entryCost), estExitCostUsd: String(exitCost),
                estHoldingCostUsd: String(holding.totalUsd),
                fundingRatePerHour: openRow.fundingRatePerHour,
                borrowingRatePerHour: openRow.borrowingRatePerHour,
                costFetchedAt: openRow.costFetchedAt as unknown as Date | null,
                netPnlEstimatedUsd: String(net.netPnlUsd),
              };
            }
          }
          // holding/net 실패 → 비용 불명 유지 (0 대체 금지 — 이익 목표 미반영)
        }
      } catch (err) {
        // 비용 결속 실패는 거래 저장 자체를 막지 않음 — 비용 불명으로 보수적 처리
        console.warn("[data] PAPER 비용 결속 실패 — 비용 불명 저장:", (err as Error).message);
      }
    }

    await db
      .insert(tradesTable)
      .values({
        id:               r.id,
        symbol:           r.symbol,
        side:             r.side,
        action:           r.action ?? "CLOSE",
        // size (NOT NULL legacy): derive from sizeInUsd when size is absent
        size:             sizeVal,
        price:            String(r.price),
        pnl:              String(r.pnl ?? 0),
        strategy:         r.strategy ?? "Manual",
        timestamp:        new Date(r.timestamp),
        closeTime:        r.closeTime ?? 0,
        // ── GMX V2 fields ─────────────────────────────────────────
        sizeInUsd:        sizeInUsdVal,
        collateralToken:  collateral,
        gmxMarketAddress: marketAddress,
        // ── Risk fields ────────────────────────────────────────────
        leverage:         leverageVal,
        collateralUsd:    collateralUsdV,
        testMode:         testModeVal,
        // 6H-2A §2·§3: zero-fee 정의 폐기. PAPER 거래는 PAPER_ESTIMATED —
        // 순 PnL은 net_pnl_estimated_usd(ESTIMATED)로만 이익 적격.
        // LIVE TEST(test_mode=true)는 UNSETTLED로 시작 — 온체인 증거 정산
        // (recordTradeSettlement) 전 이익은 목표 산정에 반영되지 않는다.
        settlementStatus: testModeVal ? "UNSETTLED" : "PAPER_ESTIMATED",
        ...costFields,
      })
      .onConflictDoUpdate({
        target: tradesTable.id,
        set: {
          pnl:              String(r.pnl ?? 0),
          strategy:         r.strategy ?? "Manual",
          sizeInUsd:        sizeInUsdVal,
          collateralToken:  collateral,
          gmxMarketAddress: marketAddress,
          // leverage/collateralUsd are set at OPEN and should not change on CLOSE;
          // but we keep them in the update set so a re-POSTed OPEN can correct them.
          leverage:         leverageVal,
          collateralUsd:    collateralUsdV,
        },
      });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save trade" });
  }
});

/** DELETE /api/data/trades — clear all trades (emergency reset) */
router.delete("/data/trades", async (_req, res) => {
  try {
    // Task #111 — 서버 관리 행이 하나라도 있으면 전체 삭제 거부 (idempotency 증거 보호).
    // 판정 실패도 fail-closed.
    try {
      const serverRows = await db.select().from(tradesTable)
        .where(eq(tradesTable.managedBy, "SERVER")).limit(1);
      if (serverRows.length > 0) {
        return res.status(409).json({
          ok: false, code: "SERVER_MANAGED_ROW",
          error: "서버 Worker 관리 거래가 존재 — 전체 삭제 불가 (서버 권위 상태 보호)",
        });
      }
    } catch {
      return res.status(503).json({
        ok: false, code: "SERVER_GUARD_UNKNOWN",
        error: "서버 관리 상태 확인 실패 — 안전을 위해 삭제를 거부합니다 (재시도 가능)",
      });
    }
    await db.delete(tradesTable);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to clear trades" });
  }
});

// ── Strategy Config ───────────────────────────────────────────────

/** GET /api/data/strategy — return the saved strategy config */
router.get("/data/strategy", async (_req, res) => {
  try {
    const rows = await db.select().from(strategyConfigTable).limit(1);
    const row = rows[0] ?? null;
    // 읽기 경로에서도 legacy dailyTargetUSDT(예: 구형 $500)를 정책 상한으로
    // 클램프해 반환한다 — DB 실데이터는 변경하지 않는다 (destructive update 금지).
    if (row && row.limits && typeof row.limits === 'object') {
      const lim = row.limits as Record<string, unknown>;
      if ('dailyTargetUSDT' in lim) {
        res.json({ ...row, limits: { ...lim, dailyTargetUSDT: clampDailyTargetUSDT(lim.dailyTargetUSDT) } });
        return;
      }
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch strategy config" });
  }
});

/** PUT /api/data/strategy — save (upsert) strategy config */
router.put("/data/strategy", async (req, res) => {
  try {
    const { indicators } = req.body;
    // Clamp risk limits (maxDrawdownPercent, dailyLossLimitUSDT, weeklyLossLimitUSDT)
    // then LIVE TEST MODE hardcaps. Both are authoritative server-side.
    const limits = clampLiveTestLimits(clampRiskLimits(req.body.limits));

    // Always upsert into row id=1
    const existing = await db.select({ id: strategyConfigTable.id }).from(strategyConfigTable).limit(1);
    if (existing.length > 0) {
      await db
        .update(strategyConfigTable)
        .set({ indicators, limits, updatedAt: new Date() })
        .where(eq(strategyConfigTable.id, existing[0].id));
    } else {
      await db.insert(strategyConfigTable).values({ indicators, limits, updatedAt: new Date() });
    }
    // Record limits change history (fire-and-forget — never blocks the response)
    void recordLimitsChange(limits);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save strategy config" });
  }
});

/**
 * safeNum — parse any value to a finite number.
 * Returns the parsed value if finite, undefined otherwise.
 * Handles string inputs (e.g. "100"), booleans, null, undefined.
 */
function safeNum(val: unknown): number | undefined {
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * clampRiskLimits — server-side enforcement of core risk limit bounds.
 * Applied before clampLiveTestLimits on every strategy write.
 * Fields handled: maxDrawdownPercent, dailyLossLimitUSDT, weeklyLossLimitUSDT.
 * Missing / null values are left undefined so the worker falls back to its
 * built-in defaults (never silently overwritten to 0).
 */
function clampRiskLimits(limits: unknown): unknown {
  if (!limits || typeof limits !== 'object') return limits;
  const lim     = limits as Record<string, unknown>;
  const clamped: Record<string, unknown> = { ...lim };

  // maxDrawdownPercent: 1% ≤ x ≤ 50% — above 50% is unsafe, below 1% blocks all trades
  if ('maxDrawdownPercent' in clamped) {
    const v = safeNum(clamped.maxDrawdownPercent);
    clamped.maxDrawdownPercent = v !== undefined ? Math.min(50, Math.max(1, v)) : undefined;
  }

  // ── 6H-1 $1,000 최종 정책 하드캡 ────────────────────────────────────────
  // UI에서 어떤 값을 보내도 서버가 정책 상한으로 강제 클램프한다.

  // dailyLossLimitUSDT: $10 ≤ x ≤ $30 (risk capital $1,000 × 3%)
  if ('dailyLossLimitUSDT' in clamped) {
    const v = safeNum(clamped.dailyLossLimitUSDT);
    clamped.dailyLossLimitUSDT = v !== undefined ? Math.min(30, Math.max(10, v)) : undefined;
  }

  // weeklyLossLimitUSDT: $10 ≤ x ≤ $80 (risk capital $1,000 × 8%)
  if ('weeklyLossLimitUSDT' in clamped) {
    const v = safeNum(clamped.weeklyLossLimitUSDT);
    clamped.weeklyLossLimitUSDT = v !== undefined ? Math.min(80, Math.max(10, v)) : undefined;
  }

  // maxLeverage: 1x ≤ x ≤ 3x — 조건부 5x는 비활성 (conditional5xEnabled=false)
  if ('maxLeverage' in clamped) {
    const v = safeNum(clamped.maxLeverage);
    clamped.maxLeverage = v !== undefined ? Math.min(3, Math.max(1, v)) : undefined;
  }

  // tradingCapital: $10 ≤ x ≤ $1,000 — 초과 자본은 위험 산정에서 제외 (복리 금지)
  if ('tradingCapital' in clamped) {
    const v = safeNum(clamped.tradingCapital);
    clamped.tradingCapital = v !== undefined ? Math.min(1_000, Math.max(10, v)) : undefined;
  }

  // dailyTargetUSDT (soft KPI): $0 ≤ x ≤ 정책 절대 상한 $100 (+10% @ $1,000)
  // legacy $500 등 정책 초과값은 저장 자체를 차단한다 (표시 원본은 riskDerivedTargets).
  if ('dailyTargetUSDT' in clamped) {
    clamped.dailyTargetUSDT = clampDailyTargetUSDT(clamped.dailyTargetUSDT);
  }

  // maxSimultaneousPositions: 정확히 1로 강제
  if ('maxSimultaneousPositions' in clamped) {
    const v = safeNum(clamped.maxSimultaneousPositions);
    clamped.maxSimultaneousPositions = v !== undefined ? 1 : undefined;
  }

  return clamped;
}

/** CHANGELOG_KEY — worker_state key for limits change history (last 10 saves) */
const CHANGELOG_KEY = 'limitsChangelog';

interface LimitsChangeEntry {
  ts: string;
  snapshot: Record<string, unknown>;
}

/** Fire-and-forget: append a limits change entry to worker_state */
async function recordLimitsChange(limits: unknown): Promise<void> {
  try {
    if (!limits || typeof limits !== 'object') return;
    const lim = limits as Record<string, unknown>;
    // Store only the sentinel fields for the log (never trading capital or secrets)
    const snapshot: Record<string, unknown> = {};
    const tracked = ['maxDrawdownPercent','dailyLossLimitUSDT','weeklyLossLimitUSDT',
                     'testBudgetUsd','testMaxLossUsd','testMaxLeverage','liveTestMode',
                     'cooldownMinutes','maxTradesPerHour','maxConsecutiveLosses'];
    for (const k of tracked) if (k in lim) snapshot[k] = lim[k];

    const entry: LimitsChangeEntry = { ts: new Date().toISOString(), snapshot };
    const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, CHANGELOG_KEY));
    const existing: LimitsChangeEntry[] = rows[0] ? JSON.parse(rows[0].value) : [];
    const updated = [entry, ...existing].slice(0, 10);
    const now = new Date();
    if (rows.length > 0) {
      await db.update(workerStateTable)
        .set({ value: JSON.stringify(updated), updatedAt: now })
        .where(eq(workerStateTable.key, CHANGELOG_KEY));
    } else {
      await db.insert(workerStateTable).values({ key: CHANGELOG_KEY, value: JSON.stringify(updated), updatedAt: now });
    }
  } catch { /* fire-and-forget — never block the main response */ }
}

/**
 * clampLiveTestLimits — server-side enforcement of LIVE TEST MODE hardcap bounds.
 * Called on every strategy write so the DB always reflects safe values regardless
 * of what the browser UI submits (including string-typed or out-of-range values).
 * Returns the merged+clamped limits object.
 */
function clampLiveTestLimits(limits: unknown): unknown {
  if (!limits || typeof limits !== 'object') return limits;
  const lim = limits as Record<string, unknown>;
  const clamped: Record<string, unknown> = { ...lim };

  // liveTestMode: must be boolean (reject non-boolean including "true"/"false" strings)
  if ('liveTestMode' in clamped) {
    clamped.liveTestMode = clamped.liveTestMode === true;
  }

  // testBudgetUsd: finite numeric, $10 ≤ x ≤ $500. Non-numeric → default $100.
  if ('testBudgetUsd' in clamped) {
    const v = safeNum(clamped.testBudgetUsd);
    clamped.testBudgetUsd = v !== undefined ? Math.min(500, Math.max(10, v)) : 100;
  }

  // testMaxLeverage: finite numeric, 1× ≤ x ≤ 2× (server absolute max: 2×).
  // Non-numeric or out-of-range → default 2× (conservative max).
  if ('testMaxLeverage' in clamped) {
    const v = safeNum(clamped.testMaxLeverage);
    clamped.testMaxLeverage = v !== undefined ? Math.min(2, Math.max(1, v)) : 2;
  }

  // testMaxLossUsd: finite numeric, $1 ≤ x ≤ min(50% of budget, $250).
  // Non-numeric → default min($50, 50% of budget).
  if ('testMaxLossUsd' in clamped) {
    const v = safeNum(clamped.testMaxLossUsd);
    const budget = typeof clamped.testBudgetUsd === 'number' ? clamped.testBudgetUsd : 100;
    const upperBound = Math.min(250, budget * 0.5);
    clamped.testMaxLossUsd = v !== undefined ? Math.min(upperBound, Math.max(1, v)) : Math.min(50, upperBound);
  }

  return clamped;
}

export default router;
