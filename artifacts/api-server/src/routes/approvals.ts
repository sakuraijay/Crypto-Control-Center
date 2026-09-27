/**
 * Live Approvals routes
 *
 * LIVE 모드에서 오퍼레이터가 승인/거절한 결정을 DB에 영속 저장합니다.
 * 브라우저 새로고침 후에도 이력이 유지됩니다.
 *
 * GET    /api/ai/approvals           — 이력 조회 (최신순, 페이지네이션)
 * POST   /api/ai/approvals           — 신규 PENDING 항목 생성
 * POST   /api/ai/approvals/:id/retry — 드라이런 재시도 (실패 후 운영자 요청)
 * PATCH  /api/ai/approvals/:id       — 상태 업데이트 (APPROVED | REJECTED | EXPIRED)
 * DELETE /api/ai/approvals           — 전체 삭제 (개발/테스트용)
 */

import { Router } from "express";
import { db, liveApprovalsTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { validateDryRunParams } from "./executor";
import type { ExecuteOrderParams } from "../workers/internalExecutor";
import { sendPushToOperator } from "./notifications";

const router = Router();

// ── GET /api/ai/approvals ──────────────────────────────────────────────────
router.get("/ai/approvals", async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit)  || 200, 500);
    const offset = Number(req.query.offset) || 0;

    const rows = await db
      .select()
      .from(liveApprovalsTable)
      .orderBy(desc(liveApprovalsTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ approvals: rows });
  } catch (err) {
    console.error("[approvals] GET failed:", err);
    res.status(500).json({ error: "Failed to fetch approvals" });
  }
});

// ── POST /api/ai/approvals — 신규 PENDING 생성 ────────────────────────────
router.post("/ai/approvals", async (req, res) => {
  try {
    const { id, decisionJson, expiresAt } = req.body as {
      id: string;
      decisionJson: string;
      expiresAt: string;
    };

    if (!id || !decisionJson || !expiresAt) {
      return void res.status(400).json({ error: "id, decisionJson, expiresAt are required" });
    }

    const [inserted] = await db
      .insert(liveApprovalsTable)
      .values({
        id,
        decisionJson,
        status:    "PENDING",
        expiresAt: new Date(expiresAt),
      })
      .onConflictDoNothing()   // 낙관적 중복 방지
      .returning();

    // Push notification to operator — fail-closed, non-blocking
    try {
      const d = JSON.parse(decisionJson) as {
        operatingState?: string; primarySymbol?: string; sizeUsd?: number;
      };
      const sym  = d.primarySymbol ?? '';
      const size = d.sizeUsd ? ` · $${d.sizeUsd.toLocaleString()}` : '';
      void sendPushToOperator({
        title:               '⚡ LIVE 승인 필요 — Crypto CTL',
        body:                `${d.operatingState ?? 'Trade'} ${sym}/USD${size} — 대시보드에서 승인 필요`,
        tag:                 `live-approval-${id}`,
        requireInteraction:  true,
        url:                 '/futures-web/',
      });
    } catch { /* never block the response */ }

    res.status(201).json(inserted ?? { id, status: "PENDING" });
  } catch (err) {
    console.error("[approvals] POST failed:", err);
    res.status(500).json({ error: "Failed to create approval" });
  }
});

// ── POST /api/ai/approvals/:id/retry — 드라이런 재시도 ─────────────────────
// 운영자가 실패한 dry-run을 재시도할 때 호출합니다.
// 내부적으로 executeOrder를 재실행하고 retryCount, lastError, lastRetriedAt을 업데이트합니다.
router.post("/ai/approvals/:id/retry", async (req, res) => {
  try {
    const { id } = req.params;

    // 기존 승인 레코드 조회
    const [approval] = await db
      .select()
      .from(liveApprovalsTable)
      .where(eq(liveApprovalsTable.id, id))
      .limit(1);

    if (!approval) {
      return void res.status(404).json({ error: "Approval not found" });
    }
    // Only APPROVED records whose most recent dry-run failed can be retried.
    if (approval.status !== "APPROVED") {
      return void res.status(400).json({ error: "Only APPROVED approvals can be retried" });
    }
    if (approval.executionOutcome !== "failed") {
      return void res.status(400).json({
        error: "Only approvals with a failed dry-run can be retried",
        currentOutcome: approval.executionOutcome,
      });
    }
    // 최대 3회 재시도 제한
    const currentRetryCount = approval.retryCount ?? 0;
    if (currentRetryCount >= 3) {
      return void res.status(400).json({
        error: "최대 재시도 횟수(3회) 초과",
        retryCount: currentRetryCount,
      });
    }

    // decision JSON에서 실행 파라미터 추출
    let decision: {
      id: string;
      operatingState: string;
      primarySymbol?: string | null;
      selectedSymbols?: string[];
      executionType: string;
      sizeUsd?: number | null;
      leverage?: number | null;
      tpPrice?: number | null;
      slPrice?: number | null;
      trailingStopPct?: number | null;
      cycleNumber?: number;
    };
    try {
      decision = JSON.parse(approval.decisionJson) as typeof decision;
    } catch {
      return void res.status(422).json({ error: "decision_json is not valid JSON" });
    }

    const now = new Date();

    // 드라이런 재실행 — 초기 승인과 동일한 validateDryRunParams 경로 사용.
    // executeOrder는 항상 성공을 반환하므로 직접 호출하지 않는다.
    const params: ExecuteOrderParams = {
      decisionId:      decision.id,
      operatingState:  decision.operatingState,
      symbol:          decision.primarySymbol ?? (decision.selectedSymbols?.[0] ?? null),
      executionType:   decision.executionType,
      sizeUsd:         decision.sizeUsd ?? null,
      leverage:        decision.leverage ?? null,
      tpPrice:         decision.tpPrice ?? null,
      slPrice:         decision.slPrice ?? null,
      trailingStopPct: decision.trailingStopPct ?? null,
      cycleNumber:     decision.cycleNumber,
    };

    const validationError = validateDryRunParams(params);
    const outcome: "succeeded" | "failed" = validationError ? "failed" : "succeeded";
    const lastError: string | null = validationError ?? null;

    console.info(
      `[Approvals] 드라이런 재시도 — id=${id} decisionId=${decision.id} ` +
      `type=${params.executionType} symbol=${params.symbol ?? "MULTI"} ` +
      `result=${validationError ? `FAIL: ${validationError}` : "OK"}`,
    );

    // DB 업데이트: retryCount+1, executionOutcome, lastError, lastRetriedAt
    const [updated] = await db
      .update(liveApprovalsTable)
      .set({
        executionOutcome: outcome,
        lastError,
        lastRetriedAt:   now,
        retryCount:      sql`${liveApprovalsTable.retryCount} + 1`,
      })
      .where(eq(liveApprovalsTable.id, id))
      .returning();

    res.json({ ok: outcome === "succeeded", outcome, lastError, updated });
  } catch (err) {
    console.error("[approvals] retry failed:", err);
    res.status(500).json({ error: "Failed to retry approval" });
  }
});

// ── PATCH /api/ai/approvals/:id — 상태 업데이트 ──────────────────────────
router.patch("/ai/approvals/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, executionOutcome, lastError } = req.body as {
      status: "APPROVED" | "REJECTED" | "EXPIRED";
      rejectionReason?: string;
      /** dry-run 결과: 'succeeded' | 'failed' */
      executionOutcome?: string;
      /** 마지막 드라이런 에러 메시지 */
      lastError?: string | null;
    };

    if (!["APPROVED", "REJECTED", "EXPIRED"].includes(status)) {
      return void res.status(400).json({ error: "status must be APPROVED | REJECTED | EXPIRED" });
    }

    const now = new Date();
    const updates: Partial<typeof liveApprovalsTable.$inferInsert> = { status };

    if (status === "APPROVED")  updates.approvedAt  = now;
    if (status === "REJECTED") {
      updates.rejectedAt      = now;
      updates.rejectionReason = rejectionReason ?? null;
    }
    if (status === "EXPIRED")   updates.rejectedAt  = now; // 만료도 rejectedAt 기록
    if (executionOutcome)       updates.executionOutcome = executionOutcome;
    if (lastError !== undefined) updates.lastError = lastError ?? null;

    const [updated] = await db
      .update(liveApprovalsTable)
      .set(updates)
      .where(eq(liveApprovalsTable.id, id))
      .returning();

    if (!updated) return void res.status(404).json({ error: "Approval not found" });
    res.json(updated);
  } catch (err) {
    console.error("[approvals] PATCH failed:", err);
    res.status(500).json({ error: "Failed to update approval" });
  }
});

// ── DELETE /api/ai/approvals — 전체 삭제 (개발용) ────────────────────────
router.delete("/ai/approvals", async (_req, res) => {
  try {
    await db.delete(liveApprovalsTable);
    res.json({ ok: true });
  } catch (err) {
    console.error("[approvals] DELETE failed:", err);
    res.status(500).json({ error: "Failed to clear approvals" });
  }
});

export default router;
