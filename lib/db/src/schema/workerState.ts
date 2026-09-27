import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * worker_state — AI Worker 런타임 상태 영속 저장소 (서버 재시작 복구용).
 * 현재 키:
 *   'equityHwm' → value: equity high-water mark USD (문자열)
 */
export const workerStateTable = pgTable("worker_state", {
  key:       text("key").primaryKey(),
  value:     text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
