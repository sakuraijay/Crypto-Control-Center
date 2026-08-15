/**
 * Live Approvals routes
 *
 * LIVE 모드에서 오퍼레이터가 승인/거절한 결정을 DB에 영속 저장합니다.
 * 브라우저 새로고침 후에도 이력이 유지됩니다.
 *
 * GET    /api/ai/approvals         — 이력 조회 (최신순, 페이지네이션)
 * POST   /api/ai/approvals         — 신규 PENDING 항목 생성
 * PATCH  /api/ai/approvals/:id     — 상태 업데이트 (APPROVED | REJECTED | EXPIRED)
 * DELETE /api/ai/approvals         — 전체 삭제 (개발/테스트용)
 */

import { Router } from "express";
import { db, liveApprovalsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

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
      return res.status(400).json({ error: "id, decisionJson, expiresAt are required" });
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

    res.status(201).json(inserted ?? { id, status: "PENDING" });
  } catch (err) {
    console.error("[approvals] POST failed:", err);
    res.status(500).json({ error: "Failed to create approval" });
  }
});

// ── PATCH /api/ai/approvals/:id — 상태 업데이트 ──────────────────────────
router.patch("/ai/approvals/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, executionOutcome } = req.body as {
      status: "APPROVED" | "REJECTED" | "EXPIRED";
      rejectionReason?: string;
      /** dry-run 결과: 'succeeded' | 'failed' */
      executionOutcome?: string;
    };

    if (!["APPROVED", "REJECTED", "EXPIRED"].includes(status)) {
      return res.status(400).json({ error: "status must be APPROVED | REJECTED | EXPIRED" });
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

    const [updated] = await db
      .update(liveApprovalsTable)
      .set(updates)
      .where(eq(liveApprovalsTable.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Approval not found" });
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
