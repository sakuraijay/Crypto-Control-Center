/**
 * relayNonce — durable userNonce allocation (4단계).
 *
 * 공식 근거:
 *  - 온체인 replay 방어는 digest 기반이다 (BaseGelatoRelayRouter._validateDigest:
 *    digests[digest] 재사용 시 InvalidUserDigest revert). userNonce는
 *    relayParams hash를 통해 digest 유일성을 만드는 입력값이다.
 *  - 공식 interface는 userNonce=BigInt(nowInSeconds())를 쓴다. 동일 초에
 *    OPEN·CLOSE·REVOKE가 겹칠 수 있으므로 이 방식은 폐기한다 (지시서 §2).
 *
 * 규칙:
 *  - DB 단조 증가 allocation: max(nonce)+1 → insert. (main_account, nonce)
 *    unique index가 다중 프로세스·동시 요청의 최종 방어 — 충돌 시 재시도.
 *  - 재시작 후에도 max 기반이라 중복 없음.
 *  - allocation된 nonce는 제출 여부와 무관하게 재사용하지 않는다.
 *    (digest 방어상 "확실히 미제출"인 nonce의 재사용은 온체인상 안전하지만,
 *     제출 여부가 불명확한 상황의 재사용 사고를 원천 차단하는 strictly-safe 선택.
 *     nonce는 소모품이며 고갈 개념이 없다.)
 *  - epoch초·Date.now() 단독 의존 금지.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, relayNoncesTable } from '@workspace/db';

const MAX_ALLOCATION_ATTEMPTS = 5;

export type NonceAllocation =
  | { ok: true; nonce: bigint; allocationId: string }
  | { ok: false; reason: string };

/**
 * userNonce 원자적 allocation.
 * 실패(모든 재시도 소진·DB 오류) 시 fail-closed — 호출측은 제출 진행 금지.
 */
export async function allocateUserNonce(params: {
  mainAccount: string;
  purpose: 'OPEN' | 'CLOSE' | 'REVOKE';
}): Promise<NonceAllocation> {
  const account = params.mainAccount.toLowerCase();

  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    let maxNonce = -1n;
    try {
      const rows = await db.select({ nonce: relayNoncesTable.nonce }).from(relayNoncesTable)
        .where(eq(relayNoncesTable.mainAccount, account));
      for (const r of rows) {
        try {
          const n = BigInt(r.nonce);
          if (n > maxNonce) maxNonce = n;
        } catch { /* 비정상 행 무시 — max 계산에서 제외 */ }
      }
    } catch {
      return { ok: false, reason: 'nonce 조회 실패 — allocation 불가 (fail-closed)' };
    }

    const next = maxNonce + 1n;
    const allocationId = randomUUID();
    try {
      await db.insert(relayNoncesTable).values({
        id: allocationId,
        mainAccount: account,
        nonce: next.toString(),
        purpose: params.purpose,
      });
      return { ok: true, nonce: next, allocationId };
    } catch {
      // unique(main_account, nonce) 충돌 — 다른 프로세스가 선점. 재시도.
      continue;
    }
  }
  return { ok: false, reason: `nonce allocation ${MAX_ALLOCATION_ATTEMPTS}회 충돌 — 중단 (fail-closed)` };
}

/** allocation을 relay task에 결합 (감사 추적용) — 실패해도 nonce는 이미 소모됨 */
export async function bindNonceToTask(allocationId: string, taskId: string): Promise<boolean> {
  try {
    const updated = await db.update(relayNoncesTable)
      .set({ taskId })
      .where(eq(relayNoncesTable.id, allocationId))
      .returning({ id: relayNoncesTable.id });
    return updated.length === 1;
  } catch {
    return false;
  }
}
