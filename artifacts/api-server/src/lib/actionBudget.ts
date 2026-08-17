/**
 * actionBudget — 6H-2B §7 Owner Approval action 예산 회계.
 *
 * 공식 근거 (gmx-synthetics SubaccountRouterUtils / SubaccountUtils):
 *  - subaccount 경유의 모든 주문 작업(createOrder / updateOrder / cancelOrder)은
 *    각각 handleSubaccountAction → validateSubaccountAction을 거치며
 *    SUBACCOUNT_ORDER_ACTION actionsCount를 **작업당 정확히 1** 소비한다.
 *  - owner 본인이 서명·전송하는 tx(승인 갱신, removeSubaccount/revoke)는
 *    subaccount action count를 소비하지 않는다.
 *  - 소비는 성공/실패와 무관하게 relay에 수락되어 실행되는 시점에 발생하므로
 *    예산 판단은 canonical snapshot의 remaining(온체인 조회값)만 신뢰한다.
 *
 * canary 1회 최소 예산 (§7):
 *  OPEN(createOrder)=1 + INITIAL_STOP(createOrder)=1 + EMERGENCY_CLOSE(createOrder)=1
 *  + stale stop CANCEL(cancelOrder)=1  ⇒ 4
 *
 * 현재 저장된 approval 기본 maxAllowedCount=2는 이 최소 예산에 미달 —
 * 서버가 자동 확대하는 것은 금지(owner 재서명 필요)이므로 부족 시 OPEN 차단 후 보고.
 */

/** 작업별 action 소비량 — 전부 1 (공식 handleSubaccountAction 규칙) */
export const ACTION_COST = {
  createOrder: 1,
  updateOrder: 1,
  cancelOrder: 1,
} as const;

/** canary 1 사이클 안전 최소 예산: OPEN + INITIAL_STOP + EMERGENCY_CLOSE + stale CANCEL */
export const MIN_SAFE_ACTION_BUDGET =
  ACTION_COST.createOrder /* OPEN */ +
  ACTION_COST.createOrder /* INITIAL_STOP */ +
  ACTION_COST.createOrder /* EMERGENCY_CLOSE */ +
  ACTION_COST.cancelOrder /* stale stop cancel */;

export interface ActionBudgetInput {
  /** canonical snapshot remaining (온체인 조회값 문자열). null/파싱불가 = 차단 */
  remaining: string | null;
  /** approval 만료 (unix seconds 문자열). null/과거 = 차단 */
  expiresAt: string | null;
  nowMs: number;
}

export interface ActionBudgetResult {
  sufficient: boolean;
  remainingActions: number | null;
  requiredActions: number;
  reasons: string[];
}

/** §7 — OPEN 허용 전 action 예산 평가. 조회 실패/부족 = OPEN 차단 (fail-closed). */
export function evaluateActionBudget(input: ActionBudgetInput): ActionBudgetResult {
  const reasons: string[] = [];
  let remaining: number | null = null;
  try {
    if (input.remaining === null) throw new Error('none');
    const v = BigInt(input.remaining);
    remaining = v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
    if (remaining < 0) throw new Error('neg');
  } catch {
    remaining = null;
    reasons.push('remaining actions 조회 불가 — OPEN 차단 (fail-closed)');
  }
  try {
    if (input.expiresAt === null) throw new Error('none');
    if (Number(input.expiresAt) * 1000 <= input.nowMs) reasons.push('approval 만료 — OPEN 차단');
  } catch {
    reasons.push('approval 만료시각 불명 — OPEN 차단 (fail-closed)');
  }
  if (remaining !== null && remaining < MIN_SAFE_ACTION_BUDGET) {
    reasons.push(
      `remaining actions ${remaining} < 최소 안전 예산 ${MIN_SAFE_ACTION_BUDGET} ` +
      `(OPEN+INITIAL_STOP+EMERGENCY_CLOSE+stale CANCEL) — OPEN 차단. ` +
      `owner 재서명으로 maxAllowedCount 확대 필요 (서버 자동 확대 금지)`,
    );
  }
  return {
    sufficient: reasons.length === 0,
    remainingActions: remaining,
    requiredActions: MIN_SAFE_ACTION_BUDGET,
    reasons,
  };
}
