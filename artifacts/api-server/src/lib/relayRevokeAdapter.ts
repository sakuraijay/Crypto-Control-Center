/**
 * relayRevokeAdapter — revoke(removeSubaccount) 실제 어댑터 판정 규칙 (4단계 §8).
 *
 * 원칙:
 *  - revoke relay task accepted만으로 REVOKED 전이 금지.
 *  - canonical(DataStore)에서 subaccount 제거가 확인된 후에만 세션 REVOKED.
 *  - 결과 모호(조회 실패·불명)면 UNRESOLVED 처리 유지 — 자동 종결 금지.
 *  - revoke 진행 중에는 신규 주문 relay 경로 전면 차단 (활성화 게이트
 *    activeRevokeInProgress + 서버 주문 경로 + UI 3면 차단).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, subaccountApprovalSessionsTable } from '@workspace/db';
import { SESSION_STATUS } from './ownerApprovalSession';
import { REVOKE_PURPOSE } from './revokeSession';

export type RevokeVerdict =
  | { verdict: 'REVOKED'; basis: string }
  | { verdict: 'PENDING'; basis: string }
  | { verdict: 'UNRESOLVED'; basis: string };

/**
 * 순수 판정 — canonical 조회 결과에서 revoke 완료 여부 결정.
 * @param canonicalRemoved true=DataStore에서 제거 확인, false=아직 존재, null=조회 실패/불명
 */
export function decideRevokeCompletion(params: {
  taskAccepted: boolean;
  canonicalRemoved: boolean | null;
}): RevokeVerdict {
  if (params.canonicalRemoved === true) {
    return { verdict: 'REVOKED', basis: 'canonical DataStore에서 subaccount 제거 확인' };
  }
  if (params.canonicalRemoved === false) {
    // task accepted여도 온체인 미반영 — 절대 REVOKED 금지
    return {
      verdict: 'PENDING',
      basis: params.taskAccepted
        ? 'task accepted이나 canonical 미반영 — REVOKED 금지, 재확인 대기'
        : 'canonical에 아직 존재 — 대기',
    };
  }
  return { verdict: 'UNRESOLVED', basis: 'canonical 조회 실패/불명 — 자동 종결 금지, 운영자 조사 필요' };
}

/** canonical 제거 확인 후에만 호출 — revoke 세션 REVOKED 마감 */
export async function finalizeRevokeSession(sessionId: string, basis: string): Promise<boolean> {
  try {
    const updated = await db.update(subaccountApprovalSessionsTable)
      .set({ status: SESSION_STATUS.REVOKED, invalidReason: basis, updatedAt: new Date() })
      .where(and(
        eq(subaccountApprovalSessionsTable.id, sessionId),
        eq(subaccountApprovalSessionsTable.purpose, REVOKE_PURPOSE),
        inArray(subaccountApprovalSessionsTable.status, [SESSION_STATUS.PREPARED, SESSION_STATUS.OWNER_SIGNATURE_READY]),
      ))
      .returning({ id: subaccountApprovalSessionsTable.id });
    return updated.length === 1;
  } catch {
    return false;
  }
}
