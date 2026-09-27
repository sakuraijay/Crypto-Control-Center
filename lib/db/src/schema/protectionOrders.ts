import { pgTable, text, integer, boolean, numeric, timestamp } from "drizzle-orm/pg-core";

/**
 * protection_orders — 6H-2B §3 durable 보호 주문(stop/emergency close) 모델.
 *
 * 상태 모델 (terminal 역행 금지, 조건부 UPDATE로만 전이):
 *   PLANNED    — OPEN 확정 후 보호 주문 계획 저장됨 (prepare 이전).
 *   PREPARED   — GMX API prepare 응답·결속 검증 통과, digest 확보.
 *   SUBMITTING — 제출 시도 직전 커밋 (재시작 시 UNRESOLVED 취급).
 *   SUBMITTED  — relay 제출 수락 (requestId 확보). 아직 ACTIVE 아님.
 *   ACTIVE     — 온체인 OrderCreated/GMX 공식 증거로 orderKey 확인 후에만.
 *   EXECUTED   — stop 체결 확인 (terminal).
 *   CANCELLED  — 취소 온체인 확인 (terminal).
 *   UNRESOLVED — 상태 불명 (자동 재제출 금지, 운영자/증거 해소 전 신규 OPEN 차단).
 *   FROZEN     — GMX OrderFrozen 관측 (체결 여부 불확실 — 차단).
 *
 * position/purpose당 활성(non-terminal) 보호 주문은 정확히 1개 —
 * 부분 unique index(uq_protection_active)로 DB에서 강제한다.
 */
export const protectionOrdersTable = pgTable("protection_orders", {
  /** protectionId — 결정적 idempotency key (예: prot:<intentId>:INITIAL_STOP) */
  id:                 text("id").primaryKey(),
  /** 이 보호 주문이 지키는 OPEN intent id */
  parentOpenIntentId: text("parent_open_intent_id").notNull(),
  /** GMX position key 참조 (market:isLong:collateral 파생 또는 intent 기반 ref) */
  positionKey:        text("position_key").notNull(),
  purpose:            text("purpose").notNull(), // INITIAL_STOP | PROFIT_FLOOR_STOP | EMERGENCY_CLOSE
  symbol:             text("symbol").notNull(),
  marketAddress:      text("market_address").notNull(),
  isLong:             boolean("is_long").notNull(),
  sizeDeltaUsd:       numeric("size_delta_usd", { precision: 18, scale: 4 }).notNull(),
  triggerPriceUsd:    numeric("trigger_price_usd", { precision: 18, scale: 8 }),
  acceptablePriceUsd: numeric("acceptable_price_usd", { precision: 18, scale: 8 }),
  /** Manila 운영일 키 (UTC 날짜부) */
  dayKey:             text("day_key").notNull(),
  status:             text("status").notNull(),
  /** GMX API requestId (제출 수락 증거) */
  requestId:          text("request_id"),
  /** 온체인 OrderCreated orderKey (ACTIVE 증거) */
  orderKey:           text("order_key"),
  /** 서버 재계산 typed data digest */
  typedDataDigest:    text("typed_data_digest"),
  /** 판정 근거 요약 (sanitized) */
  evidence:           text("evidence"),
  error:              text("error"),
  submitAttempts:     integer("submit_attempts").notNull().default(0),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // ── 6H-2C §3 — 가격 변환에 사용한 decimals 증거 (durable) ──────────────────
  decimalsUsed:        integer("decimals_used"),
  decimalsSource:      text("decimals_source"),          // 'sdk+onchain'
  decimalsTokenAddress: text("decimals_token_address"),
  decimalsVerifiedAt:  timestamp("decimals_verified_at", { withTimezone: true }),
  // ── 6H-2C §4 — 상태별 온체인 증거 (tx/block) ────────────────────────────────
  emitterAddress:      text("emitter_address"),          // 제출 당시 허용 emitter (판정 결속)
  createdTxHash:       text("created_tx_hash"),
  executedTxHash:      text("executed_tx_hash"),
  cancelledTxHash:     text("cancelled_tx_hash"),
  frozenTxHash:        text("frozen_tx_hash"),
  evidenceBlockNumber: text("evidence_block_number"),
  // ── 6H-2C §6 — 제출 시점 action budget 스냅샷 (JSON, 사후 감사용) ──────────
  actionBudgetSnapshot: text("action_budget_snapshot"),
  // ── 6H-2D §2·§3·§4 — autoCancel 인코딩값·의미 결속·receipt 증거 ─────────────
  /** 서명된 typed data의 autoCancel 인코딩값 (게이트 통과 시에만 기록) */
  autoCancelEncoded:   boolean("auto_cancel_encoded"),
  /** 온체인 이벤트 의미 결속(account/market/orderType/isLong 등) 검증 결과 */
  semanticBindingOk:   boolean("semantic_binding_ok"),
  /** 의미 결속 불일치/검증불가 사유 (sanitized 요약) */
  semanticMismatches:  text("semantic_mismatches"),
  /** 판정 근거 tx receipt status ('success'|'reverted') */
  receiptStatus:       text("receipt_status"),
  /** 판정 근거 receipt block number */
  receiptBlockNumber:  text("receipt_block_number"),
  /** ambiguous 판정 사유 (전이 금지 근거) */
  ambiguousReason:     text("ambiguous_reason"),
});

export type ProtectionOrderRow = typeof protectionOrdersTable.$inferSelect;
export type NewProtectionOrderRow = typeof protectionOrdersTable.$inferInsert;
