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
import { listRecentIntents } from "../lib/executionIntents";
import { deriveRelayEnvFlags } from "../lib/relayActivationStatus";
import { validateEnvAgainstManifest } from "../lib/gmxDeploymentManifest";
import { getActiveRevokeSession } from "../lib/revokeSession";
import { getReleaseIdentity } from "../lib/releaseIdentity";
import { deriveOperationalDiagnostics } from "../lib/operationalDiagnostics";

const router = Router();

// ── GET /executor/intents ─────────────────────────────────────────────────────
// Read-only execution intent 상태 조회 — 수동 상태 변경 엔드포인트는 의도적으로
// 존재하지 않는다 (차단 해소는 온체인 증거로만 가능, fail-closed).
router.get("/executor/intents", async (_req, res) => {
  try {
    const intents = await listRecentIntents(50);
    if (intents === null) {
      return res.json({ ok: false, error: "intent 목록 조회 실패" });
    }
    return res.json({ ok: true, intents });
  } catch {
    return res.json({ ok: false, error: "intent 목록 조회 실패" });
  }
});

// ── Dry-run parameter validator ───────────────────────────────────────────────
// Returns an error string on failure, null on success.
// Checks type membership, numeric finiteness, and value ranges so the badge
// reflects a meaningful validation — not just "symbol and executionType exist".
const VALID_EXECUTION_TYPES = new Set([
  "spot_swap", "perp_long_open", "perp_short_open", "perp_close",
  "hedge_open", "scale_in", "scale_out", "hold", "cash_exit",
]);

export function validateDryRunParams(params: ExecuteOrderParams): string | null {
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
router.get("/executor/status", async (_req, res) => {
  try {
    const status = getExecutorStatus();
    // 4단계: revoke 진행 중 신규 주문 전면 차단용 boolean (PIN 불필요, 상세 미노출)
    let activeRevoke = false;
    try {
      activeRevoke = (await getActiveRevokeSession()) !== null;
    } catch { /* 조회 실패 시 false — 주문 경로는 서버측 게이트가 별도 차단 */ }
    // 6E-5 §6 — relay 설정 인식 파생 상태 (boolean/enum만, Secret 원문 없음).
    // manifest 검증 실패도 status 응답 자체는 200 유지 (표시용 파생값이므로 fail-open 아님:
    // false = 미충족으로 표시되며 실행 게이트는 별도 서버측 검증을 그대로 거친다.)
    let relayFlags: ReturnType<typeof deriveRelayEnvFlags> | null = null;
    try {
      relayFlags = deriveRelayEnvFlags(process.env, validateEnvAgainstManifest(process.env).ok);
    } catch { /* 파생 실패 시 null — 클라이언트는 미확인으로 표시 */ }
    const operationalDiagnostics = deriveOperationalDiagnostics(process.env, {
      engineMode: status.engineMode,
      liveExecutionLocked: status.liveExecutionLocked,
      relayFlags,
    }, getReleaseIdentity());
    return res.json({ ...status, activeRevoke, relayFlags, operationalDiagnostics });
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

  // 4단계 §8: revoke 진행 중 신규 주문 전면 차단 (서버측 — UI 차단과 이중).
  // 조회 실패도 fail-closed — 불확실하면 차단한다.
  try {
    const revoke = await getActiveRevokeSession();
    if (revoke) {
      return res.status(409).json({
        ok: false,
        code: "REVOKE_IN_PROGRESS",
        error: "Subaccount revoke가 진행 중입니다 — 완료 또는 취소 전까지 신규 주문이 차단됩니다.",
      });
    }
  } catch {
    return res.status(503).json({
      ok: false,
      code: "REVOKE_STATE_UNKNOWN",
      error: "Revoke 세션 상태 확인 실패 — 안전을 위해 주문을 차단합니다 (fail-closed).",
    });
  }

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
