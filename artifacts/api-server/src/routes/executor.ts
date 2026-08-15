/**
 * Internal Executor routes — Replit-hosted GMX V2 execution
 *
 * GET  /executor/status   — readiness & health (no secrets returned)
 * POST /executor/execute  — submit an operator-approved AI decision for execution
 *
 * These routes complement the existing /vps/* routes.
 * /vps/* remains for the optional external-VPS mode.
 * /executor/* is the default internal execution path for Reserved VM deployments.
 */

import { Router } from "express";
import { getExecutorStatus, executeOrder } from "../workers/internalExecutor";
import type { ExecuteOrderParams } from "../workers/internalExecutor";

const router = Router();

// ── GET /executor/status ──────────────────────────────────────────────────────
// Returns executor readiness without exposing any credential values.
router.get("/executor/status", (_req, res) => {
  try {
    const status = getExecutorStatus();
    return res.json(status);
  } catch {
    return res.status(500).json({ ok: false, error: "Failed to read executor status" });
  }
});

// ── POST /executor/execute ────────────────────────────────────────────────────
// Submits an operator-approved AI decision to the internal GMX executor.
// The operator approval gate is enforced on the client (web/mobile AiEngineContext).
// Credentials are read from server env vars only — never from the request body.
router.post("/executor/execute", async (req, res) => {
  const body = req.body as Record<string, unknown>;

  if (!body.symbol || !body.executionType) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: symbol, executionType",
    });
  }

  const params: ExecuteOrderParams = {
    decisionId:      String(body.decisionId      ?? ""),
    operatingState:  String(body.operatingState   ?? ""),
    symbol:          body.symbol ? String(body.symbol) : null,
    executionType:   String(body.executionType    ?? ""),
    sizeUsd:         body.sizeUsd  != null ? Number(body.sizeUsd)  : null,
    leverage:        body.leverage != null ? Number(body.leverage) : null,
    tpPrice:         body.tpPrice  != null ? Number(body.tpPrice)  : null,
    slPrice:         body.slPrice  != null ? Number(body.slPrice)  : null,
    trailingStopPct: body.trailingStopPct != null ? Number(body.trailingStopPct) : null,
    cycleNumber:     body.cycleNumber != null ? Number(body.cycleNumber) : undefined,
  };

  try {
    const result = await executeOrder(params);
    if (!result.ok) {
      return res.status(502).json(result);
    }
    return res.json(result);
  } catch (e: unknown) {
    const msg = (e as Error).message ?? "Internal executor error";
    return res.status(500).json({ ok: false, error: msg, code: "EXECUTOR_ERROR" });
  }
});

export default router;
