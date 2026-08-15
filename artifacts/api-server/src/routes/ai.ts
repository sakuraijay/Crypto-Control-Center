/**
 * AI Decision Log routes
 *
 * The VPS AI POSTs a record here every time it makes a trading decision.
 * Clients (web/mobile) poll GET /api/ai/decisions to display the log.
 *
 * Risk controls have absolute veto authority — if riskResult='VETOED', the
 * decision is logged but no order was placed.
 *
 * POST /api/ai/decisions   — VPS ingests a decision
 * GET  /api/ai/decisions   — client reads the log (paginated)
 * DELETE /api/ai/decisions — owner clears the log
 */

import { Router } from "express";
import { db, aiDecisionsTable } from "@workspace/db";
import { desc, gte, and, eq, sql } from "drizzle-orm";

const router = Router();

// ── GET /api/ai/decisions ─────────────────────────────────────────
router.get("/ai/decisions", async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit)  || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const since     = req.query.since     ? new Date(String(req.query.since))     : null;
    const symbol    = req.query.symbol    ? String(req.query.symbol)    : null;
    const direction = req.query.direction ? String(req.query.direction) : null;

    const conditions: ReturnType<typeof eq>[] = [];
    if (since)     conditions.push(gte(aiDecisionsTable.ts, since) as any);
    if (symbol)    conditions.push(eq(aiDecisionsTable.symbol, symbol));
    if (direction) conditions.push(eq(aiDecisionsTable.direction, direction));

    const decisions = await db
      .select()
      .from(aiDecisionsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(aiDecisionsTable.ts))
      .limit(limit)
      .offset(offset);

    // Today's stats (UTC midnight)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const todayRows = await db
      .select()
      .from(aiDecisionsTable)
      .where(gte(aiDecisionsTable.ts, todayStart));

    const approved  = todayRows.filter(d => d.riskResult === "APPROVED").length;
    const vetoed    = todayRows.filter(d => d.riskResult === "VETOED").length;
    const filled    = todayRows.filter(d => d.executionOutcome === "FILLED").length;
    const confSum   = todayRows.reduce((s, d) => s + (d.confidence ?? 0), 0);

    res.json({
      decisions,
      stats: {
        today:         todayRows.length,
        todayApproved: approved,
        todayVetoed:   vetoed,
        todayFilled:   filled,
        avgConfidence: todayRows.length > 0 ? confSum / todayRows.length : 0,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch AI decisions" });
  }
});

// ── POST /api/ai/decisions — VPS ingests a decision ──────────────
router.post("/ai/decisions", async (req, res) => {
  try {
    const b = req.body;
    const [inserted] = await db
      .insert(aiDecisionsTable)
      .values({
        ts:               b.ts ? new Date(b.ts) : new Date(),
        symbol:           String(b.symbol           ?? "UNKNOWN"),
        direction:        String(b.direction         ?? "NO_TRADE"),
        confidence:       Number(b.confidence        ?? 0),
        rationale:        String(b.rationale         ?? ""),
        strategy:         String(b.strategy          ?? ""),
        entryPrice:       b.entryPrice  != null ? Number(b.entryPrice)  : null,
        exitPrice:        b.exitPrice   != null ? Number(b.exitPrice)   : null,
        size:             b.size        != null ? Number(b.size)        : null,
        riskResult:       String(b.riskResult        ?? "APPROVED"),
        riskNote:         b.riskNote    ? String(b.riskNote)  : null,
        executionOutcome: String(b.executionOutcome  ?? "PENDING"),
        pnl:              b.pnl         != null ? Number(b.pnl)         : null,
        durationMs:       b.durationMs  != null ? Number(b.durationMs)  : null,
        fullJson:         b.fullJson    ? String(b.fullJson)            : null,
      })
      .returning();
    res.status(201).json(inserted);
  } catch {
    res.status(500).json({ error: "Failed to insert AI decision" });
  }
});

// ── DELETE /api/ai/decisions — clear log ─────────────────────────
router.delete("/ai/decisions", async (_req, res) => {
  try {
    await db.delete(aiDecisionsTable);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to clear AI decisions" });
  }
});

export default router;
