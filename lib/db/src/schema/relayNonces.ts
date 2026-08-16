import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * GMX delegated trading 4단계 — durable userNonce allocation.
 *
 * 온체인 replay 방어는 digest 기반(BaseGelatoRelayRouter.digests[digest] →
 * InvalidUserDigest revert)이고, userNonce는 relayParams hash를 통해 digest
 * 유일성을 만드는 입력값이다. 공식 interface는 epoch초를 쓰지만, 동일 초에
 * OPEN·CLOSE·REVOKE가 겹치면 relayParams 구성에 따라 digest 충돌 여지가
 * 있으므로 이를 폐기하고 DB 기반 단조 증가 allocation으로 대체한다.
 *
 * 규칙:
 *  - (main_account, nonce) unique — 다중 프로세스·동시 요청에서 DB가 최종 방어.
 *  - 재시작 후에도 max(nonce)+1 방식이라 중복 없음.
 *  - 한 번 allocation된 nonce는 제출 여부와 무관하게 재사용하지 않는다
 *    (digest 기반 방어상 미제출 nonce 재사용은 온체인상 안전하지만,
 *     "제출 여부 불명" 상태에서의 재사용 사고를 원천 차단하는 strictly-safe 선택).
 */
export const relayNoncesTable = pgTable("relay_nonces", {
  id:          text("id").primaryKey(),
  mainAccount: text("main_account").notNull(),   // lowercase address
  nonce:       text("nonce").notNull(),          // uint256 십진 문자열
  purpose:     text("purpose").notNull(),        // OPEN | CLOSE | REVOKE
  taskId:      text("task_id"),                  // relay_tasks.id (제출 결합 시)
  allocatedAt: timestamp("allocated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type RelayNonceRow = typeof relayNoncesTable.$inferSelect;
