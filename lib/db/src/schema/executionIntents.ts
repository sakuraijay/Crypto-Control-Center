import { pgTable, text, integer, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

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
  /** 주문 의도 생성 당시 적용된 버전 프로필과 파생 한도 불변 스냅샷 */
  riskProfileSnapshot: jsonb("risk_profile_snapshot"),
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
  // ── CLOSE 포지션 결속 필드 (migration 0030 — additive, nullable) ─────────────
  /**
   * CLOSE intent에서 결속된 계정 주소 (소문자 정규화).
   * prepare/sign/submit 전에 커밋되어야 하며, OPEN intent는 null.
   */
  closeAccount:            text("close_account"),
  /**
   * CLOSE intent에서 결속된 GMX 마켓 토큰 주소 (소문자 정규화).
   * executeViaGmxApi의 market 일치 검증의 권위 소스.
   */
  closeMarketAddress:      text("close_market_address"),
  /**
   * CLOSE intent에서 결속된 담보 토큰 주소 (소문자 정규화).
   * canonical position key 재구성의 exact 담보 토큰.
   */
  closeCollateralToken:    text("close_collateral_token"),
  /**
   * keccak256(account || market || collateralToken || isLong) — CLOSE 대상 GMX V2 canonical position key.
   * PositionReader 반환값에서 직접 추출되며, 대체 포지션 선택을 구조적으로 차단한다.
   */
  closePositionKey:        text("close_position_key"),
  /**
   * CLOSE 제출 직전 온체인에서 확인된 포지션 크기 (USD, numeric string).
   */
  closePreSizeUsd:         numeric("close_pre_size_usd", { precision: 18, scale: 4 }),
  /** PositionReader의 exact sizeInUsd uint256 (1e30 정수 문자열). */
  closePreSizeUsd30:       text("close_pre_size_usd_30"),
  /**
   * 이 CLOSE 주문이 요청한 감소 크기 (USD, numeric string).
   */
  closeRequestedReductionUsd: numeric("close_requested_reduction_usd", { precision: 18, scale: 4 }),
  /** prepare 요청의 exact sizeDeltaUsd uint256 (1e30 정수 문자열). */
  closeRequestedReductionUsd30: text("close_requested_reduction_usd_30"),
  /**
   * 이 intent와 연결된 미결산 CLOSE 거래 행 id.
   * settlement:close:<intentId> 형식으로 결정적 생성 — 재시작 후에도 동일 행 참조.
   */
  closeSettlementTradeId:  text("close_settlement_trade_id"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
