import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * GMX delegated trading — owner approval 세션 (2단계).
 *
 * owner signature는 만료 전 relay 권한을 갖는 capability이므로
 * SESSION_SECRET 기반 AES-256-GCM 인증암호화로만 저장한다 (encrypted_signature).
 * signature 전문·암호문은 API·로그·오류·감사 화면에 절대 노출하지 않는다.
 *
 * 숫자 필드(expiresAt/maxAllowedCount/nonce/deadline 등)는 uint256 정밀도
 * 보존을 위해 text(십진 문자열)로 저장한다 (execution_intents와 동일 패턴).
 */
export const subaccountApprovalSessionsTable = pgTable("subaccount_approval_sessions", {
  id:                 text("id").primaryKey(),
  mainAccount:        text("main_account").notNull(),
  subaccount:         text("subaccount").notNull(),           // delegated signer 공개 주소
  chainId:            text("chain_id").notNull(),
  verifyingContract:  text("verifying_contract").notNull(),
  actionType:         text("action_type").notNull(),
  shouldAdd:          boolean("should_add").notNull(),
  expiresAt:          text("expires_at").notNull(),
  maxAllowedCount:    text("max_allowed_count").notNull(),
  approvalNonce:      text("approval_nonce").notNull(),
  desChainId:         text("des_chain_id").notNull(),
  deadline:           text("deadline").notNull(),
  integrationId:      text("integration_id").notNull(),
  typedDataDigest:    text("typed_data_digest").notNull(),
  encryptedSignature: text("encrypted_signature"),            // 서명 제출 전 null
  status:             text("status").notNull(),               // PREPARED | OWNER_SIGNATURE_READY | INVALIDATED | CONSUMED | REVOKED
  invalidReason:      text("invalid_reason"),
  createdAt:          timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  consumedAt:         timestamp("consumed_at", { withTimezone: true }),
  revokedAt:          timestamp("revoked_at", { withTimezone: true }),
});

export type SubaccountApprovalSessionRow = typeof subaccountApprovalSessionsTable.$inferSelect;
export type NewSubaccountApprovalSessionRow = typeof subaccountApprovalSessionsTable.$inferInsert;
