/**
 * Internal Executor routes — Replit-hosted GMX V2 execution
 *
 * GET  /executor/status   — readiness & health (no secrets returned)
 * POST /executor/execute  — submit an operator-approved AI decision for execution
 *
 * /executor/* is the Replit-hosted execution path for Reserved VM deployments.
 * Actual GMX order signing requires a configured One-Click subaccount (task #32).
 */

import { Router } from "express";
import { getExecutorStatus, executeOrder } from "../workers/internalExecutor";
import type { ExecuteOrderParams } from "../workers/internalExecutor";

const router = Router();

// ── Dry-run parameter validator ───────────────────────────────────────────────
// Returns an error string on failure, null on success.
// Checks type membership, numeric finiteness, and value ranges so the badge
// reflects a meaningful validation — not just "symbol and executionType exist".
const VALID_EXECUTION_TYPES = new Set([
  "spot_swap", "perp_long_open", "perp_short_open", "perp_close",
  "hedge_open", "scale_in", "scale_out", "hold", "cash_exit",
]);

function validateDryRunParams(params: ExecuteOrderParams): string | null {
  if (!params.symbol || !params.symbol.trim()) {
    return "심볼이 비어 있습니다";
  }
  if (!VALID_EXECUTION_TYPES.has(params.executionType)) {
    return `지원하지 않는 executionType: ${params.executionType}`;
  }
  // Actionable execution types require a positive sizeUsd
  const needsSize = !["hold", "cash_exit"].includes(params.executionType);
  if (needsSize) {
    if (params.sizeUsd == null || !Number.isFinite(params.sizeUsd) || params.sizeUsd <= 0) {
      return `sizeUsd가 유효하지 않습니다 (${params.sizeUsd}) — 양수가 필요합니다`;
    }
  }
  if (params.leverage != null) {
    if (!Number.isFinite(params.leverage) || params.leverage < 1 || params.leverage > 100) {
      return `leverage가 유효하지 않습니다 (${params.leverage}) — 1~100 범위여야 합니다`;
    }
  }
  if (params.tpPrice != null) {
    if (!Number.isFinite(params.tpPrice) || params.tpPrice <= 0) {
      return `TP 가격이 유효하지 않습니다 (${params.tpPrice}) — 양수가 필요합니다`;
    }
  }
  if (params.slPrice != null) {
    if (!Number.isFinite(params.slPrice) || params.slPrice <= 0) {
      return `SL 가격이 유효하지 않습니다 (${params.slPrice}) — 양수가 필요합니다`;
    }
  }
  if (params.trailingStopPct != null) {
    if (!Number.isFinite(params.trailingStopPct) || params.trailingStopPct <= 0 || params.trailingStopPct > 50) {
      return `trailingStopPct가 유효하지 않습니다 (${params.trailingStopPct}) — 0 초과 50 이하여야 합니다`;
    }
  }
  return null; // all parameters valid
}

// ── GET /executor/status ──────────────────────────────────────────────────────
// Returns executor readiness without exposing any credential values.
// Always returns HTTP 200 so clients can distinguish "server up, read failed"
// from real network errors (404 / connection refused).
router.get("/executor/status", (_req, res) => {
  try {
    const status = getExecutorStatus();
    return res.json(status);
  } catch {
    return res.json({ ok: false, gmxConnected: false, error: "Failed to read executor status" });
  }
});

// ── POST /executor/execute ────────────────────────────────────────────────────
// Submits an operator-approved AI decision to the internal paper executor.
//
// When body.dryRun === true the call is a validation-only dry run:
//   - Parameters are validated and a simulated result is returned.
//   - No order is placed; no signing occurs (executor is always paper/simulated).
//   - The response includes dryRun: true so the client can show the correct badge.
//
// The operator approval gate is enforced on the client (web AiEngineContext).
// Credentials are read from server env vars only — never from the request body.
router.post("/executor/execute", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const isDryRun = body.dryRun === true;

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

  if (isDryRun) {
    // Dry-run: validate order parameters and return a simulated result.
    // No signing, no RPC call — purely a parameter-level sanity check.
    // The executor is always paper-only, but this path is labeled explicitly
    // so audit logs distinguish dry-run checks from regular paper calls.
    const validationError = validateDryRunParams(params);

    console.info(
      `[Executor] 드라이런 검증 — decisionId=${params.decisionId} ` +
      `type=${params.executionType} symbol=${params.symbol ?? "MULTI"} ` +
      `result=${validationError ? `FAIL: ${validationError}` : "OK"}`,
    );

    if (validationError) {
      return res.json({
        ok:        false,
        dryRun:    true,
        simulated: true,
        error:     validationError,
        executedAt: new Date().toISOString(),
      });
    }

    return res.json({
      ok:        true,
      executedAt: new Date().toISOString(),
      txHash:    null,
      simulated: true,
      dryRun:    true,
      note:      "PAPER ONLY — 드라이런 검증 통과. 실제 주문 없음.",
    });
  }

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
