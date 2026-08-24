/**
 * riskStateMachine — 운용 상태 결정 (6H-1 §6·§7·§8·§10).
 *
 * 우선순위 (높은 것이 이김):
 *   UNRESOLVED > HARD_STOPPED > WEEKLY_LOSS_LOCKED > DAILY_LOSS_LOCKED
 *   > PROFIT_CAP_LOCKED > CONSECUTIVE_LOSS_LOCKED > PROFIT_TARGET_LOCKED
 *   > PROFIT_PROTECTED > DEFENSIVE > NORMAL
 *
 * 해제 규칙:
 *  - 일일 잠금(DAILY_LOSS/PROFIT_TARGET/PROFIT_CAP/CONSECUTIVE_LOSS)·일일 카운터는
 *    다음 Manila 거래일에 reset 가능.
 *  - WEEKLY_LOSS_LOCKED는 Manila 월요일 00:00에만 해제 — 일일 reset으로 안 풀림.
 *  - HARD_STOPPED·UNRESOLVED는 날짜 변경으로 절대 자동 해제 금지 —
 *    운영자 명시적 검토 필요 (UI 토글만으로 해제 금지).
 *
 * 데이터 결측·저장 실패는 전부 신규 진입 차단 (fail-closed).
 */

import { RISK_POLICY, deriveDailyTargets, deriveWeeklyMaxLossUsd } from './riskPolicy';

export type RiskOperatingState =
  | 'NORMAL'
  | 'DEFENSIVE'
  | 'PROFIT_PROTECTED'
  | 'PROFIT_TARGET_LOCKED'
  | 'PROFIT_CAP_LOCKED'
  | 'DAILY_LOSS_LOCKED'
  | 'WEEKLY_LOSS_LOCKED'
  | 'CONSECUTIVE_LOSS_LOCKED'
  | 'HARD_STOPPED'
  | 'UNRESOLVED';

/** 강제 조치 — 워커/실행 경로가 수행해야 할 액션 */
export type RiskAction =
  | 'CLOSE_ALL_POSITIONS'
  | 'CANCEL_ALL_ORDERS'
  | 'REDUCE_POSITION_70PCT';

/** 이전 사이클로부터 이월되는 잠금 상태 (영속화됨) */
export interface PersistedLocks {
  dailyLockReason: string | null;       // PROFIT_TARGET/PROFIT_CAP/DAILY_LOSS/CONSECUTIVE_LOSS 사유
  dailyLockState: RiskOperatingState | null;
  weeklyLockReason: string | null;
  hardStopReason: string | null;
  unresolvedReason: string | null;
  /** Profit Protection 진입 후 보호 floor (USD). null = 미진입 */
  protectedProfitFloorUsd: number | null;
  /** Profit Protection 70% 축소가 이미 실행되었는지 */
  profitReductionDone: boolean;
  defensiveActive: boolean;
  /** Defensive 진입 후 사용한 신규 진입 횟수 */
  defensiveEntriesUsed: number;
}

export interface RiskEvaluationInput {
  /** min(startOfDayEquity, 1000) — 산출 실패 시 null → 진입 차단 */
  dailyRiskCapitalUsd: number | null;
  weeklyRiskCapitalUsd: number | null;
  currentEquityUsd: number | null;
  /** authoritative 실현 순수익 (오늘, Manila) — null = 산출 불가 */
  dailyRealizedNetPnlUsd: number | null;
  /** 보수적 손실 게이트 PnL (오늘) — null = 산출 불가 */
  dailyLossAwareNetPnlUsd: number | null;
  /** 열린 포지션 포함 보수적 추정 exit PnL — null = 열린 포지션 없음/산출 불가 */
  estimatedExitNetPnlUsd: number | null;
  weeklyRealizedNetPnlUsd: number | null;
  dailyEntryCount: number;
  consecutiveLossCount: number;
  openPositionCount: number;
  /** 적용 프로필 상한. 절대 프로필 상한(2)을 넘길 수 없다. */
  maxConcurrentPositions?: number;
  /** DB 영속화 정상 여부 — false면 무조건 진입 차단 */
  dbOk: boolean;
  /** 수수료/시장 데이터 사용 가능 여부 — false면 진입 차단 */
  feeDataOk: boolean;
  marketDataFresh: boolean;
  locks: PersistedLocks;
}

export interface RiskEvaluationResult {
  state: RiskOperatingState;
  entryAllowed: boolean;
  blockReasons: string[];
  actions: RiskAction[];
  /** Defensive 시 0.5, Profit Protection 축소 대상 시 0.3(잔여), 그 외 1 */
  sizeFactor: number;
  /** 현재 상태에서 허용되는 최대 레버리지 */
  maxLeverage: number;
  /** 갱신된 잠금 상태 — 호출측이 영속화해야 함. 저장 실패 시 다음 사이클 진입 차단 */
  locks: PersistedLocks;
}

export const EMPTY_LOCKS: PersistedLocks = {
  dailyLockReason: null, dailyLockState: null,
  weeklyLockReason: null, hardStopReason: null, unresolvedReason: null,
  protectedProfitFloorUsd: null, profitReductionDone: false,
  defensiveActive: false, defensiveEntriesUsed: 0,
};

/** Manila 거래일 변경 시 daily 잠금·카운터 reset (weekly/hard/unresolved는 유지) */
export function resetDailyLocks(locks: PersistedLocks): PersistedLocks {
  return {
    ...locks,
    dailyLockReason: null, dailyLockState: null,
    protectedProfitFloorUsd: null, profitReductionDone: false,
    defensiveActive: false, defensiveEntriesUsed: 0,
  };
}

/** Manila 월요일 00:00 — weekly 잠금 해제 (hard/unresolved는 유지) */
export function resetWeeklyLocks(locks: PersistedLocks): PersistedLocks {
  return { ...locks, weeklyLockReason: null };
}

export function evaluateRiskState(input: RiskEvaluationInput): RiskEvaluationResult {
  const p = RISK_POLICY;
  const maxConcurrentPositions = Math.max(
    1,
    Math.min(
      Number.isFinite(input.maxConcurrentPositions)
        ? Math.floor(input.maxConcurrentPositions as number)
        : p.maxConcurrentPositions,
      p.maxProfileConcurrentPositions,
    ),
  );
  const locks: PersistedLocks = { ...input.locks };
  const blockReasons: string[] = [];
  const actions: RiskAction[] = [];

  const blocked = (state: RiskOperatingState, sizeFactor = 0): RiskEvaluationResult => ({
    state, entryAllowed: false, blockReasons, actions, sizeFactor,
    maxLeverage: 0, locks,
  });

  // ── 0. 영속/데이터 fail-closed 게이트 ────────────────────────────────────────
  if (locks.unresolvedReason) {
    blockReasons.push(`UNRESOLVED: ${locks.unresolvedReason} — 운영자 확인 전 차단`);
    return blocked('UNRESOLVED');
  }
  if (!input.dbOk) {
    blockReasons.push('DB 영속화 실패 — 메모리 상태만으로 거래 금지 (fail-closed)');
    return blocked('UNRESOLVED');
  }

  // ── 1. HARD STOP — equity ≤ $850, 자동 해제 절대 금지 ───────────────────────
  if (locks.hardStopReason) {
    blockReasons.push(`HARD_STOPPED: ${locks.hardStopReason} — 운영자 명시적 검토 전 영구 차단`);
    return blocked('HARD_STOPPED');
  }
  if (input.currentEquityUsd !== null && input.currentEquityUsd <= p.hardStopEquityUsd) {
    locks.hardStopReason =
      `equity $${input.currentEquityUsd.toFixed(2)} ≤ hard stop $${p.hardStopEquityUsd} (최초 $${p.initialCapitalUsd} 대비 -15%)`;
    actions.push('CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS');
    blockReasons.push(locks.hardStopReason);
    return blocked('HARD_STOPPED');
  }

  // ── 2. 데이터 게이트 — 값 없음/stale이면 신규 진입 차단 ─────────────────────
  if (input.currentEquityUsd === null) blockReasons.push('현재 equity 산출 불가 — 진입 차단');
  if (input.dailyRiskCapitalUsd === null) blockReasons.push('dailyRiskCapital 산출 불가 — 진입 차단');
  if (input.weeklyRiskCapitalUsd === null) blockReasons.push('weeklyRiskCapital 산출 불가 — 진입 차단');
  if (input.dailyRealizedNetPnlUsd === null) blockReasons.push('일일 실현 순수익 산출 불가 — 진입 차단');
  if (input.dailyLossAwareNetPnlUsd === null) blockReasons.push('손실 게이트 PnL 산출 불가 — 진입 차단');
  if (input.weeklyRealizedNetPnlUsd === null) blockReasons.push('주간 순수익 산출 불가 — 진입 차단');
  if (!input.feeDataOk) blockReasons.push('수수료/비용 데이터 결측·stale — 진입 차단 (가짜 0 대체 금지)');
  if (!input.marketDataFresh) blockReasons.push('시장 데이터 stale — 진입 차단');
  if (blockReasons.length > 0) {
    return { state: 'NORMAL', entryAllowed: false, blockReasons, actions, sizeFactor: 0, maxLeverage: 0, locks };
  }

  const dailyCap = input.dailyRiskCapitalUsd!;
  const weeklyCap = input.weeklyRiskCapitalUsd!;
  const targets = deriveDailyTargets(dailyCap);
  const weeklyMaxLossUsd = deriveWeeklyMaxLossUsd(weeklyCap);
  const realized = input.dailyRealizedNetPnlUsd!;
  const lossAware = input.dailyLossAwareNetPnlUsd!;
  const weeklyPnl = input.weeklyRealizedNetPnlUsd!;
  const est = input.estimatedExitNetPnlUsd;

  // ── 3. WEEKLY LOSS LOCK (-8%) — 일일 reset으로 해제 금지 ─────────────────────
  if (locks.weeklyLockReason) {
    blockReasons.push(`WEEKLY_LOSS_LOCKED: ${locks.weeklyLockReason}`);
    return blocked('WEEKLY_LOSS_LOCKED');
  }
  if (weeklyPnl <= -weeklyMaxLossUsd) {
    locks.weeklyLockReason =
      `주간 순손실 $${weeklyPnl.toFixed(2)} ≤ -$${weeklyMaxLossUsd.toFixed(2)} (weekly capital × ${p.weeklyMaxLossPercent}%)`;
    actions.push('CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS');
    blockReasons.push(locks.weeklyLockReason);
    return blocked('WEEKLY_LOSS_LOCKED');
  }

  // ── 4. 일일 잠금 이월 (같은 Manila 거래일 내 유지) ───────────────────────────
  if (locks.dailyLockReason && locks.dailyLockState) {
    blockReasons.push(`${locks.dailyLockState}: ${locks.dailyLockReason} — 다음 Manila 거래일까지 차단`);
    // PROFIT_PROTECTED에서 이월된 floor 후퇴 감시는 아래 §6-B에서 계속 수행
    if (locks.dailyLockState !== 'PROFIT_PROTECTED') {
      return blocked(locks.dailyLockState);
    }
  }

  // ── 5. -3% DAILY LOSS LOCK ───────────────────────────────────────────────────
  if (lossAware <= -targets.dailyMaxLossUsd) {
    locks.dailyLockState = 'DAILY_LOSS_LOCKED';
    locks.dailyLockReason =
      `일일 손실 $${lossAware.toFixed(2)} ≤ -$${targets.dailyMaxLossUsd.toFixed(2)} (-${p.dailyMaxLossPercent}%)`;
    actions.push('CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS');
    blockReasons.push(locks.dailyLockReason);
    return blocked('DAILY_LOSS_LOCKED');
  }

  // ── 6. +10% 절대 상한 — realized 또는 estimated 중 하나라도 도달 ────────────
  const capHit =
    realized >= targets.absoluteProfitCapUsd ||
    (est !== null && est >= targets.absoluteProfitCapUsd);
  if (capHit) {
    locks.dailyLockState = 'PROFIT_CAP_LOCKED';
    locks.dailyLockReason =
      `+${p.absoluteProfitCapPercent}% 절대 상한 도달 (realized $${realized.toFixed(2)}, est ${est === null ? 'n/a' : '$' + est.toFixed(2)}) — 종료 비용으로 10% 미만이 되어도 재진입 금지`;
    actions.push('CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS');
    blockReasons.push(locks.dailyLockReason);
    return blocked('PROFIT_CAP_LOCKED');
  }

  // ── 7. 연속 손실 3회 ────────────────────────────────────────────────────────
  if (input.consecutiveLossCount >= p.maxConsecutiveLosses) {
    locks.dailyLockState = 'CONSECUTIVE_LOSS_LOCKED';
    locks.dailyLockReason = `연속 손실 ${input.consecutiveLossCount}회 ≥ ${p.maxConsecutiveLosses}회 — 즉시 중단`;
    blockReasons.push(locks.dailyLockReason);
    return blocked('CONSECUTIVE_LOSS_LOCKED');
  }

  // ── 8. +5% Profit Protection ────────────────────────────────────────────────
  // A. 실현 순수익 +5% — 신규 진입 금지, 부분청산 후 5% 미만이어도 재진입 금지
  if (realized >= targets.primaryProfitTargetUsd || locks.dailyLockState === 'PROFIT_TARGET_LOCKED') {
    if (locks.dailyLockState !== 'PROFIT_TARGET_LOCKED') {
      locks.dailyLockState = 'PROFIT_TARGET_LOCKED';
      locks.dailyLockReason =
        `일일 실현 순수익 +${p.primaryProfitTargetPercent}% 목표 달성 ($${realized.toFixed(2)}) — 다음 Manila 거래일까지 신규 진입 금지`;
    }
    blockReasons.push(locks.dailyLockReason!);
    // 열린 포지션 잔여분의 floor 후퇴 감시는 계속
    if (locks.protectedProfitFloorUsd !== null && est !== null && est <= locks.protectedProfitFloorUsd) {
      actions.push('CLOSE_ALL_POSITIONS');
      blockReasons.push(`estimated $${est.toFixed(2)} ≤ 보호 floor $${locks.protectedProfitFloorUsd.toFixed(2)} — 잔여 전량 종료`);
    }
    return blocked('PROFIT_TARGET_LOCKED');
  }

  // B. estimated(열린 포지션 포함) +5% — 70% 축소 + floor 3.5%
  const inProtection = locks.dailyLockState === 'PROFIT_PROTECTED';
  if (inProtection || (est !== null && est >= targets.primaryProfitTargetUsd)) {
    if (!inProtection) {
      locks.dailyLockState = 'PROFIT_PROTECTED';
      locks.dailyLockReason =
        `estimated exit 순수익 +${p.primaryProfitTargetPercent}% 도달 ($${est!.toFixed(2)}) — 70% 축소, 신규 진입 금지`;
      locks.protectedProfitFloorUsd = targets.protectedProfitFloorUsd;
    }
    blockReasons.push(locks.dailyLockReason!);
    if (!locks.profitReductionDone) {
      actions.push('REDUCE_POSITION_70PCT');
      // profitReductionDone은 축소 주문 확정 후 호출측이 true로 영속화한다.
      // 실패/불명확 시 false 유지 → 신규 주문 차단 지속.
    }
    // floor 후퇴 → 잔여 전량 종료
    if (est !== null && locks.protectedProfitFloorUsd !== null && est <= locks.protectedProfitFloorUsd) {
      actions.push('CLOSE_ALL_POSITIONS');
      blockReasons.push(`estimated $${est.toFixed(2)} ≤ 보호 floor $${locks.protectedProfitFloorUsd.toFixed(2)} — 잔여 전량 종료`);
    }
    // 잔여 30%만 추세 지속 허용 — 신규 진입은 금지
    return { state: 'PROFIT_PROTECTED', entryAllowed: false, blockReasons, actions, sizeFactor: 0.3, maxLeverage: 0, locks };
  }

  // ── 9. -2% Defensive Mode ───────────────────────────────────────────────────
  if (lossAware <= -targets.defensiveModeLossUsd || locks.defensiveActive) {
    if (!locks.defensiveActive) locks.defensiveActive = true;
    const defensiveMaxLev = 2;
    // 남은 신규 진입 최대 1회
    if (locks.defensiveEntriesUsed >= 1) {
      blockReasons.push('DEFENSIVE: 남은 신규 진입 소진 (최대 1회)');
      return blocked('DEFENSIVE', 0.5);
    }
    if (input.dailyEntryCount >= p.maxDailyEntries) {
      blockReasons.push(`일일 신규 진입 한도 (${input.dailyEntryCount}/${p.maxDailyEntries})`);
      return blocked('DEFENSIVE', 0.5);
    }
    if (input.openPositionCount >= maxConcurrentPositions) {
      blockReasons.push(`동시 포지션 한도 (${input.openPositionCount}/${maxConcurrentPositions})`);
      return blocked('DEFENSIVE', 0.5);
    }
    return {
      state: 'DEFENSIVE', entryAllowed: true, blockReasons,
      actions, sizeFactor: 0.5, maxLeverage: defensiveMaxLev, locks,
    };
  }

  // ── 10. NORMAL — 횟수/동시 포지션 게이트 ────────────────────────────────────
  if (input.dailyEntryCount >= p.maxDailyEntries) {
    blockReasons.push(`일일 신규 진입 한도 도달 (${input.dailyEntryCount}/${p.maxDailyEntries})`);
    return blocked('NORMAL', 1);
  }
  if (input.openPositionCount >= maxConcurrentPositions) {
    blockReasons.push(`동시 포지션 한도 (${input.openPositionCount}/${maxConcurrentPositions})`);
    return blocked('NORMAL', 1);
  }

  return {
    state: 'NORMAL', entryAllowed: true, blockReasons: [],
    actions, sizeFactor: 1, maxLeverage: p.baseMaxLeverage, locks,
  };
}
