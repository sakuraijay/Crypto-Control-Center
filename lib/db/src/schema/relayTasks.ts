import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * GMX delegated trading 3단계 — durable relay lifecycle.
 *
 * 외부 relay(Gelato) 호출 전에 반드시 이 테이블에 intent가 커밋되어야 한다.
 * DB 저장 실패 시 relay 호출 0회 (fail-closed).
 *
 * 상태: PREPARED → DRY_RUN_VALIDATED → SUBMITTING → TASK_ACCEPTED →
 *       TX_SUBMITTED → ORDER_CREATED → CONFIRMED
 *       (분기: CANCELLED / FAILED_PRE_BROADCAST / UNRESOLVED)
 * terminal(CONFIRMED/CANCELLED/FAILED_PRE_BROADCAST)에서 역행 금지.
 * timeout·응답 유실은 FAILED가 아니라 UNRESOLVED.
 *
 * 숫자(uint256)는 text 십진 문자열로 저장 (기존 패턴).
 */
export const relayTasksTable = pgTable("relay_tasks", {
  id:                text("id").primaryKey(),
  idempotencyKey:    text("idempotency_key").notNull(),      // unique index (migration)
  intentId:          text("intent_id"),                      // execution_intents 연결 (nullable: revoke 등)
  approvalSessionId: text("approval_session_id"),            // subaccount_approval_sessions 연결
  kind:              text("kind").notNull(),                 // OPEN | CLOSE | REVOKE
  status:            text("status").notNull(),
  payloadHash:       text("payload_hash").notNull(),         // 조립 payload 전체 hash
  calldataHash:      text("calldata_hash"),
  relayTaskId:       text("relay_task_id"),                  // Gelato taskId
  txHash:            text("tx_hash"),
  orderKey:          text("order_key"),
  feeToken:          text("fee_token"),
  feeAmount:         text("fee_amount"),
  userNonce:         text("user_nonce"),
  approvalNonce:     text("approval_nonce"),
  // 6F-2 §3 — transport 세대: 'legacy-digital'(구 REST) | 'jsonrpc-gasless-0.0.10'.
  // legacy 세대 taskId는 신형 endpoint로 조회 금지 (UNRESOLVED_LEGACY_TRANSPORT).
  transportGen:      text("transport_gen").notNull().default("legacy-digital"),
  // 6G-1 §9 — 공식 GMX API v2 경로(transport_gen='GMX_API_V2') 전용 필드.
  gmxRequestId:       text("gmx_request_id"),        // prepare 응답 requestId (unique partial index)
  gmxIdempotencyKey:  text("gmx_idempotency_key"),   // prepare 응답 idempotencyKey (unique partial index)
  gmxApiStatus:       text("gmx_api_status"),        // 마지막으로 관측된 GMX API status 문자열
  gmxExecutionTxHash: text("gmx_execution_tx_hash"), // API가 보고한 실행 tx hash
  gmxOrderKeys:       text("gmx_order_keys"),        // JSON array 직렬화된 order key 목록
  gmxApiPeer:         text("gmx_api_peer"),          // 제출에 사용된 peer host (경로/쿼리 제외)
  preparedPayloadHash: text("prepared_payload_hash"), // prepare typed data 전체 hash (결속 검증용)
  // 6G-3 §5 — prepare 단계 비민감 증거 (전문·서명·암호문 저장 금지).
  gmxPrimaryType:        text("gmx_primary_type"),        // typedData.primaryType
  gmxTypedDataDigest:    text("gmx_typed_data_digest"),   // 서버 독립 재계산 digest
  gmxPreparePeer:        text("gmx_prepare_peer"),        // prepare에 응답한 peer host
  gmxPrepareRequestedAt: timestamp("gmx_prepare_requested_at", { withTimezone: true }), // 외부 prepare 요청 시각
  gmxPreparedAt:         timestamp("gmx_prepared_at", { withTimezone: true }),          // 증거 저장 완료 시각
  errorClass:        text("error_class"),                    // 오류 분류
  resolutionBasis:   text("resolution_basis"),               // 판정 근거 (온체인 증거 등)
  createdAt:         timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt:        timestamp("resolved_at", { withTimezone: true }),
});

export type RelayTaskRow = typeof relayTasksTable.$inferSelect;
export type NewRelayTaskRow = typeof relayTasksTable.$inferInsert;
