/**
 * Live Approvals — LIVE 모드 승인/거절 결정 영속 저장
 *
 * 오퍼레이터가 LIVE 모드에서 AI 제안을 승인/거절한 결정을 DB에 저장합니다.
 * 브라우저를 새로고침해도 이력이 유지됩니다.
 *
 * 보안 원칙:
 *   - decision_json은 AiEngineDecision 전체를 직렬화한 것 (지갑 정보 없음)
 *   - 실제 주문 실행 여부와 무관하게 오퍼레이터 결정을 감사 기록으로 보존
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const liveApprovalsTable = pgTable("live_approvals", {
  /** UUID — 클라이언트에서 생성하여 낙관적 업데이트와 동기화 */
  id:              text("id").primaryKey(),
  /** 전체 AiEngineDecision JSON (full-fidelity 재현용) */
  decisionJson:    text("decision_json").notNull(),
  /** PENDING | APPROVED | REJECTED | EXPIRED */
  status:          text("status").notNull().default("PENDING"),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt:       timestamp("expires_at", { withTimezone: true }).notNull(),
  approvedAt:      timestamp("approved_at", { withTimezone: true }),
  rejectedAt:      timestamp("rejected_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
});

export type DbLiveApproval = typeof liveApprovalsTable.$inferSelect;
export type InsertLiveApproval = typeof liveApprovalsTable.$inferInsert;
