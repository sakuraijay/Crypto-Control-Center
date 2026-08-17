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
import { eq } from "drizzle-orm";

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
    if (!Array.isArray(rows) || rows.length === 0) { res.json({ count: 0 }); return; }

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
      })))
      .onConflictDoNothing();

    res.json({ count: rows.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to batch-insert trades" });
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
    const sizeVal        = String(r.sizeInUsd ?? r.size ?? 0);
    const sizeInUsdVal   = r.sizeInUsd != null ? String(r.sizeInUsd) : null;
    const collateral     = r.collateralToken ?? "USDC";
    const marketAddress  = r.gmxMarketAddress ?? null;
    // Risk fields — null-safe; only OPEN trades carry these
    const leverageVal    = r.leverage != null ? String(r.leverage) : null;
    const collateralUsdV = r.collateralUsd != null ? String(r.collateralUsd) : null;
    const testModeVal    = r.testMode === true;           // LIVE TEST MODE flag

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
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save trade" });
  }
});

/** DELETE /api/data/trades — clear all trades (emergency reset) */
router.delete("/data/trades", async (_req, res) => {
  try {
    await db.delete(tradesTable);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear trades" });
  }
});

// ── Strategy Config ───────────────────────────────────────────────

/** GET /api/data/strategy — return the saved strategy config */
router.get("/data/strategy", async (_req, res) => {
  try {
    const rows = await db.select().from(strategyConfigTable).limit(1);
    res.json(rows[0] ?? null);
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
