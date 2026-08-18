/**
 * actionBudget — 6H-2B §7 + 6H-2C §6 Owner Approval action 예산 회계 (전면 재감사).
 *
 * 공식 근거 (gmx-synthetics SubaccountRouterUtils / SubaccountUtils):
 *  - subaccount 경유의 모든 주문 작업(createOrder / updateOrder / cancelOrder)은
 *    각각 handleSubaccountAction → validateSubaccountAction을 거치며
 *    SUBACCOUNT_ORDER_ACTION actionsCount를 **작업당 정확히 1** 소비한다.
 *    (SDK 1.7.0 configs/dataStore: SUBACCOUNT_ORDER_ACTION / SUBACCOUNT_ACTION_COUNT /
 *     MAX_ALLOWED_SUBACCOUNT_ACTION_COUNT 키 — 온체인 DataStore 카운터.)
 *  - keeper의 주문 **실행/체결**(OrderExecuted)은 subaccount action이 아니다 — 소비 0.
 *  - owner 본인이 서명·전송하는 tx(승인 갱신, removeSubaccount/revoke)는 소비하지 않는다.
 *  - 소비는 relay 수락·실행 시점에 발생 — 예산 판단은 canonical snapshot의
 *    remaining(온체인 조회값)만 신뢰한다.
 *  - 부분 청산 후 기존 stop size는 자동 조정되지 않으며(공식 자동조정 규칙 없음 —
 *    oversized stop은 InvalidDecreaseOrderSize 위험), 전량 종료 후 stop 자동취소는
 *    autoCancel 플래그 설정 시에만 발생(우리 주문은 미설정 가정) — 따라서 기존 stop
 *    정리는 **별도 cancelOrder=1 소비**로 계상한다.
 */

/** 작업별 action 소비량 — 전부 1 (공식 handleSubaccountAction 규칙) */
export const ACTION_COST = {
  createOrder: 1,
  updateOrder: 1,
  cancelOrder: 1,
} as const;

/** §6 — canary 경로별 action 소비 표 (각 항목 = subaccount 작업 1회) */
export interface CanaryActionPath {
  path: string;
  steps: { step: string; op: keyof typeof ACTION_COST }[];
  total: number;
}

function makePath(path: string, steps: { step: string; op: keyof typeof ACTION_COST }[]): CanaryActionPath {
  return { path, steps, total: steps.reduce((s, x) => s + ACTION_COST[x.op], 0) };
}

export const CANARY_ACTION_PATHS: readonly CanaryActionPath[] = [
  makePath('정상 손절 (stop 체결)', [
    { step: 'OPEN', op: 'createOrder' },
    { step: 'INITIAL_STOP 생성', op: 'createOrder' },
    // stop 체결은 keeper 실행 — action 소비 0
  ]),
  makePath('stop 생성 실패 → 즉시 전량 종료', [
    { step: 'OPEN', op: 'createOrder' },
    { step: 'INITIAL_STOP 시도 (수락 시 소비)', op: 'createOrder' },
    { step: 'EMERGENCY_CLOSE (MarketDecrease)', op: 'createOrder' },
    { step: '잔존 stale stop 취소', op: 'cancelOrder' },
  ]),
  makePath('+5% 이익보호 (70% 축소 → 잔여 30% 전량 종료)', [
    { step: 'OPEN', op: 'createOrder' },
    { step: 'INITIAL_STOP 생성', op: 'createOrder' },
    { step: '70% 축소 (MarketDecrease)', op: 'createOrder' },
    { step: '잔여 30% 전량 종료 (교체 미증명 — §8 CLOSE_REMAINING)', op: 'createOrder' },
    { step: '기존 stop 취소 (자동취소 없음 — 별도 소비)', op: 'cancelOrder' },
  ]),
  makePath('+10% / 일일·주간 손실 한도 → 전량 종료', [
    { step: 'OPEN', op: 'createOrder' },
    { step: 'INITIAL_STOP 생성', op: 'createOrder' },
    { step: '전량 종료 (MarketDecrease)', op: 'createOrder' },
    { step: '기존 stop 취소', op: 'cancelOrder' },
  ]),
  makePath('FROZEN/UNRESOLVED stop → 취소 시도 + 비상 종료', [
    { step: 'OPEN', op: 'createOrder' },
    { step: 'INITIAL_STOP 시도', op: 'createOrder' },
    { step: '문제 stop 취소 시도', op: 'cancelOrder' },
    { step: 'EMERGENCY_CLOSE', op: 'createOrder' },
  ]),
] as const;

/** 최악 경로 소비량 (동적 파생 — 고정 상수 금지) */
export const WORST_PATH_ACTIONS = Math.max(...CANARY_ACTION_PATHS.map(p => p.total));
/** 운영자 수동 복구용 예약분 (예상 밖 취소/정리 1회) */
export const RESERVED_EMERGENCY_ACTIONS = 1;

/** §6 — OPEN 전 필요 예산 = 최악 경로 + 비상 예약 (진행 중 예약분은 별도 가산) */
export function requiredActionsBeforeOpen(): number {
  return WORST_PATH_ACTIONS + RESERVED_EMERGENCY_ACTIONS;
}

/**
 * 과거 고정값 4는 +5% 이익보호 경로(5소비)와 비상 예약을 누락한 과소계산 —
 * §6 재감사에 따라 동적 파생값으로 교정 (현재 5+1=6).
 */
export const MIN_SAFE_ACTION_BUDGET = requiredActionsBeforeOpen();

// ── 6H-2D §6 — 예산 정책 메타 (autoCancel 미사용 근거 명시) ────────────────────

/** 예산 계산 기준 버전 — 재감사 회차 추적용 */
export const ACTION_BUDGET_VERSION = '6H-2D';

/**
 * autoCancel 예산 정책: autoCancel=false(미사용).
 * 전량 청산 시 프로토콜 자동취소의 보장 범위·subaccount action 소비 여부를 로컬
 * 공식 소스로 증명할 수 없어, stop 정리는 항상 명시적 cancelOrder 1 action을
 * 예산에 예약한다. 자동취소 가정으로 예산을 축소하지 않는다 (지시서 §2·§6).
 */
export const AUTO_CANCEL_BUDGET_POLICY =
  'autoCancel=false(미사용) — 자동취소 미증명, cancelOrder 1 action 명시 예약 유지';

/** 최악 소비 경로 이름 (동적 파생) */
export function worstCasePathName(): string {
  const worst = CANARY_ACTION_PATHS.reduce((a, b) => (b.total > a.total ? b : a));
  return worst.path;
}

/**
 * Owner approval 권장 count — 필요 최소(현재 6)에 재시도·예상 밖 정리 여유 +2.
 * 최소 6 미만 설정 = OPEN 차단, 10 초과 요구가 계산되면 Canary 차단 표시 (§7).
 */
export const RECOMMENDED_OWNER_APPROVAL_COUNT = requiredActionsBeforeOpen() + 2;

export interface ActionBudgetInput {
  /** canonical snapshot remaining (온체인 조회값 문자열). null/파싱불가 = 차단 */
  remaining: string | null;
  /** approval 만료 (unix seconds 문자열). null/과거 = 차단 */
  expiresAt: string | null;
  nowMs: number;
  /**
   * §6 — 진행 중(비terminal) 보호 주문·intent가 앞으로 소비할 예약분.
   * 미제공(undefined) = 0으로 두지 않고 null로 취급해 차단.
   */
  inFlightReservedActions?: number | null;
}

export interface ActionBudgetResult {
  sufficient: boolean;
  remainingActions: number | null;
  requiredActions: number;
  reservedEmergencyActions: number;
  inFlightReservedActions: number | null;
  /** shortfall = max(0, required + inFlight − remaining); 조회불가 = null */
  budgetShortfall: number | null;
  /** 계산 근거 (경로 표 요약) */
  budgetBasis: string[];
  reasons: string[];
}

export function budgetBasisLines(): string[] {
  return [
    ...CANARY_ACTION_PATHS.map(p => `${p.path}: ${p.steps.map(s => s.step).join(' + ')} = ${p.total}`),
    `최악 경로 ${WORST_PATH_ACTIONS} + 비상 예약 ${RESERVED_EMERGENCY_ACTIONS} = 필요 ${requiredActionsBeforeOpen()}`,
  ];
}

/** §6·§7 — OPEN 허용 전 action 예산 평가. 조회 실패/부족 = OPEN 차단 (fail-closed). */
export function evaluateActionBudget(input: ActionBudgetInput): ActionBudgetResult {
  const reasons: string[] = [];
  const required = requiredActionsBeforeOpen();
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
  let inFlight: number | null;
  if (input.inFlightReservedActions === undefined || input.inFlightReservedActions === null
      || !Number.isFinite(input.inFlightReservedActions) || input.inFlightReservedActions < 0) {
    inFlight = null;
    reasons.push('진행 중 예약분 조회 불가 — OPEN 차단 (fail-closed)');
  } else {
    inFlight = input.inFlightReservedActions;
  }
  let shortfall: number | null = null;
  if (remaining !== null && inFlight !== null) {
    shortfall = Math.max(0, required + inFlight - remaining);
    if (shortfall > 0) {
      reasons.push(
        `remaining actions ${remaining} < 필요 ${required} + 진행중 예약 ${inFlight} — 부족분 ${shortfall}, OPEN 차단. ` +
        `owner 재서명으로 maxAllowedCount 확대 필요 (서버 자동 확대 금지)`,
      );
    }
  }
  return {
    sufficient: reasons.length === 0,
    remainingActions: remaining,
    requiredActions: required,
    reservedEmergencyActions: RESERVED_EMERGENCY_ACTIONS,
    inFlightReservedActions: inFlight,
    budgetShortfall: shortfall,
    budgetBasis: budgetBasisLines(),
    reasons,
  };
}
