/**
 * Persistent storage routes for paper-trading data.
 * Stores trade history and strategy config in PostgreSQL so data
 * survives browser/app storage clears. No auth — single-user paper trading.
 */

import { Router } from "express";
import { db, tradesTable, strategyConfigTable } from "@workspace/db";
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
 */
router.post("/data/trades/batch", async (req, res) => {
  try {
    const rows = req.body as Array<{
      id: string; symbol: string; side: string; action: string;
      size: number; price: number; pnl: number; strategy: string;
      timestamp: string; closeTime: number;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) { res.json({ count: 0 }); return; }

    await db
      .insert(tradesTable)
      .values(rows.map(r => ({
        id:        r.id,
        symbol:    r.symbol,
        side:      r.side,
        action:    r.action,
        size:      String(r.size),
        price:     String(r.price),
        pnl:       String(r.pnl ?? 0),
        strategy:  r.strategy ?? "Manual",
        timestamp: new Date(r.timestamp),
        closeTime: r.closeTime ?? 0,
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
 */
router.post("/data/trades", async (req, res) => {
  try {
    const r = req.body;
    await db
      .insert(tradesTable)
      .values({
        id:        r.id,
        symbol:    r.symbol,
        side:      r.side,
        action:    r.action ?? "CLOSE",
        size:      String(r.size),
        price:     String(r.price),
        pnl:       String(r.pnl ?? 0),
        strategy:  r.strategy ?? "Manual",
        timestamp: new Date(r.timestamp),
        closeTime: r.closeTime ?? 0,
      })
      .onConflictDoUpdate({
        target: tradesTable.id,
        set: { pnl: String(r.pnl ?? 0), strategy: r.strategy ?? "Manual" },
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
    const { indicators, limits } = req.body;
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
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save strategy config" });
  }
});

export default router;
