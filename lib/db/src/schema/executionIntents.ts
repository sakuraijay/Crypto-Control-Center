import { pgTable, text, integer, numeric, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * execution_intents — LIVE 주문 durable execution intent.
 *
 * writeContract 호출 **전에** 반드시 PREPARED 행이 커밋되어야 하며,
 * 저장 실패 시 온체인 제출에 절대 도달하지 않는다 (fail-closed).
 *
 * 상태 모델:
 *   PREPARED   — 제출 직전 저장됨. 재시작 시 "미제출"로 가정하지 않고 UNRESOLVED로 취급.
 *   SUBMITTED  — writeContract 성공, txHash 기록됨.
 *   CONFIRMED  — 온체인 확인 완료 (추후 확인 로직 또는 운영자 판정).
 *   FAILED     — broadcast 이전에 확실히 실패한 경우만 (자동 시간경과 전환 금지).
 *   UNRESOLVED — broadcast 여부 불명 (네트워크 오류/타임아웃/재시작). 신규 LIVE 주문 차단.
 *
 * id 는 idempotency key — 같은 intent 의 중복 제출을 PK 충돌로 차단한다.
 */
export const executionIntentsTable = pgTable("execution_intents", {
  id:            text("id").primaryKey(),
  decisionId:    text("decision_id").notNull(),
  cycleNumber:   integer("cycle_number").notNull(),
  symbol:        text("symbol").notNull(),
  orderType:     text("order_type").notNull(),           // 'open' | 'close'
  isLong:        boolean("is_long").notNull(),
  sizeUsd:       numeric("size_usd", { precision: 18, scale: 4 }).notNull(),
  collateralUsd: numeric("collateral_usd", { precision: 18, scale: 4 }).notNull(),
  txHash:        text("tx_hash"),
  status:        text("status").notNull(),               // PREPARED | SUBMITTED | CONFIRMED | FAILED | CANCELLED | UNRESOLVED
  error:         text("error"),
  // ── 온체인 판정 근거 (migration 0012) ──────────────────────────────────────
  /** GMX order key (bytes32 hex) — OrderCreated 이벤트 topic1에서 추출 */
  orderKey:          text("order_key"),
  /** OrderCreated가 포함된 블록 번호 (문자열로 저장) */
  orderCreatedBlock: text("order_created_block"),
  /** 트랜잭션 receipt status: 'success' | 'reverted' */
  receiptStatus:     text("receipt_status"),
  /** 최종 판정 근거가 된 트랜잭션 해시 (실행/취소 이벤트의 tx) */
  resolutionTxHash:  text("resolution_tx_hash"),
  /** 최종 판정 근거가 된 블록 번호 (문자열) */
  resolutionBlock:   text("resolution_block"),
  /** 판정 사유 (예: 'OrderExecuted 이벤트 확인', 'receipt reverted') */
  resolutionReason:  text("resolution_reason"),
  /** terminal 판정 시각 */
  resolvedAt:        timestamp("resolved_at", { withTimezone: true }),
  /**
   * OrderCreated receipt에서 실제 일치한 EventEmitter 주소 (migration 0013).
   * GMX upgrade로 emitter 주소가 교체돼도, 이 intent는 저장된 과거 주소로
   * 계속 reconcile할 수 있다 (허용 emitter 집합 = 현재 설정값 ∪ 이 값).
   */
  orderEmitterAddress: text("order_emitter_address"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
