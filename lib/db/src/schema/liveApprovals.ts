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
import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

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
  rejectionReason:  text("rejection_reason"),
  /** 드라이런 실행 결과 — 'succeeded' | 'failed' | null */
  executionOutcome: text("execution_outcome"),
  /** 재시도 횟수 — 드라이런 실패 후 운영자가 재시도한 횟수 */
  retryCount:      integer("retry_count").notNull().default(0),
  /** 마지막 드라이런 에러 메시지 */
  lastError:       text("last_error"),
  /** 마지막 재시도 시각 */
  lastRetriedAt:   timestamp("last_retried_at", { withTimezone: true }),
  /** True when this approval was queued while LIVE TEST MODE was active */
  testMode:        boolean("test_mode").notNull().default(false),
});

export type DbLiveApproval = typeof liveApprovalsTable.$inferSelect;
export type InsertLiveApproval = typeof liveApprovalsTable.$inferInsert;
